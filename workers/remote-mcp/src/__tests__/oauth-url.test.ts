/**
 * Regression test for the OAuth API-key provisioning URL derivation.
 *
 * Bug (26-jun-2026): auth-handler used `${FRIHET_API_BASE}/oauth/api-key` raw.
 * With FRIHET_API_BASE = "https://api.frihet.io/v1" (the form the main client
 * also accepts), this produced "https://api.frihet.io/v1/oauth/api-key", which
 * does NOT match the provisioning route → the Firebase Bearer token is rejected
 * as an invalid API key (401) → worker returns 500 "Failed to provision API key"
 * for EVERY remote-OAuth connection. resolveOAuthApiKeyUrl strips the trailing
 * /v1 so the call always lands on the API origin root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOAuthApiKeyUrl } from "../api-url.ts";

const EXPECTED = "https://api.frihet.io/oauth/api-key";

test("resolveOAuthApiKeyUrl strips /v1 suffix (the production bug)", () => {
  assert.equal(resolveOAuthApiKeyUrl("https://api.frihet.io/v1"), EXPECTED);
});

test("resolveOAuthApiKeyUrl accepts origin form", () => {
  assert.equal(resolveOAuthApiKeyUrl("https://api.frihet.io"), EXPECTED);
});

test("resolveOAuthApiKeyUrl tolerates trailing slashes", () => {
  assert.equal(resolveOAuthApiKeyUrl("https://api.frihet.io/v1/"), EXPECTED);
  assert.equal(resolveOAuthApiKeyUrl("https://api.frihet.io/"), EXPECTED);
});

test("resolveOAuthApiKeyUrl falls back to the CF origin (NOT api.frihet.io) when unset", () => {
  // The fallback must be the direct Cloud Function origin: a worker→api.frihet.io
  // subrequest (same Cloudflare zone) returns 522, breaking provisioning.
  const cfFallback =
    "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/publicApi/api/oauth/api-key";
  assert.equal(resolveOAuthApiKeyUrl(undefined), cfFallback);
  assert.equal(resolveOAuthApiKeyUrl(""), cfFallback);
  // api.frihet.io must never be the resolved origin (the 522 trap)
  assert.ok(!resolveOAuthApiKeyUrl(undefined).includes("api.frihet.io"));
});

test("resolveOAuthApiKeyUrl only strips a /v1 SEGMENT, not substrings", () => {
  // a host literally containing v1 must not be mangled
  assert.equal(
    resolveOAuthApiKeyUrl("https://api-v1.frihet.io"),
    "https://api-v1.frihet.io/oauth/api-key",
  );
});
