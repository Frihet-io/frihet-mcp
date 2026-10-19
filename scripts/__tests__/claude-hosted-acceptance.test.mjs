/** Offline only: all network, Firebase input and deployment admission are fake. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ORIGIN, RESOURCE, SCOPES, FIREBASE_PROJECT, boundedTransport, parseArguments, privateReceiptWriter, runAcceptance, validateFirebaseInput } from "../claude-hosted-acceptance.mjs";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const UID = "offline-only-synthetic-qa";
const hash = value => createHash("sha256").update(value).digest("hex");
const SHA = "a".repeat(40), UID_HASH = hash(UID);
const CONTRACT = JSON.parse(readFileSync(new URL("../../src/__tests__/fixtures/claude-candidate-contract.json", import.meta.url), "utf8"));
const NOT_FOUND = { isError: true, content: [{ type: "text", text: "Error: Resource not found. / Recurso no encontrado." }] };
const FORBIDDEN = { isError: true, content: [{ type: "text", text: "Error: Access denied. Reconnect Frihet or use configured credentials with permission for this action. / Acceso denegado. Vuelve a conectar Frihet o usa credenciales con permiso para esta accion." }] };
const FOREIGN_ID = "foreign-synthetic-product", FOREIGN_MARKER = `FRIHET-QA-${"b".repeat(32)}`;
function fakeToken(overrides = {}) {
  const part = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", kid: "offline-key-only" })}.${part({ aud: FIREBASE_PROJECT,
    iss: `https://securetoken.google.com/${FIREBASE_PROJECT}`, sub: UID, email_verified: true,
    iat: NOW / 1000, exp: NOW / 1000 + 3600, ...overrides })}.offline_signature`;
}
const response = (status, data, headers = {}, text = "") => ({ status, data, text, headers: new Headers(headers) });

function fixture(faults = {}) {
  const calls = [], receipts = [], clients = new Map(), access = new Map(), refreshTokens = new Map(), products = new Map();
  let clientCount = 0, tokenCount = 0, reads = 0, admissions = 0;
  const publicData = {
    "/health": { status: "ok", accessProfile: "claude", releaseSha: faults.releaseSha ?? SHA },
    "/.well-known/oauth-authorization-server": { issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/authorize`, token_endpoint: `${ORIGIN}/token`, registration_endpoint: `${ORIGIN}/register`, revocation_endpoint: `${ORIGIN}/token`, scopes_supported: SCOPES, code_challenge_methods_supported: ["S256"] },
    "/.well-known/oauth-protected-resource": { resource: ORIGIN, authorization_servers: [ORIGIN], scopes_supported: SCOPES },
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
        if (client.redeemed) return faults.codeReplayAccepted ? tokens(client) : invalid();
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
      const done = (result, headers) => response(200, { jsonrpc: "2.0", id, result }, headers);
      if (request.method === "initialize") return done({ protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "offline-server", version: "1" } }, { "mcp-session-id": `v1.${"s".repeat(24)}.${"a".repeat(64)}` });
      assert.ok(options.headers["Mcp-Session-Id"]); assert.equal(options.headers["MCP-Protocol-Version"], "2025-03-26");
      if (request.method === "notifications/initialized") return response(202);
      if (request.method === "tools/list") return done({ tools: faults.catalogMismatch ? [] : CONTRACT.tools.grouped });
      if (request.method === "resources/list") return done({ resources: CONTRACT.resources.remote });
      if (request.method === "prompts/list") return done({ prompts: CONTRACT.prompts });
      if (request.method === "resources/read") { assert.equal(params.uri, "frihet://config/currencies"); return done(CONTRACT.currencies); }
      if (request.method === "prompts/get") return done(CONTRACT.promptContent.find(item => item.name === params.name).result);
      assert.equal(request.method, "tools/call");
      const { name, arguments: input } = params;
      if (name === "get_product" && input.id === FOREIGN_ID) {
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
      if (name === "get_product") return done(products.has(input.id) ? { structuredContent: structuredClone(products.get(input.id)), content: [] } : NOT_FOUND);
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
  };
  return {
    dependencies, calls, receipts, clients, products, reads: () => reads, admissions: () => admissions,
    run: (options = {}, overrides = {}) => runAcceptance({ hosted: true, expectedSha: SHA, expectedUidHash: UID_HASH, label: "offline_qa", ...options }, { ...dependencies, ...overrides }),
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

test("complete offline single-identity lifecycle validates real contract, CRUD, rotation, revocation and reconnect", async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.status, "single_identity_protocol_pass", JSON.stringify(result));
  assert.ok(Object.entries(result.checks).filter(([name]) => name !== "foreign_product_exact_id_denied").every(([, value]) => value === "pass"));
  assert.deepEqual([result.catalog.tools, result.catalog.resources, result.catalog.prompts], [132, 1, 2]);
  assert.equal(result.productLedger[0].phase, "deleted_and_not_found"); assert.equal(f.products.size, 0);
  assert.equal(f.clients.size, 2); assert.equal([...f.clients.values()].some(client => client.active), false);
  assert.equal(f.reads(), 1); assert.equal(f.admissions(), 1);
  assert.equal(result.hostedAcceptanceVerified, false); assert.equal(result.submissionReady, false); assert.equal(result.independentBackendCleanupVerified, false);
  assert.ok(result.unexercised.includes("actual_claude_client_journey"));
  const serialized = JSON.stringify(f.receipts);
  for (const value of [fakeToken(), UID, "offline-access-", "offline-refresh-", "offline-code-", "offline-state-", "offline-secret-password"]) assert.equal(serialized.includes(value), false, value);
});

test("deployment guard or public release mismatch stops before any credential read or DCR", async () => {
  for (const faults of [{ guardRejected: true }, { releaseSha: "b".repeat(40) }, { networkAt: "/health" }]) {
    const f = fixture(faults), result = await f.run();
    assert.ok(["fail", "inconclusive"].includes(result.status)); assert.equal(f.reads(), 0);
    assert.equal(f.calls.some(call => call.path === "/register"), false);
    assert.equal(JSON.stringify(result).includes("offline-secret-password"), false);
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

test("callback target/state, UserInfo principal and replays fail closed without business writes", async () => {
  for (const faults of [{ callbackTarget: "https://untrusted.invalid/callback" }, { wrongState: true }, { wrongUser: true }, { callbackReplayAccepted: true }, { codeReplayAccepted: true }, { catalogMismatch: true }]) {
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
  assert.equal(result.productLedger[0].unverifiedReturnedId, "offline-product-1"); assert.equal(result.productLedger[0].id, null);
});

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
  for (const faults of [{ revocationIneffective: true }, { replayIneffective: true }]) {
    const f = fixture(faults), result = await f.run(); assert.equal(result.status, "fail");
    assert.equal(result.independentBackendCleanupVerified, false);
    if (faults.revocationIneffective) assert.notEqual(result.checks.revoke, "pass");
    else assert.notEqual(result.checks.refresh_replay, "pass");
  }
});

test("foreign synthetic exact-ID denial accepts only sanitized not-found or forbidden responses", async () => {
  for (const faults of [{}, { foreignForbidden: true }, { foreignAccessible: true }, { foreignGenericError: true }]) {
    const f = fixture(faults), result = await f.run({ foreignProductId: FOREIGN_ID, foreignMarker: FOREIGN_MARKER });
    const rejected = faults.foreignAccessible || faults.foreignGenericError;
    assert.equal(result.status, rejected ? "fail" : "single_identity_protocol_pass");
    assert.equal(result.checks.foreign_product_exact_id_denied, rejected ? "fail" : "pass");
    if (!rejected) assert.deepEqual(result.foreignProduct, { idSha256: hash(FOREIGN_ID), markerSha256: hash(FOREIGN_MARKER) });
    assert.equal(result.hostedAcceptanceVerified, false);
  }
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
  assert.equal(parseArguments(["--hosted", "--firebase-token-fd", "3", "--output", "/private/receipt.json"]).tokenFd, 3);
  for (const args of [["--token", fakeToken()], ["--password", "bad"], ["toString", "bad"], ["--token-fd", "not-a-number"], ["--hosted"], ["--dry-run", "--hosted"]]) assert.throws(() => parseArguments(args));
});

test("actual CLI defaults to zero-network dry-run and emits only sanitized non-readiness summary", () => {
  const run = spawnSync(process.execPath, [new URL("../claude-hosted-acceptance.mjs", import.meta.url).pathname], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { status: "dry_run", hostedAcceptanceVerified: false, submissionReady: false, privateReceiptWritten: false });
});
