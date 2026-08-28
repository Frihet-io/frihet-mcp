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
