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
  FRIHET_OAUTH_API_KEY: "test-service-secret-that-is-never-sent",
};

const SUCCESSFUL_CLEANUP: OAuthCleanupAuthorities = {
  async revokeGrant(): Promise<void> {},
  async revokeBackend(): Promise<boolean> {
    return true;
  },
};

function makeStore(options: {
  state?: FakeState;
  cleanupAuthorities?: OAuthCleanupAuthorities;
} = {}): { store: OAuthStateStore; state: FakeState } {
  const state = options.state ?? new FakeState();
  return {
    store: new OAuthStateStore(
      state as unknown as DurableObjectState,
      TEST_ENV,
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

test("OAuth state is stored once, non-cacheable, and consumed exactly once", async () => {
  const { store, state } = makeStore();
  const payload = JSON.stringify({ clientId: "client_test", scope: ["frihet:workspace.manage"] });
  const stored = await store.fetch(new Request("https://oauth-state.internal/state", {
    method: "PUT",
    body: payload,
  }));

  assert.equal(stored.status, 204);
  assert.ok((state.storage.alarm ?? 0) > Date.now());

  const [left, right] = await Promise.all([
    store.fetch(new Request("https://oauth-state.internal/consume", { method: "POST" })),
    store.fetch(new Request("https://oauth-state.internal/consume", { method: "POST" })),
  ]);
  const ordered = [left, right].sort((a, b) => a.status - b.status);

  assert.deepEqual(ordered.map((response) => response.status), [200, 404]);
  assert.equal(await ordered[0]!.text(), payload);
  assert.equal(ordered[0]!.headers.get("cache-control"), "no-store");
  assert.equal(ordered[0]!.headers.get("pragma"), "no-cache");
});

test("OAuth state rejects replacement and expires through its alarm", async (context) => {
  let now = 1_800_000_000_000;
  context.mock.method(Date, "now", () => now);
  const { store } = makeStore();
  const request = (body: string) => new Request("https://oauth-state.internal/state", {
    method: "PUT",
    body,
  });

  assert.equal((await store.fetch(request("first"))).status, 204);
  assert.equal((await store.fetch(request("replacement"))).status, 409);

  await store.alarm();
  assert.equal(
    (await store.fetch(new Request("https://oauth-state.internal/consume", { method: "POST" }))).status,
    200,
    "an early alarm must not shorten the stored envelope TTL",
  );

  assert.equal((await store.fetch(request("second"))).status, 204);
  now += 600_000;
  await store.alarm();
  assert.equal(
    (await store.fetch(new Request("https://oauth-state.internal/consume", { method: "POST" }))).status,
    404,
  );
});

test("OAuth state enforces its TTL when the alarm is delayed, including the exact boundary", async (context) => {
  const t0 = 1_800_000_000_000;
  let now = t0;
  context.mock.method(Date, "now", () => now);

  const beforeBoundary = makeStore();
  assert.equal((await beforeBoundary.store.fetch(new Request(
    "https://oauth-state.internal/state",
    { method: "PUT", body: "before-boundary" },
  ))).status, 204);
  assert.deepEqual(beforeBoundary.state.storage.values.get("oauth_request"), {
    version: 1,
    payload: "before-boundary",
    expiresAtMs: t0 + 600_000,
  });
  now = t0 + 599_999;
  const accepted = await beforeBoundary.store.fetch(new Request(
    "https://oauth-state.internal/consume",
    { method: "POST" },
  ));
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), "before-boundary");

  now = t0;
  const atBoundary = makeStore();
  assert.equal((await atBoundary.store.fetch(new Request(
    "https://oauth-state.internal/state",
    { method: "PUT", body: "at-boundary" },
  ))).status, 204);
  now = t0 + 600_000;
  const expired = await atBoundary.store.fetch(new Request(
    "https://oauth-state.internal/consume",
    { method: "POST" },
  ));
  assert.equal(expired.status, 404, "Date.now() === expiresAtMs must be expired");
  assert.equal(atBoundary.state.storage.values.size, 0);
});

test("OAuth state rejects a malformed stored envelope instead of returning attacker-shaped data", async () => {
  const { store, state } = makeStore();
  for (const malformed of [
    "legacy-raw-payload",
    { version: 1, payload: "x", expiresAtMs: Date.now() + 60_000, extra: true },
    { version: 1, payload: "x", expiresAtMs: 1.5 },
    { version: 2, payload: "x", expiresAtMs: Date.now() + 60_000 },
  ]) {
    await state.storage.put("oauth_request", malformed);
    const response = await store.fetch(new Request(
      "https://oauth-state.internal/consume",
      { method: "POST" },
    ));
    assert.equal(response.status, 404);
    assert.equal(state.storage.values.size, 0);
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
