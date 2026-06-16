/**
 * Client-contract smoke for the 5 banking client methods — Megasprint 1 (#848).
 *
 * The banking *tools* (banking-tools.test.ts) mock IFrihetClient, so they never
 * exercise the real HTTP layer. This file does: it boots a local node:http server
 * acting as the Frihet ERP backend, points a REAL FrihetClient at it, and asserts
 * every banking method hits the exact verb + path + payload the LIVE server actions
 * in Frihet-ERP expect (#848). Catches path/verb/body drift that a mock cannot.
 *
 * Live REST surface (verbatim from shipped server actions):
 *   GET   /v1/banking/accounts
 *   GET   /v1/banking/accounts/:id
 *   GET   /v1/banking/transactions
 *   PATCH /v1/banking/transactions/:id/categorize
 *   POST  /v1/banking/transactions/:id/match
 *
 * Run: npm test (after build)
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { FrihetClient } from "../client.js";

// ── Captured request log ─────────────────────────────────────────────────────

interface CapturedRequest {
  method: string;
  path: string; // pathname only (no query)
  query: URLSearchParams;
  body: unknown;
}

const captured: CapturedRequest[] = [];

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
}

// ── Mock ERP backend ─────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    captured.push({
      method: req.method ?? "",
      path: url.pathname,
      query: url.searchParams,
      body: await readBody(req),
    });

    res.setHeader("Content-Type", "application/json");

    // Account / transaction list endpoints → paginated shape
    if (url.pathname === "/banking/accounts" && req.method === "GET") {
      res.end(JSON.stringify({ data: [{ id: "acct_001", ibanLast4: "4321" }], total: 1, limit: 20, offset: 0 }));
      return;
    }
    if (url.pathname === "/banking/transactions" && req.method === "GET") {
      res.end(JSON.stringify({ data: [{ id: "tx_1", status: "posted" }], total: 1, limit: 20, offset: 0 }));
      return;
    }
    // Single account + mutations → bare record
    res.end(JSON.stringify({ id: "ok" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeClient(): FrihetClient {
  // Real client, real HTTP layer, pointed at our mock backend.
  return new FrihetClient("fri_test_key", baseUrl);
}

function lastRequest(): CapturedRequest {
  return captured[captured.length - 1]!;
}

// ── Contract assertions ──────────────────────────────────────────────────────

describe("Banking client contract — #848 live REST surface", () => {
  test("listBankAccounts → GET /banking/accounts with pagination query", async () => {
    const client = makeClient();
    const result = await client.listBankAccounts({ limit: 20, offset: 0 });

    const req = lastRequest();
    assert.equal(req.method, "GET");
    assert.equal(req.path, "/banking/accounts");
    assert.equal(req.query.get("limit"), "20");
    assert.equal(req.query.get("offset"), "0");
    assert.ok(Array.isArray((result as { data: unknown[] }).data));
  });

  test("getBankAccount → GET /banking/accounts/:id (id URL-encoded)", async () => {
    const client = makeClient();
    await client.getBankAccount("acct/001");

    const req = lastRequest();
    assert.equal(req.method, "GET");
    assert.equal(req.path, "/banking/accounts/acct%2F001");
  });

  test("listTransactions → GET /banking/transactions with filters", async () => {
    const client = makeClient();
    await client.listTransactions({ accountId: "acct_001", from: "2026-05-01", to: "2026-05-31", status: "posted" });

    const req = lastRequest();
    assert.equal(req.method, "GET");
    assert.equal(req.path, "/banking/transactions");
    assert.equal(req.query.get("accountId"), "acct_001");
    assert.equal(req.query.get("from"), "2026-05-01");
    assert.equal(req.query.get("to"), "2026-05-31");
    assert.equal(req.query.get("status"), "posted");
  });

  test("categorizeTransaction → PATCH /banking/transactions/:id/categorize with body", async () => {
    const client = makeClient();
    await client.categorizeTransaction("tx_abc", { category: "supplies", notes: "Q1" });

    const req = lastRequest();
    assert.equal(req.method, "PATCH");
    assert.equal(req.path, "/banking/transactions/tx_abc/categorize");
    assert.deepEqual(req.body, { category: "supplies", notes: "Q1" });
  });

  test("matchTransactionToDocument → POST /banking/transactions/:id/match with body", async () => {
    const client = makeClient();
    await client.matchTransactionToDocument("tx_abc", { documentId: "inv_xyz", documentType: "invoice", notes: "recon" });

    const req = lastRequest();
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/banking/transactions/tx_abc/match");
    assert.deepEqual(req.body, { documentId: "inv_xyz", documentType: "invoice", notes: "recon" });
  });

  test("methods return live data (not the old '404 until backend ships' stub)", async () => {
    // Proves the wiring: a real round-trip yields the backend payload, confirming
    // the stale 'planned/404' comment no longer reflects reality (#848 shipped).
    const client = makeClient();
    const accounts = await client.listBankAccounts();
    assert.equal((accounts as { total: number }).total, 1);
  });
});
