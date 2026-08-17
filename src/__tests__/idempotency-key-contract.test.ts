/**
 * Idempotency-Key wire contract.
 *
 * Bug (reproduced against api.frihet.io, not inferred): the client never sent
 * an `Idempotency-Key` header — `grep -ri idempotency src/` returned 0 hits,
 * and `grep -ri idempotency` over the published `@frihet/mcp-server@1.16.4`
 * tarball returned 0 too (positive control: `X-API-Key` → 1 hit). The backend
 * REQUIRES the header on `POST /v1/invoices/:id/credit-note`, so
 * `create_credit_note` failed 100% of the time with
 * `400 · IDEMPOTENCY_KEY_REQUIRED`, creating 0 drafts, for every agent that
 * installed the MCP server. Two docs promised the mechanism and no line
 * implemented it (AGENTS.md "API client must respect `Idempotency-Key`",
 * CLAUDE.md "every mutating tool MUST support `Idempotency-Key`. Test it.").
 *
 * Worse, the 429 retry path re-POSTed the same body with no key at all —
 * precisely the duplicate the key exists to prevent.
 *
 * This spins up a local node:http server (acting as the ERP backend), points a
 * REAL FrihetClient at it, and asserts the header contract on the wire:
 *   1. mutations carry `Idempotency-Key`
 *   2. a caller-supplied key is propagated verbatim
 *   3. a 429 retry replays the SAME key, never a fresh one
 *   4. GET reads never send it
 *   5. distinct calls get distinct keys (no cross-request collision → no
 *      spurious 409 IDEMPOTENCY_KEY_REUSED)
 *
 * Run: npm test (after build)
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { FrihetClient } from "../client.js";

interface CapturedRequest {
  method: string;
  path: string;
  idempotencyKey: string | undefined;
}

const captured: CapturedRequest[] = [];

/** How many times the next request should be answered with 429 before succeeding. */
let rateLimitBudget = 0;

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const raw = req.headers["idempotency-key"];
    captured.push({
      method: req.method ?? "",
      path: url.pathname,
      idempotencyKey: Array.isArray(raw) ? raw[0] : raw,
    });

    // Drain the body so the socket is reusable across retries.
    req.resume();

    res.setHeader("Content-Type", "application/json");

    if (rateLimitBudget > 0) {
      rateLimitBudget -= 1;
      res.statusCode = 429;
      res.setHeader("Retry-After", "0");
      res.end(JSON.stringify({ error: "rate_limit_exceeded" }));
      return;
    }

    // List reads need the `{ data: [...] }` envelope requestPaginated validates.
    if (req.method === "GET" && url.pathname === "/invoices") {
      res.statusCode = 200;
      res.end(JSON.stringify({ data: [], total: 0, limit: 20, offset: 0 }));
      return;
    }

    res.statusCode = 201;
    res.end(
      JSON.stringify({
        data: { success: true, creditNote: { id: "cn_1", status: "draft" } },
        meta: { requestId: "req_1", timestamp: "2026-07-28T00:00:00.000Z" },
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  captured.length = 0;
  rateLimitBudget = 0;
});

const client = () => new FrihetClient("fri_test_key", `${baseUrl}`);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("Idempotency-Key wire contract", () => {
  test("createCreditNote sends an Idempotency-Key even when the caller omits one", async () => {
    await client().createCreditNote("inv_1", { reason: "error", fullCredit: true });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "POST");
    assert.equal(captured[0].path, "/invoices/inv_1/credit-note");
    assert.ok(
      captured[0].idempotencyKey,
      "POST /credit-note reached the backend with no Idempotency-Key — the live API answers 400 IDEMPOTENCY_KEY_REQUIRED and creates nothing",
    );
    assert.match(captured[0].idempotencyKey as string, UUID_RE);
  });

  test("a caller-supplied key is propagated verbatim", async () => {
    await client().createCreditNote(
      "inv_2",
      { reason: "refund", fullCredit: true },
      "caller-key-abc123",
    );

    assert.equal(captured.length, 1);
    assert.equal(captured[0].idempotencyKey, "caller-key-abc123");
  });

  test("a 429 retry replays the SAME key, never a fresh one", async () => {
    rateLimitBudget = 2;

    await client().createCreditNote("inv_3", { reason: "error", fullCredit: true });

    assert.equal(captured.length, 3, "expected 2 rate-limited attempts plus the success");
    const keys = captured.map((c) => c.idempotencyKey);
    assert.ok(keys[0], "first attempt had no key");
    assert.equal(
      new Set(keys).size,
      1,
      `retry used a different key (${keys.join(", ")}) — that is the duplicate draft the key exists to prevent`,
    );
  });

  test("GET reads never send an Idempotency-Key", async () => {
    await client().getInvoice("inv_4");

    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "GET");
    assert.equal(captured[0].idempotencyKey, undefined);
  });

  test("two separate calls get two different keys", async () => {
    const c = client();
    await c.createCreditNote("inv_5", { reason: "error", fullCredit: true });
    await c.createCreditNote("inv_6", { reason: "error", fullCredit: true });

    assert.equal(captured.length, 2);
    assert.notEqual(
      captured[0].idempotencyKey,
      captured[1].idempotencyKey,
      "distinct mutations reused one key — the backend would answer 409 IDEMPOTENCY_KEY_REUSED",
    );
  });

  test("other mutating methods carry the header too, reads do not", async () => {
    const c = client();
    await c.markInvoicePaid("inv_7");
    await c.listInvoices({ limit: 1 });

    const post = captured.find((r) => r.method === "POST");
    const get = captured.find((r) => r.method === "GET");
    assert.ok(post?.idempotencyKey, "POST /paid had no Idempotency-Key");
    assert.equal(get?.idempotencyKey, undefined);
  });

  // -- blank keys --------------------------------------------------------
  //
  // An LLM client filling an optional string param routinely emits "" rather
  // than omitting it. `idempotencyKey ?? mint()` treats "" as PRESENT, and the
  // `if (key)` that writes the header then drops it — a keyless POST, i.e.
  // exactly the 400 IDEMPOTENCY_KEY_REQUIRED this file exists to pin. These
  // two cases FAIL on the pre-fix client.

  test("an empty-string key is treated as absent, not as a key", async () => {
    await client().createCreditNote("inv_8", { reason: "error", fullCredit: true }, "");

    assert.equal(captured.length, 1);
    assert.ok(
      captured[0].idempotencyKey,
      'idempotencyKey:"" dropped the header — the live API answers 400 IDEMPOTENCY_KEY_REQUIRED',
    );
    assert.match(captured[0].idempotencyKey as string, UUID_RE);
  });

  test("a whitespace-only key is treated as absent, and a padded key is trimmed", async () => {
    const c = client();
    await c.createCreditNote("inv_9", { reason: "error", fullCredit: true }, "   ");
    await c.createCreditNote("inv_10", { reason: "error", fullCredit: true }, "  pedido-42  ");

    assert.equal(captured.length, 2);
    assert.match(
      captured[0].idempotencyKey as string,
      UUID_RE,
      "whitespace-only key left the request keyless",
    );
    assert.equal(
      captured[1].idempotencyKey,
      "pedido-42",
      "a padded key must reach the wire trimmed — leading/trailing spaces make the retry a different key",
    );
  });

  // -- Missing global crypto ------------------------------------------------
  // Defense in depth for constrained embedders: the fallback must still emit
  // a valid UUID when the normally available global is absent.

  test("the no-globalThis.crypto fallback still emits a UUID", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      await client().createCreditNote("inv_11", { reason: "error", fullCredit: true });
    } finally {
      if (original) Object.defineProperty(globalThis, "crypto", original);
      else delete (globalThis as { crypto?: unknown }).crypto;
    }

    assert.equal(captured.length, 1);
    assert.match(
      captured[0].idempotencyKey as string,
      UUID_RE,
      "the missing-crypto fallback produced a non-UUID key",
    );
  });
});
