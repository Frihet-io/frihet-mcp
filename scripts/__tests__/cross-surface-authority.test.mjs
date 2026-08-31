/**
 * Cross-surface contract authority (V2) — test suite.
 *
 * Pins the OFFLINE, FAIL-CLOSED semantics of scripts/cross-surface-authority.mjs.
 * The previous contract-fetch.mjs was a live HTTP check with graceful network
 * skip — V2 has no `fetch()` call and no skip path.
 *
 * Test matrix:
 *   - identical projection+required → exit 0 (PASS)
 *   - REMOVED: required op missing from projection → exit 1
 *   - SECURITY: required op lost its auth shape → exit 1
 *   - RESPONSE: required op lost a response code → exit 1
 *   - SCHEMA: required op lost a query parameter → exit 1
 *   - SCHEMA: required op lost a body field → exit 1
 *   - missing required.json → exit 2 (UNAVAILABLE, fail-closed)
 *   - missing source projection → exit 2 (UNAVAILABLE, fail-closed)
 *   - malformed projection JSON → exit 2 (UNAVAILABLE, fail-closed)
 *   - malformed required.json JSON → exit 2 (UNAVAILABLE, fail-closed)
 *   - projection missing openapi version → exit 2 (UNAVAILABLE)
 *   - projection with 0 paths → exit 2 (UNAVAILABLE)
 *   - --update regenerates required.json against a fixture → file present, fingerprint set
 *   - --diff reports drift without failing
 *   - never calls fetch() in --check (proven by simulating network failure)
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = "scripts/cross-surface-authority.mjs";

/**
 * The script resolves its source paths via `import.meta.url` joined with
 * `../../`. To exercise it against a fixture we must mirror the layout:
 * a tmp tree with `scripts/cross-surface-authority.mjs`, the required.json
 * it expects to find next to itself, and `workers/remote-mcp/public/openapi.json`
 * two directories up.
 */
function buildTree({ projection, requiredJson, omit } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "cross-surface-authority-"));
  const tmpScripts = join(tmp, "scripts");
  mkdirSync(tmpScripts, { recursive: true });
  mkdirSync(join(tmp, "workers/remote-mcp/public"), { recursive: true });

  // Copy the real script (we are not testing its own parse, only its drift behaviour).
  writeFileSync(
    join(tmpScripts, "cross-surface-authority.mjs"),
    readFileSync(SCRIPT, "utf8"),
  );

  if (!omit?.projection) {
    writeFileSync(
      join(tmp, "workers/remote-mcp/public/openapi.json"),
      typeof projection === "string"
        ? projection
        : JSON.stringify(projection ?? buildBaseProjection(), null, 2),
    );
  }
  if (!omit?.requiredJson) {
    const requiredPath = join(tmpScripts, "cross-surface-authority.required.json");
    writeFileSync(
      requiredPath,
      typeof requiredJson === "string"
        ? requiredJson
        : JSON.stringify(
            requiredJson ?? requiredForProjection(buildBaseProjection()),
            null,
            2,
          ),
    );
  }
  return tmp;
}

/**
 * A minimal valid OpenAPI document with the elements the gate inspects:
 * paths with operationIds, parameters, request bodies, security (root + per-op),
 * responses.
 */
function buildBaseProjection() {
  return {
    openapi: "3.1.0",
    info: { title: "Frihet API Test", version: "test-1" },
    security: [{ ApiKeyAuth: [] }],
    paths: {
      "/v1/invoices": {
        get: {
          operationId: "listInvoices",
          tags: ["Invoices"],
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer" } },
            { name: "offset", in: "query", schema: { type: "integer" } },
          ],
          responses: { "200": {}, "400": {}, "401": {}, "429": {}, "500": {} },
        },
        post: {
          operationId: "createInvoice",
          tags: ["Invoices"],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["clientId", "items"],
                  properties: {
                    clientId: { type: "string" },
                    items: { type: "array" },
                  },
                },
              },
            },
          },
          responses: { "201": {}, "400": {}, "401": {}, "429": {}, "500": {} },
        },
      },
      "/v1/invoices/{id}": {
        get: {
          operationId: "getInvoice",
          tags: ["Invoices"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": {}, "404": {}, "401": {}, "429": {}, "500": {} },
        },
      },
      "/v1/search/global": {
        get: {
          operationId: "globalSearch",
          tags: ["Search"],
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer" } },
          ],
          responses: { "200": {}, "400": {}, "401": {}, "429": {}, "500": {} },
        },
      },
      "/v1/webhooks/inbound": {
        post: {
          operationId: "resendInbound",
          tags: ["Webhooks"],
          security: [],
          responses: { "202": {}, "400": {}, "500": {} },
        },
      },
    },
    components: {
      securitySchemes: { ApiKeyAuth: { type: "apiKey", in: "header", name: "X-Api-Key" } },
    },
  };
}

/**
 * Build the minimal required contract that the gate expects, derived from a
 * projection. Mirrors what `scripts/cross-surface-authority.mjs --update` does.
 */
function requiredForProjection(projection) {
  const required = [];
  for (const [path, methods] of Object.entries(projection.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (typeof op !== "object" || typeof op.operationId !== "string") continue;
      const m = method.toLowerCase();
      if (!["get", "post", "put", "delete", "patch"].includes(m)) continue;
      const sec = op.security;
      const security = Array.isArray(sec) && sec.length === 0 ? "open" : "required";
      const codes = Object.keys(op.responses ?? {}).sort();
      required.push({
        operationId: op.operationId,
        method: m.toUpperCase(),
        path,
        security,
        responseCodes: codes,
      });
    }
  }
  required.sort((a, b) => a.operationId.localeCompare(b.operationId));
  return {
    consumer: "test-consumer",
    pinnedProjection: { fingerprint: "test", source: "workers/remote-mcp/public/openapi.json" },
    required,
  };
}

function runInTree(tree, mode = "--check") {
  const scriptPath = join(tree, "scripts/cross-surface-authority.mjs");
  return spawnSync(process.execPath, [scriptPath, mode], { encoding: "utf8" });
}

// ─────────────────────────────────────────────────────────────────────────────
// tests
// ─────────────────────────────────────────────────────────────────────────────

test("identical projection+required exits 0 (PASS)", () => {
  const projection = buildBaseProjection();
  const tree = buildTree({ projection, requiredJson: requiredForProjection(projection) });
  const result = runInTree(tree);
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /OK — 5 required operations present/);
});

test("REMOVED: required operationId missing from projection → exit 1", () => {
  const projection = buildBaseProjection();
  const required = requiredForProjection(projection);
  required.required.push({
    operationId: "fakeRemovedOp",
    method: "GET",
    path: "/v1/nope",
    security: "open",
    responseCodes: ["200"],
  });
  const tree = buildTree({ projection, requiredJson: required });
  const result = runInTree(tree);
  assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /REMOVED.*fakeRemovedOp/);
});

test("SECURITY: required op lost its auth → exit 1", () => {
  const projection = buildBaseProjection();
  // Producer flipped resendInbound from open to required — consumer that depended
  // on the open shape would break (an inbound webhook now demands a key).
  projection.paths["/v1/webhooks/inbound"].post.security = [{ ApiKeyAuth: [] }];
  const required = requiredForProjection(projection);
  // The generator would have produced "required" — for the test, we hand-write
  // "open" to simulate a consumer contract that was pinned when it was open.
  for (const r of required.required) {
    if (r.operationId === "resendInbound") r.security = "open";
  }
  const tree = buildTree({ projection, requiredJson: required });
  const result = runInTree(tree);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SECURITY.*resendInbound/);
});

test("RESPONSE: required op lost a response code → exit 1", () => {
  const projection = buildBaseProjection();
  delete projection.paths["/v1/invoices"].get.responses["400"];
  const required = requiredForProjection(projection);
  // Generator would have dropped 400 — pin it in the contract to simulate
  // a consumer that depends on it.
  for (const r of required.required) {
    if (r.operationId === "listInvoices") r.responseCodes.push("400");
  }
  const tree = buildTree({ projection, requiredJson: required });
  const result = runInTree(tree);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RESPONSE.*listInvoices.*400/);
});

test("SCHEMA: required query parameter missing → exit 1", () => {
  const projection = buildBaseProjection();
  projection.paths["/v1/search/global"].get.parameters = projection.paths[
    "/v1/search/global"
  ].get.parameters.filter((p) => p.name !== "q");
  const required = requiredForProjection(projection);
  for (const r of required.required) {
    if (r.operationId === "globalSearch") {
      r.request = { requiredQueryParams: ["q"] };
    }
  }
  const tree = buildTree({ projection, requiredJson: required });
  const result = runInTree(tree);
  assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /SCHEMA.*globalSearch.*q/);
});

test("SCHEMA: required body field missing → exit 1", () => {
  const projection = buildBaseProjection();
  // Producer narrowed createInvoice body to drop required clientId.
  projection.paths["/v1/invoices"].post.requestBody.content["application/json"].schema.required =
    ["items"];
  delete projection.paths["/v1/invoices"].post.requestBody.content["application/json"].schema
    .properties.clientId;
  const required = requiredForProjection(projection);
  for (const r of required.required) {
    if (r.operationId === "createInvoice") {
      r.request = { requiredBodyFields: ["clientId"] };
    }
  }
  const tree = buildTree({ projection, requiredJson: required });
  const result = runInTree(tree);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SCHEMA.*createInvoice.*clientId/);
});

test("missing required.json fails closed (exit 2, not graceful skip)", () => {
  const projection = buildBaseProjection();
  const tree = buildTree({ projection, omit: { requiredJson: true } });
  const result = runInTree(tree);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /required contract missing/);
  assert.doesNotMatch(result.stderr, /graceful skip/i);
});

test("missing source projection fails closed (exit 2)", () => {
  const tree = buildTree({ omit: { projection: true } });
  const result = runInTree(tree);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /source projection missing/);
});

test("malformed projection JSON fails closed (exit 2)", () => {
  const tree = buildTree({ projection: "{not-json", requiredJson: requiredForProjection(buildBaseProjection()) });
  const result = runInTree(tree);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not valid JSON/);
});

test("projection missing openapi version fails closed (exit 2)", () => {
  const projection = { paths: { "/v1/x": { get: { operationId: "x", responses: { "200": {} } } } } };
  const required = requiredForProjection(buildBaseProjection());
  const tree = buildTree({ projection, requiredJson: required });
  const result = runInTree(tree);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no "openapi" version field/);
});

test("projection with 0 paths fails closed (exit 2)", () => {
  const projection = { openapi: "3.1.0", info: { title: "x", version: "0" }, paths: {} };
  const required = requiredForProjection(buildBaseProjection());
  const tree = buildTree({ projection, requiredJson: required });
  const result = runInTree(tree);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /0 paths/);
});

test("malformed required.json JSON fails closed (exit 2)", () => {
  const projection = buildBaseProjection();
  const tree = buildTree({ projection, requiredJson: "{not-json" });
  const result = runInTree(tree);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not valid JSON/);
});

test("--update regenerates required.json against the projection", () => {
  const projection = buildBaseProjection();
  const tree = buildTree({ projection, omit: { requiredJson: true } });
  const result = runInTree(tree, "--update");
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const requiredPath = join(tree, "scripts/cross-surface-authority.required.json");
  assert.ok(existsSync(requiredPath));
  const written = JSON.parse(readFileSync(requiredPath, "utf8"));
  // Fresh --update writes the projection-derived payload. The script writes
  // consumer = "frihet-mcp" by default (this repo's identity). Operators in
  // a fork should overwrite that field with their own consumer name.
  assert.equal(written.consumer, "frihet-mcp");
  assert.ok(written.pinnedProjection?.fingerprint);
  assert.equal(written.pinnedProjection.fingerprint.length, 64); // sha256 hex
  assert.ok(Array.isArray(written.required));
  assert.ok(written.required.length >= 5);
  const opIds = written.required.map((r) => r.operationId).sort();
  assert.ok(opIds.includes("listInvoices"));
  assert.ok(opIds.includes("createInvoice"));
  assert.ok(opIds.includes("globalSearch"));
  assert.ok(opIds.includes("resendInbound"));
  // The single explicitly-open op was preserved as "open".
  const inbound = written.required.find((r) => r.operationId === "resendInbound");
  assert.equal(inbound.security, "open");
  // Every entry has the fields the gate inspects.
  for (const r of written.required) {
    assert.ok(typeof r.operationId === "string");
    assert.ok(typeof r.method === "string");
    assert.ok(typeof r.path === "string");
    assert.ok(["open", "required"].includes(r.security));
    assert.ok(Array.isArray(r.responseCodes));
  }
});

test("--diff reports drift without exiting non-zero", () => {
  const projection = buildBaseProjection();
  const required = requiredForProjection(projection);
  required.required.push({
    operationId: "fakeRemovedOp",
    method: "GET",
    path: "/v1/nope",
    security: "open",
    responseCodes: ["200"],
  });
  const tree = buildTree({ projection, requiredJson: required });
  const result = runInTree(tree, "--diff");
  assert.equal(result.status, 0, `--diff should not exit non-zero on drift\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /Drift findings/);
  assert.match(result.stdout, /fakeRemovedOp/);
});

test("--check NEVER calls fetch (offline deterministic)", () => {
  // Force the script into an environment where any `fetch()` would throw.
  // If the gate calls fetch at all, the test fails by signal — the script
  // process will exit non-zero with an uncaught fetch error.
  const projection = buildBaseProjection();
  const required = requiredForProjection(projection);
  const tree = buildTree({ projection, requiredJson: required });
  const scriptPath = join(tree, "scripts/cross-surface-authority.mjs");

  // Stub fetch as a throwing function. If the script under test calls it,
  // we observe the throw via stderr; if not, the gate runs offline.
  const preload = `
    globalThis.fetch = async () => {
      throw new TypeError("FETCH CALLED — V2 must be offline");
    };
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, scriptPath, "--check"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `unexpected exit\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /FETCH CALLED/);
});

test("schema: responseCodes field accepts string '200' and number 200", () => {
  // The committed projection uses string keys ("200"), but the gate should
  // accept either — required contracts may pin either shape from older audits.
  const projection = buildBaseProjection();
  const required = requiredForProjection(projection);
  for (const r of required.required) {
    if (r.operationId === "getInvoice") {
      r.responseCodes = ["200", 404]; // mixed
    }
  }
  const tree = buildTree({ projection, requiredJson: required });
  const result = runInTree(tree);
  assert.equal(result.status, 0);
});

test("schema: legacy security tag 'apiKey' is recognised", () => {
  const projection = buildBaseProjection();
  const required = requiredForProjection(projection);
  for (const r of required.required) {
    if (r.operationId === "resendInbound") r.security = "apiKey";
  }
  // resendInbound is explicitly open in the projection. The legacy 'apiKey'
  // tag is treated like 'required' (i.e. "must be protected"), so this
  // contract pin is correct: resendInbound should NOT be protected. The
  // 'apiKey' tag says it should be — and it isn't — so this should FAIL.
  const tree = buildTree({ projection, requiredJson: required });
  const result = runInTree(tree);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SECURITY.*resendInbound/);
});
