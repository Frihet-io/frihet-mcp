/**
 * Pagination cursor wire-param contract.
 *
 * Bug (verified live): the client built the cursor-pagination query as
 * `after: params?.after`, but the ERP backend reads `req.query.cursor`
 * (functions/src/publicApi.ts:6472 in Frihet-ERP) and returns `nextCursor`.
 * The cursor token therefore never reached the backend, every "next page"
 * request fell back to offset=0, and cursor-based pagination looped on
 * page 1 forever.
 *
 * Current state (post-fix): `after` remains the caller-facing param name on
 * every public list/search method below — tools/*.ts and other callers keep
 * passing `{ after }` unchanged, it's a naming alias only. The wire query
 * key actually sent to the backend is `cursor` (see the doc comment atop
 * `FrihetClient` in src/client.ts); `after` itself is never sent.
 *
 * This spins up a local node:http server (acting as the ERP backend), points
 * a REAL FrihetClient at it, and asserts — for EVERY paginated public method
 * that accepts `after` (the 16 call sites in src/client.ts where the wire
 * query builder has `cursor: params?.after`) — that the captured query
 * string contains `cursor=<token>` and NOT `after=<token>` when a pagination
 * token is passed.
 *
 * Run: npm test (after build)
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { FrihetClient } from "../client.js";

interface CapturedRequest {
  method: string;
  path: string; // pathname only (no query)
  query: URLSearchParams;
}

const captured: CapturedRequest[] = [];

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    captured.push({
      method: req.method ?? "",
      path: url.pathname,
      query: url.searchParams,
    });

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [], total: 0, limit: 20, offset: 0 }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeClient(): FrihetClient {
  return new FrihetClient("fri_test_key", baseUrl);
}

function lastRequest(): CapturedRequest {
  return captured[captured.length - 1]!;
}

const CURSOR_TOKEN = "eyJpZCI6Imludl8xMjMifQ"; // opaque base64url-ish token, matches backend shape

/**
 * Every public FrihetClient method whose wire-query builder in src/client.ts
 * sends `cursor: params?.after` — i.e. every method that accepts a
 * caller-facing `after` pagination token. Verified via
 * `grep -n "cursor: params?.after" src/client.ts` (16 call sites as of the
 * `cursor` rename in PR #71). Each entry drives the real method with
 * `{ after: CURSOR_TOKEN }` the same way a real caller (or tools/*.ts) would.
 * Add new paginated methods here as they ship so coverage stays exhaustive.
 */
const PAGINATED_ENDPOINTS: Array<{
  method: string;
  invoke: (client: FrihetClient) => Promise<unknown>;
}> = [
  { method: "listInvoices", invoke: (c) => c.listInvoices({ after: CURSOR_TOKEN, limit: 20 }) },
  { method: "searchInvoices", invoke: (c) => c.searchInvoices("acme", { after: CURSOR_TOKEN }) },
  { method: "listExpenses", invoke: (c) => c.listExpenses({ after: CURSOR_TOKEN }) },
  { method: "listClients", invoke: (c) => c.listClients({ after: CURSOR_TOKEN }) },
  { method: "listProducts", invoke: (c) => c.listProducts({ after: CURSOR_TOKEN }) },
  { method: "listQuotes", invoke: (c) => c.listQuotes({ after: CURSOR_TOKEN }) },
  { method: "listVendors", invoke: (c) => c.listVendors({ after: CURSOR_TOKEN }) },
  { method: "listDeposits", invoke: (c) => c.listDeposits({ after: CURSOR_TOKEN }) },
  { method: "listReservations", invoke: (c) => c.listReservations({ after: CURSOR_TOKEN }) },
  { method: "listProperties", invoke: (c) => c.listProperties({ after: CURSOR_TOKEN }) },
  { method: "listSales", invoke: (c) => c.listSales({ after: CURSOR_TOKEN }) },
  { method: "listKitchenTickets", invoke: (c) => c.listKitchenTickets({ after: CURSOR_TOKEN }) },
  { method: "listMenuItems", invoke: (c) => c.listMenuItems({ after: CURSOR_TOKEN }) },
  { method: "listTransactions", invoke: (c) => c.listTransactions({ after: CURSOR_TOKEN }) },
  { method: "listTimeEntries", invoke: (c) => c.listTimeEntries({ after: CURSOR_TOKEN }) },
  { method: "listLeaves", invoke: (c) => c.listLeaves({ after: CURSOR_TOKEN }) },
];

describe("Pagination cursor wire param — every list/search method must send `cursor`, not `after`", () => {
  for (const { method, invoke } of PAGINATED_ENDPOINTS) {
    test(`${method}({ after: token }) → query string has cursor=token, no after param`, async () => {
      const client = makeClient();
      await invoke(client);

      const req = lastRequest();
      assert.equal(
        req.query.get("cursor"),
        CURSOR_TOKEN,
        `${method}: backend reads req.query.cursor — token must land there`,
      );
      assert.equal(
        req.query.get("after"),
        null,
        `${method}: the \`after\` param is not read by the backend and must not be sent`,
      );
    });
  }
});
