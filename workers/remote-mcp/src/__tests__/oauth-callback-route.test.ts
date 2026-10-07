/**
 * Route-level pin for the reviewed host's OAuth callback: the REAL
 * `/authorize -> /callback -> provision -> completeAuthorization -> /token ->
 * /mcp` path, with faults injected at every boundary after the state exists.
 *
 * Invariants:
 *   - a failed attempt never strands the login: the same state retries;
 *   - one authorization yields at most one grant and one active backend key;
 *   - a key whose provisioning outcome is unknown is revoked by correlation
 *     before the lease is released, and every attempt uses a new correlation;
 *   - a replay after commit is rejected.
 *
 * The harness (support/oauth-route-harness.ts) runs the production
 * authHandler, OAuthStateStore and token-family exchange on the locked
 * provider dist; only KV, Durable Objects and the ERP authority are fakes.
 */

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import {
  consumeOnReserveStateStore,
  createOAuthRouteHarness,
  type DeleteFault,
  mintIdToken,
  type PostFault,
  type StateStoreFactory,
} from "./support/oauth-route-harness.ts";

type Harness = Awaited<ReturnType<typeof createOAuthRouteHarness>>;

/** The issued credential is the grant's credential, and the only active one. */
async function assertSingleUsableCredential(h: Harness, clientId: string, redirectTo: unknown) {
  const mcp = await h.redeem(clientId, redirectTo);
  assert.deepEqual(h.erp.activeKeyIds(), [mcp.keyId]);
  assert.equal(h.kv.grantKeys().length, 1, "exactly one live grant");
  assert.equal(
    new Set(h.erp.postCorrelations).size,
    h.erp.postCorrelations.length,
    "every provisioning attempt carries a fresh correlation",
  );
  return mcp;
}

/** No credential, ID token or service secret ever reaches a log line. */
function assertLogsAreClean(h: Harness, idTokens: string[]) {
  const secrets = [...h.erp.issuedApiKeys(), ...idTokens, String(h.env.FRIHET_OAUTH_API_KEY)];
  for (const line of h.logs) {
    for (const secret of secrets) {
      assert.equal(line.includes(secret), false, "a secret leaked into a log line");
    }
  }
}

async function replayIsRejected(h: Harness, stateKey: string, idToken: string) {
  const posts = h.erp.postCorrelations.length;
  const replay = await h.callback(stateKey, idToken);
  assert.equal(replay.status, 400);
  assert.deepEqual(replay.body, { error: "Invalid or expired state" });
  assert.equal(h.erp.postCorrelations.length, posts, "a replay never provisions");
}

test("happy path: one callback provisions, completes, commits and reaches /mcp", async (t) => {
  const h = await createOAuthRouteHarness(t);
  const { clientId, stateKey } = await h.startLogin();
  const idToken = await mintIdToken();

  const result = await h.callback(stateKey, idToken);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(Object.keys(result.body), ["redirectTo"]);
  const mcp = await assertSingleUsableCredential(h, clientId, result.body.redirectTo);
  assert.equal(mcp.userId, "firebase-route-user");
  assert.deepEqual(h.events.filter((event) => event.startsWith("do:")), [
    "do:/state",
    "do:/reserve",
    "do:/attempt",
    "do:/commit",
  ]);
  assert.equal(h.kv.grantWrites, 1);

  await replayIsRejected(h, stateKey, idToken);
  assertLogsAreClean(h, [idToken]);
});

// ---------------------------------------------------------------------------
// Fault at every boundary after the state exists -> the same login retries
// ---------------------------------------------------------------------------

type FaultCase = {
  name: string;
  /** Status the failed attempt answers with. */
  status: number;
  inject(h: Harness): void;
  restore?(h: Harness): void;
  firstIdToken?: () => Promise<string>;
};

const FAULT_CASES: FaultCase[] = [
  {
    name: "Firebase verification fails (expired ID token)",
    status: 401,
    inject() {},
    firstIdToken: () => mintIdToken({ expired: true }),
  },
  {
    name: "Firebase verification fails (unknown signing key)",
    status: 401,
    inject() {},
    firstIdToken: () => mintIdToken({ kid: "rotated-away" }),
  },
  {
    name: "lifecycle service secret unavailable",
    status: 503,
    inject(h) {
      delete h.env.FRIHET_OAUTH_API_KEY;
    },
    restore(h) {
      h.env.FRIHET_OAUTH_API_KEY = "route-test-service-secret-0123456789abcdef";
    },
  },
  {
    name: "state store unreachable at reserve",
    status: 503,
    inject(h) {
      h.namespace.fail("/reserve", "before");
    },
  },
  {
    name: "state store unreachable when arming the attempt",
    status: 502,
    inject(h) {
      h.namespace.fail("/attempt", "before");
    },
  },
  {
    name: "provisioning network error before the request lands",
    status: 502,
    inject(h) {
      h.erp.postFaults.push({ kind: "network-before" });
    },
  },
  {
    name: "provisioning response lost after the key was written",
    status: 502,
    inject(h) {
      h.erp.postFaults.push({ kind: "lost-after" });
    },
  },
  {
    name: "provisioning timeout after the key was written",
    status: 502,
    inject(h) {
      h.erp.postFaults.push({ kind: "timeout-after" });
    },
  },
  {
    name: "provisioning 429",
    status: 429,
    inject(h) {
      h.erp.postFaults.push({ kind: "status-before", status: 429 });
    },
  },
  {
    name: "provisioning 403",
    status: 403,
    inject(h) {
      h.erp.postFaults.push({ kind: "status-before", status: 403 });
    },
  },
  {
    name: "provisioning 500 after the key was written",
    status: 502,
    inject(h) {
      h.erp.postFaults.push({ kind: "status-after", status: 500 });
    },
  },
  {
    name: "provisioning 503",
    status: 502,
    inject(h) {
      h.erp.postFaults.push({ kind: "status-before", status: 503 });
    },
  },
  {
    name: "provisioning 409",
    status: 502,
    inject(h) {
      h.erp.postFaults.push({ kind: "status-before", status: 409 });
    },
  },
  {
    name: "provisioning 410 with a recovery body",
    status: 502,
    inject(h) {
      h.erp.postFaults.push({
        kind: "status-after",
        status: 410,
        body: { code: "IDEMPOTENT_TUPLE_REVOKED_USE_NEW_CORRELATION" },
      });
    },
  },
  {
    name: "malformed 200 provisioning payload",
    status: 502,
    inject(h) {
      h.erp.postFaults.push({ kind: "malformed-after" });
    },
  },
  {
    name: "completeAuthorization fails to store the grant",
    status: 502,
    inject(h) {
      let remaining = 1;
      h.kv.putFault = (key) => key.startsWith("grant:") && remaining-- > 0;
    },
  },
  {
    name: "state store unreachable at commit",
    status: 503,
    inject(h) {
      h.namespace.fail("/commit", "before", 2);
    },
  },
];

async function runFaultCase(t: TestContext, fault: FaultCase, stateStore?: StateStoreFactory) {
  const h = await createOAuthRouteHarness(t, stateStore ? { stateStore } : {});
  const { clientId, stateKey } = await h.startLogin();
  const idToken = await mintIdToken();
  const firstIdToken = fault.firstIdToken ? await fault.firstIdToken() : idToken;

  fault.inject(h);
  const failed = await h.callback(stateKey, firstIdToken);
  fault.restore?.(h);
  assert.equal(failed.status, fault.status, JSON.stringify(failed.body));
  assert.equal("redirectTo" in failed.body, false, "a failed attempt never returns a code");
  assert.equal(JSON.stringify(failed.body).includes("IDEMPOTENT"), false, "upstream bodies are never forwarded");
  assert.deepEqual(h.erp.activeKeyIds(), [], "a failed attempt leaves no active backend key");

  const retried = await h.callback(stateKey, idToken);
  assert.equal(retried.status, 200, `retry after "${fault.name}": ${JSON.stringify(retried.body)}`);
  await assertSingleUsableCredential(h, clientId, retried.body.redirectTo);
  await replayIsRejected(h, stateKey, idToken);
  assertLogsAreClean(h, [idToken, firstIdToken]);
  return h;
}

for (const fault of FAULT_CASES) {
  test(`fault: ${fault.name} -> the same login retries to exactly one credential`, async (t) => {
    await runFaultCase(t, fault);
  });
}

test("a lost /commit response is absorbed by the idempotent commit retry", async (t) => {
  const h = await createOAuthRouteHarness(t);
  const { clientId, stateKey } = await h.startLogin();
  const idToken = await mintIdToken();
  h.namespace.fail("/commit", "after");

  const result = await h.callback(stateKey, idToken);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  await assertSingleUsableCredential(h, clientId, result.body.redirectTo);
  assert.equal(h.erp.postCorrelations.length, 1);
  await replayIsRejected(h, stateKey, idToken);
});

// ---------------------------------------------------------------------------
// Concurrency and replay
// ---------------------------------------------------------------------------

async function settleTurns(predicate: () => boolean) {
  for (let turn = 0; turn < 1_000 && !predicate(); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(predicate(), "condition never settled");
}

test("16 concurrent callbacks for one state: one provisioning request, one grant", async (t) => {
  const h = await createOAuthRouteHarness(t);
  const { clientId, stateKey } = await h.startLogin();
  const idToken = await mintIdToken();
  // Hold the winner inside provisioning so every loser races a live lease.
  h.erp.postFaults.push({ kind: "hang" });

  const settled: Array<Awaited<ReturnType<Harness["callback"]>>> = [];
  const callbacks = Array.from({ length: 16 }, () =>
    h.callback(stateKey, idToken).then((result) => {
      settled.push(result);
      return result;
    }));
  await h.erp.hangStarted;
  await settleTurns(() => settled.length === 15);
  h.erp.releaseHang();
  const results = await Promise.all(callbacks);

  const winners = results.filter((result) => result.status === 200);
  const losers = results.filter((result) => result.status !== 200);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 15);
  for (const loser of losers) {
    assert.equal(loser.status, 409);
    assert.deepEqual(loser.body, { error: "Authorization is already in progress" });
  }
  assert.equal(h.erp.postCorrelations.length, 1, "exactly one provisioning fetch");
  assert.equal(h.kv.grantWrites, 1, "exactly one grant");
  await assertSingleUsableCredential(h, clientId, winners[0]!.body.redirectTo);
  await replayIsRejected(h, stateKey, idToken);
});

test("16 concurrent callbacks after a failed attempt still converge on one credential", async (t) => {
  const h = await createOAuthRouteHarness(t);
  const { clientId, stateKey } = await h.startLogin();
  const idToken = await mintIdToken();
  h.erp.postFaults.push({ kind: "lost-after" });
  assert.equal((await h.callback(stateKey, idToken)).status, 502);

  const results = await Promise.all(
    Array.from({ length: 16 }, () => h.callback(stateKey, idToken)),
  );
  const winners = results.filter((result) => result.status === 200);
  assert.equal(winners.length, 1);
  for (const loser of results.filter((result) => result.status !== 200)) {
    assert.ok([400, 409].includes(loser.status), JSON.stringify(loser));
    assert.equal("redirectTo" in loser.body, false);
  }
  assert.equal(h.erp.postCorrelations.length, 2);
  await assertSingleUsableCredential(h, clientId, winners[0]!.body.redirectTo);
});

// ---------------------------------------------------------------------------
// Unknown outcome: revoke by correlation BEFORE release, new correlation after
// ---------------------------------------------------------------------------

test("unknown outcome: revoke-by-correlation precedes release; the retry uses a new correlation", async (t) => {
  const h = await createOAuthRouteHarness(t);
  const { clientId, stateKey } = await h.startLogin();
  const idToken = await mintIdToken();
  h.erp.postFaults.push({ kind: "timeout-after" });

  assert.equal((await h.callback(stateKey, idToken)).status, 502);
  const [first] = h.erp.postCorrelations;
  const post1 = h.events.indexOf(`erp:POST:${first}`);
  const delete1 = h.events.indexOf(`erp:DELETE:${first}`);
  const release1 = h.events.indexOf("do:/release", post1);
  assert.ok(post1 >= 0 && post1 < delete1 && delete1 < release1, h.events.join(" "));

  const retried = await h.callback(stateKey, idToken);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  const second = h.erp.postCorrelations[1];
  assert.ok(second && second !== first, "a retry must never resend a used correlation");
  assert.ok(h.events.indexOf(`erp:POST:${second}`) > release1);
  await assertSingleUsableCredential(h, clientId, retried.body.redirectTo);
});

test("a revocation that fails keeps the attempt recorded; the retry reconciles it before sending", async (t) => {
  const h = await createOAuthRouteHarness(t);
  const { clientId, stateKey } = await h.startLogin();
  const idToken = await mintIdToken();
  h.erp.postFaults.push({ kind: "lost-after" });
  h.erp.deleteFaults.push({ kind: "network" });

  assert.equal((await h.callback(stateKey, idToken)).status, 502);
  const [first] = h.erp.postCorrelations;
  assert.equal(h.erp.activeKeyIds().length, 1, "the unproven key is still live at the authority");

  // The next attempt cannot prove it either: it refuses before sending.
  h.erp.deleteFaults.push({ kind: "status", status: 500 });
  const blocked = await h.callback(stateKey, idToken);
  assert.equal(blocked.status, 503);
  assert.deepEqual(blocked.body, { error: "Failed to provision API key" });
  assert.equal(h.erp.postCorrelations.length, 1, "no second credential while one is unproven");

  const retried = await h.callback(stateKey, idToken);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  const second = h.erp.postCorrelations[1]!;
  const lastDelete = h.events.lastIndexOf(`erp:DELETE:${first}`);
  assert.ok(lastDelete >= 0 && lastDelete < h.events.indexOf(`erp:POST:${second}`), h.events.join(" "));
  await assertSingleUsableCredential(h, clientId, retried.body.redirectTo);
});

test("a lost /release keeps the lease until it expires; the takeover reconciles it", async (t) => {
  const h = await createOAuthRouteHarness(t);
  const { clientId, stateKey } = await h.startLogin();
  const idToken = await mintIdToken();
  h.erp.postFaults.push({ kind: "status-after", status: 500 });
  h.namespace.fail("/release", "before");

  assert.equal((await h.callback(stateKey, idToken)).status, 502);
  const busy = await h.callback(stateKey, idToken);
  assert.equal(busy.status, 409);

  h.clock.offsetMs += 61_000;
  const [first] = h.erp.postCorrelations;
  const deletesBefore = h.events.filter((event) => event === `erp:DELETE:${first}`).length;
  const retried = await h.callback(stateKey, idToken);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(
    h.events.filter((event) => event === `erp:DELETE:${first}`).length,
    deletesBefore + 1,
    "the takeover proves the abandoned correlation again before sending",
  );
  await assertSingleUsableCredential(h, clientId, retried.body.redirectTo);
});

test("an abandoned in-flight attempt is taken over after its lease; its late request is fenced", async (t) => {
  const h = await createOAuthRouteHarness(t);
  const { clientId, stateKey } = await h.startLogin();
  const idToken = await mintIdToken();
  h.erp.postFaults.push({ kind: "hang" });

  const abandoned = h.callback(stateKey, idToken);
  await h.erp.hangStarted;
  assert.equal((await h.callback(stateKey, idToken)).status, 409, "a live lease is never shared");

  h.clock.offsetMs += 61_000;
  const takeover = await h.callback(stateKey, idToken);
  assert.equal(takeover.status, 200, JSON.stringify(takeover.body));
  const [first, second] = h.erp.postCorrelations;
  assert.ok(h.events.indexOf(`erp:DELETE:${first}`) < h.events.indexOf(`erp:POST:${second}`));

  // The stalled request finally lands: its correlation is tombstoned, so it
  // mints nothing, and the stale holder gets no code.
  h.erp.releaseHang();
  const late = await abandoned;
  assert.equal(late.status, 502);
  assert.equal("redirectTo" in late.body, false);
  assert.equal(h.erp.keys.size, 1, "the fenced correlation never minted a key");
  await assertSingleUsableCredential(h, clientId, takeover.body.redirectTo);
});

test("arming renews the lease: a slow reconcile cannot let a takeover race the provisioning holder", async (t) => {
  const h = await createOAuthRouteHarness(t);
  const { clientId, stateKey } = await h.startLogin();
  const idToken = await mintIdToken();
  // Attempt 1 leaves an unproven correlation.
  h.erp.postFaults.push({ kind: "lost-after" });
  h.erp.deleteFaults.push({ kind: "network" });
  assert.equal((await h.callback(stateKey, idToken)).status, 502);

  // Attempt 2: its reconcile takes 50 s, then it arms and stalls provisioning.
  h.erp.deleteFaults.push({ kind: "slow", before: () => { h.clock.offsetMs += 50_000; } });
  h.erp.postFaults.push({ kind: "hang" });
  const holder = h.callback(stateKey, idToken);
  await h.erp.hangStarted;

  // 100 s after its reservation, 50 s after arming: still the holder's lease.
  h.clock.offsetMs += 50_000;
  const contender = await h.callback(stateKey, idToken);
  assert.equal(contender.status, 409, JSON.stringify(contender.body));

  h.erp.releaseHang();
  const result = await holder;
  assert.equal(result.status, 200, JSON.stringify(result.body));
  await assertSingleUsableCredential(h, clientId, result.body.redirectTo);
});

test("attempts are bounded per authorization request", async (t) => {
  const h = await createOAuthRouteHarness(t);
  const { stateKey } = await h.startLogin();
  const idToken = await mintIdToken();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    h.erp.postFaults.push({ kind: "status-before", status: 429 });
    assert.equal((await h.callback(stateKey, idToken)).status, 429);
  }
  const exhausted = await h.callback(stateKey, idToken);
  assert.equal(exhausted.status, 429);
  assert.deepEqual(exhausted.body, { error: "Too many attempts for this authorization request" });
  assert.equal(h.erp.postCorrelations.length, 5);
  assert.equal(h.kv.grantKeys().length, 0);
});

// ---------------------------------------------------------------------------
// Expired state with an unproven attempt: the alarm reconciles it
// ---------------------------------------------------------------------------

async function leaveUnprovenAttempt(t: TestContext, deleteFaults: DeleteFault[]) {
  const h = await createOAuthRouteHarness(t);
  const { stateKey } = await h.startLogin();
  const idToken = await mintIdToken();
  h.erp.postFaults.push({ kind: "lost-after" });
  h.erp.deleteFaults.push({ kind: "network" }, ...deleteFaults);
  assert.equal((await h.callback(stateKey, idToken)).status, 502);
  assert.equal(h.erp.activeKeyIds().length, 1);
  h.clock.offsetMs += 11 * 60_000;
  return { h, stateKey, idToken };
}

test("expired state: the alarm revokes an unproven attempt by correlation and clears storage", async (t) => {
  const { h, stateKey, idToken } = await leaveUnprovenAttempt(t, []);
  const expired = await h.callback(stateKey, idToken);
  assert.equal(expired.status, 400);
  assert.equal(h.namespace.object(stateKey).state.storage.values.size, 1, "expiry keeps the unproven attempt");

  const storage = await h.runStateAlarm(stateKey);
  assert.deepEqual(h.erp.activeKeyIds(), []);
  assert.equal(storage.values.size, 0);
});

test("expired state: a failed alarm revocation stays armed and retries", async (t) => {
  const { h, stateKey } = await leaveUnprovenAttempt(t, [{ kind: "status", status: 503 }]);
  const storage = await h.runStateAlarm(stateKey);
  assert.equal(h.erp.activeKeyIds().length, 1);
  assert.equal(storage.values.size, 1);
  assert.ok((storage.alarmAt ?? 0) > Date.now(), "the next reconcile is armed");

  await h.runStateAlarm(stateKey);
  assert.deepEqual(h.erp.activeKeyIds(), []);
  assert.equal(storage.values.size, 0);
});

// ---------------------------------------------------------------------------
// Mutation guard: the suite must catch a return to consume-before-I/O
// ---------------------------------------------------------------------------

for (const name of [
  "provisioning 503",
  "provisioning response lost after the key was written",
  "completeAuthorization fails to store the grant",
]) {
  test(`mutation guard: consume-before-I/O state is caught (${name})`, async (t) => {
    const fault = FAULT_CASES.find((candidate) => candidate.name === name)!;
    await assert.rejects(
      runFaultCase(t, fault, consumeOnReserveStateStore),
      (error: unknown) => String(error).includes("Invalid or expired state"),
    );
  });
}
