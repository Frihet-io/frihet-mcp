import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertValidOpenApiDocument,
  isOpenApiLookalikePath,
  openApiUnavailableResponse,
  parseOpenApiDocument,
  serveOpenApiAsset,
} from "../openapi-safety.ts";

test("OpenAI containment recognizes encoded, cased and slash OpenAPI lookalikes", () => {
  for (const path of [
    "/openapi.json",
    "/openapi.json/",
    "/openapi%2Ejson",
    "//openapi.json",
    "/OpenAPI.JSON",
    "/openapi.yaml",
  ]) {
    assert.equal(isOpenApiLookalikePath(path), true, path);
  }
  for (const path of ["/", "/mcp.json", "/docs/openapi.json", "/openapi.jsonx"]) {
    assert.equal(isOpenApiLookalikePath(path), false, path);
  }
});

const validFullSpec = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Frihet", version: "1.0.0" },
  paths: {
    "/v1/invoices": {
      get: { responses: { "200": { description: "ok" } } },
    },
  },
});

test("OpenAPI parser fails closed for malformed or non-spec payloads", () => {
  for (const source of [
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
  ]) {
    assert.throws(() => parseOpenApiDocument(source));
  }
  assert.throws(
    () => assertValidOpenApiDocument({ openapi: "3.1.0", info: {}, paths: {} }, "scoped"),
    /Empty scoped OpenAPI paths/u,
  );
});

test("the full MCP host only serves a structurally valid asset", async () => {
  const accepted = await serveOpenApiAsset(new Response(validFullSpec), false);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), JSON.parse(validFullSpec));

  const rejected = await serveOpenApiAsset(
    new Response("not-json business-payload-marker"),
    false,
  );
  assert.equal(rejected.status, 502);
  assert.equal(rejected.headers.get("cache-control"), "no-store");
  assert.ok(!(await rejected.text()).includes("business-payload-marker"));
});

test("controlled failure response is fixed, non-cacheable, and contains no source bytes", async () => {
  const response = openApiUnavailableResponse();
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.equal(body, JSON.stringify({ error: "OpenAPI spec temporarily unavailable" }));
  assert.ok(!body.includes("api.frihet.io/openapi.json"));
});

test("the reviewed OpenAI host retires OpenAPI at the Worker boundary", () => {
  const workerRoot = fileURLToPath(new URL("../..", import.meta.url));
  const wrangler = readFileSync(fileURLToPath(new URL("../../wrangler.toml", import.meta.url)), "utf8");
  assert.match(
    wrangler,
    /\[env\.openai\.assets\][\s\S]*?directory\s*=\s*"\.\/public-openai"[\s\S]*?run_worker_first\s*=\s*\["\/openapi\.json"\]/u,
  );

  const runtime = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
  const jsonRoute = runtime.match(/if \(pathname === "\/openapi\.json"\) \{[\s\S]*?\n\s{6}\}/u)?.[0];
  assert.ok(jsonRoute, "index.ts must define the /openapi.json route");
  assert.match(jsonRoute, /if \(openai\)[\s\S]*?status:\s*404/u);
  assert.match(jsonRoute, /OpenAPI is not part of the reviewed ChatGPT connector/u);

  const yamlRoute = runtime.match(/if \(pathname === "\/openapi\.yaml"\) \{[\s\S]*?\n\s{6}\}/u)?.[0];
  assert.ok(yamlRoute, "index.ts must define the /openapi.yaml route");
  assert.match(yamlRoute, /if \(openai\)[\s\S]*?status:\s*404/u);

  assert.equal(
    existsSync(`${workerRoot}/public-openai/openapi.json`),
    false,
    "defence in depth: the OpenAI asset directory must not contain an OpenAPI document",
  );

  const descriptor = runtime.match(/const OPENAI_MCP_DESCRIPTOR = \{[\s\S]*?\n\};/u)?.[0];
  assert.ok(descriptor);
  assert.doesNotMatch(descriptor, /openapi/iu);
});

test("the OpenAPI asset helper also fails closed for reviewed mode", async () => {
  const response = await serveOpenApiAsset(new Response(validFullSpec), true);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(await response.text(), /not part of the reviewed ChatGPT connector/u);
});
