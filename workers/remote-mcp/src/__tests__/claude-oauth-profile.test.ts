import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundOAuthProfile, CLAUDE_MCP_RESOURCE, CLAUDE_OAUTH_RESOURCES,
  CLAUDE_ORIGIN, resolveWorkerAccessProfile,
} from "../oauth-profile.ts";
import {
  buildOpenAIUserInfo, FRIHET_CONNECTOR_SCOPE, OPENAI_REVIEW_OAUTH_RESOURCES, OPENAI_REVIEW_OAUTH_SCOPES,
  OPENAI_REVIEW_ORIGIN, validateOAuthBoundary,
} from "../../../../src/openai-review-oauth.ts";
import { getLoginPage } from "../login-page.ts";

test("Claude flags require explicit isolation while existing profiles retain their resource sets", () => {
  for (const flag of [undefined, "false"]) {
    assert.equal(resolveWorkerAccessProfile({ FRIHET_OPENAI_MODE: "true", FRIHET_CLAUDE_MODE: flag }), "openai");
    assert.equal(resolveWorkerAccessProfile({ FRIHET_OPENAI_MODE: "false", FRIHET_CLAUDE_MODE: flag }), "full");
  }
  assert.equal(resolveWorkerAccessProfile({ FRIHET_OPENAI_MODE: "false", FRIHET_CLAUDE_MODE: "true" }), "claude");
  for (const env of [{}, { FRIHET_CLAUDE_MODE: "true" }, { FRIHET_OPENAI_MODE: "true", FRIHET_CLAUDE_MODE: "true" }, { FRIHET_OPENAI_MODE: "false", FRIHET_CLAUDE_MODE: "TRUE" }]) {
    assert.throws(() => resolveWorkerAccessProfile(env));
  }
  assert.throws(() => boundOAuthProfile("full"));
  assert.strictEqual(boundOAuthProfile("openai").acceptedResources, OPENAI_REVIEW_OAUTH_RESOURCES);
  assert.equal(Object.isFrozen(CLAUDE_OAUTH_RESOURCES), true);
  assert.deepEqual(CLAUDE_OAUTH_RESOURCES, [CLAUDE_MCP_RESOURCE]);
  for (const resource of [CLAUDE_MCP_RESOURCE, CLAUDE_ORIGIN, ...OPENAI_REVIEW_OAUTH_RESOURCES, "https://mcp.frihet.io/mcp"]) {
    assert.equal(validateOAuthBoundary({ resource, scope: OPENAI_REVIEW_OAUTH_SCOPES, requireResource: true, requireScope: true }, CLAUDE_OAUTH_RESOURCES).ok, resource === CLAUDE_MCP_RESOURCE, resource);
  }
});

test("Claude UserInfo rejects tokens with another issuer, audience, profile or identity", () => {
  const now = 2_000_000_000;
  const props = {
    userId: "synthetic-user", email: "synthetic@example.com", emailVerified: true,
    accessProfile: "claude", authMethod: "oauth", oauthIssuer: CLAUDE_ORIGIN,
    oauthResource: CLAUDE_ORIGIN, oauthAudience: CLAUDE_MCP_RESOURCE,
    oauthScope: FRIHET_CONNECTOR_SCOPE, oauthScopes: [...OPENAI_REVIEW_OAUTH_SCOPES],
  };
  const token = { userId: props.userId, expiresAt: now + 60, audience: CLAUDE_MCP_RESOURCE,
    scope: [...OPENAI_REVIEW_OAUTH_SCOPES], grant: { scope: [...OPENAI_REVIEW_OAUTH_SCOPES], props } };
  const binding = boundOAuthProfile("claude");
  assert.deepEqual(buildOpenAIUserInfo(token, now, binding), { sub: props.userId, email: props.email, email_verified: true });
  assert.equal(buildOpenAIUserInfo(token, now), undefined, "default remains OpenAI");
  for (const mutation of [{ accessProfile: "openai" }, { oauthIssuer: OPENAI_REVIEW_ORIGIN }, { oauthResource: OPENAI_REVIEW_ORIGIN }, { oauthAudience: CLAUDE_ORIGIN }, { oauthScopes: ["read"] }, { authMethod: "api-key" }, { emailVerified: false }, { userId: "other-user" }]) {
    assert.equal(buildOpenAIUserInfo({ ...token, grant: { ...token.grant, props: { ...props, ...mutation } } }, now, binding), undefined, JSON.stringify(mutation));
  }
  assert.equal(buildOpenAIUserInfo({ ...token, expiresAt: now }, now, binding), undefined);
  assert.equal(buildOpenAIUserInfo({ ...token, audience: CLAUDE_ORIGIN }, now, binding), undefined);
});

test("Claude consent names the real fiscal permission and external effects", () => {
  const html = getLoginPage({ stateKey: "test-state", clientId: "test-client", firebaseProjectId: "test-project", accessProfile: "claude", clientName: "Claude test", redirectUri: "https://claude.ai/api/mcp/auth_callback" });
  for (const text of ["einvoice:write", "entire e-invoicing family", "30 days", "webhook", "fiscal", "https://claude-mcp.frihet.io/privacy"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /https:\/\/openai-mcp\.frihet\.io/u);
});
