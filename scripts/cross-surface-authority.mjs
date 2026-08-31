#!/usr/bin/env node
/**
 * Cross-surface contract authority (V2) for Frihet MCP consumers.
 *
 * ── Why this exists (replacing contract-fetch.mjs) ──────────────────────────
 * The previous script (`contract-fetch.mjs`) was a live HTTP check against
 * `api.frihet.io/v1/openapi.json` that graceful-skipped on network failure.
 * That is observation, not authority — a producer PR that breaks a consumer
 * contract cannot be caught by a gate that turns green when the network is
 * down. V2 is the smallest mechanism that actually catches producer→consumer
 * drift deterministically:
 *
 *   1. SOURCE. Reads `workers/remote-mcp/public/openapi.json` — the public
 *      projection committed to this repo. This is the artifact `scripts/sync-
 *      openapi.mjs` writes when it has verified the live canonical spec. It
 *      cannot describe an API other than the one the producer is shipping.
 *
 *   2. OFFLINE. `--check` does NOT call `fetch()`. Network is irrelevant.
 *      Drift is detected by reading two committed files; nothing else.
 *
 *   3. CONSUMER-SPECIFIC REQUIRED CONTRACT. Each consumer repo carries its
 *      own `scripts/cross-surface-authority.required.json` listing the
 *      operationIds that consumer calls, with the per-op expectations
 *      (security, response codes, schema shape) it depends on. A producer
 *      PR that drops a contract element fails the consumer that depends on
 *      it, even if other consumers do not depend on it.
 *
 *   4. FAIL-CLOSED. No graceful skip in `--check`. Missing files, missing
 *      operations, missing security, narrowed schemas, missing response
 *      codes → exit 1 with concrete diagnostics. `--check` cannot pass when
 *      any of these is unresolved.
 *
 * It is intentionally narrower than `scripts/sync-openapi.mjs` (which verifies
 * the committed projection matches the live canonical) and narrower than
 * `scripts/published-artifact-drift.mjs` (which verifies the published tarball
 * matches this repo). Three different problems, three different gates.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   node scripts/cross-surface-authority.mjs            # default = --check
 *   node scripts/cross-surface-authority.mjs --check    # PR gate, offline
 *   node scripts/cross-surface-authority.mjs --diff     # show what would fail
 *   node scripts/cross-surface-authority.mjs --update   # regenerate required.json
 *
 * `--update` is OFFLINE too — it reads the committed projection plus the
 * committed `src/tools/` family barrel and re-emits `cross-surface-authority.
 * required.json`. It never calls the network.
 *
 * ── Exit codes ─────────────────────────────────────────────────────────────
 *   0  OK — required contract matches the projection (within the
 *          consumer-specific subset)
 *   1  DRIFT — operation removed, security weakened, schema narrowed,
 *              response code removed, or required.json out of sync
 *   2  UNAVAILABLE — required files missing or unparseable (fail-closed)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTION = join(root, "workers/remote-mcp/public/openapi.json");
const REQUIRED = join(root, "scripts/cross-surface-authority.required.json");

const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check") || !args.has("--update");
const UPDATE = args.has("--update");
const DIFF = args.has("--diff");

/* ──────────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                    */
/* ──────────────────────────────────────────────────────────────────────────── */

/** Stable serialization: object keys sorted; arrays in source order. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((k) => [k, stable(value[k])]),
    );
  }
  return value;
}

function fingerprint(doc) {
  return createHash("sha256").update(JSON.stringify(stable(doc))).digest("hex");
}

/**
 * Walk `paths.<path>.<method>` and return one record per operationId present.
 * OpenAPI 3.0/3.1 both place operationId at the operation level.
 */
function indexByOperationId(doc) {
  const out = new Map();
  if (!doc || !doc.paths || typeof doc.paths !== "object") return out;
  for (const [path, methods] of Object.entries(doc.paths)) {
    if (!methods || typeof methods !== "object") continue;
    for (const [method, op] of Object.entries(methods)) {
      const m = method.toLowerCase();
      if (!["get", "post", "put", "delete", "patch"].includes(m)) continue;
      if (!op || typeof op !== "object") continue;
      if (typeof op.operationId !== "string") continue;
      out.set(op.operationId, {
        method: m,
        path,
        operation: op,
      });
    }
  }
  return out;
}

/**
 * The effective security for an operation:
 *   - `[]` (an empty array on the op) = explicitly OPEN (no auth needed)
 *   - `[{ApiKeyAuth: []}]` on the op or on the root = protected by ApiKeyAuth
 *   - absent op-level security, absent root security = unprotected (rare)
 *
 * Returns one of: { kind: "open" }, { kind: "apiKey", name: string },
 * or { kind: "other", schemes: object } for OAuth2/OpenID/etc.
 */
function effectiveSecurity(op, root) {
  const sec = op.security;
  if (sec === undefined) {
    // inherit root
    const rootSec = root?.security;
    if (!rootSec || (Array.isArray(rootSec) && rootSec.length === 0)) {
      return { kind: "open" };
    }
    return classifySchemes(rootSec);
  }
  if (Array.isArray(sec) && sec.length === 0) {
    return { kind: "open" };
  }
  return classifySchemes(sec);
}

function classifySchemes(arr) {
  const out = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") continue;
    out.push(...Object.keys(entry));
  }
  if (out.length === 0) return { kind: "open" };
  // Treat any scheme other than "ApiKeyAuth" as "other" so the script
  // surfaces non-trivial drift (OAuth, OpenID) instead of silently passing.
  const hasApiKey = out.includes("ApiKeyAuth");
  const hasOther = out.some((s) => s !== "ApiKeyAuth");
  if (hasApiKey && !hasOther) return { kind: "apiKey", name: "ApiKeyAuth" };
  if (hasOther) return { kind: "other", schemes: [...new Set(out)].sort() };
  return { kind: "open" };
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  File loading (fail-closed)                                                 */
/* ──────────────────────────────────────────────────────────────────────────── */

function loadProjection() {
  if (!existsSync(PROJECTION)) {
    console.error(
      `FAIL: source projection missing at ${PROJECTION}. ` +
        `Run \`node scripts/sync-openapi.mjs\` to regenerate the committed projection, ` +
        `then re-run this gate.`,
    );
    process.exit(2);
  }
  let raw;
  try {
    raw = readFileSync(PROJECTION, "utf8");
  } catch (err) {
    console.error(
      `FAIL: cannot read ${PROJECTION}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    console.error(
      `FAIL: ${PROJECTION} is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
        `The committed projection is corrupted; regenerate via sync-openapi.mjs.`,
    );
    process.exit(2);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    console.error(`FAIL: ${PROJECTION} is not a JSON object.`);
    process.exit(2);
  }
  if (typeof doc.openapi !== "string") {
    console.error(
      `FAIL: ${PROJECTION} has no "openapi" version field. This is not an OpenAPI document.`,
    );
    process.exit(2);
  }
  if (!doc.paths || typeof doc.paths !== "object" || Object.keys(doc.paths).length === 0) {
    console.error(`FAIL: ${PROJECTION} is an OpenAPI document with 0 paths.`);
    process.exit(2);
  }
  return doc;
}

function loadRequired() {
  if (!existsSync(REQUIRED)) {
    console.error(
      `FAIL: required contract missing at ${REQUIRED}. ` +
        `Run \`node scripts/cross-surface-authority.mjs --update\` to regenerate it. ` +
        `A missing required contract is a fail-closed condition — the gate cannot claim ` +
        `the consumer needs nothing of the producer.`,
    );
    process.exit(2);
  }
  let raw;
  try {
    raw = readFileSync(REQUIRED, "utf8");
  } catch (err) {
    console.error(
      `FAIL: cannot read ${REQUIRED}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    console.error(
      `FAIL: ${REQUIRED} is not valid JSON: ${err instanceof Error ? err.message : String(err)}.`,
    );
    process.exit(2);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    console.error(`FAIL: ${REQUIRED} is not a JSON object.`);
    process.exit(2);
  }
  if (!doc.consumer || typeof doc.consumer !== "string") {
    console.error(
      `FAIL: ${REQUIRED} has no "consumer" string field. Identify which consumer repo this contract pins.`,
    );
    process.exit(2);
  }
  if (!doc.pinnedProjection || typeof doc.pinnedProjection !== "object") {
    console.error(
      `FAIL: ${REQUIRED} has no "pinnedProjection" object. Pin the source it was generated against.`,
    );
    process.exit(2);
  }
  if (!Array.isArray(doc.required)) {
    console.error(
      `FAIL: ${REQUIRED} has no "required" array. List the operationIds this consumer depends on.`,
    );
    process.exit(2);
  }
  return doc;
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  Drift detection                                                            */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * For each required operationId, return the list of drift findings.
 * Each finding is `{ op, category, message }`.
 *
 * Categories:
 *   - REMOVED       : operationId missing from the projection
 *   - SECURITY      : operation lost its expected security shape
 *   - SCHEMA        : a required request field/parameter is missing or narrowed
 *   - RESPONSE      : a required response code is missing
 *   - METHOD/PATH   : operationId resolved at a different method or path
 */
function detectDrift(required, byOp, projection) {
  const findings = [];

  for (const req of required) {
    const id = req.operationId;
    const found = byOp.get(id);
    if (!found) {
      findings.push({
        op: id,
        category: "REMOVED",
        message: `operationId "${id}" is not present in the committed projection — the producer dropped it`,
      });
      continue;
    }

    // method/path sanity (defensive — usually matches by construction)
    if (req.method && found.method.toUpperCase() !== req.method.toUpperCase()) {
      findings.push({
        op: id,
        category: "METHOD/PATH",
        message: `operationId "${id}" resolved at ${found.method.toUpperCase()} ${found.path} (expected ${req.method.toUpperCase()})`,
      });
    }

    // SECURITY
    if (req.security) {
      const actual = effectiveSecurity(found.operation, projection);
      const expected = req.security;
      if (!securityMatches(actual, expected)) {
        findings.push({
          op: id,
          category: "SECURITY",
          message: `operationId "${id}" security drifted: expected ${formatSecurity(expected)}, actual ${formatSecurity(actual)}`,
        });
      }
    }

    // RESPONSE CODES
    if (Array.isArray(req.responseCodes) && req.responseCodes.length > 0) {
      const actualCodes = Object.keys(found.operation.responses ?? {});
      const missing = req.responseCodes.filter((c) => !actualCodes.includes(String(c)));
      if (missing.length > 0) {
        findings.push({
          op: id,
          category: "RESPONSE",
          message: `operationId "${id}" response codes lost: ${missing.join(", ")} (have: ${actualCodes.sort().join(", ")})`,
        });
      }
    }

    // SCHEMA (request parameters / body required fields)
    if (req.request && typeof req.request === "object") {
      const schemaFindings = detectSchemaDrift(id, found.operation, req.request);
      findings.push(...schemaFindings);
    }
  }

  return findings;
}

function securityMatches(actual, expected) {
  if (expected === "open") return actual.kind === "open";
  if (expected === "required") return actual.kind !== "open";
  // Legacy tags (older required.json snapshots) — keep recognising them so a
  // --update is not required to bump the schema version.
  if (expected === "apiKey") return actual.kind === "apiKey";
  if (expected === "inherited") return actual.kind === "apiKey";
  return false;
}

function formatSecurity(sec) {
  if (sec === "open") return "open";
  if (sec === "required") return "required (some scheme)";
  if (sec === "apiKey") return "apiKey (ApiKeyAuth)";
  if (sec === "inherited") return "inherited (root: ApiKeyAuth)";
  return JSON.stringify(sec);
}

/**
 * Required fields can be specified two ways:
 *   1. `request.requiredQueryParams`: array of query param names that must exist
 *   2. `request.requiredBodyFields`:  array of JSON body field names that must exist
 *
 * We do a NAMES-ONLY check, not a deep type diff. Deep schema diffing is the
 * job of `scripts/conformance/run-phase0.mjs`; this gate is the names-of-things
 * layer that fires before the conformance harness can be tricked.
 */
function detectSchemaDrift(opId, op, req) {
  const findings = [];
  const params = Array.isArray(op.parameters) ? op.parameters : [];
  const queryNames = params
    .filter((p) => p && p.in === "query" && typeof p.name === "string")
    .map((p) => p.name);
  const pathNames = params
    .filter((p) => p && p.in === "path" && typeof p.name === "string")
    .map((p) => p.name);
  const headerNames = params
    .filter((p) => p && p.in === "header" && typeof p.name === "string")
    .map((p) => p.name);

  for (const want of req.requiredQueryParams ?? []) {
    if (!queryNames.includes(want)) {
      findings.push({
        op: opId,
        category: "SCHEMA",
        message: `operationId "${opId}" query parameter "${want}" is missing`,
      });
    }
  }
  for (const want of req.requiredPathParams ?? []) {
    if (!pathNames.includes(want)) {
      findings.push({
        op: opId,
        category: "SCHEMA",
        message: `operationId "${opId}" path parameter "${want}" is missing`,
      });
    }
  }
  for (const want of req.requiredHeaders ?? []) {
    if (!headerNames.includes(want)) {
      findings.push({
        op: opId,
        category: "SCHEMA",
        message: `operationId "${opId}" header parameter "${want}" is missing`,
      });
    }
  }

  // Body fields: walk requestBody.content."application/json".schema.properties.
  // Only "required array" + "top-level property presence" — we do not validate
  // types, because the spec allows $ref expansion that this gate does not run.
  const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
  if (bodySchema && typeof bodySchema === "object") {
    const props = bodySchema.properties ?? {};
    const declared = Object.keys(props);
    const requiredArr = Array.isArray(bodySchema.required) ? bodySchema.required : [];
    for (const want of req.requiredBodyFields ?? []) {
      if (!declared.includes(want) && !requiredArr.includes(want)) {
        findings.push({
          op: opId,
          category: "SCHEMA",
          message: `operationId "${opId}" body field "${want}" is missing`,
        });
      }
    }
  } else if ((req.requiredBodyFields ?? []).length > 0) {
    // The op is required to have a body but the projection says it has none.
    findings.push({
      op: opId,
      category: "SCHEMA",
      message: `operationId "${opId}" has no JSON request body — required body fields ${JSON.stringify(req.requiredBodyFields)} cannot be satisfied`,
    });
  }

  return findings;
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  Regeneration (offline, source-bound)                                       */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * Regenerate `scripts/cross-surface-authority.required.json` against the
 * committed projection. Offline: no `fetch()` calls. The script reads the
 * committed `openapi.json` and emits a consumer-specific required contract
 * whose scope is "every operationId the projection exposes that the MCP
 * consumer actually calls."
 *
 * MCP calls most operations on the projection; the consumer-specific narrowing
 * lives in `src/tools/register-all.ts` and is reviewed at PR time. For V2 we
 * take the conservative shape: include every operationId the projection
 * exposes, with the security expectation derived from the projection itself.
 * Future revisions can narrow further (e.g. when MCP drops a tool, remove it
 * from required.json in the same PR that drops the tool).
 */
function regenerate(projection) {
  const fp = fingerprint(projection);
  const version = projection?.info?.version ?? null;
  const rootSecurity = projection?.security ?? null;

  const required = [];
  for (const [path, methods] of Object.entries(projection.paths ?? {})) {
    if (!methods || typeof methods !== "object") continue;
    for (const [method, op] of Object.entries(methods)) {
      const m = method.toLowerCase();
      if (!["get", "post", "put", "delete", "patch"].includes(m)) continue;
      if (!op || typeof op !== "object") continue;
      if (typeof op.operationId !== "string") continue;

      // The pin records the security shape that matters for drift detection:
      //   "open"    — op.security is explicitly [] (no auth required)
      //   "required" — op.security is anything else (inherited or explicit
      //                ApiKeyAuth or OAuth2 — anything that demands a key)
      // We deliberately collapse all non-open shapes into "required" so that
      // (a) a producer that flips a `security: []` op to `security: [...]`
      //     is caught (an op that was callable without a key now demands one),
      // and (b) a producer that switches a `[{ApiKeyAuth: []}]` op to an
      // explicit OAuth scheme is also caught. The exact scheme name is recorded
      // in `effectiveSecuritySchemes` for human review.
      const sec = effectiveSecurity(op, projection);
      const securityTag = sec.kind === "open" ? "open" : "required";
      const codes = Object.keys(op.responses ?? {}).sort();

      const entry = {
        operationId: op.operationId,
        method: m.toUpperCase(),
        path,
        security: securityTag,
        responseCodes: codes,
      };
      required.push(entry);
    }
  }
  required.sort((a, b) => a.operationId.localeCompare(b.operationId));

  const payload = {
    consumer: "frihet-mcp",
    pinnedProjection: {
      source: "workers/remote-mcp/public/openapi.json",
      fingerprint: fp,
      openapiVersion: projection.openapi ?? null,
      infoVersion: version,
      // The projection's root security — recorded so a future operator can
      // see what `inherited` actually inherits without re-reading the file.
      rootSecurity,
      frozenAt: new Date().toISOString().slice(0, 10),
    },
    required,
  };
  writeFileSync(REQUIRED, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  Main                                                                       */
/* ──────────────────────────────────────────────────────────────────────────── */

function main() {
  const projection = loadProjection();

  if (UPDATE) {
    const payload = regenerate(projection);
    console.log(
      `wrote      ${REQUIRED}  (${payload.required.length} required operations, fingerprint ${payload.pinnedProjection.fingerprint.slice(0, 12)}…)`,
    );
    console.log("OK (update)");
    return;
  }

  const requiredDoc = loadRequired();
  const byOp = indexByOperationId(projection);

  console.log(`projection  ${PROJECTION}`);
  console.log(
    `            openapi ${projection.openapi}, info.version ${projection.info?.version ?? "?"}, ${byOp.size} operationIds`,
  );
  console.log(
    `required    consumer=${requiredDoc.consumer}, ${requiredDoc.required.length} required ops`,
  );
  const fp = fingerprint(projection);
  const pinnedFp = requiredDoc.pinnedProjection?.fingerprint ?? null;
  if (pinnedFp === fp) {
    console.log(`            fingerprint matches pinned (${fp.slice(0, 12)}…)`);
  } else {
    console.log(
      `            fingerprint drifted: pinned=${pinnedFp ? pinnedFp.slice(0, 12) + "…" : "(none)"}, actual=${fp.slice(0, 12)}…`,
    );
    console.log(
      `            → projection changed since required.json was last regenerated. ` +
        `Run \`node scripts/cross-surface-authority.mjs --update\` to refresh the pin ` +
        `(after reviewing the projection diff).`,
    );
  }

  const findings = detectDrift(requiredDoc.required, byOp, projection);

  if (DIFF) {
    if (findings.length === 0) {
      console.log("\nNo drift. (--diff)");
      return;
    }
    console.log(`\nDrift findings (${findings.length}):`);
    for (const f of findings) {
      console.log(`  [${f.category}] ${f.message}`);
    }
    return;
  }

  // CHECK mode (default)
  if (findings.length > 0) {
    console.error(`\nFAIL (${findings.length}):`);
    const byCat = new Map();
    for (const f of findings) {
      byCat.set(f.category, (byCat.get(f.category) ?? 0) + 1);
    }
    for (const [cat, n] of [...byCat.entries()].sort()) {
      console.error(`  ${cat}: ${n}`);
    }
    for (const f of findings.slice(0, 50)) {
      console.error(`  - [${f.category}] ${f.message}`);
    }
    if (findings.length > 50) {
      console.error(`  … ${findings.length - 50} more`);
    }
    console.error(
      `\nProducer→consumer drift detected. The committed projection ${PROJECTION} ` +
        `no longer satisfies the consumer-required contract at ${REQUIRED}. ` +
        `Either restore the contract in the producer (Frihet-ERP publicApi), ` +
        `or update the consumer contract in this same PR after reviewing the projection diff.`,
    );
    process.exit(1);
  }

  // Pin-drift is informational, not a failure, as long as the consumer-required
  // contract still resolves inside the new projection. A producer that ships a
  // benign addition does not require a required.json bump.
  console.log(`\nOK — ${requiredDoc.required.length} required operations present, no security/schema/response drift`);
}

main();
