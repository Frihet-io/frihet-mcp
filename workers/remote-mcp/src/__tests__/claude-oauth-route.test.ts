/** Local route integration: actual auth handler and locked OAuth SDK; synthetic KV, DO and ERP authority. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CLAUDE_MCP_RESOURCE, CLAUDE_ORIGIN } from "../oauth-profile.ts";
import { OPENAI_REVIEW_OAUTH_SCOPES } from "../../../../src/openai-review-oauth.ts";
import {
  CLAUDE_REDIRECT_URI,
  createOAuthRouteHarness,
  mintIdToken,
  USER_ID,
  type PostFault,
} from "./support/oauth-route-harness.ts";

type Harness = Awaited<ReturnType<typeof createOAuthRouteHarness>>;

function assertNoSecretsInLogs(h: Harness, idToken: string): void {
  for (const secret of [idToken, ...h.erp.issuedApiKeys(), String(h.env.FRIHET_OAUTH_API_KEY), String(h.env.FRIHET_CLAUDE_OAUTH_API_KEY)]) {
    for (const log of h.logs) assert.equal(log.includes(secret), false, "synthetic credential reached a log");
  }
}

for (const [label, configured] of [
  ["non-QA identity", JSON.stringify(["other-synthetic-qa-user"])],
  ["missing config", undefined],
  ["malformed JSON", "{"],
  ["empty list", "[]"],
  ["invalid member", JSON.stringify([USER_ID, "user/path"])],
  ["duplicate member", JSON.stringify([USER_ID, USER_ID])],
] as const) {
  test(`Claude callback refuses ${label} before arming, provisioning or completing a grant`, async (t) => {
    const h = await createOAuthRouteHarness(t, { profile: "claude" });
    const { stateKey } = await h.startLogin();
    if (configured === undefined) delete h.env.FRIHET_CLAUDE_QA_UIDS;
    else h.env.FRIHET_CLAUDE_QA_UIDS = configured;
    const idToken = await mintIdToken();
    const response = await h.callback(stateKey, idToken);
    assert.equal(response.status, 503);
    assert.equal("redirectTo" in response.body, false);
    assert.equal(h.events.includes("do:/attempt"), false);
    assert.equal(h.erp.requests.length, 0);
    assert.equal(h.kv.grantKeys().length, 0);
    assertNoSecretsInLogs(h, idToken);
  });
}

test("Claude QA membership cannot be spoofed with a caller UID when the verified Firebase user is outside the pilot", async (t) => {
  const h = await createOAuthRouteHarness(t, { profile: "claude" });
  const { stateKey } = await h.startLogin();
  const idToken = await mintIdToken({ uid: "non-qa-firebase-user" });
  const response = await h.send(new Request(`${CLAUDE_ORIGIN}/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stateKey, idToken, uid: USER_ID, userId: USER_ID, accessProfile: "full" }),
  }));
  assert.equal(response.status, 503);
  assert.equal(h.events.includes("do:/attempt"), false);
  assert.equal(h.erp.requests.length, 0);
  assert.equal(h.kv.grantKeys().length, 0);
  assertNoSecretsInLogs(h, idToken);
});

test("Claude authorization-code exchange rechecks current QA membership after the callback", async (t) => {
  const h = await createOAuthRouteHarness(t, { profile: "claude" });
  const { clientId, stateKey } = await h.startLogin();
  const completed = await h.callback(stateKey, await mintIdToken());
  assert.equal(completed.status, 200);
  h.env.FRIHET_CLAUDE_QA_UIDS = JSON.stringify(["other-synthetic-qa-user"]);
  const code = new URL(String(completed.body.redirectTo)).searchParams.get("code");
  assert.ok(code);
  const response = await h.exchangeToken(new URLSearchParams({
    grant_type: "authorization_code", client_id: clientId, code,
    redirect_uri: h.redirectUri, code_verifier: "v".repeat(64),
  }));
  assert.equal(response.status, 503);
  const rejected = await response.json() as Record<string, unknown>;
  assert.equal(rejected.error, "temporarily_unavailable");
  assert.equal("access_token" in rejected || "refresh_token" in rejected, false);
  assert.equal([...h.namespace.objects.values()].some(({ state }) => state.storage.values.has("oauth_token_family")), false);
});

for (const [label, configured] of [
  ["removed UID", JSON.stringify(["other-synthetic-qa-user"])],
  ["missing config", undefined],
  ["malformed config", JSON.stringify([USER_ID, null])],
] as const) {
  test(`Claude ${label} blocks existing MCP access and refresh while disconnect and alarm cleanup remain available`, async (t) => {
    const h = await createOAuthRouteHarness(t, { profile: "claude" });
    const { clientId, stateKey } = await h.startLogin();
    const completed = await h.callback(stateKey, await mintIdToken());
    assert.equal(completed.status, 200);
    const initial = await h.redeem(clientId, completed.body.redirectTo);
    if (configured === undefined) delete h.env.FRIHET_CLAUDE_QA_UIDS;
    else h.env.FRIHET_CLAUDE_QA_UIDS = configured;
    for (const method of ["GET", "POST"]) {
      const mcp = await h.send(new Request(`${CLAUDE_ORIGIN}/mcp`, {
        method,
        headers: { Authorization: `Bearer ${initial.accessToken}` },
        ...(method === "POST" ? { body: JSON.stringify({ uid: USER_ID }) } : {}),
      }));
      assert.equal(mcp.status, 503, method);
    }
    const sessionDelete = await h.send(new Request(`${CLAUDE_ORIGIN}/mcp`, {
      method: "DELETE", headers: { Authorization: `Bearer ${initial.accessToken}` },
    }));
    assert.equal(sessionDelete.status, 200, "authenticated session-cleanup adapter is still reachable");
    const refreshed = await h.exchangeToken(new URLSearchParams({
      grant_type: "refresh_token", client_id: clientId, refresh_token: initial.refreshToken,
    }));
    assert.equal(refreshed.status, 503);
    const rejected = await refreshed.json() as Record<string, unknown>;
    assert.equal(rejected.error, "temporarily_unavailable");
    assert.equal("access_token" in rejected || "refresh_token" in rejected, false);
    const disconnected = await h.exchangeToken(new URLSearchParams({
      token: initial.refreshToken, client_id: clientId, token_type_hint: "refresh_token",
    }));
    assert.equal(disconnected.status, 200);
    assert.equal(h.kv.grantKeys().length, 0);
    await h.runFamilyAlarms();
    assert.deepEqual(h.erp.activeKeyIds(), []);
    assert.deepEqual(h.erp.requests.at(-1), { method: "DELETE", body: { uid: initial.userId, correlationId: h.erp.postCorrelations[0] } });
    assert.equal(h.erp.correlations.get(h.erp.postCorrelations[0]!)?.tombstoned, true);
  });
}

test("OpenAI OAuth and MCP access ignore the Claude-only private QA config", async (t) => {
  const h = await createOAuthRouteHarness(t);
  h.env.FRIHET_CLAUDE_QA_UIDS = "{";
  const { clientId, stateKey } = await h.startLogin();
  const completed = await h.callback(stateKey, await mintIdToken());
  assert.equal(completed.status, 200);
  const initial = await h.redeem(clientId, completed.body.redirectTo);
  const refreshed = await h.exchangeToken(new URLSearchParams({
    grant_type: "refresh_token", client_id: clientId, refresh_token: initial.refreshToken,
  }));
  assert.equal(refreshed.status, 200);
  const tokens = await refreshed.json() as { access_token: string };
  assert.equal((await h.callMcp(tokens.access_token)).status, 200);
});

const CUSTOMER_UID = "verified-frihet-customer";
const customerPolicy = () => JSON.stringify({ version: 1, mode: "customers", qaUids: [USER_ID] });

function credentialSnapshot(h: Harness) {
  return {
    kv: structuredClone([...h.kv.values.entries()]),
    // Resolving a stub for a read can instantiate an empty fake DO; compare
    // persisted storage and alarms, not transient in-memory instances.
    families: [...h.namespace.objects.entries()].filter(([, { state }]) => state.storage.values.size > 0 || state.storage.alarmAt !== null).map(([name, { state }]) => ({
      name, values: structuredClone([...state.storage.values.entries()]), alarm: state.storage.alarmAt,
    })),
    activeKeys: h.erp.activeKeyIds(),
    backendRequests: structuredClone(h.erp.requests),
  };
}

test("customer admission verifies Firebase without adding the customer to QA or widening OAuth scope", async (t) => {
  const h = await createOAuthRouteHarness(t, { profile: "claude" });
  h.env.FRIHET_CLAUDE_QA_UIDS = customerPolicy();
  const { clientId, stateKey } = await h.startLogin();
  const idToken = await mintIdToken({ uid: CUSTOMER_UID });
  const completed = await h.callback(stateKey, idToken);
  assert.equal(completed.status, 200);
  const initial = await h.redeem(clientId, completed.body.redirectTo);
  assert.equal(initial.userId, CUSTOMER_UID);
  assert.equal(initial.tokens.scope, OPENAI_REVIEW_OAUTH_SCOPES.join(" "));
  assert.deepEqual(JSON.parse(String(h.env.FRIHET_CLAUDE_QA_UIDS)).qaUids, [USER_ID]);
  assertNoSecretsInLogs(h, idToken);
});

for (const mode of ["qa", "customers"]) {
  for (const claims of [{ emailVerified: false }, { emailVerified: "true" }, { email: undefined }, { email: "invalid" }]) {
    test(`Claude ${mode} callback refuses invalid verified Firebase claims despite caller identity fields: ${JSON.stringify(claims)}`, async (t) => {
      const h = await createOAuthRouteHarness(t, { profile: "claude" });
      h.env.FRIHET_CLAUDE_QA_UIDS = JSON.stringify({ version: 1, mode, qaUids: [USER_ID] });
      const { stateKey } = await h.startLogin();
      const response = await h.send(new Request(`${CLAUDE_ORIGIN}/callback`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stateKey, idToken: await mintIdToken(claims), uid: USER_ID, email: "caller@example.com", emailVerified: true }),
      }));
      assert.equal(response.status, 403);
      assert.equal(h.events.includes("do:/attempt"), false);
      assert.deepEqual(h.erp.requests, []);
      assert.deepEqual(h.kv.grantKeys(), []);
    });
  }
}

test("customer authorization code pauses without consuming or provisioning, then the same code resumes", async (t) => {
  const h = await createOAuthRouteHarness(t, { profile: "claude" });
  h.env.FRIHET_CLAUDE_QA_UIDS = customerPolicy();
  const { clientId, stateKey } = await h.startLogin();
  const completed = await h.callback(stateKey, await mintIdToken({ uid: CUSTOMER_UID }));
  assert.equal(completed.status, 200);
  const code = new URL(String(completed.body.redirectTo)).searchParams.get("code");
  assert.ok(code);
  const form = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code,
    redirect_uri: h.redirectUri, code_verifier: "v".repeat(64) });
  h.env.FRIHET_CLAUDE_QA_UIDS = JSON.stringify([USER_ID]);
  const before = credentialSnapshot(h);
  const invalidPkce = new URLSearchParams(form);
  invalidPkce.set("code_verifier", "x".repeat(64));
  const invalid = await h.exchangeToken(invalidPkce);
  assert.equal(invalid.status, 400, "invalid PKCE stays invalid rather than becoming a policy response");
  assert.deepEqual(credentialSnapshot(h), before);
  const paused = await h.exchangeToken(form);
  assert.equal(paused.status, 503);
  assert.equal((await paused.json() as { error: string }).error, "temporarily_unavailable");
  assert.deepEqual(credentialSnapshot(h), before);
  h.env.FRIHET_CLAUDE_QA_UIDS = customerPolicy();
  const resumed = await h.exchangeToken(form);
  assert.equal(resumed.status, 200);
  const tokens = await resumed.json() as { access_token: string };
  assert.equal((await h.callMcp(tokens.access_token)).status, 200);
  assert.equal(h.erp.postCorrelations.length, 1);
});

test("customer access and current refresh pause without changing KV, token-family hashes, alarms or API key and resume", async (t) => {
  const h = await createOAuthRouteHarness(t, { profile: "claude" });
  h.env.FRIHET_CLAUDE_QA_UIDS = customerPolicy();
  const { clientId, stateKey } = await h.startLogin();
  const completed = await h.callback(stateKey, await mintIdToken({ uid: CUSTOMER_UID }));
  const initial = await h.redeem(clientId, completed.body.redirectTo);
  const form = new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: initial.refreshToken });
  const before = credentialSnapshot(h);
  for (const policy of [JSON.stringify([USER_ID]), "{", JSON.stringify({ version: 1, mode: "qa", qaUids: [USER_ID] })]) {
    h.env.FRIHET_CLAUDE_QA_UIDS = policy;
    assert.equal((await h.callMcp(initial.accessToken)).status, 503);
    const paused = await h.exchangeToken(form);
    assert.equal(paused.status, 503);
    assert.equal((await paused.json() as { error: string }).error, "temporarily_unavailable");
    assert.deepEqual(credentialSnapshot(h), before);
  }
  h.env.FRIHET_CLAUDE_QA_UIDS = customerPolicy();
  assert.equal((await h.callMcp(initial.accessToken)).status, 200);
  const resumed = await h.exchangeToken(form);
  assert.equal(resumed.status, 200, "the exact unconsumed refresh remains redeemable");
  assert.deepEqual(h.erp.activeKeyIds(), [initial.keyId]);
  assert.equal(h.erp.postCorrelations.length, 1);
});

test("customer policy pause cannot disguise previous-refresh replay as temporary unavailability", async (t) => {
  const h = await createOAuthRouteHarness(t, { profile: "claude" });
  h.env.FRIHET_CLAUDE_QA_UIDS = customerPolicy();
  const { clientId, stateKey } = await h.startLogin();
  const completed = await h.callback(stateKey, await mintIdToken({ uid: CUSTOMER_UID }));
  const initial = await h.redeem(clientId, completed.body.redirectTo);
  const oldForm = new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: initial.refreshToken });
  const rotated = await h.exchangeToken(oldForm);
  assert.equal(rotated.status, 200);
  const tokens = await rotated.json() as { access_token: string; refresh_token: string };
  h.env.FRIHET_CLAUDE_QA_UIDS = JSON.stringify([USER_ID]);
  const replay = await h.exchangeToken(oldForm);
  assert.equal(replay.status, 400);
  assert.equal((await replay.json() as { error: string }).error, "invalid_grant");
  assert.equal((await h.callMcp(tokens.access_token)).status, 401, "revocation precedes policy response");
  await h.runFamilyAlarms();
  assert.deepEqual(h.erp.activeKeyIds(), []);
  assert.deepEqual(h.kv.grantKeys(), []);
});

for (const invalidState of ["expired", "revoked"] as const) {
  test(`Claude policy pause still rejects and cleans a truly ${invalidState} token family`, async (t) => {
    const h = await createOAuthRouteHarness(t, { profile: "claude" });
    h.env.FRIHET_CLAUDE_QA_UIDS = customerPolicy();
    const { clientId, stateKey } = await h.startLogin();
    const completed = await h.callback(stateKey, await mintIdToken({ uid: CUSTOMER_UID }));
    const initial = await h.redeem(clientId, completed.body.redirectTo);
    const family = [...h.namespace.objects.values()].find(({ state }) => state.storage.values.has("oauth_token_family"));
    assert.ok(family);
    const record = structuredClone(family.state.storage.values.get("oauth_token_family")) as Record<string, unknown>;
    if (invalidState === "expired") record.expiresAtMs = Date.now() - 1;
    else record.status = "revoked";
    family.state.storage.values.set("oauth_token_family", record);
    h.env.FRIHET_CLAUDE_QA_UIDS = JSON.stringify([USER_ID]);
    const response = await h.exchangeToken(new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: initial.refreshToken }));
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: string }).error, "invalid_grant");
    await h.runFamilyAlarms();
    assert.deepEqual(h.erp.activeKeyIds(), []);
    assert.deepEqual(h.kv.grantKeys(), []);
  });
}

test("paused customers can revoke their own grant while another OAuth client cannot revoke it", async (t) => {
  const h = await createOAuthRouteHarness(t, { profile: "claude" });
  h.env.FRIHET_CLAUDE_QA_UIDS = customerPolicy();
  const { clientId, stateKey } = await h.startLogin();
  const completed = await h.callback(stateKey, await mintIdToken({ uid: CUSTOMER_UID }));
  const initial = await h.redeem(clientId, completed.body.redirectTo);
  const otherClientId = await h.register();
  h.env.FRIHET_CLAUDE_QA_UIDS = JSON.stringify([USER_ID]);
  const before = credentialSnapshot(h);
  const foreign = await h.exchangeToken(new URLSearchParams({ token: initial.refreshToken, client_id: otherClientId, token_type_hint: "refresh_token" }));
  assert.equal(foreign.status, 200, "RFC7009 gives no token-existence information");
  assert.deepEqual(credentialSnapshot(h), before);
  const owner = await h.exchangeToken(new URLSearchParams({ token: initial.refreshToken, client_id: clientId, token_type_hint: "refresh_token" }));
  assert.equal(owner.status, 200);
  await h.runFamilyAlarms();
  assert.deepEqual(h.erp.activeKeyIds(), []);
  assert.deepEqual(h.kv.grantKeys(), []);
});

test("Claude local SDK route completes DCR, Firebase verification, credential binding, token redemption and MCP access", async (t) => {
  const h = await createOAuthRouteHarness(t, { profile: "claude" });
  assert.equal(h.origin, CLAUDE_ORIGIN);
  assert.equal(h.mcpResource, CLAUDE_MCP_RESOURCE);
  const { clientId, stateKey } = await h.startLogin();
  const client = await h.kv.get(`client:${clientId}`, { type: "json" }) as { redirectUris: string[] };
  assert.deepEqual(client.redirectUris, [CLAUDE_REDIRECT_URI]);
  const idToken = await mintIdToken();
  const completed = await h.callback(stateKey, idToken);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const redirect = new URL(String(completed.body.redirectTo));
  assert.equal(`${redirect.origin}${redirect.pathname}`, CLAUDE_REDIRECT_URI);
  assert.equal(redirect.searchParams.get("state"), "client-state");
  const mcp = await h.redeem(clientId, completed.body.redirectTo);
  assert.equal(mcp.tokens.resource, CLAUDE_MCP_RESOURCE);
  assert.deepEqual(h.erp.activeKeyIds(), [mcp.keyId]);
  assert.equal(h.kv.grantKeys().length, 1);
  const grant = await h.kv.get(h.kv.grantKeys()[0]!, { type: "json" }) as { resource: string };
  assert.equal(grant.resource, CLAUDE_MCP_RESOURCE);
  const family = [...h.namespace.objects.values()]
    .map(({ state }) => state.storage.values.get("oauth_token_family"))
    .find(Boolean) as { accessProfile: string; apiKeyBinding: Record<string, unknown> };
  assert.equal(family.accessProfile, "claude");
  assert.deepEqual(family.apiKeyBinding, {
    uid: mcp.userId,
    keyId: mcp.keyId,
    accessProfile: "claude",
    oauthResource: CLAUDE_ORIGIN,
    correlationId: h.erp.postCorrelations[0],
  });
  assert.deepEqual(h.erp.requests[0]?.body, { uid: mcp.userId, correlationId: h.erp.postCorrelations[0] });
  assert.match(h.erp.postCorrelations[0]!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  const callbackReplay = await h.callback(stateKey, idToken);
  assert.equal(callbackReplay.status, 400);
  assert.equal(h.erp.postCorrelations.length, 1);
  const foreignMcp = await h.send(new Request("https://openai-mcp.frihet.io/mcp", {
    method: "POST", headers: { Authorization: `Bearer ${mcp.accessToken}` }, body: "{}",
  }));
  assert.equal(foreignMcp.status, 401, "the real provider rejects the token's foreign target");
  assertNoSecretsInLogs(h, idToken);
});

for (const fault of ["lost-after", "timeout-after"] as const) {
  test(`Claude local callback ${fault} revokes the uncertain key before the same state retries`, async (t) => {
    const h = await createOAuthRouteHarness(t, { profile: "claude" });
    const { clientId, stateKey } = await h.startLogin();
    const idToken = await mintIdToken();
    h.erp.postFaults.push({ kind: fault } satisfies PostFault);
    const failed = await h.callback(stateKey, idToken);
    assert.equal(failed.status, 502);
    assert.equal("redirectTo" in failed.body, false);
    assert.deepEqual(h.erp.activeKeyIds(), []);
    assert.equal(h.kv.grantKeys().length, 0);
    const retry = await h.callback(stateKey, idToken);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    const mcp = await h.redeem(clientId, retry.body.redirectTo);
    assert.deepEqual(h.erp.activeKeyIds(), [mcp.keyId]);
    assert.equal(h.erp.keys.size, 2, "the earlier synthetic key was revoked, not left active");
    assert.equal(new Set(h.erp.postCorrelations).size, 2);
    for (const { body } of h.erp.requests) {
      assert.deepEqual(Object.keys(body).sort(), ["correlationId", "uid"]);
      assert.equal("accessProfile" in body || "oauthResource" in body, false);
    }
    assertNoSecretsInLogs(h, idToken);
  });
}

test("Claude authorize rejects foreign resources and the origin alias before allocating state", async (t) => {
  const h = await createOAuthRouteHarness(t, { profile: "claude" });
  const clientId = await h.register();
  for (const resource of [
    CLAUDE_ORIGIN,
    "https://openai-mcp.frihet.io/mcp",
    "https://mcp.frihet.io/mcp",
    `${CLAUDE_MCP_RESOURCE}/`,
    `${CLAUDE_MCP_RESOURCE}?scope=full`,
    "https://claude-mcp.frihet.io.evil.example/mcp",
  ]) {
    const response = await h.authorize(clientId, resource);
    assert.equal(response.status, 400, resource);
    assert.equal((await response.json() as { error: string }).error, "invalid_target");
  }
  assert.equal(h.namespace.objects.size, 0);
  assert.equal(h.erp.requests.length, 0);
  assert.equal(h.kv.grantKeys().length, 0);
});

test("Claude callback derives identity/profile from Firebase and Worker; caller overrides never reach provisioning", async (t) => {
  const h = await createOAuthRouteHarness(t, { profile: "claude" });
  const { clientId, stateKey } = await h.startLogin();
  const response = await h.send(new Request(`${CLAUDE_ORIGIN}/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stateKey,
      idToken: await mintIdToken(),
      uid: "caller-chosen-user",
      accessProfile: "openai",
      oauthResource: "https://openai-mcp.frihet.io",
    }),
  }));
  assert.equal(response.status, 200);
  const completed = await response.json() as { redirectTo: string };
  const mcp = await h.redeem(clientId, completed.redirectTo);
  assert.equal(mcp.userId, "firebase-route-user");
  assert.equal(mcp.tokens.resource, CLAUDE_MCP_RESOURCE);
  assert.deepEqual(h.erp.requests[0]?.body, { uid: mcp.userId, correlationId: h.erp.postCorrelations[0] });
});

test("Claude callback with missing service secret refuses before arming and never falls back to OpenAI", async (t) => {
  const h = await createOAuthRouteHarness(t, { profile: "claude" });
  const { stateKey } = await h.startLogin();
  delete h.env.FRIHET_CLAUDE_OAUTH_API_KEY;
  const response = await h.callback(stateKey, await mintIdToken());
  assert.equal(response.status, 503);
  assert.equal(h.events.includes("do:/attempt"), false);
  assert.equal(h.erp.requests.length, 0);
  assert.deepEqual(h.erp.activeKeyIds(), []);
});

test("Claude local SDK refresh rotates once; replay tombstones the family and cleanup revokes its backend key", async (t) => {
  const h = await createOAuthRouteHarness(t, { profile: "claude" });
  const { clientId, stateKey } = await h.startLogin();
  const completed = await h.callback(stateKey, await mintIdToken());
  assert.equal(completed.status, 200);
  const initial = await h.redeem(clientId, completed.body.redirectTo);
  const form = new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: initial.refreshToken });
  const refreshed = await h.exchangeToken(form);
  assert.equal(refreshed.status, 200);
  const tokens = await refreshed.json() as { access_token: string; refresh_token: string; resource: string };
  assert.equal(tokens.resource, CLAUDE_MCP_RESOURCE);
  assert.notEqual(tokens.refresh_token, initial.refreshToken);
  assert.equal((await h.callMcp(tokens.access_token)).status, 200);
  const replay = await h.exchangeToken(form);
  assert.equal(replay.status, 400);
  const rejected = await replay.json() as Record<string, unknown>;
  assert.equal(rejected.error, "invalid_grant");
  assert.equal("access_token" in rejected || "refresh_token" in rejected, false);
  assert.equal((await h.callMcp(tokens.access_token)).status, 401);
  await h.runFamilyAlarms();
  assert.deepEqual(h.erp.activeKeyIds(), []);
  assert.equal(h.kv.grantKeys().length, 0);
  assert.equal([...h.namespace.objects.values()].some(({ state }) => state.storage.values.has("oauth_token_family_cleanup")), false);
  assert.equal(h.erp.correlations.get(h.erp.postCorrelations[0]!)?.tombstoned, true);
});

test("Claude local refresh-token disconnect removes the SDK grant and revokes the exact backend credential", async (t) => {
  const h = await createOAuthRouteHarness(t, { profile: "claude" });
  const { clientId, stateKey } = await h.startLogin();
  const completed = await h.callback(stateKey, await mintIdToken());
  assert.equal(completed.status, 200);
  const initial = await h.redeem(clientId, completed.body.redirectTo);
  const response = await h.exchangeToken(new URLSearchParams({ token: initial.refreshToken, client_id: clientId, token_type_hint: "refresh_token" }));
  assert.equal(response.status, 200);
  assert.equal((await h.callMcp(initial.accessToken)).status, 401);
  await h.runFamilyAlarms();
  assert.deepEqual(h.erp.activeKeyIds(), []);
  assert.equal(h.kv.grantKeys().length, 0);
  assert.deepEqual(h.erp.requests.at(-1), { method: "DELETE", body: { uid: initial.userId, correlationId: h.erp.postCorrelations[0] } });
  assert.equal(h.erp.correlations.get(h.erp.postCorrelations[0]!)?.tombstoned, true);
});

for (const host of ["localhost", "127.0.0.1"]) {
  test(`Claude Code local SDK flow accepts ${host} callback ports that differ from DCR registration`, async (t) => {
    const registeredRedirectUri = `http://${host}:8080/oauth/callback?client=claude-code`;
    const redirectUri = `http://${host}:49152/oauth/callback?client=claude-code`;
    const h = await createOAuthRouteHarness(t, { profile: "claude", registeredRedirectUri, redirectUri });
    const { clientId, stateKey } = await h.startLogin();
    const client = await h.kv.get(`client:${clientId}`, { type: "json" }) as { redirectUris: string[] };
    assert.deepEqual(client.redirectUris, [registeredRedirectUri]);
    const completed = await h.callback(stateKey, await mintIdToken());
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    const target = new URL(String(completed.body.redirectTo));
    assert.equal(target.hostname, host);
    assert.equal(target.port, "49152");
    assert.equal(target.pathname, "/oauth/callback");
    assert.equal(target.searchParams.get("client"), "claude-code");
    const mcp = await h.redeem(clientId, completed.body.redirectTo);
    assert.equal(mcp.tokens.resource, CLAUDE_MCP_RESOURCE);
    assert.deepEqual(h.erp.activeKeyIds(), [mcp.keyId]);
  });
}

test("OpenAI harness retains the unmodified SDK localhost port comparison", async (t) => {
  const h = await createOAuthRouteHarness(t, {
    registeredRedirectUri: "http://localhost:8080/oauth/callback",
    redirectUri: "http://localhost:49152/oauth/callback",
  });
  const clientId = await h.register();
  const response = await h.authorize(clientId);
  assert.equal(response.status, 400);
  assert.equal(h.namespace.objects.size, 0);
  assert.equal(h.erp.requests.length, 0);
});
