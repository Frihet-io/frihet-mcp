import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertValidOpenApiDocument,
  openApiUnavailableResponse,
  parseOpenApiDocument,
  serveOpenApiAsset,
} from "../openapi-safety.ts";

const validFullSpec = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Frihet", version: "1.0.0" },
  paths: {
    "/v1/invoices": {
      get: {
        responses: { "200": { description: "ok" } },
        description: "Invoice with taxId and IBAN",
      },
    },
    "/v1/guests": {
      get: { responses: { "200": { description: "hidden" } } },
    },
  },
  components: {
    securitySchemes: { ApiKeyAuth: { type: "apiKey" } },
    schemas: {
      Invoice: {
        type: "object",
        properties: { id: { type: "string" }, taxId: { type: "string" } },
      },
    },
  },
  security: [{ ApiKeyAuth: [] }],
});

test("OpenAI runtime scoper fails closed for malformed or structurally invalid assets", () => {
  const rejected = [
    "not-json business-payload-marker",
    "null",
    "[]",
    JSON.stringify({ error: "upstream business-payload-marker" }),
    JSON.stringify({ openapi: "3.1.0", info: {}, paths: {} }),
    JSON.stringify({
      openapi: "3.1.0",
      info: {},
      paths: { "/v1/invoices": "business-payload-marker" },
    }),
    JSON.stringify({
      openapi: "3.1.0",
      info: {},
      paths: { "/v1/invoices": { get: {} } },
      arbitraryPayload: "business-payload-marker",
    }),
    JSON.stringify({
      openapi: "3.1.0",
      info: {},
      paths: { "/v1/invoices": { get: {} } },
      components: "business-payload-marker",
    }),
    JSON.stringify({
      openapi: "3.1.0",
      info: {},
      paths: { "/v1/invoices": { get: {} } },
      tags: "business-payload-marker",
    }),
  ];

  for (const source of rejected) {
    assert.throws(() => parseOpenApiDocument(source), source);
  }
});

test("valid source parses and an emptied scoped document fails closed", () => {
  const source = parseOpenApiDocument(validFullSpec);
  assert.equal(Object.keys(source.paths).length, 2);
  assert.throws(
    () => assertValidOpenApiDocument({ openapi: "3.1.0", info: {}, paths: {} }, "scoped"),
    /Empty scoped OpenAPI paths/u,
  );
});

test("the real OpenAI asset boundary fails closed and reduces valid full input", async () => {
  const malicious = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Frihet", version: "1.0.0" },
    paths: { "/v1/invoices": "business-payload-marker" },
  });
  const rejected = await serveOpenApiAsset(new Response(malicious), true);
  assert.equal(rejected.status, 502);
  assert.equal(rejected.headers.get("cache-control"), "no-store");
  assert.ok(!(await rejected.text()).includes("business-payload-marker"));

  for (const invalidRoot of [
    { components: "business-payload-marker" },
    { tags: "business-payload-marker" },
  ]) {
    const response = await serveOpenApiAsset(new Response(JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Frihet", version: "1.0.0" },
      paths: { "/v1/invoices": { get: {} } },
      ...invalidRoot,
    })), true);
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes("business-payload-marker"));
  }

  const accepted = await serveOpenApiAsset(new Response(validFullSpec), true);
  assert.equal(accepted.status, 200);
  const scoped = await accepted.json() as { paths: Record<string, unknown> };
  assert.deepEqual(Object.keys(scoped.paths), ["/v1/invoices"]);
  const serialized = JSON.stringify(scoped);
  assert.ok(!serialized.includes("/v1/guests"));
  assert.ok(!serialized.includes("taxId"));
  assert.ok(!serialized.includes("ApiKeyAuth"));
});

test("controlled failure response is fixed, non-cacheable, and contains no source bytes", async () => {
  const response = openApiUnavailableResponse();
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.equal(body, JSON.stringify({ error: "OpenAPI spec temporarily unavailable" }));
  assert.ok(!body.includes("business-payload-marker"));
  assert.ok(!body.includes("api.frihet.io/openapi.json"));
});

test("OpenAI assets route through the Worker before openapi.json can be served", () => {
  const wrangler = readFileSync(
    fileURLToPath(new URL("../../wrangler.toml", import.meta.url)),
    "utf8",
  );
  assert.match(
    wrangler,
    /\[env\.openai\.assets\][\s\S]*?directory\s*=\s*"\.\/public-openai"[\s\S]*?run_worker_first\s*=\s*\["\/openapi\.json"\]/u,
  );
  const runtime = readFileSync(
    fileURLToPath(new URL("../index.ts", import.meta.url)),
    "utf8",
  );
  assert.match(runtime, /return serveOpenApiAsset\(assetResp, openai, BASE_SECURITY_HEADERS\);/u);
  assert.match(runtime, /if \(openai\) return openApiUnavailableResponse\(BASE_SECURITY_HEADERS\);/u);
});

test("generator rejects structurally invalid input without writing a scoped artifact", () => {
  const scratch = mkdtempSync(join(tmpdir(), "frihet-openapi-containment-"));
  const sourceDir = join(scratch, "source");
  const outputDir = join(scratch, "output");
  try {
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "openapi.json"),
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Frihet", version: "1.0.0" },
        paths: { "/v1/invoices": "business-payload-marker" },
      }),
    );
    const script = fileURLToPath(new URL("../../scripts/scope-openai-openapi.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, SCOPE_SRC_DIR: sourceDir, SCOPE_OUT_DIR: outputDir },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(outputDir, "openapi.json")), false);
    assert.ok(!result.stdout.includes("business-payload-marker"));
    assert.ok(!result.stderr.includes("business-payload-marker"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("generator rejects scalar known-root fields without writing a scoped artifact", () => {
  for (const invalidRoot of [
    { components: "business-payload-marker" },
    { tags: "business-payload-marker" },
  ]) {
    const scratch = mkdtempSync(join(tmpdir(), "frihet-openapi-root-shape-"));
    const sourceDir = join(scratch, "source");
    const outputDir = join(scratch, "output");
    try {
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, "openapi.json"), JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Frihet", version: "1.0.0" },
        paths: { "/v1/invoices": { get: {} } },
        ...invalidRoot,
      }));
      const script = fileURLToPath(new URL("../../scripts/scope-openai-openapi.mjs", import.meta.url));
      const result = spawnSync(process.execPath, [script], {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        env: { ...process.env, SCOPE_SRC_DIR: sourceDir, SCOPE_OUT_DIR: outputDir },
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(join(outputDir, "openapi.json")), false);
      assert.ok(!result.stdout.includes("business-payload-marker"));
      assert.ok(!result.stderr.includes("business-payload-marker"));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

test("generator fails when filtering would leave zero reviewed paths", () => {
  const scratch = mkdtempSync(join(tmpdir(), "frihet-openapi-empty-scope-"));
  const sourceDir = join(scratch, "source");
  const outputDir = join(scratch, "output");
  try {
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "openapi.json"),
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Frihet", version: "1.0.0" },
        paths: { "/v1/guests": { get: {} } },
      }),
    );
    const script = fileURLToPath(new URL("../../scripts/scope-openai-openapi.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, SCOPE_SRC_DIR: sourceDir, SCOPE_OUT_DIR: outputDir },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(outputDir, "openapi.json")), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("generator reduces a valid full input to the reviewed path set", () => {
  const scratch = mkdtempSync(join(tmpdir(), "frihet-openapi-valid-"));
  const sourceDir = join(scratch, "source");
  const outputDir = join(scratch, "output");
  try {
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "openapi.json"), validFullSpec);
    const script = fileURLToPath(new URL("../../scripts/scope-openai-openapi.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, SCOPE_SRC_DIR: sourceDir, SCOPE_OUT_DIR: outputDir },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const scoped = JSON.parse(readFileSync(join(outputDir, "openapi.json"), "utf8")) as {
      paths: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(scoped.paths), ["/v1/invoices"]);
    const serialized = JSON.stringify(scoped);
    assert.ok(!serialized.includes("/v1/guests"));
    assert.ok(!serialized.includes("taxId"));
    assert.ok(!serialized.includes("ApiKeyAuth"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
