import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildOpenAIReviewOAuthContract,
  OAUTH_PROVIDER_REVIEW_OPTIONS,
  OPENAI_REVIEW_ORIGIN,
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

test("real Worker OAuth options remain byte-compatible with the reviewed routes", () => {
  assert.deepEqual(OAUTH_PROVIDER_REVIEW_OPTIONS, {
    apiRoute: "/mcp",
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: ["read", "write"],
    accessTokenTTL: 3600,
    refreshTokenTTL: 2592000,
    allowPlainPKCE: false,
  });
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
