/** Local route integration: actual auth handler and locked OAuth SDK; synthetic KV, DO and ERP authority. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CLAUDE_MCP_RESOURCE, CLAUDE_ORIGIN } from "../oauth-profile.ts";
import {
  CLAUDE_REDIRECT_URI,
  createOAuthRouteHarness,
  mintIdToken,
  type PostFault,
} from "./support/oauth-route-harness.ts";

type Harness = Awaited<ReturnType<typeof createOAuthRouteHarness>>;

function assertNoSecretsInLogs(h: Harness, idToken: string): void {
  for (const secret of [idToken, ...h.erp.issuedApiKeys(), String(h.env.FRIHET_OAUTH_API_KEY), String(h.env.FRIHET_CLAUDE_OAUTH_API_KEY)]) {
    for (const log of h.logs) assert.equal(log.includes(secret), false, "synthetic credential reached a log");
  }
}

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
  assert.deepEqual(h.erp.requests.at(-1), { method: "DELETE", body: { uid: initial.userId, keyId: initial.keyId } });
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
