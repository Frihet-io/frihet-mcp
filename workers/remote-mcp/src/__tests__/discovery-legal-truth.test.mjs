/**
 * Discovery-artifact truth for the legal URLs and the rate-limit claim (#145).
 *
 * Two independent defects were published by the two Workers that serve
 * discovery blobs:
 *
 *   1. `api.frihet.io/agents.json` advertised `https://www.frihet.io/legal/privacy`
 *      and `/legal/terms`. There has never been a `/legal/*` route on the
 *      website — those two URLs return 404. `/{lang}/legal` exists but is an
 *      LSSI-CE legal notice, a different document, not a hub. This survived
 *      because a bare `curl` gets a 403 from the WAF for every path on that
 *      host, so a default-User-Agent check reports nothing useful either way.
 *
 *   2. Both Workers published `rateLimit: { tier: "pro", requestsPerMinute: 600 }`.
 *      No rate limiter is implemented for mcp.frihet.io in any repo — the Worker
 *      only passes an upstream 429 through. And 600 is the BUSINESS tier of
 *      api.frihet.io (Frihet-ERP unkeyService PLAN_RATE_LIMITS; pro is 300), so
 *      the number promised a pro key twice what it actually gets. An agent paces
 *      its request budget against this blob, which makes an unsupported precise
 *      figure worse than no figure. Owner decision: publish nothing — do NOT
 *      substitute 100, 300 or any other value.
 *
 * Written as plain .mjs, not .ts, on purpose: CI pins Node 20, which has
 * neither `--experimental-strip-types` (Node 22.6+) nor glob arguments to
 * `--test`. A .ts gate here would only ever run on a developer laptop, and an
 * unenforced gate is exactly how a 404 stayed published. The Worker's own
 * `npm test` glob is widened to cover *.test.mjs in the same diff.
 *
 * Source-level assertions, not imports: `index.ts` pulls Cloudflare/OAuth/DO
 * modules that do not resolve under the node test runner, and `server-meta.ts`
 * imports the root package.json plus built `../../../src/*.js`, so neither can
 * be imported here. `agents-metadata.test.ts` established this same pattern for
 * this same blob.
 *
 * The canonical value is read OUT OF `server-meta.ts` rather than hardcoded in
 * this file, so the parity checks compare both Workers against one source. A
 * second hardcoded copy here would just be a third place to drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REMOTE_MCP_SRC = join(__dirname, "..");
const REPO_ROOT = join(REMOTE_MCP_SRC, "..", "..", "..");

const indexSrc = readFileSync(join(REMOTE_MCP_SRC, "index.ts"), "utf8");
const serverMetaSrc = readFileSync(join(REMOTE_MCP_SRC, "server-meta.ts"), "utf8");
const apiProxySrc = readFileSync(
  join(REPO_ROOT, "workers", "api-proxy", "worker.js"),
  "utf8",
);

/** Read an exported string constant out of server-meta.ts source. */
function canonicalConstant(name) {
  const match = serverMetaSrc.match(
    new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`),
  );
  assert.ok(match, `server-meta.ts must export ${name} as a string literal`);
  return match[1];
}

const CANONICAL_PRIVACY = canonicalConstant("LEGAL_PRIVACY_URL");
const CANONICAL_TERMS = canonicalConstant("LEGAL_TERMS_URL");

// --------------------------------------------------------------------------
// 1. /legal/* can never return — those two URLs 404
// --------------------------------------------------------------------------

test("no discovery artifact publishes a /legal/privacy or /legal/terms URL", () => {
  for (const [label, src] of [
    ["remote-mcp/src/index.ts", indexSrc],
    ["api-proxy/worker.js", apiProxySrc],
    ["remote-mcp/src/server-meta.ts", serverMetaSrc],
  ]) {
    assert.ok(
      !/frihet\.io\/legal\/privacy/.test(src),
      `${label} must not publish https://www.frihet.io/legal/privacy (404)`,
    );
    assert.ok(
      !/frihet\.io\/legal\/terms/.test(src),
      `${label} must not publish https://www.frihet.io/legal/terms (404)`,
    );
  }
});

// --------------------------------------------------------------------------
// 2. /en/* cannot drift back onto these blobs
// --------------------------------------------------------------------------

test("no discovery artifact drifts back to the /en/ legal locale", () => {
  for (const [label, src] of [
    ["remote-mcp/src/index.ts", indexSrc],
    ["api-proxy/worker.js", apiProxySrc],
    ["remote-mcp/src/server-meta.ts", serverMetaSrc],
  ]) {
    assert.ok(
      !/frihet\.io\/en\/privacy/.test(src),
      `${label} must not publish the /en/ privacy locale (canonical is /es/)`,
    );
    assert.ok(
      !/frihet\.io\/en\/terms/.test(src),
      `${label} must not publish the /en/ terms locale (canonical is /es/)`,
    );
  }
});

// --------------------------------------------------------------------------
// 3. canonical /es/privacy + /es/terms
// --------------------------------------------------------------------------

test("server-meta publishes the canonical /es/ legal URLs", () => {
  assert.equal(CANONICAL_PRIVACY, "https://www.frihet.io/es/privacy");
  assert.equal(CANONICAL_TERMS, "https://www.frihet.io/es/terms");
});

test("both remote-mcp agents.json blobs source their legal URLs from the constants", () => {
  // Two blobs: the default host and the OpenAI-scoped host. Both must read the
  // shared constants — a literal in either one is how the fleet drifted.
  const legalBlocks = indexSrc.match(
    /legal:\s*\{\s*privacyPolicy:\s*([^,]+),\s*termsOfService:\s*([^,]+),?\s*\}/g,
  );
  assert.ok(legalBlocks, "index.ts must contain legal blocks");
  assert.equal(legalBlocks.length, 2, "expected exactly 2 legal blocks (default + OpenAI host)");
  for (const block of legalBlocks) {
    assert.match(block, /privacyPolicy:\s*LEGAL_PRIVACY_URL/);
    assert.match(block, /termsOfService:\s*LEGAL_TERMS_URL/);
  }
});

test("both remote-mcp ai.txt License lines source the canonical terms constant", () => {
  const licenseLines = indexSrc.match(/^License: .*$/gm);
  assert.ok(licenseLines, "index.ts must contain ai.txt License lines");
  assert.equal(licenseLines.length, 2, "expected 2 License lines (default + OpenAI ai.txt)");
  for (const line of licenseLines) {
    assert.equal(line, "License: ${LEGAL_TERMS_URL}");
  }
});

// --------------------------------------------------------------------------
// 4. no rateLimit structural field
// --------------------------------------------------------------------------

test("no discovery blob declares a structural rateLimit field", () => {
  for (const [label, src] of [
    ["remote-mcp/src/index.ts", indexSrc],
    ["api-proxy/worker.js", apiProxySrc],
  ]) {
    // Matches `rateLimit: {` on either Worker, in block or inline form.
    assert.ok(
      !/(^|[\s,{])rateLimit\s*:/.test(src),
      `${label} must not declare a rateLimit field in a discovery blob`,
    );
  }
});

// --------------------------------------------------------------------------
// 5. no 600 / pro rate figure in discovery prose either
// --------------------------------------------------------------------------

test("no discovery artifact carries the unenforced 600/pro rate claim", () => {
  for (const [label, src] of [
    ["remote-mcp/src/index.ts", indexSrc],
    ["api-proxy/worker.js", apiProxySrc],
  ]) {
    assert.ok(
      !/requestsPerMinute/i.test(src),
      `${label} must not carry a requestsPerMinute figure`,
    );
    // The field could come back under another name, or as prose in llms.txt /
    // ai.txt / a tool description. Catch a rate figure written out in words.
    assert.doesNotMatch(
      src,
      /\d+\s*(?:req|requests?|calls?)\s*(?:\/|\s+per\s+)\s*(?:min|minute|sec|second|hour)/i,
      `${label} must not state a rate limit in prose`,
    );
    // `tier: "pro"` was the second half of the false claim.
    assert.doesNotMatch(
      src,
      /tier\s*:\s*["']pro["']/i,
      `${label} must not advertise a "pro" rate tier`,
    );
  }
});

// --------------------------------------------------------------------------
// 6. api-proxy + remote-mcp parity, keyed to the single canonical source
// --------------------------------------------------------------------------

test("api-proxy publishes exactly the canonical legal URLs from server-meta", () => {
  // api-proxy is a standalone Worker with no bundler, so it cannot import the
  // constants. This is the mechanism that keeps its literals honest.
  assert.ok(
    apiProxySrc.includes(`privacyPolicy: "${CANONICAL_PRIVACY}"`),
    `api-proxy must publish privacyPolicy ${CANONICAL_PRIVACY}`,
  );
  assert.ok(
    apiProxySrc.includes(`termsOfService: "${CANONICAL_TERMS}"`),
    `api-proxy must publish termsOfService ${CANONICAL_TERMS}`,
  );
});

test("api-proxy ai.txt License uses the canonical terms URL", () => {
  const licenseLines = apiProxySrc.match(/^License: .*$/gm);
  assert.ok(licenseLines, "api-proxy must contain an ai.txt License line");
  for (const line of licenseLines) {
    assert.equal(line, `License: ${CANONICAL_TERMS}`);
  }
});

test("both Workers agree on the legal locale — no split fleet", () => {
  // The defect that produced #145 was three hosts disagreeing. Assert the
  // agreement directly rather than only asserting each side separately.
  const locale = (url) => url.match(/frihet\.io\/([a-z-]+)\//)?.[1];
  const proxyPrivacy = apiProxySrc.match(/privacyPolicy:\s*"([^"]+)"/)?.[1];
  const proxyTerms = apiProxySrc.match(/termsOfService:\s*"([^"]+)"/)?.[1];
  assert.ok(proxyPrivacy && proxyTerms, "api-proxy must publish both legal URLs");
  assert.equal(locale(proxyPrivacy), locale(CANONICAL_PRIVACY));
  assert.equal(locale(proxyTerms), locale(CANONICAL_TERMS));
  assert.equal(locale(CANONICAL_PRIVACY), "es");
});
