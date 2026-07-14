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
 * This spins up a local node:http server (acting as the ERP backend), points
 * a REAL FrihetClient at it, and asserts the captured query string contains
 * `cursor=<token>` and NOT `after=<token>` when a pagination token is passed.
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

describe("Pagination cursor wire param — client must send `cursor`, not `after`", () => {
  test("listInvoices(after: token) → query string has cursor=token, no after param", async () => {
    const client = makeClient();
    await client.listInvoices({ after: CURSOR_TOKEN, limit: 20 });

    const req = lastRequest();
    assert.equal(req.query.get("cursor"), CURSOR_TOKEN, "backend reads req.query.cursor — token must land there");
    assert.equal(req.query.get("after"), null, "the `after` param is not read by the backend and must not be sent");
  });

  test("listExpenses(after: token) → query string has cursor=token, no after param", async () => {
    const client = makeClient();
    await client.listExpenses({ after: CURSOR_TOKEN });

    const req = lastRequest();
    assert.equal(req.query.get("cursor"), CURSOR_TOKEN);
    assert.equal(req.query.get("after"), null);
  });

  test("listClients(after: token) → query string has cursor=token, no after param", async () => {
    const client = makeClient();
    await client.listClients({ after: CURSOR_TOKEN });

    const req = lastRequest();
    assert.equal(req.query.get("cursor"), CURSOR_TOKEN);
    assert.equal(req.query.get("after"), null);
  });
});
