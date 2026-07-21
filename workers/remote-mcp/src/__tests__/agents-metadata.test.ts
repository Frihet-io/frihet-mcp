/**
 * Served agent-metadata auth regression (agents.json discovery surface).
 *
 * The `/agents.json` descriptor advertises how AI agents authenticate. The
 * canonical header is `X-API-Key` (matches the live API + openapi ApiKeyAuth
 * securityScheme). The legacy `X-Frihet-API-Key` is NOT read by the API, so
 * advertising it sends agents down a dead path ("API key required"). This test
 * pins the served metadata to the canonical header and forbids the legacy one.
 *
 * Source-level assertion (not an import): index.ts pulls Cloudflare/OAuth/DO
 * modules that don't resolve under the node test runner, so we read the served
 * AGENTS_JSON literal from source instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(__dirname, "..", "index.ts"), "utf8");

test("agents.json apiKey auth advertises the canonical X-API-Key header", () => {
  const m = indexSrc.match(/type:\s*"apiKey"\s*,\s*headerName:\s*"([^"]+)"/);
  assert.ok(m, "apiKey auth entry with a headerName must exist in agents.json");
  assert.equal(m[1], "X-API-Key");
});

test("served agent metadata never references the legacy X-Frihet-API-Key header", () => {
  assert.ok(
    !indexSrc.includes("X-Frihet-API-Key"),
    "legacy X-Frihet-API-Key header must not appear in the served metadata",
  );
});
