import assert from "node:assert/strict";
import { test } from "node:test";

import type { TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import {
  OAuthTokenFamilyExchange,
  OAuthTokenFamilyGuardError,
  OAuthTokenFamilyRevocation,
} from "../oauth-token-family.ts";
import { OAuthStateStore } from "../oauth-state-store.ts";

class FakeStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async setAlarm(): Promise<void> {}

  async deleteAll(): Promise<void> {
    this.values.clear();
  }
}

class FakeState {
  readonly storage = new FakeStorage();
  private queue: Promise<void> = Promise.resolve();

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const prior = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return prior.then(callback).finally(release);
  }
}

class FakeDurableObjectNamespace {
  private readonly stores = new Map<string, OAuthStateStore>();

  idFromName(name: string): DurableObjectId {
    return { name } as unknown as DurableObjectId;
  }

  get(id: DurableObjectId): DurableObjectStub {
    const name = (id as unknown as { name: string }).name;
    let store = this.stores.get(name);
    if (!store) {
      store = new OAuthStateStore(new FakeState() as unknown as DurableObjectState);
      this.stores.set(name, store);
    }
    return {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        store!.fetch(new Request(input, init)),
    } as unknown as DurableObjectStub;
  }
}

class FakeKv {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    const value = this.values.get(key);
    return value === undefined ? null : structuredClone(value) as T;
  }

  putJson(key: string, value: unknown): void {
    this.values.set(key, structuredClone(value));
  }
}

const USER_ID = "firebase-user";
const GRANT_ID = "g".repeat(16);
const CLIENT_ID = "c".repeat(16);
const CODE = `${USER_ID}:${GRANT_ID}:${"A".repeat(32)}`;
const REFRESH_0 = `${USER_ID}:${GRANT_ID}:${"B".repeat(32)}`;
const REFRESH_1 = `${USER_ID}:${GRANT_ID}:${"C".repeat(32)}`;
const ACCESS_0 = `${USER_ID}:${GRANT_ID}:${"D".repeat(32)}`;
const BINDING = {
  uid: USER_ID,
  keyId: "AbCdEfGhIjKlMnOpQrSt",
  accessProfile: "openai",
  oauthResource: "https://openai-mcp.frihet.io",
} as const;

async function providerHash(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function callbackOptions(grantType: "authorization_code" | "refresh_token") {
  return {
    grantType,
    clientId: CLIENT_ID,
    userId: USER_ID,
    scope: ["frihet:workspace.manage"],
    requestedScope: ["frihet:workspace.manage"],
    props: {
      apiKey: `fri_${"A".repeat(43)}`,
      keyId: BINDING.keyId,
      apiKeyExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      userId: USER_ID,
      accessProfile: "openai",
      oauthScope: "frihet:workspace.manage",
      oauthResource: BINDING.oauthResource,
      authMethod: "oauth",
    },
  } as unknown as TokenExchangeCallbackOptions;
}

function tokenResponse(
  refreshToken = REFRESH_0,
  overrides: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({
    access_token: ACCESS_0,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: 3600,
    scope: "frihet:workspace.manage",
    resource: "https://openai-mcp.frihet.io",
    ...overrides,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function invalidGrant(): Response {
  return new Response(JSON.stringify({ error: "invalid_grant" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

function exchangeFor(
  grantType: "authorization_code" | "refresh_token",
  credential: string,
  namespace: FakeDurableObjectNamespace,
  kv: FakeKv,
): OAuthTokenFamilyExchange {
  const form = new URLSearchParams({ grant_type: grantType });
  form.set(grantType === "authorization_code" ? "code" : "refresh_token", credential);
  const exchange = OAuthTokenFamilyExchange.fromForm(
    form,
    namespace as unknown as DurableObjectNamespace,
    kv as unknown as KVNamespace,
  );
  assert.ok(exchange);
  return exchange;
}

test("every provider-valid Firebase UID shape remains inside both guards", () => {
  const namespace = new FakeDurableObjectNamespace();
  const kv = new FakeKv();
  const firebaseUids = [
    "tenant/user",
    ".",
    "..",
    "user with spaces",
    "usuario-ñ",
    "emoji-🛡️",
    `nul\0uid`,
    "u".repeat(128),
  ];

  for (const userId of firebaseUids) {
    const credential = `${userId}:${GRANT_ID}:${"Z".repeat(32)}`;
    // This is the exact structural test used by pinned provider 0.3.0 before
    // it verifies the generated credential hash against KV.
    assert.equal(credential.split(":").length, 3, `provider grammar for ${JSON.stringify(userId)}`);

    const exchangeForm = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential,
    });
    assert.ok(OAuthTokenFamilyExchange.fromForm(
      exchangeForm,
      namespace as unknown as DurableObjectNamespace,
      kv as unknown as KVNamespace,
    ), `exchange guard for ${JSON.stringify(userId)}`);

    const revocationForm = new URLSearchParams({ token: credential });
    assert.ok(OAuthTokenFamilyRevocation.fromForm(
      revocationForm,
      namespace as unknown as DurableObjectNamespace,
      kv as unknown as KVNamespace,
    ), `revocation guard for ${JSON.stringify(userId)}`);
  }
});

async function initializeThroughAuthorizationCode(
  namespace: FakeDurableObjectNamespace,
  kv: FakeKv,
): Promise<void> {
  const grantKey = `grant:${USER_ID}:${GRANT_ID}`;
  kv.putJson(grantKey, {
    clientId: CLIENT_ID,
    authCodeId: await providerHash(CODE),
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  });
  const exchange = exchangeFor("authorization_code", CODE, namespace, kv);
  await exchange.reserve(callbackOptions("authorization_code"), BINDING);
  kv.putJson(grantKey, {
    clientId: CLIENT_ID,
    refreshTokenId: await providerHash(REFRESH_0),
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  });
  const settled = await exchange.settle(tokenResponse());
  assert.equal(settled.response.status, 200);
  assert.equal(settled.revokeGrant, false);
}

test("generic failures before the provider callback carry no revocation authority", async () => {
  const namespace = new FakeDurableObjectNamespace();
  const kv = new FakeKv();
  const exchange = exchangeFor("authorization_code", CODE, namespace, kv);

  assert.equal(exchange.hasValidatedCredential(), false);
  assert.equal(await exchange.settleThrown(new Error("provider rejected request")), undefined);
  assert.equal(exchange.hasValidatedCredential(), false);
});

test("the provider callback records validation only after family binding matches", async () => {
  const namespace = new FakeDurableObjectNamespace();
  const kv = new FakeKv();
  kv.putJson(`grant:${USER_ID}:${GRANT_ID}`, {
    clientId: CLIENT_ID,
    authCodeId: await providerHash(CODE),
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  });

  const mismatch = exchangeFor("authorization_code", CODE, namespace, kv);
  await assert.rejects(
    () => mismatch.reserve(
      { ...callbackOptions("authorization_code"), userId: "another-user" },
      BINDING,
    ),
    OAuthTokenFamilyGuardError,
  );
  assert.equal(mismatch.hasValidatedCredential(), false);

  const exchange = exchangeFor("authorization_code", CODE, namespace, kv);
  await exchange.reserve(callbackOptions("authorization_code"), BINDING);
  assert.equal(exchange.hasValidatedCredential(), true);
});

test("two accepted authorization-code exchanges release zero token responses", async () => {
  const namespace = new FakeDurableObjectNamespace();
  const kv = new FakeKv();
  kv.putJson(`grant:${USER_ID}:${GRANT_ID}`, {
    clientId: CLIENT_ID,
    authCodeId: await providerHash(CODE),
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  });

  const left = exchangeFor("authorization_code", CODE, namespace, kv);
  const right = exchangeFor("authorization_code", CODE, namespace, kv);
  const reservations = await Promise.allSettled([
    left.reserve(callbackOptions("authorization_code"), BINDING),
    right.reserve(callbackOptions("authorization_code"), BINDING),
  ]);
  assert.equal(reservations.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(reservations.filter((result) => result.status === "rejected").length, 1);

  const winnerIndex = reservations.findIndex((result) => result.status === "fulfilled");
  const winner = winnerIndex === 0 ? left : right;
  const loser = winnerIndex === 0 ? right : left;
  const loserReason = reservations[winnerIndex === 0 ? 1 : 0];
  assert.equal(loserReason?.status, "rejected");
  if (loserReason?.status !== "rejected") return;
  assert.ok(loserReason.reason instanceof OAuthTokenFamilyGuardError);

  const losingSettlement = await loser.settleThrown(loserReason.reason);
  assert.equal(losingSettlement?.response.status, 400);
  const winningSettlement = await winner.settle(tokenResponse());
  assert.equal(winningSettlement.response.status, 400);
  assert.equal(winningSettlement.revokeGrant, true);
});

test("two accepted uses of one current refresh token tombstone before either 200 escapes", async () => {
  const namespace = new FakeDurableObjectNamespace();
  const kv = new FakeKv();
  await initializeThroughAuthorizationCode(namespace, kv);

  const left = exchangeFor("refresh_token", REFRESH_0, namespace, kv);
  const right = exchangeFor("refresh_token", REFRESH_0, namespace, kv);
  const reservations = await Promise.allSettled([
    left.reserve(callbackOptions("refresh_token"), BINDING),
    right.reserve(callbackOptions("refresh_token"), BINDING),
  ]);
  assert.equal(reservations.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(reservations.filter((result) => result.status === "rejected").length, 1);

  const winnerIndex = reservations.findIndex((result) => result.status === "fulfilled");
  const winner = winnerIndex === 0 ? left : right;
  const loser = winnerIndex === 0 ? right : left;
  const loserReason = reservations[winnerIndex === 0 ? 1 : 0];
  assert.equal(loserReason?.status, "rejected");
  if (loserReason?.status !== "rejected") return;

  const losingSettlement = await loser.settleThrown(loserReason.reason);
  assert.equal(losingSettlement?.response.status, 400);
  const winningSettlement = await winner.settle(tokenResponse(REFRESH_1));
  assert.equal(winningSettlement.response.status, 400);
  assert.equal(winningSettlement.revokeGrant, true);
});

test("a spent authorization code detected after the provider rejects it revokes the family", async () => {
  const namespace = new FakeDurableObjectNamespace();
  const kv = new FakeKv();
  await initializeThroughAuthorizationCode(namespace, kv);

  const replay = exchangeFor("authorization_code", CODE, namespace, kv);
  const settlement = await replay.settle(invalidGrant());
  assert.equal(settlement.response.status, 400);
  assert.equal(settlement.revokeGrant, true);
  assert.deepEqual(settlement.apiKeyBinding, BINDING);

  const current = exchangeFor("refresh_token", REFRESH_0, namespace, kv);
  await assert.rejects(
    () => current.reserve(callbackOptions("refresh_token"), BINDING),
    (error: unknown) => error instanceof OAuthTokenFamilyGuardError
      && error.reason === "revoked",
  );
});

test("unknown structured credentials cannot tombstone an active family", async () => {
  const namespace = new FakeDurableObjectNamespace();
  const kv = new FakeKv();
  await initializeThroughAuthorizationCode(namespace, kv);

  const unknown = `${USER_ID}:${GRANT_ID}:${"Z".repeat(32)}`;
  const unknownExchange = exchangeFor("refresh_token", unknown, namespace, kv);
  const rejected = await unknownExchange.settle(invalidGrant());
  assert.equal(rejected.revokeGrant, false);

  const current = exchangeFor("refresh_token", REFRESH_0, namespace, kv);
  await current.reserve(callbackOptions("refresh_token"), BINDING);
});

test("a provider success with widened token metadata is withheld and revokes the family", async () => {
  const namespace = new FakeDurableObjectNamespace();
  const kv = new FakeKv();
  kv.putJson(`grant:${USER_ID}:${GRANT_ID}`, {
    clientId: CLIENT_ID,
    authCodeId: await providerHash(CODE),
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  });
  const exchange = exchangeFor("authorization_code", CODE, namespace, kv);
  await exchange.reserve(callbackOptions("authorization_code"), BINDING);

  const settlement = await exchange.settle(tokenResponse(REFRESH_0, {
    resource: "https://mcp.frihet.io",
  }));
  assert.equal(settlement.response.status, 400);
  assert.equal(settlement.revokeGrant, true);
  assert.deepEqual(settlement.apiKeyBinding, BINDING);
});

test("a legacy previous refresh token is treated as replay, never as family head", async () => {
  const namespace = new FakeDurableObjectNamespace();
  const kv = new FakeKv();
  kv.putJson(`grant:${USER_ID}:${GRANT_ID}`, {
    clientId: CLIENT_ID,
    refreshTokenId: await providerHash(REFRESH_1),
    previousRefreshTokenId: await providerHash(REFRESH_0),
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  });

  const previous = exchangeFor("refresh_token", REFRESH_0, namespace, kv);
  await assert.rejects(
    () => previous.reserve(callbackOptions("refresh_token"), BINDING),
    (error: unknown) => error instanceof OAuthTokenFamilyGuardError
      && error.reason === "replay",
  );
  const current = exchangeFor("refresh_token", REFRESH_1, namespace, kv);
  await assert.rejects(
    () => current.reserve(callbackOptions("refresh_token"), BINDING),
    (error: unknown) => error instanceof OAuthTokenFamilyGuardError
      && error.reason === "revoked",
  );
});

test("RFC 7009 revocation is client-bound and refresh revocation tombstones the family", async () => {
  const namespace = new FakeDurableObjectNamespace();
  const kv = new FakeKv();
  await initializeThroughAuthorizationCode(namespace, kv);

  const attackerForm = new URLSearchParams({
    token: REFRESH_0,
    client_id: "attacker-client",
  });
  const attacker = OAuthTokenFamilyRevocation.fromForm(
    attackerForm,
    namespace as unknown as DurableObjectNamespace,
    kv as unknown as KVNamespace,
  );
  assert.ok(attacker);
  const attackerRequest = new Request("https://openai-mcp.frihet.io/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: attackerForm.toString(),
  });
  const protectedAttackerRequest = await attacker.protectRequest(attackerRequest, attackerForm);
  const protectedAttackerForm = new URLSearchParams(await protectedAttackerRequest.text());
  assert.equal(protectedAttackerForm.get("token"), "invalid");
  assert.equal((await attacker.settle(new Response(null, { status: 200 }))).revokeGrant, false);

  const ownerForm = new URLSearchParams({ token: REFRESH_0, client_id: CLIENT_ID });
  const owner = OAuthTokenFamilyRevocation.fromForm(
    ownerForm,
    namespace as unknown as DurableObjectNamespace,
    kv as unknown as KVNamespace,
  );
  assert.ok(owner);
  const ownerRequest = new Request("https://openai-mcp.frihet.io/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: ownerForm.toString(),
  });
  assert.equal(await owner.protectRequest(ownerRequest, ownerForm), ownerRequest);
  const ownerSettlement = await owner.settle(new Response(null, { status: 200 }));
  assert.equal(ownerSettlement.revokeGrant, true);
  assert.deepEqual(ownerSettlement.apiKeyBinding, BINDING);
});

test("same-client access-token revocation does not destroy the refresh family", async () => {
  const namespace = new FakeDurableObjectNamespace();
  const kv = new FakeKv();
  await initializeThroughAuthorizationCode(namespace, kv);
  kv.putJson(`token:${USER_ID}:${GRANT_ID}:${await providerHash(ACCESS_0)}`, {
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    grant: { clientId: CLIENT_ID },
  });

  const form = new URLSearchParams({ token: ACCESS_0, client_id: CLIENT_ID });
  const revocation = OAuthTokenFamilyRevocation.fromForm(
    form,
    namespace as unknown as DurableObjectNamespace,
    kv as unknown as KVNamespace,
  );
  assert.ok(revocation);
  const request = new Request("https://openai-mcp.frihet.io/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  assert.equal(await revocation.protectRequest(request, form), request);
  assert.equal((await revocation.settle(new Response(null, { status: 200 }))).revokeGrant, false);

  const current = exchangeFor("refresh_token", REFRESH_0, namespace, kv);
  await current.reserve(callbackOptions("refresh_token"), BINDING);
});
