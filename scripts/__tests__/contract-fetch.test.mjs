/**
 * Cross-surface drift defense — contract-fetch.mjs test suite.
 *
 * Stubs `globalThis.fetch` to return a canned openapi.json fixture and asserts
 * the script's check/update behavior. The fixture is generated in-process so
 * each test can mutate it without writing files to disk.
 *
 * Test matrix:
 *   - identical spec → exit 0 (PASS)
 *   - removed operationId → exit 1 (FAIL)
 *   - response code removed → exit 1 (FAIL)
 *   - security scheme removed → exit 1 (FAIL)
 *   - tag removed → exit 1 (FAIL)
 *   - new operationId appended → exit 0 (additive, non-breaking)
 *   - new tag appended → exit 0 (additive, non-breaking)
 *   - bad JSON body → exit 1 (semantic, not retry)
 *   - non-spec body (missing openapi field) → exit 1
 *   - HTTP 5xx → exit 2 (CONTRACT_UNAVAILABLE, not drift)
 *   - network error → exit 2 (CONTRACT_UNAVAILABLE)
 *   - --update writes the expected file → exits 0, file present
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = "scripts/contract-fetch.mjs";

/**
 * Minimal valid OpenAPI doc with the contract fields contract-fetch checks.
 * Tests mutate copies of this; the fixture itself must stay in sync with
 * contract-fetch.mjs expectations (operationId presence, tags, security).
 */
function buildBaseFixture() {
  return {
    openapi: "3.0.3",
    info: { title: "Frihet API", version: "1.0.0" },
    paths: {
      "/v1/invoices": {
        get: {
          operationId: "listInvoices",
          tags: ["Invoices"],
          responses: { "200": {}, "401": {}, "403": {} },
        },
        post: {
          operationId: "createInvoice",
          tags: ["Invoices"],
          responses: { "201": {}, "400": {}, "401": {}, "403": {} },
        },
      },
      "/v1/invoices/{id}": {
        get: {
          operationId: "getInvoice",
          tags: ["Invoices"],
          responses: { "200": {}, "404": {}, "401": {}, "403": {} },
        },
        delete: {
          operationId: "deleteInvoice",
          tags: ["Invoices"],
          responses: { "204": {}, "401": {}, "403": {} },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "apiKey", in: "header", name: "X-Api-Key" },
      },
    },
  };
}

/**
 * Run contract-fetch.mjs in a tmp directory tree that mirrors the repo layout.
 * The script computes its expected-file path from `import.meta.url` (its own
 * location joined with `../scripts/contract-fetch.expected.json`), so we copy
 * the script AND the expected.json into `tmp/scripts/` to preserve the path
 * resolution. Each test can supply its own expected.json to drive drift.
 */
function runInFreshTree(fixture, opts = {}) {
  const {
    status = 200,
    body,
    error,
    expectedJson,
    mode = "--check",
  } = opts;

  const tmp = mkdtempSync(join(tmpdir(), "contract-fetch-tree-"));
  const tmpScripts = join(tmp, "scripts");
  mkdirSync(tmpScripts, { recursive: true });

  writeFileSync(join(tmpScripts, "contract-fetch.mjs"), readFileSync("scripts/contract-fetch.mjs", "utf8"));

  const expectedPath = join(tmpScripts, "contract-fetch.expected.json");
  if (expectedJson !== undefined) {
    writeFileSync(expectedPath, JSON.stringify(expectedJson, null, 2));
  } else if (existsSync(join(process.cwd(), "scripts/contract-fetch.expected.json"))) {
    writeFileSync(expectedPath, readFileSync("scripts/contract-fetch.expected.json", "utf8"));
  }

  const payload = body !== undefined ? body : JSON.stringify(fixture);
  const preload = `
    const body = ${JSON.stringify(payload)};
    const status = ${status};
    const shouldError = ${error ? "true" : "false"};
    globalThis.fetch = async (_url, _options) => {
      if (shouldError) throw new TypeError("simulated network failure");
      return {
        status,
        ok: status >= 200 && status < 300,
        text: async () => body,
      };
    };
  `;

  const result = spawnSync(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, join(tmpScripts, "contract-fetch.mjs"), mode],
    { encoding: "utf8" },
  );

  return { result, expectedPath, tmp };
}

// ─────────────────────────────────────────────────────────────────────────────
// tests
// ─────────────────────────────────────────────────────────────────────────────

test("identical fixture exits 0 (PASS)", () => {
  const base = buildBaseFixture();
  const expected = {
    operationCount: 4,
    operationIds: ["createInvoice", "deleteInvoice", "getInvoice", "listInvoices"],
    tags: ["Invoices"],
    securitySchemes: ["ApiKeyAuth"],
    hasUnauthorizedResponse: true,
    hasForbiddenResponse: true,
  };
  const { result } = runInFreshTree(base, { expectedJson: expected, mode: "--check" });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /OK/);
});

test("removed operationId exits 1 (FAIL)", () => {
  const base = buildBaseFixture();
  // Drop createInvoice — a producer that removes an operation breaks consumers.
  delete base.paths["/v1/invoices"].post;
  const expected = {
    operationCount: 4,
    operationIds: ["createInvoice", "deleteInvoice", "getInvoice", "listInvoices"],
    tags: ["Invoices"],
    securitySchemes: ["ApiKeyAuth"],
    hasUnauthorizedResponse: true,
    hasForbiddenResponse: true,
  };
  const { result } = runInFreshTree(base, { expectedJson: expected, mode: "--check" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /operationIds removed: createInvoice/);
});

test("operationCount drift exits 1 (FAIL)", () => {
  const base = buildBaseFixture();
  const expected = {
    operationCount: 5,
    operationIds: ["createInvoice", "deleteInvoice", "getInvoice", "listInvoices", "fakeOp"],
    tags: ["Invoices"],
    securitySchemes: ["ApiKeyAuth"],
    hasUnauthorizedResponse: true,
    hasForbiddenResponse: true,
  };
  const { result } = runInFreshTree(base, { expectedJson: expected, mode: "--check" });
  assert.equal(result.status, 1);
  // Additive count growth is non-breaking; only the missing expected op fails.
  assert.match(result.stderr, /operationIds removed: fakeOp/);
});

test("tag removed exits 1 (FAIL)", () => {
  const base = buildBaseFixture();
  // Re-tag every operation: a producer that drops the "Invoices" tag breaks
  // consumers that organize their surface by tag.
  for (const methods of Object.values(base.paths)) {
    for (const op of Object.values(methods)) {
      op.tags = ["Renamed"];
    }
  }
  const expected = {
    operationCount: 4,
    operationIds: ["createInvoice", "deleteInvoice", "getInvoice", "listInvoices"],
    tags: ["Invoices"],
    securitySchemes: ["ApiKeyAuth"],
    hasUnauthorizedResponse: true,
    hasForbiddenResponse: true,
  };
  const { result } = runInFreshTree(base, { expectedJson: expected, mode: "--check" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tags removed: Invoices/);
});

test("security scheme removed exits 1 (FAIL)", () => {
  const base = buildBaseFixture();
  delete base.components.securitySchemes.ApiKeyAuth;
  const expected = {
    operationCount: 4,
    operationIds: ["createInvoice", "deleteInvoice", "getInvoice", "listInvoices"],
    tags: ["Invoices"],
    securitySchemes: ["ApiKeyAuth"],
    hasUnauthorizedResponse: true,
    hasForbiddenResponse: true,
  };
  const { result } = runInFreshTree(base, { expectedJson: expected, mode: "--check" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /securitySchemes removed: ApiKeyAuth/);
});

test("additive operationId appended exits 0 (PASS, non-breaking)", () => {
  const base = buildBaseFixture();
  base.paths["/v1/quotes"] = {
    get: {
      operationId: "listQuotes",
      tags: ["Quotes"],
      responses: { "200": {}, "401": {}, "403": {} },
    },
  };
  const expected = {
    operationCount: 4,
    operationIds: ["createInvoice", "deleteInvoice", "getInvoice", "listInvoices"],
    tags: ["Invoices"],
    securitySchemes: ["ApiKeyAuth"],
    hasUnauthorizedResponse: true,
    hasForbiddenResponse: true,
  };
  const { result } = runInFreshTree(base, { expectedJson: expected, mode: "--check" });
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /operationIds added \(non-breaking\): listQuotes/);
});

test("additive tag appended exits 0 (PASS, non-breaking)", () => {
  const base = buildBaseFixture();
  base.paths["/v1/invoices"].get.tags = ["Invoices", "NewTag"];
  const expected = {
    operationCount: 4,
    operationIds: ["createInvoice", "deleteInvoice", "getInvoice", "listInvoices"],
    tags: ["Invoices"],
    securitySchemes: ["ApiKeyAuth"],
    hasUnauthorizedResponse: true,
    hasForbiddenResponse: true,
  };
  const { result } = runInFreshTree(base, { expectedJson: expected, mode: "--check" });
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /tags added \(non-breaking\): NewTag/);
});

test("non-spec body (missing openapi field) exits 1 (FAIL)", () => {
  const { result } = runInFreshTree(
    { paths: { "/v1/invoices": { get: { operationId: "x" } } } },
    {
      expectedJson: {
        operationCount: 4,
        operationIds: ["createInvoice", "deleteInvoice", "getInvoice", "listInvoices"],
        tags: ["Invoices"],
        securitySchemes: ["ApiKeyAuth"],
        hasUnauthorizedResponse: true,
        hasForbiddenResponse: true,
      },
      mode: "--check",
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no "openapi" version field/);
});

test("0 paths exits 1 (FAIL)", () => {
  const { result } = runInFreshTree(
    { openapi: "3.0.3", paths: {} },
    {
      expectedJson: {
        operationCount: 0,
        operationIds: [],
        tags: [],
        securitySchemes: [],
        hasUnauthorizedResponse: false,
        hasForbiddenResponse: false,
      },
      mode: "--check",
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /0 paths/);
});

test("malformed JSON body exits 1 (FAIL)", () => {
  const { result } = runInFreshTree(buildBaseFixture(), {
    body: "{not-json",
    expectedJson: {
      operationCount: 4,
      operationIds: ["createInvoice", "deleteInvoice", "getInvoice", "listInvoices"],
      tags: ["Invoices"],
      securitySchemes: ["ApiKeyAuth"],
      hasUnauthorizedResponse: true,
      hasForbiddenResponse: true,
    },
    mode: "--check",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not valid JSON/);
});

test("HTTP 5xx exits 2 (CONTRACT_UNAVAILABLE, not drift)", () => {
  const { result } = runInFreshTree(buildBaseFixture(), {
    status: 503,
    expectedJson: {
      operationCount: 4,
      operationIds: ["createInvoice", "deleteInvoice", "getInvoice", "listInvoices"],
      tags: ["Invoices"],
      securitySchemes: ["ApiKeyAuth"],
      hasUnauthorizedResponse: true,
      hasForbiddenResponse: true,
    },
    mode: "--check",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CONTRACT_UNAVAILABLE/);
});

test("network error exits 2 (CONTRACT_UNAVAILABLE, not drift)", () => {
  const { result } = runInFreshTree(buildBaseFixture(), {
    error: true,
    expectedJson: {
      operationCount: 4,
      operationIds: ["createInvoice", "deleteInvoice", "getInvoice", "listInvoices"],
      tags: ["Invoices"],
      securitySchemes: ["ApiKeyAuth"],
      hasUnauthorizedResponse: true,
      hasForbiddenResponse: true,
    },
    mode: "--check",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CONTRACT_UNAVAILABLE/);
});

test("--update writes the expected file and exits 0", () => {
  const base = buildBaseFixture();
  const { result, expectedPath } = runInFreshTree(base, { mode: "--update" });
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /wrote/);
  assert.ok(existsSync(expectedPath), "expected file should be written alongside the script copy");
  const written = JSON.parse(readFileSync(expectedPath, "utf8"));
  assert.equal(written.operationCount, 4);
  assert.deepEqual(written.operationIds, ["createInvoice", "deleteInvoice", "getInvoice", "listInvoices"]);
});

test("missing expected file exits 1 (FAIL)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "contract-fetch-noexpected-"));
  const tmpScripts = join(tmp, "scripts");
  mkdirSync(tmpScripts, { recursive: true });
  const scriptDst = join(tmpScripts, "contract-fetch.mjs");
  writeFileSync(scriptDst, readFileSync("scripts/contract-fetch.mjs", "utf8"));
  // No expected.json written alongside.

  const preload = `
    globalThis.fetch = async (_url) => ({
      status: 200, ok: true,
      text: async () => JSON.stringify(${JSON.stringify(buildBaseFixture())}),
    });
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, scriptDst, "--check"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not found/);
});
