/** Offline only: all network, Firebase input and deployment admission are fake. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { FrihetApiError } from "../../dist/client.js";
import { handleToolError } from "../../dist/tools/shared.js";
import { claudeToolResult } from "../../dist/claude-output-privacy.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerProductTools } from "../../dist/tools/products.js";
import { CONSULTATION_LISTS, CONSULTATION_DENIED, ORIGIN, RESOURCE, SCOPES, FIREBASE_PROJECT, boundedTransport, parseArguments, privateReceiptWriter, runAcceptance, validateFirebaseInput } from "../claude-hosted-acceptance.mjs";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const UID = "offline-only-synthetic-qa";
const hash = value => createHash("sha256").update(value).digest("hex");
const SHA = "a".repeat(40), UID_HASH = hash(UID);
const CANDIDATE = JSON.parse(readFileSync(new URL("../../src/__tests__/fixtures/claude-candidate-contract.json", import.meta.url), "utf8"));
const CONSULTATION_CONTRACT = structuredClone(CANDIDATE);
const consultationNames = [...CONSULTATION_LISTS, "list_tool_groups", "search_tools", "describe_tool"];
CONSULTATION_CONTRACT.tools.full = CANDIDATE.tools.full.filter(item => CONSULTATION_LISTS.includes(item.name));
CONSULTATION_CONTRACT.tools.grouped = CANDIDATE.tools.grouped.filter(item => consultationNames.includes(item.name));
CONSULTATION_CONTRACT.prompts = []; CONSULTATION_CONTRACT.promptContent = [];
for (const kind of ["local", "remote"]) CONSULTATION_CONTRACT.resources[kind] = CANDIDATE.resources[kind].filter(item => item.uri === "frihet://config/currencies");
CONSULTATION_CONTRACT.catalogue.canonicalOperations = 6; CONSULTATION_CONTRACT.catalogue.aliases = {};
CONSULTATION_CONTRACT.groups.totalTools = 6;
const consultationGroups = { invoicing: 2, expenses: 2, crm: 1, catalog: 1 };
CONSULTATION_CONTRACT.groups.groups = CONSULTATION_CONTRACT.groups.groups.filter(item => item.group in consultationGroups).map(item => ({ ...item, toolCount: consultationGroups[item.group] }));
CONSULTATION_CONTRACT.groups.totalGroups = 4;
// Only an injected, four-tool offline fixture keeps the historical destructive
// lifecycle safety tests. It is not a deployable/accepted current Claude profile.
async function historicalProductPilotContract() {
  const server = new McpServer({ name: "offline-historical-products", version: "1" });
  registerProductTools(server, {});
  const client = new Client({ name: "offline-historical-descriptors", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    return { ...CONSULTATION_CONTRACT, tools: { grouped: (await client.listTools()).tools.filter(item => ["create_product", "get_product", "update_product", "delete_product"].includes(item.name)) } };
  } finally { await Promise.allSettled([client.close(), server.close()]); }
}
const CONTRACT = await historicalProductPilotContract();
const NOT_FOUND = handleToolError(new FrihetApiError(404, "not_found", "PRIVATE_provider_message", "PRIVATE_provider_detail"));
const FORBIDDEN = handleToolError(new FrihetApiError(403, "forbidden", "PRIVATE_provider_message", "PRIVATE_provider_detail"));
const FOREIGN_ID = "foreign-synthetic-product", FOREIGN_MARKER = `FRIHET-QA-${"b".repeat(32)}`;
function fakeToken(overrides = {}) {
  const part = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", kid: "offline-key-only" })}.${part({ aud: FIREBASE_PROJECT,
    iss: `https://securetoken.google.com/${FIREBASE_PROJECT}`, sub: UID, email_verified: true,
    iat: NOW / 1000, exp: NOW / 1000 + 3600, ...overrides })}.offline_signature`;
}
const response = (status, data, headers = {}, text = "") => ({ status, data, text, headers: new Headers(headers) });

function fixture(faults = {}) {
  const contract = faults.consultation ? CONSULTATION_CONTRACT : CONTRACT;
  const calls = [], receipts = [], clients = new Map(), access = new Map(), refreshTokens = new Map(), products = new Map();
  let clientCount = 0, tokenCount = 0, reads = 0, admissions = 0;
  const publicData = {
    "/health": { status: "ok", accessProfile: "claude", releaseSha: faults.releaseSha ?? SHA },
    "/.well-known/oauth-authorization-server": { issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/authorize`, token_endpoint: `${ORIGIN}/token`, registration_endpoint: `${ORIGIN}/register`, revocation_endpoint: `${ORIGIN}/token`, scopes_supported: SCOPES, code_challenge_methods_supported: ["S256"] },
    "/.well-known/oauth-protected-resource": { resource: RESOURCE, authorization_servers: [ORIGIN], scopes_supported: SCOPES },
    "/.well-known/oauth-protected-resource/mcp": { resource: RESOURCE, authorization_servers: [ORIGIN], scopes_supported: SCOPES },
    "/.well-known/openid-configuration": { issuer: ORIGIN, userinfo_endpoint: `${ORIGIN}/userinfo` },
  };
  function tokens(client) {
    const serial = ++tokenCount;
    client.access = `offline-access-${serial}`; client.refresh = `offline-refresh-${serial}`;
    access.set(client.access, client); refreshTokens.set(client.refresh, { client, used: false }); client.active = true;
    return response(200, { access_token: client.access, refresh_token: client.refresh, token_type: "Bearer", scope: SCOPES.join(" "), resource: RESOURCE, expires_in: 3600 });
  }
  function principal(options) {
    const authorization = options.headers?.Authorization;
    return authorization?.startsWith("Bearer ") ? access.get(authorization.slice(7)) : undefined;
  }
  async function send(path, options = {}) {
    const target = new URL(path, ORIGIN), method = options.method ?? "GET";
    calls.push({ path: target.pathname, method, options });
    if (faults.networkAt === target.pathname) throw new Error("untrusted provider body offline-secret-password");
    if (method === "GET" && publicData[target.pathname]) return response(200, publicData[target.pathname]);
    if (target.pathname === "/userinfo") {
      const client = principal(options);
      return client?.active ? response(200, { sub: faults.wrongUser ? "other-offline-uid" : UID, email_verified: true }, { "cache-control": "no-store" }) : response(401, { error: "invalid_token" });
    }
    if (target.pathname === "/register") {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.grant_types, ["authorization_code", "refresh_token"]);
      assert.equal(body.token_endpoint_auth_method, "none");
      const clientId = `offline-client-${++clientCount}`;
      clients.set(clientId, { id: clientId, redirect: body.redirect_uris[0] }); return response(201, { client_id: clientId });
    }
    if (target.pathname === "/authorize") {
      const query = target.searchParams, client = clients.get(query.get("client_id"));
      assert.equal(query.get("resource"), RESOURCE); assert.equal(query.get("code_challenge_method"), "S256");
      assert.equal(query.get("redirect_uri"), client.redirect);
      Object.assign(client, { state: query.get("state"), challenge: query.get("code_challenge"), stateKey: `offline-state-${client.id}` });
      const data = { stateKey: client.stateKey, clientId: client.id, firebaseProjectId: FIREBASE_PROJECT };
      return response(200, undefined, {}, `<script type="application/json" id="server-data">${JSON.stringify(data)}</script>`);
    }
    if (target.pathname === "/callback") {
      const body = JSON.parse(options.body), client = [...clients.values()].find(item => item.stateKey === body.stateKey);
      assert.equal(body.idToken, fakeToken());
      if (client.callbackDone) return response(faults.callbackReplayAccepted ? 200 : 400, {});
      client.callbackDone = true; client.code = `offline-code-${client.id}`;
      const redirect = new URL(faults.callbackTarget ?? client.redirect);
      redirect.searchParams.set("state", faults.wrongState ? "other-state" : client.state); redirect.searchParams.set("code", client.code);
      return response(200, { redirectTo: redirect.href });
    }
    if (target.pathname === "/token") {
      const form = new URLSearchParams(options.body), client = clients.get(form.get("client_id"));
      if (!form.has("grant_type")) {
        assert.equal(form.get("token_type_hint"), "refresh_token"); assert.equal(form.get("token"), client.refresh);
        if (!faults.revocationIneffective) client.active = false; return response(200, {});
      }
      const invalid = () => response(400, { error: "invalid_grant" });
      if (form.get("grant_type") === "authorization_code") {
        assert.equal(form.get("redirect_uri"), client.redirect); assert.equal(form.get("resource"), RESOURCE);
        assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), client.challenge);
        if (client.redeemed) {
          if (faults.codeReplayAccepted) return tokens(client);
          if (!faults.codeReplayIneffective) client.active = false;
          return invalid();
        }
        client.redeemed = true; return tokens(client);
      }
      assert.equal(form.get("resource"), RESOURCE);
      const stored = refreshTokens.get(form.get("refresh_token"));
      if (!client.active || !stored) return invalid();
      if (stored.used) { if (!faults.replayIneffective) client.active = false; return invalid(); }
      stored.used = true; return tokens(client);
    }
    if (target.pathname === "/mcp") {
      const client = principal(options); if (!client?.active) return response(401, { error: "invalid_token" });
      const request = JSON.parse(options.body), { id, params } = request;
      // Exercise the actual runtime privacy boundary, including errors: the
      // shared mapper's human-readable denial text never reaches Claude.
      const done = (result, headers, raw = false) => response(200, { jsonrpc: "2.0", id,
        result: request.method === "tools/call" && !raw ? claudeToolResult(result) : result }, headers);
      if (request.method === "initialize") return done({ protocolVersion: "2025-03-26", capabilities: faults.retainedPromptCapability ? { prompts: {} } : {}, serverInfo: { name: "offline-server", version: "1" } }, { "mcp-session-id": `v1.${"s".repeat(24)}.${"a".repeat(64)}` });
      assert.ok(options.headers["Mcp-Session-Id"]); assert.equal(options.headers["MCP-Protocol-Version"], "2025-03-26");
      if (request.method === "notifications/initialized") return response(202);
      if (request.method === "tools/list") return done({ tools: faults.catalogMismatch ? [] : contract.tools.grouped });
      if (request.method === "resources/list") return done({ resources: contract.resources.remote });
      if (request.method === "prompts/list") { assert.equal(Boolean(faults.consultation), false, "consultation must not call an unsupported capability"); return done({ prompts: contract.prompts }); }
      if (request.method === "resources/read") { assert.equal(params.uri, "frihet://config/currencies"); return done(contract.currencies); }
      if (request.method === "prompts/get") return done(contract.promptContent.find(item => item.name === params.name).result);
      assert.equal(request.method, "tools/call");
      const { name, arguments: input } = params;
      if (faults.consultation) {
        if (CONSULTATION_DENIED.includes(name)) return done(faults.excludedResult ?? { isError: true, content: [{ type: "text", text: `MCP error -32602: Tool ${name} not found` }] }, {}, true);
        if (name === "list_tool_groups") return done({ structuredContent: contract.groups, content: [] });
        if (name === "search_tools") return done({ structuredContent: { count: 6, tools: CONSULTATION_LISTS.map(name => ({ name, readOnly: true })) }, content: [] });
        if (name === "describe_tool") return done({ structuredContent: { name: "list_invoices", readOnly: true }, content: [] });
        assert.ok(CONSULTATION_LISTS.includes(name), `consultation must never invoke ${name}`);
        assert.deepEqual(input, { limit: 10, offset: 0 });
        const empty = faults.consultationEmpty, incomplete = faults.consultationIncomplete;
        return done({ content: [], structuredContent: { data: empty ? [] : [{ id: `synthetic-${name}` }],
          total: faults.badConsultationTotal ? 0 : incomplete ? 20 : empty ? 0 : 1, limit: 10, offset: 0,
          ...(faults.consultationCursor ? { nextCursor: "synthetic-more" } : {}) } });
      }
      if (name === "get_product" && input.id === FOREIGN_ID) {
        if (faults.foreignResult) return done(faults.foreignResult);
        if (faults.foreignAccessible) return done({ structuredContent: { id: FOREIGN_ID, name: FOREIGN_MARKER, unitPrice: 0 }, content: [] });
        if (faults.foreignGenericError) return done({ isError: true, content: [{ type: "text", text: "Error: offline timeout" }] });
        return done(faults.foreignForbidden ? FORBIDDEN : NOT_FOUND);
      }
      if (name === "create_product") {
        assert.equal(input.unitPrice, 0); assert.equal("taxRate" in input, false);
        const checkpoint = receipts.at(-1).productLedger[0];
        assert.equal(checkpoint.phase, "create_pending"); assert.equal(checkpoint.marker, input.name);
        products.set("offline-product-1", { id: "offline-product-1", ...input });
        if (faults.uncertainCreate) throw new Error("provider secret offline-secret-password");
        return done({ content: [], structuredContent: { ...products.get("offline-product-1"), ...(faults.badCreatedProduct ? { name: "unrelated-product" } : {}) } });
      }
      assert.equal(input.id, "offline-product-1", "Only recorded newly-created synthetic product may be touched");
      if (name === "get_product") return done(products.has(input.id) ? { structuredContent: structuredClone(products.get(input.id)), content: [] } : faults.cleanupReadbackResult ?? NOT_FOUND);
      if (name === "update_product") {
        assert.deepEqual(Object.keys(input).sort(), ["description", "id"]);
        Object.assign(products.get(input.id), { description: input.description });
        if (faults.uncertainUpdate) throw new Error("offline-secret-password");
        return done({ content: [], structuredContent: structuredClone(products.get(input.id)) });
      }
      assert.equal(name, "delete_product");
      if (!faults.deleteIneffective) products.delete(input.id);
      if (faults.uncertainDelete) throw new Error("offline-secret-password");
      return done({ content: [], structuredContent: { success: true, id: input.id } });
    }
    assert.fail(`Unimplemented offline route ${target.pathname}`);
  }
  const dependencies = {
    send, clock: () => NOW, readToken: async () => { reads++; return fakeToken(); },
    verifyAdmission: async () => { admissions++; if (faults.guardRejected) throw new Error("do not leak offline-secret-password"); },
    persist: receipt => receipts.push(structuredClone(receipt)),
    contractLoader: () => contract,
  };
  return {
    dependencies, calls, receipts, clients, products, reads: () => reads, admissions: () => admissions,
    run: (options = {}, overrides = {}) => runAcceptance({ hosted: true, expectedSha: SHA, expectedUidHash: UID_HASH, label: "offline_qa", ...(faults.consultation ? { consultation: true } : {}), ...options }, { ...dependencies, ...overrides }),
  };
}

test("default dry-run performs no admission, credential read, or network call", async () => {
  const f = fixture(); const result = await runAcceptance({}, f.dependencies);
  assert.equal(result.status, "dry_run"); assert.equal(f.calls.length, 0); assert.equal(f.reads(), 0); assert.equal(f.admissions(), 0);
  assert.ok(Object.values(result.checks).every(value => value === "not_exercised"));
});

test("hosted exported API requires a private receipt sink before network or credentials", async () => {
  const f = fixture(), result = await f.run({}, { persist: undefined });
  assert.equal(result.status, "fail"); assert.equal(result.failure, "HOSTED_PRIVATE_RECEIPT_REQUIRED");
  assert.equal(f.calls.length, 0); assert.equal(f.reads(), 0); assert.equal(f.admissions(), 0);
});

test("default bundled operational contract reaches the credential boundary without an injected catalogue", async () => {
  const f = fixture();
  let requested = false;
  const result = await f.run({}, {
    contractLoader: undefined,
    readToken: async () => { requested = true; throw new Error("offline-stop-before-credentials"); },
  });
  assert.equal(requested, true, "the shipped catalogue must pass its digest and product checks");
  assert.equal(result.failedAt, "firebase_input");
  assert.equal(result.status, "fail");
  assert.equal(result.grants.length, 0);
  assert.equal(result.productLedger.length, 0);
  assert.ok(f.calls.every(call => call.method === "GET"), "contract loading must not authorize or write");
  assert.equal(result.hostedAcceptanceVerified, false);
  assert.equal(result.submissionReady, false);
});

test("offline historical four-product lifecycle retains CRUD uncertainty, rotation, revocation and reconnect checks", async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.status, "single_identity_protocol_pass", JSON.stringify(result));
  assert.ok(Object.entries(result.checks).filter(([name]) => name !== "foreign_product_exact_id_denied").every(([, value]) => value === "pass"));
  assert.deepEqual([result.catalog.tools, result.catalog.resources, result.catalog.prompts], [4, 1, 0]);
  assert.equal(result.productLedger[0].phase, "deleted_and_not_found"); assert.equal(f.products.size, 0);
  assert.equal(f.clients.size, 3); assert.equal([...f.clients.values()].some(client => client.active), false);
  assert.deepEqual(result.grants.map(grant => grant.phase), ["revoked", "replay_invalidated", "replay_invalidated"]);
  assert.equal(f.reads(), 1); assert.equal(f.admissions(), 1);
  assert.equal(result.hostedAcceptanceVerified, false); assert.equal(result.submissionReady, false); assert.equal(result.independentBackendCleanupVerified, false);
  assert.ok(result.unexercised.includes("actual_claude_client_journey"));
  const serialized = JSON.stringify(f.receipts);
  for (const value of [fakeToken(), UID, "offline-access-", "offline-refresh-", "offline-code-", "offline-state-", "offline-secret-password"]) assert.equal(serialized.includes(value), false, value);
});

test("explicit consultation runs all nine real-descriptor cases, the resource and excluded-name probes without business writes", async () => {
  const f = fixture({ consultation: true }), result = await f.run();
  assert.equal(result.status, "consultation_protocol_pass", JSON.stringify(result));
  assert.ok(Object.values(result.checks).every(value => value === "pass"));
  assert.deepEqual([result.catalog.tools, result.catalog.resources, result.catalog.prompts], [9, 1, 0]);
  assert.deepEqual([...result.consultation.succeededTools].sort(), [...consultationNames].sort());
  assert.deepEqual(result.consultation.excludedCalls, CONSULTATION_DENIED);
  assert.equal(result.consultation.populatedCompleteLists, true);
  assert.equal(result.consultation.filtersAndPaginationWithDataVerified, false);
  assert.deepEqual(result.productLedger, []); assert.equal(f.products.size, 0);
  assert.equal(result.submissionReady, false); assert.equal(result.hostedAcceptanceVerified, false);
  const methods = f.calls.filter(call => call.path === "/mcp" && call.options.body).map(call => JSON.parse(call.options.body));
  assert.equal(methods.some(call => call.method === "prompts/list" || call.method === "prompts/get"), false);
  assert.deepEqual(methods.filter(call => call.method === "tools/call").map(call => call.params.name).sort(), [...consultationNames, ...CONSULTATION_DENIED].sort());
  assert.equal(JSON.stringify(result).includes("synthetic-list_"), false, "record identifiers must not enter receipts");
});

test("empty, truncated or cursor-bearing consultation pages cannot prove populated complete data", async () => {
  for (const fault of ["consultationEmpty", "consultationIncomplete", "consultationCursor"]) {
    const f = fixture({ consultation: true, [fault]: true }), result = await f.run();
    assert.equal(result.status, "fail", JSON.stringify(result));
    assert.equal(result.failure, "CONSULTATION_DATA_EMPTY_OR_INCOMPLETE");
    assert.equal(result.failedAt, "consultation_population");
    assert.equal(result.checks.consultation_reads, "pass"); assert.equal(result.checks.consultation_denials, "pass");
    assert.equal(result.consultation.succeededTools.length, 9); assert.equal(result.consultation.populatedCompleteLists, false);
    assert.equal(result.submissionReady, false); assert.deepEqual(result.productLedger, []);
    assert.equal([...f.clients.values()].some(client => client.active), false);
  }
});

test("consultation rejects contradictory pagination and any retained prompt capability", async () => {
  for (const [fault, failure] of [["badConsultationTotal", "CONSULTATION_PAGE_INVALID"], ["retainedPromptCapability", "CONSULTATION_PROMPT_CAPABILITY_MISMATCH"]]) {
    const f = fixture({ consultation: true, [fault]: true }), result = await f.run();
    assert.equal(result.status, "fail"); assert.equal(result.failure, failure);
    assert.deepEqual(result.productLedger, []); assert.equal(result.submissionReady, false);
  }
});

test("consultation requires registration absence, never generic denial or input errors", async () => {
  for (const excludedResult of [
    { isError: true, content: [{ type: "text", text: "Action denied" }] },
    { isError: true, content: [{ type: "text", text: "Invalid params: name required" }] },
    { isError: true, structuredContent: {}, content: [{ type: "text", text: "MCP error -32602: Tool create_product not found" }] },
    { content: [], structuredContent: { id: "unwanted-write" } },
  ]) {
    const f = fixture({ consultation: true, excludedResult }), result = await f.run();
    assert.equal(result.status, "fail"); assert.equal(result.failure, "EXCLUDED_TOOL_NOT_PROVEN_ABSENT");
    assert.deepEqual(result.productLedger, []);
  }
});

test("consultation refuses a mixed catalog before credentials and legacy mode refuses the new catalog", async () => {
  const expanded = structuredClone(CONSULTATION_CONTRACT);
  expanded.tools.grouped.push(CONTRACT.tools.grouped.find(item => item.name === "create_product"));
  const f = fixture({ consultation: true });
  const result = await f.run({}, { contractLoader: () => expanded });
  assert.equal(result.failure, "CONSULTATION_CONTRACT_REQUIRED"); assert.equal(f.reads(), 0);
  assert.equal(f.calls.some(call => call.path === "/register"), false);
  const legacy = fixture({ consultation: true });
  const legacyResult = await legacy.run({ consultation: false });
  assert.equal(legacyResult.failure, "LEGACY_PRODUCT_PILOT_UNAVAILABLE_FOR_CURRENT_CATALOG");
  assert.equal(legacy.reads(), 0); assert.equal(legacy.calls.some(call => call.path === "/register"), false);
});

test("consultation cannot inherit a foreign-product hook or product lifecycle target", async () => {
  for (const [options, overrides] of [
    [{ foreignProductId: FOREIGN_ID, foreignMarker: FOREIGN_MARKER }, {}],
    [{}, { afterProductCreated: async () => assert.fail("must not be invoked") }],
  ]) {
    const f = fixture({ consultation: true }), result = await f.run(options, overrides);
    assert.equal(result.failure, "CONSULTATION_CANNOT_RUN_PRODUCT_LIFECYCLE");
    assert.equal(f.calls.length, 0); assert.equal(f.reads(), 0);
  }
});

test("deployment guard or public release mismatch stops before any credential read or DCR", async () => {
  for (const faults of [{ guardRejected: true }, { releaseSha: "b".repeat(40) }, { networkAt: "/health" }]) {
    const f = fixture(faults), result = await f.run();
    assert.ok(["fail", "inconclusive"].includes(result.status)); assert.equal(f.reads(), 0);
    assert.equal(f.calls.some(call => call.path === "/register"), false);
    assert.equal(JSON.stringify(result).includes("offline-secret-password"), false);
  }
});

test("root protected-resource metadata rejects the legacy origin, foreign resource and missing resource before credentials or DCR", async () => {
  for (const resource of [ORIGIN, "https://foreign.invalid/mcp", undefined]) {
    const f = fixture(), base = f.dependencies.send;
    const result = await f.run({}, { send: async (path, options = {}) => {
      const response = await base(path, options);
      if (path === "/.well-known/oauth-protected-resource") {
        if (resource === undefined) delete response.data.resource;
        else response.data.resource = resource;
      }
      return response;
    } });
    assert.equal(result.status, "fail"); assert.equal(result.failure, "RESOURCE_METADATA_MISMATCH");
    assert.equal(result.failedAt, "public_release"); assert.equal(f.reads(), 0);
    assert.equal(f.calls.some(call => call.path === "/register"), false);
    assert.ok(f.calls.every(call => call.method === "GET"));
    assert.deepEqual(result.grants, []); assert.deepEqual(result.productLedger, []);
  }
});

test("release/principal bindings and root-controlled synthetic foreign binding are mandatory before network", async () => {
  for (const options of [{ label: "do not echo offline-secret-password" }, { expectedSha: "unknown" }, { expectedUidHash: "" }, { foreignProductId: "arbitrary-existing-id" }, { foreignProductId: "../unsafe", foreignMarker: FOREIGN_MARKER }, { foreignProductId: FOREIGN_ID, foreignMarker: "customer product" }]) {
    const f = fixture(), result = await f.run(options);
    assert.equal(result.status, "fail"); assert.equal(f.calls.length, 0); assert.equal(f.reads(), 0);
    assert.equal(JSON.stringify(result).includes("offline-secret-password"), false);
  }
});

test("Firebase local input guard rejects wrong audience, identity, verification, stale and expired tokens", () => {
  validateFirebaseInput(fakeToken(), UID_HASH, NOW);
  for (const fields of [{ aud: "other-project" }, { sub: "another-uid" }, { email_verified: false }, { iat: NOW / 1000 - 301 }, { exp: NOW / 1000 + 10 }, { exp: NOW / 1000 + 3601 }]) {
    assert.throws(() => validateFirebaseInput(fakeToken(fields), UID_HASH, NOW), /FIREBASE_IDENTITY_OR_FRESHNESS_MISMATCH/u);
  }
  assert.throws(() => validateFirebaseInput("credential-in-argv", UID_HASH, NOW), /FIREBASE_INPUT_INVALID/u);
});

test("callback target/state, UserInfo principal, callback replay and catalog fail closed without business writes", async () => {
  for (const faults of [{ callbackTarget: "https://untrusted.invalid/callback" }, { wrongState: true }, { wrongUser: true }, { callbackReplayAccepted: true }, { catalogMismatch: true }]) {
    const f = fixture(faults), result = await f.run();
    assert.equal(result.status, "fail"); assert.equal(result.productLedger.length, 0);
    assert.equal(f.calls.some(call => call.options.body?.includes('"create_product"')), false);
  }
});

test("uncertain create is never retried or followed by speculative CRUD; ledger survives and grant is revoked", async () => {
  const f = fixture({ uncertainCreate: true }), result = await f.run();
  assert.equal(result.status, "fail"); assert.equal(result.productLedger[0].phase, "create_pending");
  assert.equal(result.productLedger[0].id, null); assert.match(result.productLedger[0].marker, /^FRIHET-QA-[a-f0-9]{32}$/u);
  const mutations = f.calls.filter(call => call.options.body?.includes('"create_product"'));
  assert.equal(mutations.length, 1); assert.equal(f.products.size, 1);
  assert.equal(f.calls.some(call => call.options.body?.includes('"delete_product"')), false);
  assert.equal(result.grants[0].phase, "revoked"); assert.equal(JSON.stringify(result).includes("offline-secret-password"), false);
});

test("a mismatched create response cannot authorize deleting another record", async () => {
  const f = fixture({ badCreatedProduct: true }), result = await f.run();
  assert.equal(result.status, "fail"); assert.equal(f.calls.some(call => call.options.body?.includes('"delete_product"')), false);
  assert.equal(result.productLedger[0].unverifiedReturnedIdSha256, hash("offline-product-1")); assert.equal(result.productLedger[0].id, null);
  assert.equal(JSON.stringify(f.receipts).includes("offline-product-1"), false);
});

test("a candidate product ID stays hashed until independent matching readback", async () => {
  const f = fixture(), base = f.dependencies.send; let hookCalls = 0;
  const result = await f.run({}, { afterProductCreated: async () => { hookCalls++; }, send: async (path, options = {}) => {
    const result = await base(path, options);
    const request = path === "/mcp" && options.body ? JSON.parse(options.body) : undefined;
    if (request?.params?.name === "get_product") result.data.result.structuredContent.name = "unrelated-product";
    return result;
  } });
  assert.equal(result.status, "fail"); assert.equal(result.failure, "PRODUCT_READBACK_MISMATCH");
  assert.equal(hookCalls, 0); assert.equal(f.calls.some(call => call.options.body?.includes('"delete_product"')), false);
  assert.equal(result.productLedger[0].unverifiedReturnedIdSha256, hash("offline-product-1"));
  assert.ok(f.receipts.every(receipt => !receipt.productLedger[0]?.id));
  assert.equal(JSON.stringify(f.receipts).includes("offline-product-1"), false);
});

for (const reflectedKind of ["access", "previous_access", "refresh", "previous_refresh", "uid", "client", "state", "stateKey", "code", "verifier", "firebase", "session"]) {
  for (const [matchingMarker, wrapped] of [[false, false], [false, true], [true, false], [true, true]]) {
    test(`${wrapped ? "embedded" : "exact"} reflected ${reflectedKind} cannot enter receipt or hook with ${matchingMarker ? "matching" : "wrong"} product marker`, async () => {
      const f = fixture(), base = f.dependencies.send; let reflected, hookCalls = 0, candidateReads = 0;
      const result = await f.run({}, { afterProductCreated: async () => { hookCalls++; }, send: async (path, options = {}) => {
        const request = path === "/mcp" && options.body ? JSON.parse(options.body) : undefined;
        if (reflected && request?.params?.name === "get_product" && request.params.arguments.id === reflected) {
          candidateReads++;
          return response(200, { jsonrpc: "2.0", id: request.id, result: { content: [], structuredContent: { id: reflected, name: f.receipts.at(-1).productLedger[0].marker, unitPrice: 0 } } });
        }
        const result = await base(path, options);
        if (request?.params?.name === "create_product") {
          const client = f.clients.get("offline-client-1");
          const redemption = f.calls.find(call => call.path === "/token" && new URLSearchParams(call.options.body).get("grant_type") === "authorization_code");
          const values = { access: client.access, previous_access: "offline-access-1", refresh: client.refresh, previous_refresh: "offline-refresh-1", uid: UID, client: client.id,
            state: client.state, stateKey: client.stateKey, code: client.code,
            verifier: new URLSearchParams(redemption.options.body).get("code_verifier"), firebase: fakeToken(),
            session: `v1.${"s".repeat(24)}.${"a".repeat(64)}` };
          reflected = wrapped ? `reflected-${values[reflectedKind]}-suffix` : values[reflectedKind];
          result.data.result.structuredContent.id = reflected;
          if (!matchingMarker) result.data.result.structuredContent.name = "unrelated-product";
        }
        return result;
      } });
      assert.notEqual(result.status, "single_identity_protocol_pass");
      assert.equal(JSON.stringify(f.receipts).includes(reflected), false, "Untrusted ID must never serialize a credential");
      assert.equal(hookCalls, 0); assert.equal(candidateReads, 0, "Reflected ID must be rejected before independent readback");
      assert.equal(f.calls.some(call => call.options.body?.includes('"delete_product"')), false);
    });
  }
}

test("uncertain update still cleans only the known synthetic product and revokes its grant", async () => {
  const f = fixture({ uncertainUpdate: true }), result = await f.run();
  assert.equal(result.status, "fail"); assert.equal(result.productLedger[0].phase, "deleted_and_not_found");
  assert.equal(f.products.size, 0); assert.equal(result.grants[0].phase, "revoked");
});

test("uncertain delete is never retried; successful delete without not-found readback is not cleanup proof", async () => {
  for (const faults of [{ uncertainDelete: true }, { deleteIneffective: true }]) {
    const f = fixture(faults), result = await f.run();
    assert.equal(result.status, "fail"); assert.notEqual(result.checks.product_cleanup, "pass");
    assert.equal(f.calls.filter(call => call.options.body?.includes('"delete_product"')).length, 1);
    assert.equal(result.grants[0].phase, "revoked");
  }
});

test("revoke HTTP 200 or replay 400 alone is insufficient without dead access readback", async () => {
  for (const faults of [{ revocationIneffective: true }, { codeReplayIneffective: true }, { replayIneffective: true }]) {
    const f = fixture(faults), result = await f.run(); assert.equal(result.status, "fail");
    assert.equal(result.independentBackendCleanupVerified, false);
    if (faults.revocationIneffective) assert.notEqual(result.checks.revoke, "pass");
    else if (faults.codeReplayIneffective) assert.notEqual(result.checks.code_replay, "pass");
    else assert.notEqual(result.checks.refresh_replay, "pass");
  }
});

for (const phase of ["revoke", "code_replay", "refresh_replay"]) {
  for (const path of ["/userinfo", "/mcp"]) {
    test(`${phase} checks earlier issued access tokens on ${path}`, async () => {
      const f = fixture(), base = f.dependencies.send;
      const clientId = phase === "revoke" ? "offline-client-1" : phase === "code_replay" ? "offline-client-2" : "offline-client-3";
      const staleAccess = phase === "revoke" ? "offline-access-1" : phase === "code_replay" ? "offline-access-3" : "offline-access-4";
      const send = async (target, options = {}) => {
        const result = await base(target, options);
        if (target === path && options.headers?.Authorization === `Bearer ${staleAccess}` && f.clients.get(clientId)?.active === false) {
          return response(200, { sub: UID, email_verified: true }, { "cache-control": "no-store" });
        }
        return result;
      };
      const result = await f.run({}, { send });
      assert.notEqual(result.status, "single_identity_protocol_pass"); assert.notEqual(result.checks[phase], "pass");
      assert.equal((await send(path, { headers: { Authorization: `Bearer ${staleAccess}` } })).status, 200);
      assert.equal(JSON.stringify(f.receipts).includes(staleAccess), false);
    });
  }
}

test("revocation and replay probe every issued access and refresh token without persisting credentials", async () => {
  const f = fixture(), result = await f.run(); assert.equal(result.status, "single_identity_protocol_pass");
  const revokeIndex = f.calls.findIndex(call => call.path === "/token" && new URLSearchParams(call.options.body).has("token"));
  const primaryAfterRevoke = f.calls.slice(revokeIndex + 1);
  for (const serial of [1, 2]) {
    for (const path of ["/userinfo", "/mcp"]) assert.ok(primaryAfterRevoke.some(call => call.path === path && call.options.headers?.Authorization === `Bearer offline-access-${serial}`));
    assert.ok(primaryAfterRevoke.some(call => call.path === "/token" && new URLSearchParams(call.options.body).get("refresh_token") === `offline-refresh-${serial}`));
  }
  const codeReplayIndex = f.calls.map((call, index) => ({ call, index }))
    .filter(({ call }) => call.path === "/token" && new URLSearchParams(call.options.body).get("grant_type") === "authorization_code"
      && new URLSearchParams(call.options.body).get("client_id") === "offline-client-2")[1].index;
  assert.ok(codeReplayIndex > revokeIndex);
  const reconnectIndex = f.calls.map((call, index) => ({ call, index })).filter(({ call }) => call.path === "/register")[2].index;
  const codeAfterReplay = f.calls.slice(codeReplayIndex + 1, reconnectIndex);
  for (const path of ["/userinfo", "/mcp"]) assert.ok(codeAfterReplay.some(call => call.path === path && call.options.headers?.Authorization === "Bearer offline-access-3"));
  assert.ok(codeAfterReplay.some(call => call.path === "/token" && new URLSearchParams(call.options.body).get("refresh_token") === "offline-refresh-3"));
  const replayIndex = f.calls.map((call, index) => ({ call, index }))
    .filter(({ call }) => call.path === "/token" && new URLSearchParams(call.options.body).get("refresh_token") === "offline-refresh-4")[1].index;
  const negativeAfterReplay = f.calls.slice(replayIndex);
  for (const serial of [4, 5]) {
    for (const path of ["/userinfo", "/mcp"]) assert.ok(negativeAfterReplay.some(call => call.path === path && call.options.headers?.Authorization === `Bearer offline-access-${serial}`));
    assert.ok(negativeAfterReplay.some(call => call.path === "/token" && new URLSearchParams(call.options.body).get("refresh_token") === `offline-refresh-${serial}`));
  }
  assert.equal(JSON.stringify(f.receipts).includes("offline-access-"), false);
  assert.equal(JSON.stringify(f.receipts).includes("offline-refresh-"), false);
});

test("unexpected tokens issued by accepted code replay are tracked and revoked before returning failure", async () => {
  const f = fixture({ codeReplayAccepted: true }), result = await f.run();
  assert.equal(result.status, "fail"); assert.equal(result.failure, "INVALID_GRANT_NOT_ENFORCED");
  assert.equal(result.grants[0].phase, "revoked"); assert.equal(f.clients.get("offline-client-1").active, false);
  assert.equal(result.grants[1].phase, "revoked"); assert.equal(f.clients.get("offline-client-2").active, false);
  assert.equal(result.failedAt, "code_replay"); assert.equal(result.checks.product_cleanup, "pass"); assert.equal(f.products.size, 0);
  const cleanupIndex = f.calls.findIndex(call => call.path === "/token" && new URLSearchParams(call.options.body).has("token")
    && new URLSearchParams(call.options.body).get("client_id") === "offline-client-2");
  assert.ok(cleanupIndex >= 0);
  const cleanup = f.calls.slice(cleanupIndex + 1);
  for (const serial of [3, 4]) {
    for (const path of ["/userinfo", "/mcp"]) assert.ok(cleanup.some(call => call.path === path && call.options.headers?.Authorization === `Bearer offline-access-${serial}`));
    assert.ok(cleanup.some(call => call.path === "/token" && new URLSearchParams(call.options.body).get("refresh_token") === `offline-refresh-${serial}`));
  }
  assert.equal(JSON.stringify(f.receipts).includes("offline-access-"), false);
  assert.equal(JSON.stringify(f.receipts).includes("offline-refresh-"), false);
});

test("tokens in an invalid initial response remain eligible for one cleanup revocation", async () => {
  const f = fixture(), base = f.dependencies.send;
  const result = await f.run({}, { send: async (path, options = {}) => {
    const result = await base(path, options);
    const form = path === "/token" && options.body ? new URLSearchParams(options.body) : undefined;
    if (form?.get("grant_type") === "authorization_code" && result.data?.access_token) result.data.resource = ORIGIN;
    return result;
  } });
  assert.equal(result.status, "fail"); assert.equal(result.failure, "TOKEN_RESPONSE_INVALID");
  assert.equal(result.grants[0].phase, "revoked"); assert.equal(f.clients.get("offline-client-1").active, false);
  assert.equal(f.calls.filter(call => call.path === "/token" && new URLSearchParams(call.options.body).has("token")).length, 1);
});

test("a lost revoke response checkpoints uncertainty and never sends a second revocation POST", async () => {
  const f = fixture(), base = f.dependencies.send; let revokePosts = 0, phaseBeforeWrite;
  const result = await f.run({}, { send: async (path, options = {}) => {
    const form = path === "/token" && options.body ? new URLSearchParams(options.body) : undefined;
    if (form?.has("token") && !form.has("grant_type")) {
      revokePosts++;
      phaseBeforeWrite = f.receipts.at(-1).grants[0].phase;
      const result = await base(path, options);
      if (revokePosts === 1) throw new Error("offline accepted revoke but response lost");
      return result;
    }
    return base(path, options);
  } });
  assert.equal(revokePosts, 1); assert.equal(phaseBeforeWrite, "revocation_pending");
  assert.notEqual(result.status, "single_identity_protocol_pass");
  assert.equal(result.grants[0].phase, "reconciliation_required");
  assert.equal(result.grants[0].cleanup, "reconciliation_required"); assert.notEqual(result.checks.revoke, "pass");
});

test("foreign synthetic exact-ID denial accepts only real Claude-profile not-found or forbidden responses", async () => {
  for (const faults of [{}, { foreignForbidden: true }, { foreignAccessible: true }, { foreignGenericError: true }]) {
    const f = fixture(faults), result = await f.run({ foreignProductId: FOREIGN_ID, foreignMarker: FOREIGN_MARKER });
    const rejected = faults.foreignAccessible || faults.foreignGenericError;
    assert.equal(result.status, rejected ? "fail" : "single_identity_protocol_pass");
    assert.equal(result.checks.foreign_product_exact_id_denied, rejected ? "fail" : "pass");
    if (!rejected) assert.deepEqual(result.foreignProduct, { idSha256: hash(FOREIGN_ID), markerSha256: hash(FOREIGN_MARKER) });
    assert.equal(result.hostedAcceptanceVerified, false);
  }
});

test("denial and deletion proof reject non-denial errors and ambiguous metadata through the real privacy boundary", async () => {
  const rejected = [
    ...[[401, "unauthorized"], [429, "rate_limited"], [500, "internal_error"],
      [503, "network_error"], [408, "request_timeout"], [504, "response_timeout"],
      [404, "request_timeout"], [403, "network_error"], [404, "invalid_response_after_success"]]
      .map(([status, code]) => handleToolError(new FrihetApiError(status, code, "PRIVATE_provider_message"))),
    handleToolError(new Error("PRIVATE_unexpected_error")),
    { isError: true, content: [{ type: "text", text: "Error: Resource not found. / Recurso no encontrado." }] },
    ...[false, "true", 1, { raw: "PRIVATE_meta" }].map(value => ({ ...NOT_FOUND, _meta: { "io.frihet/resourceNotFound": value } })),
    { ...NOT_FOUND, _meta: { "io.frihet/resourceNotFound": true, "io.frihet/accessDenied": true } },
    ...["authenticationRequired", "operationOutcomeUnknown", "transportOutcomeUnknown", "operationMayHaveCompleted", "retryable"]
      .map(flag => ({ ...NOT_FOUND, _meta: { "io.frihet/resourceNotFound": true, [`io.frihet/${flag}`]: true } })),
    { ...NOT_FOUND, structuredContent: { id: FOREIGN_ID, taxId: "PRIVATE_record" } },
    { ...NOT_FOUND, structuredContent: null },
    { ...NOT_FOUND, isError: false },
  ];
  for (const denial of rejected) {
    const foreign = fixture({ foreignResult: denial });
    const result = await foreign.run({ foreignProductId: FOREIGN_ID, foreignMarker: FOREIGN_MARKER });
    assert.equal(result.status, "fail", JSON.stringify(denial));
    assert.equal(result.checks.foreign_product_exact_id_denied, "fail");
    assert.equal(result.failure, "TOOL_RESULT_INVALID_OR_UNCERTAIN");
    assert.equal(foreign.products.size, 0);
    const cleanup = fixture({ cleanupReadbackResult: denial });
    const cleaned = await cleanup.run();
    assert.equal(cleaned.status, "fail", JSON.stringify(denial));
    assert.notEqual(cleaned.checks.product_cleanup, "pass");
    assert.equal(cleaned.productLedger[0].phase, "delete_readback_pending");
    assert.equal(cleanup.calls.filter(call => call.options.body?.includes('"delete_product"')).length, 1);
    assert.equal(JSON.stringify([...foreign.receipts, ...cleanup.receipts]).includes("PRIVATE_"), false);
  }
});

test("forbidden is foreign denial evidence but never proves deletion of an owned product", async () => {
  const f = fixture({ cleanupReadbackResult: FORBIDDEN }), result = await f.run();
  assert.equal(result.status, "fail");
  assert.notEqual(result.checks.product_cleanup, "pass");
  assert.equal(result.productLedger[0].phase, "delete_readback_pending");
  assert.equal(f.calls.filter(call => call.options.body?.includes('"delete_product"')).length, 1);
});

test("owner in-memory counterpart hook receives only own ID/marker while record exists, then cleanup runs", async () => {
  const f = fixture(); let calls = 0;
  const result = await f.run({}, { afterProductCreated: async payload => {
    calls++; assert.deepEqual(Object.keys(payload).sort(), ["id", "marker"]);
    assert.equal(Object.isFrozen(payload), true); assert.equal(f.products.get(payload.id).name, payload.marker);
    assert.equal(f.receipts.at(-1).productLedger[0].phase, "awaiting_owner_counterpart");
  } });
  assert.equal(calls, 1); assert.equal(result.status, "single_identity_protocol_pass"); assert.equal(f.products.size, 0);
});

test("counterpart hook failure still deletes only own new record and revokes own grant", async () => {
  const f = fixture(), result = await f.run({}, { afterProductCreated: async () => { throw new Error("offline-secret-password"); } });
  assert.equal(result.status, "fail"); assert.equal(f.products.size, 0); assert.equal(result.checks.product_cleanup, "pass");
  assert.equal(result.grants[0].phase, "revoked"); assert.equal(JSON.stringify(result).includes("offline-secret-password"), false);
});

test("bounded transport fixes origin, disables redirects and credentials, and rejects Location without echoing it", async () => {
  let calls = 0;
  const send = boundedTransport({ fetchImpl: async (url, options) => {
    calls++; assert.equal(url, `${ORIGIN}/health`); assert.equal(options.redirect, "manual"); assert.equal(options.credentials, "omit");
    return new Response(null, { status: 302, headers: { Location: "https://untrusted.invalid/offline-secret-password" } });
  } });
  await assert.rejects(send("https://untrusted.invalid/health"), /TARGET_REFUSED/u); assert.equal(calls, 0);
  await assert.rejects(send("/not-allowed"), /TARGET_REFUSED/u); assert.equal(calls, 0);
  await assert.rejects(send("/health"), error => error.message === "REDIRECT_REFUSED"); assert.equal(calls, 1);
});

test("body Content-Length and actual streamed bytes are bounded", async () => {
  for (const headers of [{ "content-length": "999" }, { "content-length": "invalid" }, {}]) {
    const send = boundedTransport({ maxBytes: 4, fetchImpl: async () => new Response("12345", { headers }) });
    await assert.rejects(send("/health"), /BODY_LIMIT/u);
  }
});

test("hung request and body produce bounded sanitized timeout without retries", async () => {
  for (const fetchImpl of [async () => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }))]) {
    const send = boundedTransport({ timeoutMs: 10, fetchImpl }); await assert.rejects(send("/health"), /TIMEOUT/u);
  }
});

test("SSE result is selected by request ID and cancels a still-open stream", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n')); }, cancel() { cancelled = true; } });
  const send = boundedTransport({ fetchImpl: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }) });
  const result = await send("/mcp", { method: "POST", rpcId: 7 });
  assert.deepEqual(result.data, { jsonrpc: "2.0", id: 7, result: { ok: true } }); assert.equal(cancelled, true);
});

test("receipt checkpoints are atomic mode0600, reject overwrite and symlink destinations, and detect outside changes", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "claude-offline-receipt-")));
  try {
    const path = join(directory, "receipt.json"), persist = privateReceiptWriter(path);
    persist({ status: "running" }); persist({ status: "done" });
    assert.equal(statSync(path).mode & 0o777, 0o600); assert.deepEqual(JSON.parse(readFileSync(path)), { status: "done" });
    assert.throws(() => privateReceiptWriter(path), /RECEIPT_ALREADY_EXISTS_OR_UNSAFE/u);
    const destination = join(directory, "destination.txt"); writeFileSync(destination, "preserve");
    const symlink = join(directory, "symlink.json"); symlinkSync(destination, symlink);
    assert.throws(() => privateReceiptWriter(symlink), /RECEIPT_ALREADY_EXISTS_OR_UNSAFE/u); assert.equal(readFileSync(destination, "utf8"), "preserve");
    chmodSync(path, 0o644);
    assert.throws(() => persist({ status: "overwrite" }), /RECEIPT_CHANGED_EXTERNALLY/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("CLI only accepts token descriptor number, never token/password argv or mode ambiguity", () => {
  assert.deepEqual(parseArguments([]), {});
  assert.deepEqual(parseArguments(["--dry-run"]), { hosted: false });
  assert.deepEqual(parseArguments(["--dry-run", "--consultation"]), { hosted: false, consultation: true });
  assert.equal(parseArguments(["--hosted", "--firebase-token-fd", "3", "--output", "/private/receipt.json"]).tokenFd, 3);
  for (const args of [["--token", fakeToken()], ["--password", "bad"], ["toString", "bad"], ["--token-fd", "not-a-number"], ["--hosted"], ["--dry-run", "--hosted"], ["--consultation", "--consultation"]]) assert.throws(() => parseArguments(args));
});

test("actual CLI defaults to zero-network dry-run and emits only sanitized non-readiness summary", () => {
  const run = spawnSync(process.execPath, [new URL("../claude-hosted-acceptance.mjs", import.meta.url).pathname], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { status: "dry_run", hostedAcceptanceVerified: false, submissionReady: false, privateReceiptWritten: false });
});
