/**
 * Pins the Claude QA-UID allowlist gates in the PRODUCTION Worker (`src/index.ts`).
 *
 * The route-harness tests run a mirror of these gates, so deleting the real ones
 * would leave them green. Here `src/index.ts` itself is imported (through the
 * test-only loader) and its own `apiHandler` / `tokenExchangeCallback` closures
 * are driven directly.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { before, test } from "node:test";

import { CLAUDE_ORIGIN, ClaudeAdmissionPolicyError } from "../oauth-profile.ts";
import { bindMcpSessionId, fingerprintSessionPrincipal } from "../mcp-session-binding.ts";
import { FRIHET_CONNECTOR_SCOPE, OPENAI_REVIEW_OAUTH_SCOPES } from "../../../../src/openai-review-oauth.ts";

const ALLOWED_UID = "claude-qa-allowed-user";
const OUTSIDER_UID = "claude-qa-outsider-user";
const GRANT_ID = "g".repeat(16);
const TOKEN_SECRET = "s".repeat(32);

type Handler = { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> };
type ExchangeOptions = {
  grantType: "authorization_code" | "refresh_token";
  scope: string[];
  requestedScope: string[];
  props: Record<string, unknown>;
  userId: string;
};
type RecordedProviderOptions = {
  apiHandler: Handler;
  tokenExchangeCallback?: (options: ExchangeOptions) => unknown;
};

let production: { default: Handler };
let claudeOptions: RecordedProviderOptions;

before(async () => {
  register(new URL("./support/production-index-loader.mjs", import.meta.url));
  production = await import("../index.ts") as unknown as { default: Handler };
  // Reaching the Claude provider constructs it, with the production
  // `createClaudeProviderOptions(env)` closure, per request.
  const response = await production.default.fetch(
    new Request(`${CLAUDE_ORIGIN}/.well-known/oauth-authorization-server`),
    claudeEnv(JSON.stringify([ALLOWED_UID])),
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 204, "the recorder provider must have been reached");
  const recorded = (globalThis as unknown as { __recordedOAuthProviders: RecordedProviderOptions[] }).__recordedOAuthProviders;
  claudeOptions = recorded[recorded.length - 1];
  assert.equal(typeof claudeOptions.tokenExchangeCallback, "function");
});

function claudeEnv(qaUids: string | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    FRIHET_OPENAI_MODE: "false",
    FRIHET_CLAUDE_MODE: "true",
    FRIHET_API_BASE: "https://api.frihet.io/v1",
    COOKIE_ENCRYPTION_KEY: "k".repeat(64),
    ...(qaUids === undefined ? {} : { FRIHET_CLAUDE_QA_UIDS: qaUids }),
    ...extra,
  };
}

function authProps(userId: string): Record<string, unknown> {
  return {
    apiKey: `fri_${"A".repeat(43)}`,
    keyId: "AbCdEfGhIjKlMnOpQrSt",
    apiKeyExpiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
    locale: "es",
    userId,
    email: "qa@example.com",
    emailVerified: true,
    accessProfile: "claude",
    authMethod: "oauth",
    oauthScope: FRIHET_CONNECTOR_SCOPE,
    oauthScopes: [...OPENAI_REVIEW_OAUTH_SCOPES],
    oauthIssuer: CLAUDE_ORIGIN,
    oauthResource: CLAUDE_ORIGIN,
    oauthAudience: `${CLAUDE_ORIGIN}/mcp`,
  };
}

/** Env whose token-family DO always reports active and whose MCP DO records any contact. */
function ingressEnv(qaUids: string | undefined) {
  const mcpObjectTouches: string[] = [];
  const touch = (name: string) => () => { mcpObjectTouches.push(name); throw new Error("MCP_OBJECT reached"); };
  const env = claudeEnv(qaUids, {
    OAUTH_STATE: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ outcome: "active" }) }),
    },
    MCP_OBJECT: new Proxy({}, { has: () => true, get: (_target, property) => touch(String(property)) }),
  });
  return { env, mcpObjectTouches };
}

async function ingress(method: string, userId: string, qaUids: string | undefined, extra: {
  props?: Record<string, unknown>; tokenUserId?: string; sessionId?: string;
} = {}) {
  const { env, mcpObjectTouches } = ingressEnv(qaUids);
  let response: Response | undefined;
  let thrown: unknown;
  try {
    response = await claudeOptions.apiHandler.fetch(
      new Request(`${CLAUDE_ORIGIN}/mcp`, {
        method,
        headers: {
          Authorization: `Bearer ${extra.tokenUserId ?? userId}:${GRANT_ID}:${TOKEN_SECRET}`,
          "Content-Type": "application/json",
          ...(extra.sessionId ? { "mcp-session-id": extra.sessionId } : {}),
          Accept: "application/json, text/event-stream",
        },
        ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) } : {}),
      }),
      env,
      { waitUntil() {}, passThroughOnException() {}, props: { ...authProps(userId), ...extra.props } },
    );
  } catch (error) {
    thrown = error;
  }
  return { response, thrown, mcpObjectTouches };
}

function isGateRejection(response: Response | undefined, body: string | undefined): boolean {
  return response?.status === 401 && body === JSON.stringify({ error: "invalid_token" });
}

test("production ingress rejects a Claude principal outside FRIHET_CLAUDE_QA_UIDS before the MCP Durable Object", async () => {
  const denied = await ingress("POST", OUTSIDER_UID, JSON.stringify([ALLOWED_UID]));
  assert.equal(denied.thrown, undefined);
  assert.equal(denied.response?.status, 503);
  assert.equal((await denied.response?.json() as { error: string }).error, "temporarily_unavailable");
  assert.deepEqual(denied.mcpObjectTouches, [], "the DO must never be contacted for a non-allow-listed uid");
});

for (const [label, qaUids] of [
  ["missing config", undefined],
  ["malformed config", "{"],
  ["empty list", "[]"],
] as const) {
  test(`production ingress fails closed on ${label} even for a previously valid uid`, async () => {
    const denied = await ingress("POST", ALLOWED_UID, qaUids);
    assert.equal(denied.response?.status, 503);
    assert.deepEqual(denied.mcpObjectTouches, []);
  });
}

test("production ingress admits an allow-listed Claude principal past the gate (control)", async () => {
  const admitted = await ingress("POST", ALLOWED_UID, JSON.stringify([ALLOWED_UID]));
  // Past the gate the request enters the Agents SDK, which this Node harness
  // cannot fully serve (it throws or answers without the gate's invalid_token).
  assert.equal(isGateRejection(admitted.response, await admitted.response?.clone().text()), false);
});

test("production ingress still lets a withdrawn principal close its own session (DELETE is cleanup)", async () => {
  const closing = await ingress("DELETE", OUTSIDER_UID, JSON.stringify([ALLOWED_UID]));
  assert.equal(isGateRejection(closing.response, await closing.response?.clone().text()), false);
});

for (const grantType of ["authorization_code", "refresh_token"] as const) {
  test(`production Claude ${grantType} exchange rejects a uid outside FRIHET_CLAUDE_QA_UIDS`, async () => {
    const exchange = claudeOptions.tokenExchangeCallback!;
    const options = (userId: string): ExchangeOptions => ({
      grantType,
      scope: [...OPENAI_REVIEW_OAUTH_SCOPES],
      requestedScope: [...OPENAI_REVIEW_OAUTH_SCOPES],
      props: authProps(userId),
      userId,
    });
    assert.throws(
      () => exchange(options(OUTSIDER_UID)),
      ClaudeAdmissionPolicyError,
    );
    // Control: everything else identical, allow-listed uid is accepted.
    const accepted = exchange(options(ALLOWED_UID)) as { accessTokenProps: { userId: string } };
    assert.equal(accepted.accessTokenProps.userId, ALLOWED_UID);
  });

  test(`production Claude ${grantType} exchange rejects a malformed retained correlation instead of using legacy cleanup`, () => {
    for (const correlationId of [null, "", "not-a-uuid", "7fac6e06-e24c-1a74-9460-4e213b683f13"]) {
      assert.throws(() => claudeOptions.tokenExchangeCallback!({
        grantType,
        scope: [...OPENAI_REVIEW_OAUTH_SCOPES],
        requestedScope: [...OPENAI_REVIEW_OAUTH_SCOPES],
        props: { ...authProps(ALLOWED_UID), correlationId },
        userId: ALLOWED_UID,
      }), /does not match the Frihet connector boundary/u);
    }
  });
}

test("the production guarded Claude callback carries the encrypted grant correlation into the new durable family", async () => {
  const correlationId = "7fac6e06-e24c-4a74-9460-4e213b683f13";
  const credential = `${ALLOWED_UID}:${GRANT_ID}:${TOKEN_SECRET}`;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const initialized: Array<Record<string, unknown>> = [];
  let begins = 0;
  const env = claudeEnv(JSON.stringify([ALLOWED_UID]), {
    OAUTH_KV: { get: async () => ({ refreshTokenId: hash, expiresAt: Math.floor(Date.now() / 1000) + 60_000 }) },
    OAUTH_STATE: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (url: string, init: RequestInit) => {
          if (new URL(url).pathname === "/token-family/begin") {
            return Response.json(++begins === 1 ? { outcome: "missing" } : { outcome: "started", leaseId: correlationId });
          }
          assert.equal(new URL(url).pathname, "/token-family");
          initialized.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        },
      }),
    },
  });
  const response = await production.default.fetch(new Request(`${CLAUDE_ORIGIN}/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: credential, client_id: "synthetic-client",
      resource: `${CLAUDE_ORIGIN}/mcp`,
    }),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 204, "the recorder captures the production guarded provider");
  const recorded = (globalThis as unknown as { __recordedOAuthProviders: RecordedProviderOptions[] }).__recordedOAuthProviders;
  const guarded = recorded[recorded.length - 1];
  await guarded.tokenExchangeCallback!({
    grantType: "refresh_token", scope: [...OPENAI_REVIEW_OAUTH_SCOPES], requestedScope: [...OPENAI_REVIEW_OAUTH_SCOPES],
    props: { ...authProps(ALLOWED_UID), correlationId }, userId: ALLOWED_UID,
  });
  assert.equal(initialized.length, 1);
  assert.deepEqual(initialized[0].apiKeyBinding, {
    uid: ALLOWED_UID, keyId: authProps(ALLOWED_UID).keyId,
    accessProfile: "claude", oauthResource: CLAUDE_ORIGIN, correlationId,
  });
});

const customerPolicy = () => JSON.stringify({ version: 1, mode: "customers", qaUids: [ALLOWED_UID] });

async function productionClaudeOptions(policy: string): Promise<RecordedProviderOptions> {
  await production.default.fetch(new Request(`${CLAUDE_ORIGIN}/.well-known/oauth-authorization-server`),
    claudeEnv(policy), { waitUntil() {}, passThroughOnException() {} });
  const recorded = (globalThis as unknown as { __recordedOAuthProviders: RecordedProviderOptions[] }).__recordedOAuthProviders;
  return recorded[recorded.length - 1];
}

test("production Claude customer ingress and both grant exchanges admit verified non-QA customers", async () => {
  const admitted = await ingress("POST", OUTSIDER_UID, customerPolicy());
  assert.notEqual(admitted.response?.status, 503);
  assert.equal(isGateRejection(admitted.response, await admitted.response?.clone().text()), false);
  const options = await productionClaudeOptions(customerPolicy());
  for (const grantType of ["authorization_code", "refresh_token"] as const) {
    const accepted = options.tokenExchangeCallback!({
      grantType, scope: [...OPENAI_REVIEW_OAUTH_SCOPES], requestedScope: [...OPENAI_REVIEW_OAUTH_SCOPES],
      props: authProps(OUTSIDER_UID), userId: OUTSIDER_UID,
    }) as { accessTokenProps: Record<string, unknown>; accessTokenScope: string[] };
    assert.equal(accepted.accessTokenProps.userId, OUTSIDER_UID);
    assert.deepEqual(accepted.accessTokenScope, [...OPENAI_REVIEW_OAUTH_SCOPES]);
  }
});

test("production ingress rejects invalid encrypted claims before the policy check or session cleanup bypass", async () => {
  for (const policy of [customerPolicy(), JSON.stringify([ALLOWED_UID])]) {
    for (const mutation of [
      { accessProfile: "openai" }, { authMethod: "api-key" }, { oauthIssuer: "https://openai-mcp.frihet.io" },
      { oauthResource: "https://mcp.frihet.io" }, { oauthAudience: CLAUDE_ORIGIN },
      { oauthScope: "read" }, { oauthScopes: ["read", "write"] },
      { emailVerified: false }, { emailVerified: "true" }, { emailVerified: undefined },
      { email: undefined }, { email: "invalid" }, { userId: "user/path" },
    ]) {
      for (const method of ["POST", "DELETE"]) {
        const denied = await ingress(method, OUTSIDER_UID, policy, { props: mutation });
        assert.equal(denied.response?.status, 401, JSON.stringify({ method, mutation }));
        assert.deepEqual(denied.mcpObjectTouches, []);
      }
    }
  }
});

test("production paused DELETE keeps token-owner and signed session-principal checks", async () => {
  const qaPolicy = JSON.stringify([ALLOWED_UID]);
  const fingerprint = await fingerprintSessionPrincipal(authProps(OUTSIDER_UID));
  assert.ok(fingerprint);
  const ownSession = await bindMcpSessionId("synthetic_session_123", fingerprint, "k".repeat(64));
  assert.ok(ownSession);
  const mismatchedToken = await ingress("DELETE", OUTSIDER_UID, qaPolicy, { tokenUserId: ALLOWED_UID, sessionId: ownSession });
  assert.equal(mismatchedToken.response?.status, 401);
  assert.deepEqual(mismatchedToken.mcpObjectTouches, []);
  const otherFingerprint = await fingerprintSessionPrincipal(authProps(ALLOWED_UID));
  assert.ok(otherFingerprint);
  const otherSession = await bindMcpSessionId("synthetic_session_123", otherFingerprint, "k".repeat(64));
  assert.ok(otherSession);
  const foreignSession = await ingress("DELETE", OUTSIDER_UID, qaPolicy, { sessionId: otherSession });
  assert.equal(foreignSession.response?.status, 403);
  assert.deepEqual(foreignSession.mcpObjectTouches, []);
  const owner = await ingress("DELETE", OUTSIDER_UID, qaPolicy, { sessionId: ownSession });
  assert.notEqual(owner.response?.status, 401);
  assert.notEqual(owner.response?.status, 403);
  assert.notEqual(owner.response?.status, 503);
});

test("production token exchange validates all retained claims and credential lifetime before a reversible policy denial", async () => {
  const options = await productionClaudeOptions(JSON.stringify([ALLOWED_UID]));
  for (const mutation of [
    { accessProfile: "openai" }, { authMethod: "api-key" }, { oauthIssuer: "https://openai-mcp.frihet.io" },
    { oauthAudience: CLAUDE_ORIGIN }, { oauthScopes: ["read"] }, { emailVerified: false },
    { emailVerified: "true" }, { email: undefined }, { userId: "other-user" },
    { apiKey: "invalid" }, { keyId: "invalid" }, { correlationId: "invalid" },
    { apiKeyExpiresAt: new Date(Date.now() - 1000).toISOString() },
  ]) {
    assert.throws(() => options.tokenExchangeCallback!({
      grantType: "refresh_token", scope: [...OPENAI_REVIEW_OAUTH_SCOPES], requestedScope: [...OPENAI_REVIEW_OAUTH_SCOPES],
      props: { ...authProps(OUTSIDER_UID), ...mutation }, userId: OUTSIDER_UID,
    }), (error: unknown) => error instanceof Error && !(error instanceof ClaudeAdmissionPolicyError), JSON.stringify(mutation));
  }
});

test("production guarded token route returns generic 503 with no reserve, grant write or revocation for a valid paused refresh", async (t) => {
  const credential = `${OUTSIDER_UID}:${GRANT_ID}:${TOKEN_SECRET}`;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const touched: string[] = [];
  const state = globalThis as unknown as {
    __recordedOAuthProviderFetch?: (options: RecordedProviderOptions) => Promise<Response>;
  };
  state.__recordedOAuthProviderFetch = async (options) => {
    await options.tokenExchangeCallback!({
      grantType: "refresh_token", scope: [...OPENAI_REVIEW_OAUTH_SCOPES], requestedScope: [...OPENAI_REVIEW_OAUTH_SCOPES],
      props: authProps(OUTSIDER_UID), userId: OUTSIDER_UID,
    });
    throw new Error("a paused credential must not issue a token");
  };
  t.after(() => { delete state.__recordedOAuthProviderFetch; });
  const env = claudeEnv(JSON.stringify([ALLOWED_UID]), {
    OAUTH_KV: { get: async () => ({ refreshTokenId: hash }), put: () => { throw new Error("unexpected grant write"); } },
    OAUTH_STATE: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (url: string) => {
        const path = new URL(url).pathname;
        touched.push(path);
        if (path === "/token-family/check") return Response.json({ outcome: "current" });
        assert.equal(path, "/token-family/status");
        return Response.json({ outcome: "active" });
      } }),
    },
  });
  const response = await production.default.fetch(new Request(`${CLAUDE_ORIGIN}/token`, {
    method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential,
      client_id: "synthetic-client", resource: `${CLAUDE_ORIGIN}/mcp` }),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "temporarily_unavailable", error_description: "Frihet Claude access is temporarily unavailable. Try again later.",
  });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(touched, ["/token-family/check", "/token-family/status"]);
});
