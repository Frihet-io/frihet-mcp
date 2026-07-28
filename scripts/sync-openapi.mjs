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
 * `api.frihet.io` proxies it live (workers/api-proxy). The remote-mcp hosts
 * cannot: Cloudflare Workers Assets serves files from the asset directory
 * BEFORE the Worker runs, so `mcp.frihet.io/openapi.json` and
 * `openai-mcp.frihet.io/openapi.json` must ship a real file. Those files are
 * DERIVED — generated here, never hand-edited — and `--check` fails when the
 * committed artifact no longer matches canonical.
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
import { execFileSync } from "node:child_process";
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

/** The derived artifact this repo owns. public-openai/ is produced from it. */
const FULL_ASSET = join(root, "workers/remote-mcp/public/openapi.json");
const SCOPED_ASSET = join(root, "workers/remote-mcp/public-openai/openapi.json");
const SCOPE_SCRIPT = join(root, "workers/remote-mcp/scripts/scope-openai-openapi.mjs");

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
  { url: "https://openai-mcp.frihet.io/openapi.json", owner: "frihet-mcp (workers/remote-mcp --env openai)" },
  { url: "https://www.frihet.io/openapi.json", owner: "Frihet-Saas-Website (prebuild sync)" },
  { url: "https://docs.frihet.io/openapi.json", owner: "frihet-docs (vercel-build sync)" },
  { url: "https://app.frihet.io/openapi.json", owner: "Frihet-ERP (apps/erp/public, needs a frontend deploy)" },
];

const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check");
const LIVE = args.has("--live");

async function fetchSpec(url) {
  const res = await fetch(`${url}?cb=${Date.now()}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return JSON.parse(await res.text());
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
const note = (m) => console.log(m);

const canonical = await fetchSpec(CANONICAL_URL);
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
if (cn?.saysSent) {
  fail.push(
    "CANONICAL describes the credit note as created with `sent` status. It creates a draft. Fix functions/src/openapi.yaml in Frihet-ERP before syncing anything.",
  );
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
  execFileSync(process.execPath, [SCOPE_SCRIPT], { stdio: "inherit" });
  note(`wrote      ${relative(root, SCOPED_ASSET)} (via scope-openai-openapi.mjs)`);
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
      fail.push(`${host.url}: ${err.message}`);
      continue;
    }
    const c = creditNoteContract(served);
    if (!c) {
      // The scoped OpenAI surface deliberately drops this path.
      note(`ok         ${host.url} (no credit-note path — scoped surface)`);
      continue;
    }
    if (c.saysSent || c.responses !== cn.responses || c.requiresIdempotencyKey !== cn.requiresIdempotencyKey) {
      fail.push(
        `${host.url} serves a stale credit-note contract: responses ${c.responses} ` +
          `(canonical ${cn.responses}), Idempotency-Key required ${c.requiresIdempotencyKey} ` +
          `(canonical ${cn.requiresIdempotencyKey})${c.saysSent ? ', and still says "`sent` status"' : ""}` +
          ` — owner: ${host.owner}`,
      );
    } else {
      note(`ok         ${host.url} matches the canonical credit-note contract`);
    }
  }
}

if (fail.length) {
  console.error(`\nFAIL (${fail.length}):`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
note("\nOK");
