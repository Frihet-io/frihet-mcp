import assert from "node:assert/strict";
import { test } from "node:test";

import { OAuthStateStore } from "../oauth-state-store.ts";

class FakeStorage {
  readonly values = new Map<string, unknown>();
  alarm?: number;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
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

function makeStore(): { store: OAuthStateStore; state: FakeState } {
  const state = new FakeState();
  return {
    store: new OAuthStateStore(state as unknown as DurableObjectState),
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
  return new Request(`https://oauth-state.internal${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
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

test("OAuth state rejects replacement and expires through its alarm", async () => {
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
    404,
  );
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
});

test("token family bindings accept the full provider-valid Firebase UID segment", async () => {
  for (const uid of ["tenant/user", ".", "..", "with space", "usuario-ñ", "nul\0uid"]) {
    const { store } = makeStore();
    const response = await store.fetch(familyRequest("/token-family", {
      currentKind: "authorization_code",
      currentHash: "a".repeat(64),
      expiresAtMs: Date.now() + 60_000,
      apiKeyBinding: { ...OPENAI_BINDING, uid },
    }, "PUT"));
    assert.equal(response.status, 204, JSON.stringify(uid));
  }
});
