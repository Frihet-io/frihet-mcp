/**
 * Pins the wire contract of the two purchase-order client methods through a
 * REAL FrihetClient against a local node:http server (ADR 0027 S2): the MCP
 * surface is read-only, so both must be GET on exactly /purchase-orders and
 * /purchase-orders/{id}. Turns red if either becomes POST/PUT/PATCH/DELETE or
 * moves to another path.
 *
 * Run: npm test (after build)
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { FrihetClient } from "../client.js";

interface Hit {
  method: string | undefined;
  path: string;
  query: string;
}

const hits: Hit[] = [];
let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push({ method: req.method, path: url.pathname, query: url.search });
    req.resume();
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 200;
    const isList = url.pathname.endsWith("/purchase-orders");
    res.end(
      JSON.stringify(
        isList
          ? { data: [{ id: "po_1" }], total: 1, limit: 10, offset: 0 }
          : { data: { id: "po/1 x" } },
      ),
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
});

const client = () => new FrihetClient("fri_test_key", baseUrl);

test("listPurchaseOrders is a GET on /purchase-orders carrying the filters", async () => {
  await client().listPurchaseOrders({ status: "draft", vendorId: "v1", limit: 5, offset: 2 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.method, "GET");
  assert.ok(hits[0]!.path.endsWith("/purchase-orders"), hits[0]!.path);
  const q = new URLSearchParams(hits[0]!.query);
  assert.equal(q.get("status"), "draft");
  assert.equal(q.get("vendorId"), "v1");
  assert.equal(q.get("limit"), "5");
  assert.equal(q.get("offset"), "2");
});

test("getPurchaseOrder is a GET on /purchase-orders/{id} with the id URL-encoded", async () => {
  await client().getPurchaseOrder("po/1 x");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.method, "GET");
  assert.ok(hits[0]!.path.endsWith("/purchase-orders/po%2F1%20x"), hits[0]!.path);
});
