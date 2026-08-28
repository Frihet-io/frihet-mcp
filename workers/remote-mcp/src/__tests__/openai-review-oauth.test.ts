import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildOpenAIReviewOAuthContract,
  buildOpenAIUnauthorizedChallenge,
  FRIHET_CONNECTOR_SCOPE,
  isValidPKCECodeVerifier,
  isValidS256CodeChallenge,
  OAUTH_PROVIDER_REVIEW_OPTIONS,
  OPENAI_REVIEW_ORIGIN,
  validateOAuthBoundary,
} from "../../../../src/openai-review-oauth.ts";

const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../src/__tests__/fixtures/openai-review-descriptor.snapshot.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as { oauth: Record<string, unknown> };

const workerLock = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../package-lock.json", import.meta.url)),
    "utf8",
  ),
) as { packages?: Record<string, { version?: string }> };

const workerSource = readFileSync(
  fileURLToPath(new URL("../index.ts", import.meta.url)),
  "utf8",
);
const authSource = readFileSync(
  fileURLToPath(new URL("../auth-handler.ts", import.meta.url)),
  "utf8",
);
const wranglerSource = readFileSync(
  fileURLToPath(new URL("../../wrangler.toml", import.meta.url)),
  "utf8",
);

test("real Worker OAuth options remain byte-compatible with the reviewed routes", () => {
  assert.deepEqual(OAUTH_PROVIDER_REVIEW_OPTIONS, {
    apiRoute: "/mcp",
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: [FRIHET_CONNECTOR_SCOPE],
    accessTokenTTL: 3600,
    refreshTokenTTL: 2592000,
    allowPlainPKCE: false,
    resourceMetadata: {
      resource: OPENAI_REVIEW_ORIGIN,
      authorization_servers: [OPENAI_REVIEW_ORIGIN],
      scopes_supported: [FRIHET_CONNECTOR_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Frihet ChatGPT connector",
    },
  });
});

test("OAuth boundary requires the exact host resource and one honest scope", () => {
  assert.deepEqual(
    validateOAuthBoundary(
      {
        resource: OPENAI_REVIEW_ORIGIN,
        scope: [FRIHET_CONNECTOR_SCOPE],
        requireResource: true,
        requireScope: true,
      },
      OPENAI_REVIEW_ORIGIN,
    ),
    { ok: true },
  );

  for (const resource of [
    undefined,
    "https://mcp.frihet.io",
    `${OPENAI_REVIEW_ORIGIN}/`,
    [OPENAI_REVIEW_ORIGIN],
  ]) {
    const result = validateOAuthBoundary(
      {
        resource,
        scope: FRIHET_CONNECTOR_SCOPE,
        requireResource: true,
        requireScope: true,
      },
      OPENAI_REVIEW_ORIGIN,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "invalid_target");
  }

  for (const scope of [undefined, "", "read", "write", [FRIHET_CONNECTOR_SCOPE, "read"]]) {
    const result = validateOAuthBoundary(
      {
        resource: OPENAI_REVIEW_ORIGIN,
        scope,
        requireResource: true,
        requireScope: true,
      },
      OPENAI_REVIEW_ORIGIN,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "invalid_scope");
  }

  assert.deepEqual(
    validateOAuthBoundary(
      {
        resource: OPENAI_REVIEW_ORIGIN,
        requireResource: false,
        requireScope: false,
      },
      OPENAI_REVIEW_ORIGIN,
    ),
    { ok: true },
    "refresh/token requests may omit scope only after the grant was validated",
  );

  assert.deepEqual(
    validateOAuthBoundary(
      { requireResource: false, requireScope: false },
      OPENAI_REVIEW_ORIGIN,
    ),
    { ok: true },
    "token exchange and refresh may inherit resource and scope from the validated grant",
  );
});

test("reviewed PKCE accepts only exact S256 challenges and RFC 7636 verifiers", () => {
  assert.equal(isValidS256CodeChallenge("A".repeat(43)), true);
  assert.equal(isValidS256CodeChallenge("A".repeat(42)), false);
  assert.equal(isValidS256CodeChallenge("A".repeat(44)), false);
  assert.equal(isValidS256CodeChallenge(`${"A".repeat(42)}.`), false);

  assert.equal(isValidPKCECodeVerifier("a".repeat(43)), true);
  assert.equal(isValidPKCECodeVerifier(`${"a".repeat(42)}~`), true);
  assert.equal(isValidPKCECodeVerifier("a".repeat(42)), false);
  assert.equal(isValidPKCECodeVerifier("a".repeat(129)), false);
  assert.equal(isValidPKCECodeVerifier(`${"a".repeat(42)}+`), false);
});

test("runtime bearer challenge is single-sourced from the frozen OAuth contract", () => {
  assert.equal(
    buildOpenAIUnauthorizedChallenge(),
    buildOpenAIReviewOAuthContract().wwwAuthenticate.missingTokenHeader,
  );
});

test("OAuth discovery, protected resource and WWW-Authenticate metadata match the freeze", () => {
  const { providerPackageVersion, ...expectedMetadata } = snapshot.oauth;
  assert.deepEqual(
    buildOpenAIReviewOAuthContract(OPENAI_REVIEW_ORIGIN),
    expectedMetadata,
  );

  const resolvedVersion = workerLock.packages?.[
    "node_modules/@cloudflare/workers-oauth-provider"
  ]?.version;
  assert.equal(resolvedVersion, providerPackageVersion);
});

test("reviewed Worker uses a distinct OAuth store and a non-preview canonical route", () => {
  const fullKv = wranglerSource.match(
    /\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"OAUTH_KV"[\s\S]*?id\s*=\s*"([a-f0-9]+)"/u,
  )?.[1];
  const reviewedKv = wranglerSource.match(
    /\[\[env\.openai\.kv_namespaces\]\][\s\S]*?binding\s*=\s*"OAUTH_KV"[\s\S]*?id\s*=\s*"([a-f0-9]+)"/u,
  )?.[1];

  assert.ok(fullKv);
  assert.ok(reviewedKv);
  assert.notEqual(reviewedKv, fullKv);
  const openAIConfig = wranglerSource.match(
    /^\[env\.openai\]\s*$[\s\S]*?^\[env\.openai\.vars\]\s*$/mu,
  )?.[0];
  assert.ok(openAIConfig);
  assert.match(openAIConfig, /workers_dev\s*=\s*false/u);
  assert.match(openAIConfig, /preview_urls\s*=\s*false/u);
});

test("reviewed provider cannot resolve direct API keys or cross host/scope/auth grants", () => {
  const options = workerSource.match(
    /const openAIProviderOptions:[\s\S]*?\n\};\n/u,
  )?.[0];
  assert.ok(options);
  assert.doesNotMatch(options, /resolveExternalToken/u);
  assert.match(options, /accessProfile !== "openai"/u);
  assert.match(options, /oauthResource !== OPENAI_REVIEW_ORIGIN/u);
  assert.match(options, /oauthScope !== FRIHET_CONNECTOR_SCOPE/u);
  assert.match(options, /authMethod !== "oauth"/u);
  assert.match(
    workerSource,
    /\(openai \? openAIOAuthProvider : fullOAuthProvider\)\.fetch/u,
  );
});

test("reviewed authorize/callback source enforces exact state, PKCE, client lookup and atomic consumption", () => {
  assert.match(authSource, /params\.getAll\(key\)\.length !== 1/u);
  assert.match(authSource, /OAuth parameter state must be non-empty/u);
  assert.match(authSource, /code_challenge_method"\) !== "S256"/u);
  assert.match(authSource, /isValidS256CodeChallenge\(challenge\)/u);
  const lookupIndex = authSource.indexOf("lookupClient(oauthReq.clientId)");
  const storeIndex = authSource.indexOf("storeOAuthState(c.env.OAUTH_STATE");
  const consumeIndex = authSource.indexOf("consumeOAuthState<AuthRequest>");
  const verifyIndex = authSource.indexOf("auth.verifyIdToken(body.idToken)");
  assert.ok(lookupIndex >= 0 && lookupIndex < storeIndex);
  assert.ok(consumeIndex >= 0 && consumeIndex < verifyIndex);
});

test("OAuth secrets are non-cacheable and Bearer challenge is limited to the MCP route", () => {
  assert.match(
    workerSource,
    /const OAUTH_SENSITIVE_PATHS = new Set\(\["\/authorize", "\/callback", "\/token", "\/register"\]\)/u,
  );
  assert.match(workerSource, /headers\.set\("Cache-Control", "no-store"\)/u);
  assert.match(workerSource, /headers\.set\("Pragma", "no-cache"\)/u);
  assert.match(
    workerSource,
    /url\.pathname === OAUTH_PROVIDER_REVIEW_OPTIONS\.apiRoute && response\.status === 401/u,
  );
  assert.equal(
    (
      workerSource.match(
        /headers\.set\("WWW-Authenticate", buildOpenAIUnauthorizedChallenge\(\)\)/gu,
      ) ?? []
    ).length,
    1,
  );
  assert.doesNotMatch(workerSource, /if\s*\(\s*response\.status === 401\s*\)/u);
});

test("OAuth state Durable Object is bound in both environments and migrated once", () => {
  assert.equal((wranglerSource.match(/name\s*=\s*"OAUTH_STATE"/gu) ?? []).length, 2);
  assert.match(
    wranglerSource,
    /\[\[migrations\]\][\s\S]*?new_sqlite_classes\s*=\s*\["OAuthStateStore"\][\s\S]*?tag\s*=\s*"v2"/u,
  );
});
