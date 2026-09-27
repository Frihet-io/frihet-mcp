import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { inspectPublicSurface, PUBLIC_PROBES, REVIEW_ORIGIN } from "../check-openai-public-surface.mjs";

const root = new URL("../../", import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const descriptor = read("src/__tests__/fixtures/openai-review-descriptor.snapshot.json");
const version = read("package.json").version;
const count = descriptor.tools.length;

function fixtures() {
  const scoped = {
    endpoint: `${REVIEW_ORIGIN}/mcp`, tools_count: count, reviewed_business_tools_count: count,
    discovery_meta_tools_count: 0, resources_count: 0, prompts_count: 0,
    docs: `${REVIEW_ORIGIN}/support`, privacy: `${REVIEW_ORIGIN}/privacy`,
    auth: {
      authorization_server: `${REVIEW_ORIGIN}/.well-known/oauth-authorization-server`,
      authorization_endpoint: `${REVIEW_ORIGIN}/authorize`, token_endpoint: `${REVIEW_ORIGIN}/token`,
      registration_endpoint: `${REVIEW_ORIGIN}/register`, scopes: descriptor.oauth.authorizationServer.scopes_supported,
    },
  };
  const values = {
    root: { tools: count, reviewedBusinessOperations: count, discoveryNames: 0, resources: 0, prompts: 0,
      mcp: `${REVIEW_ORIGIN}/mcp`, auth: scoped.auth, docs: scoped.docs, privacy: scoped.privacy },
    health: { status: "ok", version, releaseVersion: version, releaseSource: "wrangler-var", releaseSha: "a".repeat(40) },
    discovery: scoped, manifest: structuredClone(scoped),
    authorization: descriptor.oauth.authorizationServer, resource: descriptor.oauth.protectedResource,
  };
  return Object.fromEntries(PUBLIC_PROBES.map(([id]) => {
    if (id.startsWith("openapi")) return [id, () => new Response(null, { status: 404 })];
    if (id === "challenge") return [id, () => new Response("{}", { status: 401, headers: { "www-authenticate": descriptor.oauth.wwwAuthenticate.missingTokenHeader } })];
    if (id === "privacy" || id === "support") return [id, () => new Response(
      "<html>VICTOR BERTHELIUS PATO — ayuda@frihet.io — openai-mcp.frihet.io</html>",
      { headers: { "content-type": "text/html; charset=utf-8" } },
    )];
    return [id, () => Response.json(values[id])];
  }));
}

function mocked(values = fixtures(), inspect = () => {}) {
  return async (url, init) => {
    inspect(url, init);
    const probe = PUBLIC_PROBES.find(([, path, method]) => url === `${REVIEW_ORIGIN}${path}` && init.method === method);
    assert.ok(probe, "no requests outside the fixed reviewed-host probe set");
    return values[probe[0]]();
  };
}

test("matching public metadata passes only the public check, never certifies readiness", async () => {
  let calls = 0;
  const result = await inspectPublicSurface({ fetchImpl: mocked(fixtures(), (url, init) => {
    calls += 1;
    assert.equal(init.redirect, "manual");
    assert.equal(init.credentials, "omit");
    assert.equal(Object.hasOwn(init.headers, "Authorization"), false);
    assert.equal(Object.hasOwn(init.headers, "Cookie"), false);
    if (init.method === "POST") assert.equal(JSON.parse(init.body).method, "tools/list");
  }) });
  assert.equal(calls, PUBLIC_PROBES.length);
  assert.equal(result.publicSurfaceStatus, "pass");
  assert.equal(result.submissionReady, false);
  assert.equal(result.unverified.length, 5);
});

for (const [name, probe, data] of [
  ["historical full root", "root", { tools: 157, resources: 11, prompts: 10, mcp: "https://mcp.frihet.io/mcp" }],
  ["historical 56-tool discovery", "discovery", { tools_count: 56 }],
  ["unbound health version", "health", { status: "ok", version: "1.16.5" }],
  ["broad OAuth scopes", "authorization", { ...descriptor.oauth.authorizationServer, scopes_supported: ["read", "write"] }],
  ["foreign OAuth resource", "resource", { ...descriptor.oauth.protectedResource, resource: "https://mcp.frihet.io" }],
]) test(`${name} fails public parity`, async () => {
  const values = fixtures();
  values[probe] = () => Response.json(data);
  const result = await inspectPublicSurface({ fetchImpl: mocked(values) });
  assert.equal(result.publicSurfaceStatus, "fail");
  assert.equal(result.submissionReady, false);
});

test("full OpenAPI link on an otherwise scoped root is rejected", async () => {
  const values = fixtures();
  const base = await values.root().json();
  values.root = () => Response.json({ ...base, openapi: "https://api.frihet.io/openapi.yaml" });
  const result = await inspectPublicSurface({ fetchImpl: mocked(values) });
  assert.equal(result.checks.find(c => c.id === "rootProfile").status, "fail");
});

test("HEAD 200 on a contained GET route fails, and redirects are never followed", async () => {
  const values = fixtures();
  values.openapiJsonHead = () => new Response(null, { status: 200 });
  values.privacy = () => new Response(null, { status: 302, headers: { Location: "https://example.com/private?token=secret" } });
  const result = await inspectPublicSurface({ fetchImpl: mocked(values) });
  assert.equal(result.checks.find(c => c.id === "openapiJsonHeadAbsent").status, "fail");
  assert.equal(result.checks.find(c => c.id === "privacyOwnership").status, "fail");
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("network failure remains inconclusive rather than a missing-page claim", async () => {
  const values = fixtures();
  values.privacy = () => { throw new Error("private provider body and secret"); };
  const result = await inspectPublicSurface({ fetchImpl: mocked(values) });
  assert.equal(result.publicSurfaceStatus, "inconclusive");
  assert.equal(result.probes.find(p => p.id === "privacy").httpStatus, null);
  assert.equal(result.checks.find(c => c.id === "privacyOwnership").status, "unknown");
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("HTML login page, malformed JSON, and empty success are not valid metadata", async () => {
  for (const text of ["<html>Login</html>", "{not-json", "null"]) {
    const values = fixtures();
    values.discovery = () => new Response(text, { headers: { "content-type": "application/json" } });
    const result = await inspectPublicSurface({ fetchImpl: mocked(values) });
    assert.equal(result.publicSurfaceStatus, "fail");
  }
});

test("bounded fetch includes the body and does not hang on a stalled request", async () => {
  for (const stalled of [() => new Promise(() => {}), () => new Response(new ReadableStream({}))]) {
    const values = fixtures();
    values.privacy = stalled;
    const result = await inspectPublicSurface({ fetchImpl: mocked(values), timeoutMs: 20 });
    assert.equal(result.publicSurfaceStatus, "inconclusive");
    assert.equal(result.probes.find(p => p.id === "privacy").unavailable, "timeout");
  }
});

test("body limits apply even when Content-Length is absent or dishonest", async () => {
  for (const headers of [{}, { "content-length": "1" }, { "content-length": "99999999" }]) {
    const values = fixtures();
    values.privacy = () => new Response("s".repeat(300_000), { headers });
    const result = await inspectPublicSurface({ fetchImpl: mocked(values) });
    assert.equal(result.probes.find(p => p.id === "privacy").unavailable, "body_limit");
    assert.equal(result.publicSurfaceStatus, "inconclusive");
  }
});

test("a known mismatch remains a failure when other probes are unavailable", async () => {
  const values = fixtures();
  values.root = () => Response.json({ tools: 56 });
  values.support = () => { throw new Error("offline"); };
  const result = await inspectPublicSurface({ fetchImpl: mocked(values) });
  assert.equal(result.publicSurfaceStatus, "fail");
  assert.equal(result.checks.find(c => c.id === "supportOwnership").status, "unknown");
});
