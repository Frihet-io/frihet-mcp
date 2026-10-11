import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OAuthStateStore,
  type OAuthCleanupAuthorities,
} from "../oauth-state-store.ts";

class FakeStorage {
  readonly values = new Map<string, unknown>();
  alarm?: number;
  failTransactionAfterPuts?: number;
  private transactionPuts = 0;
  private withinTransaction = false;

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  async put(key: string, value: unknown): Promise<void> {
    if (
      this.withinTransaction
      && this.failTransactionAfterPuts !== undefined
      && this.transactionPuts >= this.failTransactionAfterPuts
    ) {
      throw new Error("injected transaction failure");
    }
    if (this.withinTransaction) this.transactionPuts += 1;
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async transaction<T>(callback: (transaction: DurableObjectTransaction) => Promise<T>): Promise<T> {
    const snapshot = new Map(
      [...this.values].map(([key, value]) => [key, structuredClone(value)]),
    );
    const alarm = this.alarm;
    this.withinTransaction = true;
    this.transactionPuts = 0;
    try {
      return await callback(this as unknown as DurableObjectTransaction);
    } catch (error) {
      this.values.clear();
      for (const [key, value] of snapshot) this.values.set(key, value);
      this.alarm = alarm;
      throw error;
    } finally {
      this.withinTransaction = false;
      this.transactionPuts = 0;
    }
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarm = timestamp;
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
    this.alarm = undefined;
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

const TEST_ENV = {
  OAUTH_KV: {} as KVNamespace,
  FRIHET_API_BASE: "https://api.frihet.io",
  FRIHET_OPENAI_MODE: "true",
  FRIHET_OAUTH_API_KEY: "test-service-secret-that-is-never-sent",
};

const SUCCESSFUL_CLEANUP: OAuthCleanupAuthorities = {
  async revokeGrant(): Promise<void> {},
  async revokeBackend(): Promise<boolean> {
    return true;
  },
  async revokeBackendCorrelation(): Promise<boolean> {
    return true;
  },
};

function makeStore(options: {
  state?: FakeState;
  cleanupAuthorities?: OAuthCleanupAuthorities;
  env?: Partial<typeof TEST_ENV> & { FRIHET_CLAUDE_MODE?: string; FRIHET_CLAUDE_OAUTH_API_KEY?: string };
} = {}): { store: OAuthStateStore; state: FakeState } {
  const state = options.state ?? new FakeState();
  return {
    store: new OAuthStateStore(
      state as unknown as DurableObjectState,
      { ...TEST_ENV, ...options.env },
      options.cleanupAuthorities ?? SUCCESSFUL_CLEANUP,
    ),
    state,
  };
}

const OPENAI_BINDING = {
  uid: "firebase-user",
  keyId: "AbCdEfGhIjKlMnOpQrSt",
  accessProfile: "openai",
  oauthResource: "https://openai-mcp.frihet.io",
} as const;

function familyRequest(path: string, body?: unknown, method = "POST"): Request {
  const requestBody = path === "/token-family"
    && method === "PUT"
    && body !== null
    && typeof body === "object"
    && !Array.isArray(body)
    ? { userId: "firebase-user", grantId: "g".repeat(16), ...body }
    : body;
  return new Request(`https://oauth-state.internal${path}`, {
    method,
    ...(requestBody === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        }),
  });
}

async function familyJson(
  store: OAuthStateStore,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await store.fetch(familyRequest(path, body));
  assert.equal(response.status, 200);
  return response.json() as Promise<Record<string, unknown>>;
}

function stateRequest(path: string, body?: unknown, method = "POST"): Request {
  return new Request(`https://oauth-state.internal${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

async function stateJson(store: OAuthStateStore, path: string, body?: unknown) {
  const response = await store.fetch(stateRequest(path, body));
  assert.equal(response.status, 200);
  return response.json() as Promise<Record<string, unknown>>;
}

async function putState(store: OAuthStateStore, payload: string): Promise<number> {
  return (await store.fetch(new Request("https://oauth-state.internal/state", {
    method: "PUT",
    body: payload,
  }))).status;
}

test("OAuth state is stored once, non-cacheable, and leased to one callback at a time", async () => {
  const { store, state } = makeStore();
  const payload = JSON.stringify({ clientId: "client_test", scope: ["frihet:workspace.manage"] });
  assert.equal(await putState(store, payload), 204);
  assert.ok((state.storage.alarm ?? 0) > Date.now());

  const [left, right] = await Promise.all([
    store.fetch(stateRequest("/reserve")),
    store.fetch(stateRequest("/reserve")),
  ]);
  const bodies = await Promise.all([left, right].map((response) => response.json())) as Array<Record<string, unknown>>;
  const reserved = bodies.find((body) => body.outcome === "reserved")!;
  assert.deepEqual(bodies.map((body) => body.outcome).sort(), ["busy", "reserved"]);
  assert.equal(reserved.payload, payload);
  assert.equal(reserved.attempt, 1);
  assert.deepEqual(reserved.reconcile, []);
  assert.notEqual(reserved.correlationId, reserved.leaseId);
  assert.equal(left.headers.get("cache-control"), "no-store");
  assert.equal(left.headers.get("pragma"), "no-cache");

  // Commit requires the armed lease; afterwards the state only reads as committed.
  assert.deepEqual(await stateJson(store, "/commit", { leaseId: reserved.leaseId }), { outcome: "lease_lost" });
  assert.deepEqual(
    await stateJson(store, "/attempt", { leaseId: reserved.leaseId, uid: "firebase-user", reconciled: [] }),
    { outcome: "armed" },
  );
  assert.deepEqual(await stateJson(store, "/commit", { leaseId: reserved.leaseId }), { outcome: "committed" });
  assert.deepEqual(
    await stateJson(store, "/commit", { leaseId: reserved.leaseId }),
    { outcome: "committed" },
    "commit is idempotent for its own lease",
  );
  assert.deepEqual(await stateJson(store, "/reserve"), { outcome: "committed" });
  assert.equal(JSON.stringify(state.storage.values.get("oauth_request")).includes("client_test"), false);
});

test("OAuth state lease: release returns it, an armed unknown attempt must be reconciled first", async (context) => {
  let now = 1_800_000_000_000;
  context.mock.method(Date, "now", () => now);
  const { store } = makeStore();
  assert.equal(await putState(store, "request"), 204);

  const first = await stateJson(store, "/reserve");
  assert.deepEqual(await stateJson(store, "/attempt", { leaseId: first.leaseId, uid: "firebase-user", reconciled: [] }), { outcome: "armed" });
  assert.equal((await store.fetch(stateRequest("/release", { leaseId: first.leaseId, outcome: "unknown" }))).status, 204);

  const second = await stateJson(store, "/reserve");
  assert.equal(second.outcome, "reserved");
  assert.notEqual(second.correlationId, first.correlationId);
  assert.deepEqual(second.reconcile, [{ uid: "firebase-user", correlationId: first.correlationId }]);
  assert.deepEqual(
    await stateJson(store, "/attempt", { leaseId: second.leaseId, uid: "firebase-user", reconciled: [] }),
    { outcome: "unreconciled" },
    "no new credential request while an earlier one is unproven",
  );
  assert.deepEqual(
    await stateJson(store, "/attempt", { leaseId: second.leaseId, uid: "other-user", reconciled: [first.correlationId] }),
    { outcome: "armed" },
  );

  // An armed lease abandoned past its TTL is surrendered to the next holder.
  now += 60_000;
  const third = await stateJson(store, "/reserve");
  assert.equal(third.outcome, "reserved");
  assert.deepEqual(third.reconcile, [{ uid: "other-user", correlationId: second.correlationId }]);
  assert.deepEqual(await stateJson(store, "/commit", { leaseId: second.leaseId }), { outcome: "lease_lost" });
  assert.equal((await store.fetch(stateRequest("/release", { leaseId: second.leaseId, outcome: "unknown" }))).status, 204);
  assert.deepEqual(
    (await stateJson(store, "/attempt", { leaseId: third.leaseId, uid: "firebase-user", reconciled: [] })).outcome,
    "unreconciled",
    "a stale holder's release cannot clear or add attempts",
  );
});

test("OAuth state attempts are bounded and arming after the lease TTL is refused", async (context) => {
  let now = 1_800_000_000_000;
  context.mock.method(Date, "now", () => now);
  const { store } = makeStore();
  assert.equal(await putState(store, "request"), 204);

  const late = await stateJson(store, "/reserve");
  now += 60_000;
  assert.deepEqual(
    await stateJson(store, "/attempt", { leaseId: late.leaseId, uid: "firebase-user", reconciled: [] }),
    { outcome: "lease_lost" },
  );
  for (let attempt = 2; attempt <= 5; attempt += 1) {
    const lease = await stateJson(store, "/reserve");
    assert.equal(lease.attempt, attempt);
    assert.equal((await store.fetch(stateRequest("/release", { leaseId: lease.leaseId, outcome: "clean" }))).status, 204);
  }
  assert.deepEqual(await stateJson(store, "/reserve"), { outcome: "exhausted" });
});

test("OAuth state arms an attempt only with 30 s of state lifetime left", async (context) => {
  let now = 1_800_000_000_000;
  context.mock.method(Date, "now", () => now);
  const arm = async (remainingMs: number) => {
    const { store } = makeStore();
    now = 1_800_000_000_000;
    assert.equal(await putState(store, "request"), 204);
    now += 10 * 60_000 - remainingMs;
    const lease = await stateJson(store, "/reserve");
    return stateJson(store, "/attempt", { leaseId: lease.leaseId, uid: "firebase-user", reconciled: [] });
  };
  assert.deepEqual(await arm(30_000), { outcome: "armed" });
  assert.deepEqual(await arm(29_999), { outcome: "expired" });
});

test("OAuth state rejects replacement and expires through its alarm", async (context) => {
  let now = 1_800_000_000_000;
  context.mock.method(Date, "now", () => now);
  const { store, state } = makeStore();

  assert.equal(await putState(store, "first"), 204);
  assert.equal(await putState(store, "replacement"), 409);

  await store.alarm();
  const early = await stateJson(store, "/reserve");
  assert.equal(early.outcome, "reserved", "an early alarm must not shorten the stored state TTL");
  assert.equal(early.payload, "first");
  assert.equal((await store.fetch(stateRequest("/release", { leaseId: early.leaseId, outcome: "clean" }))).status, 204);

  now += 600_000;
  await store.alarm();
  assert.equal(state.storage.values.size, 0, "an expired state with nothing to reconcile is deleted");
  assert.deepEqual(await stateJson(store, "/reserve"), { outcome: "missing" });
  assert.equal(await putState(store, "second"), 204);
});

test("OAuth state enforces its TTL when the alarm is delayed, including the exact boundary", async (context) => {
  const t0 = 1_800_000_000_000;
  let now = t0;
  context.mock.method(Date, "now", () => now);

  const beforeBoundary = makeStore();
  assert.equal(await putState(beforeBoundary.store, "before-boundary"), 204);
  assert.deepEqual(beforeBoundary.state.storage.values.get("oauth_request"), {
    version: 2,
    accessProfile: "openai",
    status: "pending",
    payload: "before-boundary",
    expiresAtMs: t0 + 600_000,
    attempts: 0,
    unreconciled: [],
  });
  now = t0 + 599_999;
  const accepted = await stateJson(beforeBoundary.store, "/reserve");
  assert.equal(accepted.outcome, "reserved");
  assert.equal(accepted.payload, "before-boundary");

  now = t0;
  const atBoundary = makeStore();
  assert.equal(await putState(atBoundary.store, "at-boundary"), 204);
  now = t0 + 600_000;
  assert.deepEqual(
    await stateJson(atBoundary.store, "/reserve"),
    { outcome: "expired" },
    "Date.now() === expiresAtMs must be expired",
  );
  assert.equal(atBoundary.state.storage.values.size, 0);
});

const CLAUDE_ENV = {
  FRIHET_OPENAI_MODE: "false",
  FRIHET_CLAUDE_MODE: "true",
  FRIHET_CLAUDE_OAUTH_API_KEY: "synthetic-claude-service-secret-at-least-32bytes",
};

const CLAUDE_BINDING = {
  ...OPENAI_BINDING,
  accessProfile: "claude",
  oauthResource: "https://claude-mcp.frihet.io",
} as const;

test("each Worker accepts only its exact profile/resource pair in token-family bodies", async () => {
  for (const [env, binding] of [[{}, OPENAI_BINDING], [CLAUDE_ENV, CLAUDE_BINDING]] as const) {
    const { store } = makeStore({ env });
    const body = {
      currentKind: "authorization_code",
      currentHash: "a".repeat(64),
      expiresAtMs: Date.now() + 60_000,
      apiKeyBinding: binding,
    };
    for (const wrongBinding of [
      binding.accessProfile === "claude" ? OPENAI_BINDING : CLAUDE_BINDING,
      { ...binding, oauthResource: binding.accessProfile === "claude" ? OPENAI_BINDING.oauthResource : CLAUDE_BINDING.oauthResource },
      { ...binding, accessProfile: "full", oauthResource: "https://mcp.frihet.io" },
      { ...binding, extra: true },
    ]) {
      assert.equal((await store.fetch(familyRequest("/token-family", { ...body, apiKeyBinding: wrongBinding }, "PUT"))).status, 400);
    }
    assert.equal((await store.fetch(familyRequest("/token-family", body, "PUT"))).status, 204);
    const begun = await familyJson(store, "/token-family/begin", { kind: "authorization_code", credentialHash: body.currentHash });
    assert.equal(begun.outcome, "started");
    assert.equal((await store.fetch(familyRequest("/token-family/commit", {
      leaseId: begun.leaseId,
      newRefreshTokenHash: "b".repeat(64),
      apiKeyBinding: { ...binding, oauthResource: "https://mcp.frihet.io" },
    }))).status, 400);
  }
});

test("misbound DO namespace rejects state and family access before any grant or backend cleanup", async () => {
  const calls: string[] = [];
  const cleanupAuthorities: OAuthCleanupAuthorities = {
    async revokeGrant() { calls.push("grant"); },
    async revokeBackend() { calls.push("backend"); return true; },
    async revokeBackendCorrelation() { calls.push("correlation"); return true; },
  };
  const original = makeStore({ cleanupAuthorities });
  assert.equal((await original.store.fetch(familyRequest("/token-family", {
    currentKind: "refresh_token",
    currentHash: "a".repeat(64),
    expiresAtMs: Date.now() + 60_000,
    apiKeyBinding: OPENAI_BINDING,
  }, "PUT"))).status, 204);
  const wrongWorker = makeStore({ state: original.state, cleanupAuthorities, env: CLAUDE_ENV });
  for (const path of ["/token-family/begin", "/token-family/check", "/token-family/revoke", "/token-family/abort"]) {
    await assert.rejects(() => wrongWorker.store.fetch(familyRequest(path, {})), /profile differs from the Worker/u);
  }
  await assert.rejects(() => wrongWorker.store.fetch(familyRequest("/token-family/status", undefined, "GET")), /profile differs from the Worker/u);
  await assert.rejects(() => wrongWorker.store.alarm(), /profile differs from the Worker/u);
  assert.equal((original.state.storage.values.get("oauth_token_family") as {status: string}).status, "active");

  await familyJson(original.store, "/token-family/revoke", {});
  await assert.rejects(() => wrongWorker.store.alarm(), /profile differs from the Worker/u);
  assert.equal(original.state.storage.values.has("oauth_token_family_cleanup"), true);

  const oldState = makeStore({ cleanupAuthorities });
  assert.equal(await putState(oldState.store, "authorization"), 204);
  const transplantedState = makeStore({ state: oldState.state, cleanupAuthorities, env: CLAUDE_ENV });
  await assert.rejects(() => transplantedState.store.fetch(stateRequest("/reserve")), /profile differs from the Worker/u);
  await assert.rejects(() => transplantedState.store.alarm(), /profile differs from the Worker/u);
  assert.equal(oldState.state.storage.values.has("oauth_request"), true);
  assert.deepEqual(calls, []);
});

test("Claude does not adopt unmarked legacy state or family; missing flags fail closed", async () => {
  const { store, state } = makeStore({ env: CLAUDE_ENV });
  await state.storage.put("oauth_request", { version: 1, payload: "legacy", expiresAtMs: Date.now() + 60_000 });
  await assert.rejects(() => store.fetch(stateRequest("/reserve")), /profile differs from the Worker/u);
  await assert.rejects(() => store.alarm(), /profile differs from the Worker/u);
  await state.storage.deleteAll();
  await state.storage.put("oauth_token_family", {
    version: 1,
    status: "active",
    userId: "firebase-user",
    grantId: "g".repeat(16),
    currentKind: "refresh_token",
    currentHash: "a".repeat(64),
    expiresAtMs: Date.now() + 60_000,
    apiKeyBinding: OPENAI_BINDING,
  });
  await assert.rejects(() => store.fetch(familyRequest("/token-family/revoke", {})), /profile differs from the Worker/u);
  const missingFlags = makeStore({ env: { FRIHET_OPENAI_MODE: undefined } });
  await assert.rejects(() => putState(missingFlags.store, "new"), /explicitly set/u);
});

test("Claude abandoned attempt survives failed cleanup and reconciles through its own authority/secret and unchanged UUID wire", async (context) => {
  const t0 = 1_800_000_000_000;
  let now = t0;
  context.mock.method(Date, "now", () => now);
  const state = new FakeState();
  const store = new OAuthStateStore(state as unknown as DurableObjectState, { ...TEST_ENV, ...CLAUDE_ENV });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let outcome: "incomplete" | "timeout" | "proof" = "incomplete";
  context.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (outcome === "incomplete") return Response.json({ revoked: true });
    if (outcome === "timeout") throw new DOMException("Synthetic transport timeout", "TimeoutError");
    return Response.json({ revoked: true, alreadyRevoked: false, correlationTombstoned: true, activeKeys: 0 });
  });
  assert.equal(await putState(store, "claude-authorization"), 204);
  const reserved = await stateJson(store, "/reserve");
  await stateJson(store, "/attempt", { leaseId: reserved.leaseId, uid: "firebase-user", reconciled: [] });
  assert.equal((await store.fetch(stateRequest("/release", { leaseId: reserved.leaseId, outcome: "unknown" }))).status, 204);
  now += 600_000;
  await store.alarm();
  assert.equal(state.storage.values.has("oauth_request"), true);
  assert.ok((state.storage.alarm ?? 0) > now);
  outcome = "timeout";
  await store.alarm();
  assert.equal(state.storage.values.has("oauth_request"), true);
  outcome = "proof";
  await store.alarm();
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url, "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/claudeOAuthApiKeyProvisioning");
    assert.equal(call.init?.redirect, "manual");
    assert.equal(new Headers(call.init?.headers).get("x-frihet-oauth-key"), CLAUDE_ENV.FRIHET_CLAUDE_OAUTH_API_KEY);
    assert.deepEqual(JSON.parse(String(call.init?.body)), { uid: "firebase-user", correlationId: reserved.correlationId });
  }
  assert.equal(state.storage.values.size, 0);
});

test("OAuth state still reads a pre-lease envelope written by an earlier Worker", async () => {
  const { store, state } = makeStore();
  await state.storage.put("oauth_request", {
    version: 1,
    payload: "legacy-request",
    expiresAtMs: Date.now() + 60_000,
  });
  const lease = await stateJson(store, "/reserve");
  assert.equal(lease.outcome, "reserved");
  assert.equal(lease.payload, "legacy-request");
  assert.equal(lease.attempt, 1);
});

test("OAuth state rejects a malformed stored record instead of returning attacker-shaped data", async () => {
  const { store, state } = makeStore();
  const uuid = "00000000-0000-4000-8000-000000000000";
  const expiresAtMs = Date.now() + 60_000;
  for (const malformed of [
    "legacy-raw-payload",
    { version: 1, payload: "x", expiresAtMs, extra: true },
    { version: 1, payload: "x", expiresAtMs: 1.5 },
    { version: 2, payload: "x", expiresAtMs },
    { version: 2, status: "pending", payload: "x", expiresAtMs, attempts: 6, unreconciled: [] },
    {
      version: 2,
      status: "pending",
      payload: "x",
      expiresAtMs,
      attempts: 0,
      unreconciled: [],
      lease: { leaseId: uuid, correlationId: uuid, expiresAtMs },
    },
    { version: 2, status: "committed", payload: "x", expiresAtMs, attempts: 1, unreconciled: [], committedLeaseId: uuid },
  ]) {
    await state.storage.put("oauth_request", malformed);
    assert.deepEqual(await stateJson(store, "/reserve"), { outcome: "missing" });
    assert.equal(state.storage.values.size, 0);
  }
});

test("OAuth state lease endpoints reject malformed bodies", async () => {
  const { store } = makeStore();
  assert.equal(await putState(store, "request"), 204);
  const lease = await stateJson(store, "/reserve");
  for (const [path, body] of [
    ["/attempt", { leaseId: lease.leaseId, uid: "firebase-user" }],
    ["/attempt", { leaseId: "not-a-uuid", uid: "firebase-user", reconciled: [] }],
    ["/attempt", { leaseId: lease.leaseId, uid: "firebase-user", reconciled: ["x"] }],
    ["/commit", { leaseId: lease.leaseId, extra: true }],
    ["/release", { leaseId: lease.leaseId, outcome: "maybe" }],
  ] as const) {
    assert.equal((await store.fetch(stateRequest(path, body))).status, 400, `${path} ${JSON.stringify(body)}`);
  }
});

test("OAuth state store rejects empty payloads and unknown methods", async () => {
  const { store } = makeStore();
  assert.equal(
    (await store.fetch(new Request("https://oauth-state.internal/state", { method: "PUT", body: "" }))).status,
    400,
  );
  assert.equal(
    (await store.fetch(new Request("https://oauth-state.internal/state", { method: "DELETE" }))).status,
    405,
  );
});

test("token family rotates once and revokes the family when a spent token reappears", async () => {
  const { store } = makeStore();
  const authorizationCodeHash = "a".repeat(64);
  const firstRefreshHash = "b".repeat(64);

  const initialized = await store.fetch(familyRequest("/token-family", {
    currentKind: "authorization_code",
    currentHash: authorizationCodeHash,
    expiresAtMs: Date.now() + 60_000,
    apiKeyBinding: OPENAI_BINDING,
  }, "PUT"));
  assert.equal(initialized.status, 204);

  const first = await familyJson(store, "/token-family/begin", {
    kind: "authorization_code",
    credentialHash: authorizationCodeHash,
  });
  assert.equal(first.outcome, "started");
  assert.equal(typeof first.leaseId, "string");

  const committed = await familyJson(store, "/token-family/commit", {
    leaseId: first.leaseId,
    newRefreshTokenHash: firstRefreshHash,
  });
  assert.equal(committed.outcome, "committed");

  const replay = await familyJson(store, "/token-family/begin", {
    kind: "authorization_code",
    credentialHash: authorizationCodeHash,
  });
  assert.equal(replay.outcome, "replay");
  assert.deepEqual(replay.apiKeyBinding, OPENAI_BINDING);

  const activeTokenAfterReplay = await familyJson(store, "/token-family/begin", {
    kind: "refresh_token",
    credentialHash: firstRefreshHash,
  });
  assert.equal(activeTokenAfterReplay.outcome, "revoked");
});

test("two concurrent accepted uses tombstone the family before either response can escape", async () => {
  const { store } = makeStore();
  const currentHash = "1".repeat(64);
  assert.equal((await store.fetch(familyRequest("/token-family", {
    currentKind: "refresh_token",
    currentHash,
    expiresAtMs: Date.now() + 60_000,
    apiKeyBinding: OPENAI_BINDING,
  }, "PUT"))).status, 204);

  const first = await familyJson(store, "/token-family/begin", {
    kind: "refresh_token",
    credentialHash: currentHash,
  });
  assert.equal(first.outcome, "started");
  const second = await familyJson(store, "/token-family/begin", {
    kind: "refresh_token",
    credentialHash: currentHash,
  });
  assert.equal(second.outcome, "replay");

  const firstCommit = await familyJson(store, "/token-family/commit", {
    leaseId: first.leaseId,
    newRefreshTokenHash: "2".repeat(64),
  });
  assert.equal(firstCommit.outcome, "revoked");
});

test("replay atomically persists its tombstone and cleanup intent before responding", async () => {
  const { store, state } = makeStore();
  const currentHash = "3".repeat(64);
  assert.equal((await store.fetch(familyRequest("/token-family", {
    currentKind: "refresh_token",
    currentHash,
    expiresAtMs: Date.now() + 60_000,
    apiKeyBinding: OPENAI_BINDING,
  }, "PUT"))).status, 204);
  const first = await familyJson(store, "/token-family/begin", {
    kind: "refresh_token",
    credentialHash: currentHash,
  });
  assert.equal(first.outcome, "started");

  state.storage.failTransactionAfterPuts = 1;
  await assert.rejects(
    () => store.fetch(familyRequest("/token-family/begin", {
      kind: "refresh_token",
      credentialHash: currentHash,
    })),
    /injected transaction failure/u,
  );
  assert.equal(
    (state.storage.values.get("oauth_token_family") as { status: string }).status,
    "active",
    "transaction rollback must not leave a tombstone without its outbox",
  );
  assert.equal(state.storage.values.has("oauth_token_family_cleanup"), false);

  state.storage.failTransactionAfterPuts = undefined;
  const replay = await familyJson(store, "/token-family/begin", {
    kind: "refresh_token",
    credentialHash: currentHash,
  });
  assert.equal(replay.outcome, "replay");
  assert.equal(
    (state.storage.values.get("oauth_token_family") as { status: string }).status,
    "revoked",
  );
  assert.equal(state.storage.values.has("oauth_token_family_cleanup"), true);
  assert.deepEqual(state.storage.values.get("oauth_token_family_cleanup"), {
    version: 1,
    accessProfile: "openai",
    userId: "firebase-user",
    grantId: "g".repeat(16),
    apiKeyBinding: OPENAI_BINDING,
    grantRevoked: false,
    backendRevoked: false,
    attempt: 0,
  });
});

test("cleanup survives restart, remembers partial ACKs, and retries until both authorities succeed", async () => {
  let grantAttempts = 0;
  let backendAttempts = 0;
  const cleanupAuthorities: OAuthCleanupAuthorities = {
    async revokeGrant(): Promise<void> {
      grantAttempts += 1;
      if (grantAttempts < 2) throw new Error("transient OAuth KV failure");
    },
    async revokeBackend(): Promise<boolean> {
      backendAttempts += 1;
      return backendAttempts >= 3;
    },
    async revokeBackendCorrelation(): Promise<boolean> {
      throw new Error("state reconciliation is not part of token-family cleanup");
    },
  };
  const firstProcess = makeStore({ cleanupAuthorities });
  const currentHash = "4".repeat(64);
  assert.equal((await firstProcess.store.fetch(familyRequest("/token-family", {
    currentKind: "refresh_token",
    currentHash,
    expiresAtMs: Date.now() + 60_000,
    apiKeyBinding: OPENAI_BINDING,
  }, "PUT"))).status, 204);
  await familyJson(firstProcess.store, "/token-family/begin", {
    kind: "refresh_token",
    credentialHash: currentHash,
  });
  const replay = await familyJson(firstProcess.store, "/token-family/begin", {
    kind: "refresh_token",
    credentialHash: currentHash,
  });
  assert.equal(replay.outcome, "replay");
  assert.equal(firstProcess.state.storage.values.has("oauth_token_family_cleanup"), true);
  assert.doesNotMatch(
    JSON.stringify([...firstProcess.state.storage.values.values()]),
    /test-service-secret|fri_[A-Za-z0-9_-]{43}/u,
  );

  await firstProcess.store.alarm();
  assert.equal(grantAttempts, 1);
  assert.equal(backendAttempts, 1);
  assert.equal(firstProcess.state.storage.values.has("oauth_token_family_cleanup"), true);
  assert.ok((firstProcess.state.storage.alarm ?? 0) - Date.now() >= 1_000);
  assert.ok((firstProcess.state.storage.alarm ?? 0) - Date.now() <= 300_000);

  const restarted = makeStore({
    state: firstProcess.state,
    cleanupAuthorities,
  }).store;
  await restarted.alarm();
  assert.equal(grantAttempts, 2);
  assert.equal(backendAttempts, 2);
  assert.equal(firstProcess.state.storage.values.has("oauth_token_family_cleanup"), true);

  await restarted.alarm();
  assert.equal(grantAttempts, 2, "an acknowledged authority must not be called again");
  assert.equal(backendAttempts, 3);
  assert.equal(firstProcess.state.storage.values.has("oauth_token_family_cleanup"), false);
  assert.equal(
    (firstProcess.state.storage.values.get("oauth_token_family") as { status: string }).status,
    "revoked",
    "the tombstone must outlive cleanup until the family expiry",
  );
});

test("token-family status changes from active to tombstoned at the exact expiry boundary", async (context) => {
  const t0 = 1_800_000_000_000;
  let now = t0;
  context.mock.method(Date, "now", () => now);
  const { store, state } = makeStore();
  assert.equal((await store.fetch(familyRequest("/token-family", {
    currentKind: "refresh_token",
    currentHash: "5".repeat(64),
    expiresAtMs: t0 + 1_000,
    apiKeyBinding: OPENAI_BINDING,
  }, "PUT"))).status, 204);

  now = t0 + 999;
  assert.deepEqual(
    await (await store.fetch(familyRequest("/token-family/status", undefined, "GET"))).json(),
    { outcome: "active" },
  );
  now = t0 + 1_000;
  assert.deepEqual(
    await (await store.fetch(familyRequest("/token-family/status", undefined, "GET"))).json(),
    { outcome: "revoked" },
  );
  assert.equal(state.storage.values.has("oauth_token_family_cleanup"), true);
});

test("unknown token hashes fail without revoking the active family", async () => {
  const { store } = makeStore();
  const currentHash = "c".repeat(64);
  assert.equal((await store.fetch(familyRequest("/token-family", {
    currentKind: "refresh_token",
    currentHash,
    expiresAtMs: Date.now() + 60_000,
  }, "PUT"))).status, 204);

  const unknown = await familyJson(store, "/token-family/begin", {
    kind: "refresh_token",
    credentialHash: "d".repeat(64),
  });
  assert.equal(unknown.outcome, "invalid");

  const current = await familyJson(store, "/token-family/begin", {
    kind: "refresh_token",
    credentialHash: currentHash,
  });
  assert.equal(current.outcome, "started");
  assert.equal(typeof current.leaseId, "string");
});

test("token family initialization is idempotent only for the exact bound credential", async () => {
  const { store } = makeStore();
  const body = {
    currentKind: "authorization_code",
    currentHash: "e".repeat(64),
    expiresAtMs: Date.now() + 60_000,
    apiKeyBinding: OPENAI_BINDING,
  };
  assert.equal((await store.fetch(familyRequest("/token-family", body, "PUT"))).status, 204);
  assert.equal((await store.fetch(familyRequest("/token-family", body, "PUT"))).status, 204);
  assert.equal((await store.fetch(familyRequest("/token-family", {
    ...body,
    currentHash: "f".repeat(64),
  }, "PUT"))).status, 409);
  assert.equal((await store.fetch(familyRequest("/token-family", {
    ...body,
    apiKeyBinding: { ...OPENAI_BINDING, keyId: "too-short" },
  }, "PUT"))).status, 400);
  assert.equal((await makeStore().store.fetch(familyRequest("/token-family", {
    ...body,
    userId: "another-user",
  }, "PUT"))).status, 400);
});

test("token family bindings accept the full provider-valid Firebase UID segment", async () => {
  for (const uid of ["tenant/user", ".", "..", "with space", "usuario-ñ", "nul\0uid"]) {
    const { store } = makeStore();
    const response = await store.fetch(familyRequest("/token-family", {
      userId: uid,
      currentKind: "authorization_code",
      currentHash: "a".repeat(64),
      expiresAtMs: Date.now() + 60_000,
      apiKeyBinding: { ...OPENAI_BINDING, uid },
    }, "PUT"));
    assert.equal(response.status, 204, JSON.stringify(uid));
  }
});

test("production default backend revocation for a Claude token family uses the Claude authority, secret and exact {uid,keyId} body", async (context) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  context.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  });
  const state = new FakeState();
  // No cleanupAuthorities argument: this exercises DEFAULT_CLEANUP_AUTHORITIES
  // from production code, not a mirror. OpenAI's secret is configured as well so
  // a wrong secret binding is observable.
  const store = new OAuthStateStore(
    state as unknown as DurableObjectState,
    { ...TEST_ENV, ...CLAUDE_ENV },
  );
  assert.equal((await store.fetch(familyRequest("/token-family", {
    currentKind: "refresh_token",
    currentHash: "a".repeat(64),
    expiresAtMs: Date.now() + 60_000,
    apiKeyBinding: CLAUDE_BINDING,
  }, "PUT"))).status, 204);
  await familyJson(store, "/token-family/revoke", {});
  // revokeGrant cannot run in Node (cloudflare:workers); allSettled isolates it
  // and the backend authority must still be invoked.
  await store.alarm();
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/claudeOAuthApiKeyProvisioning");
  assert.equal(call.init?.method, "DELETE");
  assert.equal(call.init?.redirect, "manual");
  const secret = new Headers(call.init?.headers).get("x-frihet-oauth-key");
  assert.equal(secret, CLAUDE_ENV.FRIHET_CLAUDE_OAUTH_API_KEY);
  assert.notEqual(secret, TEST_ENV.FRIHET_OAUTH_API_KEY);
  assert.deepEqual(JSON.parse(String(call.init?.body)), {
    uid: CLAUDE_BINDING.uid,
    keyId: CLAUDE_BINDING.keyId,
  });
  assert.equal(
    (state.storage.values.get("oauth_token_family_cleanup") as { backendRevoked?: boolean } | undefined)?.backendRevoked,
    true,
  );
});
