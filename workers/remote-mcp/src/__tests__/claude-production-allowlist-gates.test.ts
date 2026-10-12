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

import { CLAUDE_ORIGIN } from "../oauth-profile.ts";
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

async function ingress(method: string, userId: string, qaUids: string | undefined) {
  const { env, mcpObjectTouches } = ingressEnv(qaUids);
  let response: Response | undefined;
  let thrown: unknown;
  try {
    response = await claudeOptions.apiHandler.fetch(
      new Request(`${CLAUDE_ORIGIN}/mcp`, {
        method,
        headers: {
          Authorization: `Bearer ${userId}:${GRANT_ID}:${TOKEN_SECRET}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) } : {}),
      }),
      env,
      { waitUntil() {}, passThroughOnException() {}, props: authProps(userId) },
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
  assert.equal(denied.response?.status, 401);
  assert.deepEqual(await denied.response?.json(), { error: "invalid_token" });
  assert.deepEqual(denied.mcpObjectTouches, [], "the DO must never be contacted for a non-allow-listed uid");
});

for (const [label, qaUids] of [
  ["missing config", undefined],
  ["malformed config", "{"],
  ["empty list", "[]"],
] as const) {
  test(`production ingress fails closed on ${label} even for a previously valid uid`, async () => {
    const denied = await ingress("POST", ALLOWED_UID, qaUids);
    assert.equal(denied.response?.status, 401);
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
      /does not match the Frihet connector boundary/u,
    );
    // Control: everything else identical, allow-listed uid is accepted.
    const accepted = exchange(options(ALLOWED_UID)) as { accessTokenProps: { userId: string } };
    assert.equal(accepted.accessTokenProps.userId, ALLOWED_UID);
  });
}
