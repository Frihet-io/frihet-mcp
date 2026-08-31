#!/usr/bin/env node
/**
 * Single-source the OpenAPI spec every Frihet surface publishes.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Four live hosts served four hand-copied openapi.json files. All four said
 * `POST /v1/invoices/:id/credit-note` responds `200` and that "the credit note
 * is created with `sent` status". It responds `201` and creates a DRAFT — no
 * fiscal number, no hash, nothing submitted to VeriFactu. They also omitted the
 * REQUIRED `Idempotency-Key` header, omitted `403` and both `409`s, and
 * inverted `fullCredit`. The oldest copy had been wrong for six weeks. The
 * committed copies had no generator and no gate, so nothing could notice.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * CANONICAL is `https://api.frihet.io/openapi.json`, served by the publicApi
 * Cloud Function from the spec BUNDLED WITH ITS OWN DEPLOYED CODE. It cannot
 * describe an API other than the one it is fronting.
 *
 * `api.frihet.io` proxies it live (workers/api-proxy). The full remote-mcp host
 * cannot: Cloudflare Workers Assets serves files from the asset directory
 * before the Worker runs, so `mcp.frihet.io/openapi.json` ships a derived file.
 * The reviewed OpenAI host intentionally publishes no REST/OpenAPI contract;
 * its `/openapi.json` route is pinned to 404 and MCP metadata is authoritative.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   node scripts/sync-openapi.mjs            # regenerate (run before deploy)
 *   node scripts/sync-openapi.mjs --check    # gate: exit 1 on drift
 *   node scripts/sync-openapi.mjs --live     # also diff what the hosts SERVE
 *
 * `--check` and `--live` need network. Wire them into an audit/cron tier, NOT
 * into the PR-blocking tier — a required check that depends on a live host
 * turns someone else's outage into a merge block.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Read from the publicApi Cloud Function ORIGIN, not from `api.frihet.io`.
 * `api.frihet.io/openapi.json` is a proxy of this exact response, so the two
 * agree by construction — but reading the origin means this generator cannot
 * be poisoned by an edge cache, a stale Worker deploy, or (as happened here) a
 * redirect that quietly pointed the public alias at a hand-copied file. The
 * public alias is verified separately, under `--live`.
 */
const CANONICAL_URL =
  "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/publicApi/openapi.json";

/** Chrome UA: curl's default trips Cloudflare's bot rules and 403s misleadingly. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * Distinguishes "origin unreachable" from every other failure this script
 * reports (drift, malformed spec, missing endpoint) so a transient 503 never
 * masquerades as a content problem in the freshness gate.
 */
class OriginUnavailableError extends Error {}

/**
 * Retry ONLY transient failures — network errors (DNS, timeout, reset) and
 * 5xx responses. A 4xx means the request itself is wrong; retrying it would
 * not help and would hide a real problem behind a slow-looking origin.
 */
async function fetchWithRetry(url, options, attempts = 3, delaysMs = [2000, 8000]) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // AbortSignal instances are single-use. A signal that timed out during a
      // body read must never poison the next attempt before it starts.
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(30000),
      });
      if (res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
      } else if (!res.ok) {
        // A completed 4xx is a semantic/request failure, not an outage.
        return { res };
      } else {
        // The retry boundary includes the complete body transfer. Headers are
        // not availability proof when the stream later stalls or resets.
        return { res, body: await res.text() };
      }
    } catch (err) {
      lastErr = err;
    }
    if (attempt < attempts) {
      await new Promise((r) => setTimeout(r, delaysMs[attempt - 1] ?? delaysMs.at(-1)));
    }
  }
  throw new OriginUnavailableError(lastErr instanceof Error ? lastErr.message : String(lastErr));
}

/** The full-host derived artifact this repo owns. */
const FULL_ASSET = join(root, "workers/remote-mcp/public/openapi.json");
const RETIRED_OPENAI_URL = "https://openai-mcp.frihet.io/openapi.json";

/**
 * EVERY host that publishes an openapi.json, not just this repo's.
 *
 * The drift was never confined to one repo — four surfaces across three repos
 * served the same false credit-note contract, and each repo's own gates were
 * blind to the other three. `owner` says who fixes a red line; this list is the
 * only place that sees all of them at once.
 */
const LIVE_HOSTS = [
  { url: "https://api.frihet.io/openapi.json", owner: "frihet-mcp (workers/api-proxy)" },
  { url: "https://mcp.frihet.io/openapi.json", owner: "frihet-mcp (workers/remote-mcp)" },
  { url: "https://www.frihet.io/openapi.json", owner: "Frihet-Saas-Website (prebuild sync)" },
  { url: "https://docs.frihet.io/openapi.json", owner: "frihet-docs (vercel-build sync)" },
  { url: "https://app.frihet.io/openapi.json", owner: "Frihet-ERP (apps/erp/public, needs a frontend deploy)" },
];

const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check");
const LIVE = args.has("--live");

async function fetchSpec(url) {
  const { res, body } = await fetchWithRetry(`${url}?cb=${Date.now()}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    // Without a signal, undici waits 300 000 ms on a blackholed host — six
    // hosts is a half-hour hang instead of a red gate. 30 s covers a Cloud
    // Function cold start on a 372 KB body (warm is ~1 s).
  });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  // Parsing and semantic validation deliberately sit outside the retry
  // boundary: a completed malformed/non-spec response is drift, not outage.
  return assertIsSpec(JSON.parse(body), url);
}

/**
 * A 200 with parseable JSON is NOT a spec. `JSON.parse` rejects HTML and
 * truncation and nothing else, so an error envelope (`{"error":"Not found"}`,
 * which this API serves with 200 from some handlers) would sail through: in
 * generate mode it gets written verbatim over both published artifacts, and in
 * `--live` mode `creditNoteContract` returns null and the host is reported as
 * "ok". Both are false greens on the exact surface this script exists to
 * protect, so assert the floor before anything downstream trusts the payload.
 */
function assertIsSpec(doc, url) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`GET ${url} → not a JSON object`);
  }
  if (typeof doc.openapi !== "string") {
    throw new Error(`GET ${url} → no "openapi" version field — this is not an OpenAPI document`);
  }
  const paths = doc.paths;
  if (!paths || typeof paths !== "object" || Object.keys(paths).length === 0) {
    throw new Error(`GET ${url} → OpenAPI document with 0 paths`);
  }
  return doc;
}

/**
 * Stable serialization so a key-order change alone never reads as drift, and
 * so two structurally identical specs always produce the same bytes.
 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    );
  }
  return value;
}

const fingerprint = (spec) => JSON.stringify(stable(spec));

/** What the credit-note operation claims — the exact thing that drifted. */
function creditNoteContract(spec) {
  const path = Object.keys(spec.paths ?? {}).find((p) => p.endsWith("/credit-note"));
  if (!path) return null;
  const op = spec.paths[path].post ?? {};
  return {
    path,
    responses: Object.keys(op.responses ?? {}).sort().join(","),
    requiresIdempotencyKey: (op.parameters ?? []).some(
      (p) => p?.name === "Idempotency-Key" && p.required === true,
    ),
    // The exact stale sentence, present tense. Canonical mentions `sent`
    // status too — to say the old behaviour is GONE — so a bare
    // /`sent` status/ match flags the correct spec as broken.
    saysSent: /credit note is created with `sent` status/.test(op.description ?? ""),
  };
}

const fail = [];
const outages = [];
const note = (m) => console.log(m);

let canonical;
try {
  canonical = await fetchSpec(CANONICAL_URL);
} catch (err) {
  if (err instanceof OriginUnavailableError) {
    console.error(`\nORIGIN_UNAVAILABLE: canonical spec unreachable after retries — ${err.message}`);
    process.exit(2);
  }
  throw err;
}
const canonicalBytes = `${JSON.stringify(canonical, null, 2)}\n`;
const cn = creditNoteContract(canonical);

note(`canonical  ${CANONICAL_URL}`);
note(`           ${Object.keys(canonical.paths ?? {}).length} paths`);
if (cn) {
  note(`           credit-note responses: ${cn.responses}`);
  note(`           Idempotency-Key required: ${cn.requiresIdempotencyKey}`);
}

// A canonical that itself carries the falsehood must stop the run — otherwise
// this script would faithfully propagate it to every surface.
//
// It has to stop HERE, not at the exit below: `fail.push` is not a stop, and
// the generate branch 20 lines down writes both published artifacts before
// `process.exit(1)` is ever reached. The guard then "fails" with the poisoned
// spec already on disk, one `wrangler deploy` away from mcp.frihet.io.
if (cn?.saysSent) {
  console.error(
    "\nFAIL (1):\n  - CANONICAL describes the credit note as created with `sent` status. " +
      "It creates a draft. Fix functions/src/openapi.yaml in Frihet-ERP before syncing anything.",
  );
  process.exit(1);
}

// Canonical must carry the operation this script is here to police. Losing it
// means the endpoint was renamed or dropped upstream — the loudest drift there
// is, and the one that would otherwise surface as a null-deref stack trace.
if (!cn) {
  console.error(
    "\nFAIL (1):\n  - CANONICAL has no `*/credit-note` path. Either the endpoint moved " +
      "(update this script) or the origin is serving something that is not the Frihet API.",
  );
  process.exit(1);
}

// ── committed artifacts ─────────────────────────────────────────────────────
if (CHECK) {
  if (!existsSync(FULL_ASSET)) {
    fail.push(`${relative(root, FULL_ASSET)} is missing`);
  } else {
    const committed = JSON.parse(readFileSync(FULL_ASSET, "utf8"));
    if (fingerprint(committed) !== fingerprint(canonical)) {
      const c = creditNoteContract(committed);
      fail.push(
        `${relative(root, FULL_ASSET)} has drifted from canonical` +
          (c ? ` (credit-note responses ${c.responses} vs ${cn.responses})` : "") +
          " — regenerate with `node scripts/sync-openapi.mjs`",
      );
    } else {
      note(`ok         ${relative(root, FULL_ASSET)} matches canonical`);
    }
  }
} else {
  writeFileSync(FULL_ASSET, canonicalBytes);
  note(`wrote      ${relative(root, FULL_ASSET)}`);
}

// ── what the hosts actually SERVE ───────────────────────────────────────────
// A committed file that matches proves nothing about a host that was never
// redeployed — that is exactly how app.frihet.io ended up a deploy behind.
if (LIVE) {
  for (const host of LIVE_HOSTS) {
    let served;
    try {
      served = await fetchSpec(host.url);
    } catch (err) {
      if (err instanceof OriginUnavailableError) {
        outages.push(`${host.url}: ${err.message} — owner: ${host.owner}`);
      } else {
        fail.push(`${host.url}: ${err.message}`);
      }
      continue;
    }
    if (fingerprint(served) !== fingerprint(canonical)) {
      fail.push(
        `${host.url} serves ${Object.keys(served.paths ?? {}).length} paths and does not match the ` +
          `full canonical (${Object.keys(canonical.paths ?? {}).length} paths) — a committed fix still ` +
          `needs the owning surface to deploy — owner: ${host.owner}`,
      );
    } else {
      note(`ok         ${host.url} matches the full canonical`);
    }
  }

  try {
    const { res } = await fetchWithRetry(`${RETIRED_OPENAI_URL}?cb=${Date.now()}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (res.status !== 404) {
      fail.push(
        `${RETIRED_OPENAI_URL} must return 404 because the reviewed connector publishes no REST/OpenAPI contract; got HTTP ${res.status}`,
      );
    } else {
      note(`ok         ${RETIRED_OPENAI_URL} is retired (HTTP 404)`);
    }
  } catch (err) {
    if (err instanceof OriginUnavailableError) outages.push(`${RETIRED_OPENAI_URL}: ${err.message}`);
    else fail.push(`${RETIRED_OPENAI_URL}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (fail.length) {
  console.error(`\nFAIL (${fail.length}):`);
  for (const f of fail) console.error(`  - ${f}`);
  if (outages.length) {
    console.error(`\nAlso unreachable (${outages.length}, not counted as drift):`);
    for (const o of outages) console.error(`  - ${o}`);
  }
  process.exit(1);
}
if (outages.length) {
  console.error(`\nORIGIN_UNAVAILABLE (${outages.length}):`);
  for (const o of outages) console.error(`  - ${o}`);
  process.exit(2);
}
note("\nOK");
