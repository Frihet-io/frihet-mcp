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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveApiBaseUrl, resolveOAuthApiKeyUrl } from "../api-url.ts";

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

test("tool and OAuth bases canonicalize trusted Frihet and exact Cloud Function origins", () => {
  assert.equal(resolveApiBaseUrl("https://API.FRIHET.IO:443/"), "https://api.frihet.io/v1");
  assert.equal(resolveApiBaseUrl("https://mcp.frihet.io/v1/"), "https://mcp.frihet.io/v1");
  assert.equal(
    resolveApiBaseUrl("https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/publicApi/api/"),
    "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/publicApi/api/v1",
  );
});

test("worker API base rejects host confusion, credentials, unsafe ports, and arbitrary CF origins", () => {
  const rejected = [
    "https://evilfrihet.io/v1",
    "https://frihet.io.evil.example/v1",
    "https://user:password@api.frihet.io/v1",
    "http://api.frihet.io/v1",
    "https://api.frihet.io:444/v1",
    "https://api.frihet.io./v1",
    "https://api.frihet.io/v1?redirect=evil",
    "https://api.frihet.io/v1#fragment",
    "https://api.frihet.io/arbitrary",
    "https://attacker-project.cloudfunctions.net/publicApi/api",
    "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/other/path",
  ];

  for (const candidate of rejected) {
    assert.throws(() => resolveApiBaseUrl(candidate), candidate);
    assert.throws(() => resolveOAuthApiKeyUrl(candidate), candidate);
  }
});

test("OAuth provisioning disables redirects before the Firebase bearer token is sent", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../auth-handler.ts", import.meta.url)),
    "utf8",
  );
  assert.match(
    source,
    /fetch\(\s*resolveOAuthApiKeyUrl\([\s\S]*?method:\s*"POST",\s*redirect:\s*"error"/u,
  );
});
