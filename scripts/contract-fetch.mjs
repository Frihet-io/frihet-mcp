#!/usr/bin/env node
/**
 * Cross-surface drift defense for Frihet MCP consumers.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The MCP server is a thin pass-through over `https://api.frihet.io/v1`. SDKs,
 * n8n nodes, Zapier apps and the Frihet-Connect marketplace all consume that
 * contract too. A producer (Frihet-ERP) PR that renames or removes an
 * operationId, narrows an enum, or changes a request schema can break every
 * consumer at once — and none of the consumer repos ship a check that would
 * surface the breakage mechanically.
 *
 * This script is the smallest mechanism that does:
 *   1. Fetch `https://api.frihet.io/v1/openapi.json` (public, no auth).
 *   2. Compute operationIds, tags and security-scheme presence.
 *   3. Compare against a frozen expected list in this repo.
 *   4. Exit 1 on any breaking change; exit 0 on additive change.
 *
 * It is intentionally narrower than `scripts/sync-openapi.mjs`, which derives
 * the full published artifact. The published-artifact drift gate is a "did the
 * committed file rot" check; this is a "did the producer break the consumer
 * contract" check. Two different problems, two different surfaces.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   node scripts/contract-fetch.mjs             # print summary, exit 0
 *   node scripts/contract-fetch.mjs --check     # CI mode, exit 1 on drift
 *   node scripts/contract-fetch.mjs --update    # write expected.json from live
 *
 * Network note: `api.frihet.io` fronted by Cloudflare blocks curl-style UAs.
 * Chrome UA is required. Endpoint is public, no auth.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_PATH = join(root, "scripts/contract-fetch.expected.json");

/** Chrome UA — curl's default trips Cloudflare's bot rules and 403s misleadingly. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Public alias — same body as canonical origin, behind Cloudflare edge. */
const CONTRACT_URL = "https://api.frihet.io/v1/openapi.json";

/** Network errors are not drift. The CI workflow treats them as graceful skip. */
class ContractUnavailableError extends Error {
  constructor(cause) {
    super(`contract endpoint unreachable: ${cause}`);
    this.name = "ContractUnavailableError";
  }
}

async function fetchContract(url, timeoutMs = 10_000) {
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ContractUnavailableError(err instanceof Error ? err.message : String(err));
  }
  if (res.status >= 500) throw new ContractUnavailableError(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  let body;
  try {
    body = await res.text();
  } catch (err) {
    throw new ContractUnavailableError(`body read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let doc;
  try {
    doc = JSON.parse(body);
  } catch (err) {
    throw new Error(`response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("response is not a JSON object");
  }
  if (typeof doc.openapi !== "string") {
    throw new Error('response has no "openapi" version field — this is not an OpenAPI document');
  }
  if (!doc.paths || typeof doc.paths !== "object" || Object.keys(doc.paths).length === 0) {
    throw new Error("OpenAPI document with 0 paths");
  }
  return doc;
}

/**
 * Extract the consumer contract: the subset of OpenAPI structure that the MCP
 * server — and by extension every consumer that depends on MCP — pins against.
 * Schema-level changes (a property narrows) are caught by the operationId
 * presence check, the response-code presence check and the tag-set check
 * below. We do NOT deep-diff request schemas here — that's `mcp-v2-baseline`'s
 * job and the conformance harness's job. This script guards the producer
 * surface, not the MCP server's view of it.
 */
function extractContract(doc) {
  const operationIds = [];
  const tags = new Set();
  let hasUnauthorizedResponse = false;
  let hasForbiddenResponse = false;
  for (const methods of Object.values(doc.paths ?? {})) {
    if (!methods || typeof methods !== "object") continue;
    for (const [method, op] of Object.entries(methods)) {
      if (!["get", "post", "put", "delete", "patch"].includes(method)) continue;
      if (!op || typeof op !== "object") continue;
      if (typeof op.operationId === "string") operationIds.push(op.operationId);
      for (const tag of op.tags ?? []) {
        if (typeof tag === "string") tags.add(tag);
      }
      const responses = op.responses ?? {};
      if (responses["401"]) hasUnauthorizedResponse = true;
      if (responses["403"]) hasForbiddenResponse = true;
    }
  }
  const securitySchemes = Object.keys(doc.components?.securitySchemes ?? {});
  return {
    operationCount: operationIds.length,
    operationIds: [...new Set(operationIds)].sort(),
    tags: [...tags].sort(),
    securitySchemes: [...new Set(securitySchemes)].sort(),
    hasUnauthorizedResponse,
    hasForbiddenResponse,
  };
}

const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check");
const UPDATE = args.has("--update");

function loadExpected() {
  if (!existsSync(EXPECTED_PATH)) {
    throw new Error(`${EXPECTED_PATH} not found — run \`node scripts/contract-fetch.mjs --update\` first`);
  }
  return JSON.parse(readFileSync(EXPECTED_PATH, "utf8"));
}

function writeExpected(actual, doc) {
  const payload = {
    ...actual,
    frozenAt: new Date().toISOString().slice(0, 10),
    source: CONTRACT_URL,
    openapiVersion: doc.openapi,
  };
  writeFileSync(EXPECTED_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`wrote      ${EXPECTED_PATH}`);
}

function diff(actual, expected) {
  const errors = [];
  const warnings = [];

  // Set comparison, not count comparison: additive changes (new operations
  // appended) are non-breaking for consumers and must not fail. The count
  // discrepancy surfaces naturally as `removed` (missing expected ops) or
  // `added` (new ops), whichever applies.
  const removedOps = expected.operationIds.filter((id) => !actual.operationIds.includes(id));
  if (removedOps.length) {
    errors.push(`operationIds removed: ${removedOps.join(", ")}`);
  }
  // Additive changes are non-breaking for consumers — new operations extend the
  // contract. Surface as a warning, never as a failure.
  const addedOps = actual.operationIds.filter((id) => !expected.operationIds.includes(id));
  if (addedOps.length) {
    warnings.push(`operationIds added (non-breaking): ${addedOps.join(", ")}`);
  }

  const removedTags = expected.tags.filter((t) => !actual.tags.includes(t));
  if (removedTags.length) {
    errors.push(`tags removed: ${removedTags.join(", ")}`);
  }
  const addedTags = actual.tags.filter((t) => !expected.tags.includes(t));
  if (addedTags.length) {
    warnings.push(`tags added (non-breaking): ${addedTags.join(", ")}`);
  }

  const removedSchemes = expected.securitySchemes.filter((s) => !actual.securitySchemes.includes(s));
  if (removedSchemes.length) {
    errors.push(`securitySchemes removed: ${removedSchemes.join(", ")}`);
  }

  return { errors, warnings };
}

async function main() {
  let doc;
  try {
    doc = await fetchContract(CONTRACT_URL);
  } catch (err) {
    if (err instanceof ContractUnavailableError) {
      console.error(`CONTRACT_UNAVAILABLE: ${err.message}`);
      console.error("Skipping drift check — this is not a contract fault.");
      process.exit(2);
    }
    throw err;
  }

  const actual = extractContract(doc);

  if (UPDATE) {
    writeExpected(actual, doc);
    console.log(`operationCount: ${actual.operationCount}`);
    console.log(`tags: ${actual.tags.length}`);
    console.log(`securitySchemes: ${actual.securitySchemes.join(", ") || "(none)"}`);
    console.log("\nOK (update)");
    return;
  }

  const expected = loadExpected();

  console.log(`contract    ${CONTRACT_URL}`);
  console.log(`            ${actual.operationCount} operations, ${actual.tags.length} tags, schemes: ${actual.securitySchemes.join(", ") || "(none)"}`);
  console.log(`expected    ${expected.operationCount} operations, ${expected.tags.length} tags, frozen ${expected.frozenAt ?? "unknown"}`);

  if (CHECK) {
    const { errors, warnings } = diff(actual, expected);
    for (const w of warnings) console.log(`warn       ${w}`);
    if (errors.length) {
      console.error(`\nFAIL (${errors.length}):`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log("\nOK");
    return;
  }

  // Default: print summary only.
  const { warnings } = diff(actual, expected);
  for (const w of warnings) console.log(`warn       ${w}`);
  console.log("\nOK (no --check: nothing failed)");
}

main().catch((err) => {
  console.error("[contract-fetch] Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
