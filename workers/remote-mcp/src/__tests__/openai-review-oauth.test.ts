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
  OPENAI_REVIEW_MCP_RESOURCE,
  OPENAI_REVIEW_MCP_RESOURCE_METADATA_PATH,
  OPENAI_REVIEW_OAUTH_RESOURCES,
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
      resource_name: "Frihet reviewed connector",
    },
  });
});

test("OAuth boundary accepts only this Worker's two resource identifiers and one honest scope", () => {
  assert.equal(OPENAI_REVIEW_MCP_RESOURCE, "https://openai-mcp.frihet.io/mcp");
  assert.deepEqual(
    [...OPENAI_REVIEW_OAUTH_RESOURCES],
    [OPENAI_REVIEW_MCP_RESOURCE, OPENAI_REVIEW_ORIGIN],
    "canonical MCP endpoint first, legacy origin kept so existing clients do not break",
  );
  assert.equal(Object.isFrozen(OPENAI_REVIEW_OAUTH_RESOURCES), true);

  for (const resource of OPENAI_REVIEW_OAUTH_RESOURCES) {
    assert.deepEqual(
      validateOAuthBoundary(
        {
          resource,
          scope: [FRIHET_CONNECTOR_SCOPE],
          requireResource: true,
          requireScope: true,
        },
        OPENAI_REVIEW_OAUTH_RESOURCES,
      ),
      { ok: true },
      resource,
    );
  }

  for (const resource of [
    undefined,
    "",
    "https://mcp.frihet.io",
    "https://mcp.frihet.io/mcp",
    `${OPENAI_REVIEW_ORIGIN}/`,
    `${OPENAI_REVIEW_ORIGIN}/mcp/`,
    `${OPENAI_REVIEW_ORIGIN}/MCP`,
    `${OPENAI_REVIEW_ORIGIN}/mcp?x=1`,
    `${OPENAI_REVIEW_ORIGIN}/mcp#x`,
    `${OPENAI_REVIEW_ORIGIN}/mcpx`,
    `${OPENAI_REVIEW_ORIGIN}/authorize`,
    "HTTPS://OPENAI-MCP.FRIHET.IO/mcp",
    "http://openai-mcp.frihet.io/mcp",
    "https://openai-mcp.frihet.io:443/mcp",
    [OPENAI_REVIEW_ORIGIN],
    [OPENAI_REVIEW_MCP_RESOURCE],
    [OPENAI_REVIEW_MCP_RESOURCE, OPENAI_REVIEW_ORIGIN],
  ]) {
    const result = validateOAuthBoundary(
      {
        resource,
        scope: FRIHET_CONNECTOR_SCOPE,
        requireResource: true,
        requireScope: true,
      },
      OPENAI_REVIEW_OAUTH_RESOURCES,
    );
    assert.equal(result.ok, false, JSON.stringify(resource));
    if (!result.ok) assert.equal(result.error, "invalid_target");
  }

  assert.equal(
    validateOAuthBoundary(
      {
        resource: OPENAI_REVIEW_MCP_RESOURCE,
        scope: FRIHET_CONNECTOR_SCOPE,
        requireResource: true,
        requireScope: true,
      },
      [],
    ).ok,
    false,
    "an empty accepted set fails closed",
  );

  for (const scope of [undefined, "", "read", "write", "offline_access", [FRIHET_CONNECTOR_SCOPE, "read"]]) {
    const result = validateOAuthBoundary(
      {
        resource: OPENAI_REVIEW_MCP_RESOURCE,
        scope,
        requireResource: true,
        requireScope: true,
      },
      OPENAI_REVIEW_OAUTH_RESOURCES,
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
      OPENAI_REVIEW_OAUTH_RESOURCES,
    ),
    { ok: true },
    "refresh/token requests may omit scope only after the grant was validated",
  );

  assert.deepEqual(
    validateOAuthBoundary(
      { requireResource: false, requireScope: false },
      OPENAI_REVIEW_OAUTH_RESOURCES,
    ),
    { ok: true },
    "token exchange and refresh may inherit resource and scope from the validated grant",
  );
});

test("the 401 challenge points at RFC 9728 path-inserted metadata naming the exact MCP URL", () => {
  const contract = buildOpenAIReviewOAuthContract();
  assert.equal(OPENAI_REVIEW_MCP_RESOURCE_METADATA_PATH, "/.well-known/oauth-protected-resource/mcp");
  // RFC 9728 section 3.1: insert the well-known suffix between the host and
  // the resource path. Claude additionally requires `resource` to equal the
  // connector URL a user enters, including its path.
  const resourceUrl = new URL(contract.protectedResourceMcp.resource);
  assert.equal(
    contract.wwwAuthenticate.resourceMetadataUrl,
    `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname}`,
  );
  assert.equal(contract.protectedResourceMcp.resource, OPENAI_REVIEW_MCP_RESOURCE);
  assert.ok(
    contract.wwwAuthenticate.missingTokenHeader.includes(
      `resource_metadata="${OPENAI_REVIEW_ORIGIN}${OPENAI_REVIEW_MCP_RESOURCE_METADATA_PATH}"`,
    ),
  );
  assert.ok(OPENAI_REVIEW_OAUTH_RESOURCES.includes(contract.protectedResourceMcp.resource));
  assert.ok(OPENAI_REVIEW_OAUTH_RESOURCES.includes(contract.protectedResource.resource));

  // Both documents describe the same authorization server, scope and bearer
  // method; only the resource identifier differs.
  const { resource: legacyResource, ...legacyRest } = contract.protectedResource;
  const { resource: mcpResource, ...mcpRest } = contract.protectedResourceMcp;
  assert.equal(legacyResource, OPENAI_REVIEW_ORIGIN);
  assert.equal(mcpResource, OPENAI_REVIEW_MCP_RESOURCE);
  assert.deepEqual(mcpRest, legacyRest);
  assert.deepEqual(mcpRest.authorization_servers, [contract.authorizationServer.issuer]);
});

test("pinned provider audience matching accepts both resource identifiers only for /mcp", () => {
  // Token audience is the RFC 8707 resource stored on the grant. Evaluate the
  // exact function shipped in the locked provider rather than restating it.
  const providerSource = readFileSync(
    fileURLToPath(
      new URL(
        "../../node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const body = providerSource.match(
    /function audienceMatches\(resourceServerUrl, audienceValue\) \{[\s\S]*?\n\}\n/u,
  )?.[0];
  assert.ok(body, "locked provider must still define audienceMatches");
  const audienceMatches = new Function(`${body}; return audienceMatches;`)() as (
    resourceServerUrl: string,
    audienceValue: string,
  ) => boolean;
  const mcpRoute = `${OPENAI_REVIEW_ORIGIN}${OAUTH_PROVIDER_REVIEW_OPTIONS.apiRoute}`;
  for (const audience of OPENAI_REVIEW_OAUTH_RESOURCES) {
    assert.equal(audienceMatches(mcpRoute, audience), true, audience);
    assert.equal(audienceMatches("https://mcp.frihet.io/mcp", audience), false, audience);
  }
  assert.equal(audienceMatches(`${OPENAI_REVIEW_ORIGIN}/mcpx`, OPENAI_REVIEW_MCP_RESOURCE), false);
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
  assert.match(options, /validateReviewedTokenExchange\(options\)/u);
  assert.match(workerSource, /reviewedProps\?\.accessProfile !== "openai"/u);
  assert.match(workerSource, /reviewedProps\.oauthResource !== OPENAI_REVIEW_ORIGIN/u);
  assert.match(workerSource, /reviewedProps\.oauthScope !== FRIHET_CONNECTOR_SCOPE/u);
  assert.match(workerSource, /reviewedProps\.authMethod !== "oauth"/u);
  assert.match(workerSource, /reviewedProps\.apiKeyExpiresAt/u);
  assert.match(workerSource, /refreshTokenTTL: credentialTtlSeconds/u);
  assert.match(workerSource, /function createGuardedOpenAIProvider/u);
  assert.match(workerSource, /await exchange\.reserve\(options, apiKeyBinding\)/u);
  assert.match(workerSource, /selectedProvider\.fetch\(providerRequest, env, ctx\)/u);
  assert.match(workerSource, /tokenFamilyExchange\.settle\(response\)/u);
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

test("every reviewed boundary call site accepts exactly the shared resource set", () => {
  const boundaryCalls = [
    ...authSource.matchAll(/validateOAuthBoundary\(\s*\{[\s\S]*?\},\s*([A-Z_]+),\s*\)/gu),
    ...workerSource.matchAll(/validateOAuthBoundary\(\s*\{[\s\S]*?\},\s*([A-Z_]+),\s*\)/gu),
  ].map((match) => match[1]);
  assert.deepEqual(boundaryCalls, [
    "OPENAI_REVIEW_OAUTH_RESOURCES",
    "OPENAI_REVIEW_OAUTH_RESOURCES",
    "OPENAI_REVIEW_OAUTH_RESOURCES",
  ]);
});

test("reviewed Worker serves the path-inserted protected-resource metadata before the provider", () => {
  const route = workerSource.match(
    /if \(openai && url\.pathname === OPENAI_REVIEW_MCP_RESOURCE_METADATA_PATH\) \{[\s\S]*?\n {4}\}\n/u,
  )?.[0];
  assert.ok(route, "index.ts must route the path-inserted metadata on the reviewed host");
  assert.match(
    route,
    /reviewedMcpProtectedResourceMetadataResponse\(\s*request,\s*buildReviewedMcpProtectedResourceMetadata\(\),?\s*\)/u,
  );
  assert.match(route, /withSecurityHeaders\(/u);
  const routeIndex = workerSource.indexOf(route);
  const providerIndex = workerSource.indexOf("selectedProvider.fetch(providerRequest, env, ctx)");
  assert.ok(routeIndex > 0 && routeIndex < providerIndex);
});
