/**
 * Retry-After contract (RFC 9110 §10.2.3) through a REAL FrihetClient against
 * a local node:http server acting as the ERP backend.
 *
 * Bug: the 429 branch computed `parseInt(retryAfter, 10) * 1000`, which is NaN
 * for an HTTP-date (setTimeout(NaN) fires immediately = an early retry) and
 * parsed prefixes of garbage ("5xyz" -> 5). A wait that did not fit any
 * budget was also slept in full.
 *
 * Timer and clock are injected, so the asserted waits are exact and no test
 * sleeps for real. Every assertion is on observable behavior: the sleeps the
 * client requested, how many calls reached the server, and the idempotency key
 * on each.
 *
 * Run: npm test (after build)
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { FrihetClient, FrihetApiError } from "../client.js";
import { parseRetryAfter } from "../retry-after.js";

const NOW = Date.parse("2026-10-05T22:40:00Z");

interface Hit {
  idempotencyKey: string | undefined;
}

const hits: Hit[] = [];
/** Retry-After value for each successive 429; `undefined` entry = header absent. */
let script: Array<string | undefined> = [];
let always429: string | undefined | null = null;

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const raw = req.headers["idempotency-key"];
    hits.push({ idempotencyKey: Array.isArray(raw) ? raw[0] : raw });
    req.resume();
    res.setHeader("Content-Type", "application/json");

    const next = always429 !== null ? always429 : script.length > 0 ? script.shift() : null;
    if (always429 !== null || next !== null) {
      res.statusCode = 429;
      if (next !== undefined && next !== null) res.setHeader("Retry-After", next);
      res.end(JSON.stringify({ error: "rate_limit_exceeded" }));
      return;
    }
    if (req.method === "GET") {
      res.setHeader("Content-Type", "application/pdf");
      res.statusCode = 200;
      res.end("%PDF-1.4 test");
      return;
    }
    res.statusCode = 201;
    res.end(
      JSON.stringify({
        data: { success: true, creditNote: { id: "cn_1", status: "draft" } },
        meta: { requestId: "req_1", timestamp: "2026-10-05T22:40:00.000Z" },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  hits.length = 0;
  script = [];
  always429 = null;
});

function harness(extra: Record<string, unknown> = {}) {
  const sleeps: number[] = [];
  // Non-literal on purpose: the options type gains these seams with the fix.
  const options: Record<string, unknown> = {
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    now: () => NOW,
    ...extra,
  };
  return { sleeps, client: new FrihetClient("fri_test_key", baseUrl, options) };
}

const credit = (c: FrihetClient) =>
  c.createCreditNote("inv_1", { reason: "error", fullCredit: true });

const httpDate = (offsetMs: number) => new Date(NOW + offsetMs).toUTCString();

describe("Retry-After honored through FrihetClient", () => {
  test("delay-seconds is waited exactly", async () => {
    script = ["2"];
    const { sleeps, client } = harness();
    await credit(client);
    assert.deepEqual(sleeps, [2000]);
    assert.equal(hits.length, 2);
  });

  test("delay-seconds 0 retries immediately", async () => {
    script = ["0"];
    const { sleeps, client } = harness();
    await credit(client);
    assert.deepEqual(sleeps, [0]);
  });

  test("future IMF-fixdate waits date - now, not NaN", async () => {
    script = [httpDate(2000)];
    const { sleeps, client } = harness();
    await credit(client);
    assert.deepEqual(sleeps, [2000]);
    assert.equal(hits.length, 2);
  });

  test("past HTTP-date waits 0, never a negative timer", async () => {
    script = [httpDate(-60_000)];
    const { sleeps, client } = harness();
    await credit(client);
    assert.deepEqual(sleeps, [0]);
  });

  test("obsolete RFC 850 and asctime forms are read as GMT", async () => {
    script = ["Monday, 05-Oct-26 22:40:02 GMT", "Mon Oct  5 22:40:03 2026"];
    const { sleeps, client } = harness();
    await credit(client);
    assert.deepEqual(sleeps, [2000, 3000]);
  });

  test("absent header falls back to exponential backoff", async () => {
    script = [undefined, undefined];
    const { sleeps, client } = harness();
    await credit(client);
    assert.deepEqual(sleeps, [1000, 2000]);
  });

  for (const bad of ["soon", "-5", "1.5", "1e3", "5xyz", "0x10", "Mon, 05 Oct 2026 22:40:02", "Fri, 31 Feb 2026 10:00:00 GMT"]) {
    test(`malformed ${JSON.stringify(bad)} falls back to backoff, never NaN or a parsed prefix`, async () => {
      script = [bad];
      const { sleeps, client } = harness();
      await credit(client);
      assert.deepEqual(sleeps, [1000]);
    });
  }

  test("a wait over the budget is deferred, not slept, not shortened, not retried", async () => {
    script = ["31"];
    const { sleeps, client } = harness();
    await assert.rejects(credit(client), (e: unknown) => {
      assert.ok(e instanceof FrihetApiError);
      assert.equal(e.statusCode, 429);
      assert.equal(e.errorCode, "rate_limit_deferred");
      assert.match(e.message, /31 seconds/);
      return true;
    });
    assert.deepEqual(sleeps, []);
    assert.equal(hits.length, 1);
  });

  test("a far-future HTTP-date is deferred", async () => {
    script = [httpDate(3_600_000)];
    const { sleeps, client } = harness();
    await assert.rejects(credit(client), /rate_limit_deferred|3600 seconds/);
    assert.deepEqual(sleeps, []);
    assert.equal(hits.length, 1);
  });

  test("an overflowing delay-seconds is deferred, not an unsafe timer", async () => {
    script = ["99999999999999999999999"];
    const { sleeps, client } = harness();
    await assert.rejects(credit(client), (e: unknown) => e instanceof FrihetApiError && e.errorCode === "rate_limit_deferred");
    assert.deepEqual(sleeps, []);
  });

  test("the budget is cumulative across retries", async () => {
    script = ["3", "3"];
    const { sleeps, client } = harness({ retryBudgetMs: 5000 });
    await assert.rejects(credit(client), (e: unknown) => e instanceof FrihetApiError && e.errorCode === "rate_limit_deferred");
    assert.deepEqual(sleeps, [3000]);
    assert.equal(hits.length, 2);
  });

  test("a budget larger than the timer limit never lets an overflowing wait become an immediate retry", async () => {
    script = ["3000000"]; // 3e9 ms > 2^31-1: setTimeout would fire at once
    const { sleeps, client } = harness({ retryBudgetMs: 1e12 });
    await assert.rejects(credit(client), (e: unknown) => e instanceof FrihetApiError && e.errorCode === "rate_limit_deferred");
    assert.deepEqual(sleeps, []);
    assert.equal(hits.length, 1);
  });

  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    test(`invalid retryBudgetMs ${bad} falls back to the default, not an unbounded sleep`, async () => {
      script = ["31"];
      const { sleeps, client } = harness({ retryBudgetMs: bad });
      await assert.rejects(credit(client), (e: unknown) => e instanceof FrihetApiError && e.errorCode === "rate_limit_deferred");
      assert.deepEqual(sleeps, []);
    });
  }

  test("surrounding whitespace is tolerated; a non-GMT zone is malformed", async () => {
    script = ["  2 ", "Mon, 05 Oct 2026 22:40:02 PST"];
    const { sleeps, client } = harness();
    await credit(client);
    assert.deepEqual(sleeps, [2000, 2000]);
  });

  test("the backoff path (no usable Retry-After) is bounded by the same budget", async () => {
    script = [undefined, undefined, undefined];
    const { sleeps, client } = harness({ retryBudgetMs: 1500 });
    await assert.rejects(credit(client), (e: unknown) => e instanceof FrihetApiError && e.errorCode === "rate_limit_deferred");
    assert.deepEqual(sleeps, [1000], "second backoff (2000 ms) would take the total to 3000 ms > 1500 ms");
    assert.equal(hits.length, 2);
  });

  test("a deferred document call leaves no per-attempt timer pending", async () => {
    const TIMEOUT = 123_457; // sentinel: identifies this client's timer among all timers
    const origSet = globalThis.setTimeout;
    const origClear = globalThis.clearTimeout;
    const live = new Set<unknown>();
    (globalThis as any).setTimeout = (fn: any, ms?: number, ...rest: any[]) => {
      const h = origSet(fn, ms, ...rest);
      if (ms === TIMEOUT) live.add(h);
      return h;
    };
    (globalThis as any).clearTimeout = (h: any) => {
      live.delete(h);
      return origClear(h);
    };
    try {
      script = ["31"];
      const { client } = harness({ timeoutMs: TIMEOUT });
      await assert.rejects(client.getInvoicePdf("inv_1"), (e: unknown) => e instanceof FrihetApiError && e.errorCode === "rate_limit_deferred");
      assert.equal(live.size, 0);
    } finally {
      globalThis.setTimeout = origSet;
      globalThis.clearTimeout = origClear;
    }
  });

  test("a 429 body is fully released before waiting, on both call paths", async () => {
    const origFetch = globalThis.fetch;
    try {
      for (const call of [
        (c: FrihetClient) => credit(c),
        (c: FrihetClient) => c.getInvoicePdf("inv_1"),
      ]) {
        let first = true;
        let released = false;
        let sleptWhileHeld = false;
        globalThis.fetch = (async () => {
          if (first) {
            first = false;
            const stream = new ReadableStream<Uint8Array>({
              pull(ctrl) {
                ctrl.enqueue(new TextEncoder().encode("{}"));
                ctrl.close();
                released = true;
              },
              cancel() {
                released = true;
              },
            });
            return new Response(stream, { status: 429, headers: { "Retry-After": "1" } });
          }
          return new Response("%PDF-1.4 test", { status: 200, headers: { "Content-Type": "application/pdf" } });
        }) as typeof fetch;
        const c = new FrihetClient("fri_test_key", baseUrl, {
          sleep: async () => {
            sleptWhileHeld = !released;
          },
          now: () => NOW,
        } as Record<string, unknown>);
        await call(c).catch(() => undefined);
        assert.equal(sleptWhileHeld, false, "slept before the 429 body was released");
        assert.equal(released, true);
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("repeated 429s stop at the attempt limit", async () => {
    always429 = "1";
    const { sleeps, client } = harness();
    await assert.rejects(credit(client), (e: unknown) => e instanceof FrihetApiError && e.errorCode === "rate_limit_exceeded");
    assert.deepEqual(sleeps, [1000, 1000, 1000]);
    assert.equal(hits.length, 4);
  });

  test("every retry replays the SAME Idempotency-Key, HTTP-date included", async () => {
    script = [httpDate(1000), "1", undefined];
    const { client } = harness();
    await credit(client);
    assert.equal(hits.length, 4);
    const keys = hits.map((h) => h.idempotencyKey);
    assert.ok(keys[0]);
    assert.equal(new Set(keys).size, 1);
  });

  test("the document (PDF) path honors an HTTP-date and defers over budget", async () => {
    script = [httpDate(4000)];
    const first = harness();
    await first.client.getInvoicePdf("inv_1");
    assert.deepEqual(first.sleeps, [4000]);

    hits.length = 0;
    script = ["31"];
    const second = harness();
    await assert.rejects(second.client.getInvoicePdf("inv_1"), (e: unknown) => e instanceof FrihetApiError && e.errorCode === "rate_limit_deferred");
    assert.deepEqual(second.sleeps, []);
    assert.equal(hits.length, 1);
  });
});

describe("parseRetryAfter", () => {
  test("null for absent, empty and garbage; never NaN", () => {
    for (const v of [null, undefined, "", "  ", "abc", "-1", "+1", "1.0", "NaN", "Infinity"]) {
      assert.equal(parseRetryAfter(v, NOW), null, JSON.stringify(v));
    }
  });

  test("RFC 850 two-digit year pivots on the injected clock, not the wall clock", () => {
    const v = "Monday, 05-Oct-99 22:40:02 GMT";
    // From 2090, "99" is 2099 (a Monday, future): a positive wait.
    const wait = parseRetryAfter(v, Date.parse("2090-10-05T22:40:00Z"));
    assert.ok(wait !== null && wait > 0);
    // From 2026, "99" is 1999 (a Tuesday): the weekday disagrees, so malformed.
    assert.equal(parseRetryAfter(v, NOW), null);
  });

  test("weekday must agree with the date", () => {
    assert.equal(parseRetryAfter("Tue, 05 Oct 2026 22:40:02 GMT", NOW), null);
    assert.equal(parseRetryAfter("Mon, 05 Oct 2026 22:40:02 GMT", NOW), 2000);
  });
});
