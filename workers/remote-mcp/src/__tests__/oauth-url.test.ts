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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolveApiBaseUrl, resolveOAuthApiKeyUrl } from "../api-url.ts";
import {
  OAUTH_PROVISIONING_CONTRACT,
  isTrustedOAuthApiKeyUrl,
  parseProvisionedOAuthApiKey,
  provisionOAuthApiKey,
  revokeOAuthApiKey,
} from "../oauth-provisioning.ts";

const EXPECTED = "https://api.frihet.io/oauth/api-key";
const SERVICE_SECRET = "s".repeat(32);
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const OPENAI_BINDING = {
  uid: "uid-test",
  accessProfile: "openai",
  oauthResource: "https://openai-mcp.frihet.io",
} as const;

test("OAuth provisioning golden matches the ERP two-phase contract", () => {
  assert.deepEqual(OAUTH_PROVISIONING_CONTRACT, {
    contractVersion: "2026-08-30",
    candidateRequestKeys: ["accessProfile", "correlationId", "oauthResource", "uid"],
    legacyRequestKeys: ["uid"],
    responseKeys: ["apiKey", "expiresAt", "keyId"],
    candidateLifetimeDays: 30,
    legacyLifetimeDays: 365,
    keyIdPattern: "^[A-Za-z0-9]{20}$",
    bindings: {
      openai: "https://openai-mcp.frihet.io",
      full: "https://mcp.frihet.io",
    },
    permissions: ["read", "write"],
  });
});

test("resolveOAuthApiKeyUrl strips /v1 suffix (the production bug)", () => {
  assert.equal(resolveOAuthApiKeyUrl("https://api.frihet.io/v1"), EXPECTED);
});

test("OAuth provisioning accepts only Frihet's exact one-time bound key tuple", () => {
  const valid = `fri_${"A".repeat(43)}`;
  const keyId = "AbCdEfGhIjKlMnOpQrSt";
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  assert.deepEqual(
    parseProvisionedOAuthApiKey({ apiKey: valid, keyId, expiresAt }, OPENAI_BINDING),
    { apiKey: valid, keyId, expiresAt, ...OPENAI_BINDING },
  );

  for (const payload of [
    null,
    [],
    {},
    { apiKey: undefined },
    { apiKey: "" },
    { apiKey: "fri_short" },
    { apiKey: `fri_${"A".repeat(42)}` },
    { apiKey: `fri_${"A".repeat(44)}` },
    { apiKey: `other_${"A".repeat(43)}` },
    { apiKey: `fri_${"A".repeat(42)}!` },
    { apiKey: ` ${valid}`, keyId, expiresAt },
    { apiKey: valid, keyId: "short", expiresAt },
    { apiKey: valid, keyId, expiresAt: "not-a-date" },
    { apiKey: valid, keyId, expiresAt: "2027-02-30T12:34:56.000Z" },
    {
      apiKey: valid,
      keyId,
      expiresAt: new Date(Date.now() + 32 * 24 * 60 * 60 * 1000).toISOString(),
    },
    { apiKey: valid, keyId, expiresAt, unexpected: true },
  ]) {
    assert.equal(
      parseProvisionedOAuthApiKey(payload, OPENAI_BINDING),
      undefined,
      JSON.stringify(payload),
    );
  }
});

test("resolveOAuthApiKeyUrl accepts origin form", () => {
  assert.equal(resolveOAuthApiKeyUrl("https://api.frihet.io"), EXPECTED);
});

test("OAuth lifecycle leaf accepts only the two exact resolved authorities", () => {
  assert.equal(isTrustedOAuthApiKeyUrl(EXPECTED), true);
  assert.equal(
    isTrustedOAuthApiKeyUrl(
      "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/publicApi/api/oauth/api-key",
    ),
    true,
  );
  for (const candidate of [
    "http://api.frihet.io/oauth/api-key",
    "https://api.frihet.io:444/oauth/api-key",
    "https://user:password@api.frihet.io/oauth/api-key",
    "https://api.frihet.io/oauth/api-key/",
    "https://api.frihet.io/oauth/api-key?redirect=evil",
    "https://api.frihet.io.evil.example/oauth/api-key",
    "https://attacker-project.cloudfunctions.net/publicApi/api/oauth/api-key",
  ]) {
    assert.equal(isTrustedOAuthApiKeyUrl(candidate), false, candidate);
  }
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

test("tool requests also fall back to the direct CF origin when the env var is unset", () => {
  const cfFallback =
    "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/publicApi/api/v1";
  assert.equal(resolveApiBaseUrl(undefined), cfFallback);
  assert.equal(resolveApiBaseUrl(""), cfFallback);
  assert.ok(!resolveApiBaseUrl(undefined).includes("api.frihet.io"));
});

test("resolveOAuthApiKeyUrl only strips a /v1 SEGMENT, not substrings", () => {
  assert.throws(() => resolveOAuthApiKeyUrl("https://api-v1.frihet.io"));
});

test("tool and OAuth bases canonicalize trusted Frihet and exact Cloud Function origins", () => {
  assert.equal(resolveApiBaseUrl("https://API.FRIHET.IO:443/"), "https://api.frihet.io/v1");
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
    "https://.frihet.io/v1",
    "https://.api.frihet.io/v1",
    "https://api..frihet.io/v1",
    "https://api.frihet.io./v1",
    "https://api.frihet.io/v1?redirect=evil",
    "https://api.frihet.io/v1#fragment",
    "https://api.frihet.io/arbitrary",
    "https://frihet.io/v1",
    "https://mcp.frihet.io/v1",
    "https://api-v1.frihet.io/v1",
    "https://attacker-project.cloudfunctions.net/publicApi/api",
    "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/other/path",
  ];

  for (const candidate of rejected) {
    assert.throws(() => resolveApiBaseUrl(candidate), candidate);
    assert.throws(() => resolveOAuthApiKeyUrl(candidate), candidate);
  }
});

test("OAuth provisioning behavior blocks redirects before the bearer token reaches a sink", async () => {
  const sinkRequests: Array<{ authorization: string | undefined }> = [];
  const redirectRequests: Array<{ authorization: string | undefined }> = [];
  const sink = createServer((req, res) => {
    sinkRequests.push({ authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ apiKey: "unused" }));
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  const sinkPort = (sink.address() as AddressInfo).port;

  const redirector = createServer((req, res) => {
    redirectRequests.push({ authorization: req.headers.authorization });
    res.writeHead(307, { location: `http://127.0.0.1:${sinkPort}/oauth-sink` });
    res.end();
  });
  await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
  const redirectPort = (redirector.address() as AddressInfo).port;

  const remappedFetch = async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), EXPECTED);
    return globalThis.fetch(`http://127.0.0.1:${redirectPort}/oauth/api-key`, init);
  };

  try {
    await assert.rejects(
      () => provisionOAuthApiKey(
        EXPECTED,
        "test-id-token",
        SERVICE_SECRET,
        OPENAI_BINDING,
        CORRELATION_ID,
        remappedFetch,
      ),
      (error: Error) => {
        assert.ok(!error.message.includes("test-id-token"));
        return true;
      },
    );
  } finally {
    await Promise.all([
      new Promise<void>((resolve, reject) => sink.close((error) => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => redirector.close((error) => error ? reject(error) : resolve())),
    ]);
  }

  assert.equal(redirectRequests.length, 1);
  assert.equal(redirectRequests[0]?.authorization, "Bearer test-id-token");
  assert.deepEqual(sinkRequests, []);
});

test("OAuth provision and revoke requests send exact bound bodies without the raw key on DELETE", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return new Response(null, { status: 200 });
  };

  await provisionOAuthApiKey(
    EXPECTED,
    "firebase-token",
    SERVICE_SECRET,
    OPENAI_BINDING,
    CORRELATION_ID,
    fetchImpl,
  );
  await revokeOAuthApiKey(
    EXPECTED,
    "s".repeat(32),
    { ...OPENAI_BINDING, keyId: "AbCdEfGhIjKlMnOpQrSt" },
    fetchImpl,
  );

  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.redirect, "error");
  assert.equal(calls[0]?.init?.body, JSON.stringify({
    ...OPENAI_BINDING,
    correlationId: CORRELATION_ID,
  }));
  assert.equal(
    (calls[0]?.init?.headers as Record<string, string>)["x-frihet-oauth-key"],
    SERVICE_SECRET,
  );
  assert.equal(calls[1]?.init?.method, "DELETE");
  assert.equal(calls[1]?.init?.redirect, "error");
  assert.equal(calls[1]?.init?.body, JSON.stringify({
    ...OPENAI_BINDING,
    keyId: "AbCdEfGhIjKlMnOpQrSt",
  }));
  assert.doesNotMatch(String(calls[1]?.init?.body), /fri_/u);
  assert.equal(
    (calls[1]?.init?.headers as Record<string, string>)["x-frihet-oauth-key"],
    "s".repeat(32),
  );
  assert.throws(() => revokeOAuthApiKey(
    EXPECTED,
    "too-short",
    { ...OPENAI_BINDING, keyId: "AbCdEfGhIjKlMnOpQrSt" },
    fetchImpl,
  ));
  assert.throws(() => provisionOAuthApiKey(
    EXPECTED,
    "firebase-token",
    "too-short",
    OPENAI_BINDING,
    CORRELATION_ID,
    fetchImpl,
  ));
  assert.throws(() => provisionOAuthApiKey(
    EXPECTED,
    "firebase-token",
    SERVICE_SECRET,
    OPENAI_BINDING,
    "not-a-correlation-id",
    fetchImpl,
  ));
});

test("OAuth lifecycle leaf rejects attacker-controlled URLs before fetch sees either secret", () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 200 });
  };
  const binding = { ...OPENAI_BINDING, keyId: "AbCdEfGhIjKlMnOpQrSt" };

  for (const candidate of [
    "https://evil.example/oauth/api-key",
    "https://api.frihet.io/oauth/api-key/",
    "https://api.frihet.io/oauth/api-key?redirect=evil",
    "https://api.frihet.io.evil.example/oauth/api-key",
  ]) {
    assert.throws(
      () => provisionOAuthApiKey(
        candidate,
        "firebase-token",
        SERVICE_SECRET,
        OPENAI_BINDING,
        CORRELATION_ID,
        fetchImpl,
      ),
      /lifecycle authority is not trusted/u,
      candidate,
    );
    assert.throws(
      () => revokeOAuthApiKey(candidate, SERVICE_SECRET, binding, fetchImpl),
      /lifecycle authority is not trusted/u,
      candidate,
    );
  }
  assert.equal(fetchCalls, 0);
});
