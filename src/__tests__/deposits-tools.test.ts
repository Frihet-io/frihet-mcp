import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FrihetClient } from "../client.js";
import { registerDepositTools } from "../tools/deposits.js";

async function connect(t: TestContext): Promise<Client> {
  const server = new McpServer({ name: "deposit-contract", version: "0.0.0" });
  registerDepositTools(server, new FrihetClient("fri_test_deposit", "https://api.frihet.io/v1"));
  const client = new Client({ name: "deposit-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

const resultFor = (amount: number, remainingBalance: number) => ({
  success: true, depositId: "dep_1", refundedAmount: amount, remainingBalance,
});

test("refund_deposit advertises bookkeeping, strict amount input and unsafe repeated execution", async (t) => {
  const client = await connect(t);
  const tool = (await client.listTools()).tools.find(({ name }) => name === "refund_deposit")!;
  assert.match(tool.description!, /no money is transferred/);
  assert.match(tool.description!, /get_deposit before retrying/);
  assert.match(tool.description!, /new call can record another partial refund/);
  assert.equal(tool.annotations?.readOnlyHint, false);
  assert.equal(tool.annotations?.destructiveHint, true);
  assert.equal(tool.annotations?.idempotentHint, false);
  assert.equal(tool.annotations?.openWorldHint, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties!).sort(), ["amount", "confirm", "id"]);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required?.slice().sort(), ["confirm", "id"]);
});

for (const [label, args] of [
  ["missing confirmation", { id: "dep_1" }],
  ["non-boolean confirmation", { id: "dep_1", confirm: "true" }],
  ["missing ID", { confirm: true }],
  ["empty ID", { id: "", confirm: true }],
  ["zero amount", { id: "dep_1", confirm: true, amount: 0 }],
  ["negative amount", { id: "dep_1", confirm: true, amount: -1 }],
  ["string amount", { id: "dep_1", confirm: true, amount: "50" }],
  ["null amount", { id: "dep_1", confirm: true, amount: null }],
  ["legacy reason", { id: "dep_1", confirm: true, reason: "cancelled" }],
  ["legacy notes", { id: "dep_1", confirm: true, notes: "cancelled" }],
] as const) {
  test(`refund_deposit rejects ${label} before the API`, async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected API call"); });
    const client = await connect(t);
    const result = await client.callTool({ name: "refund_deposit", arguments: args });
    assert.equal(result.isError, true);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

test("refund_deposit confirm=false explains the accounting consequence without calling the API", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected API call"); });
  const client = await connect(t);
  const result = await client.callTool({ name: "refund_deposit", arguments: { id: "dep_1", confirm: false } });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /reduces the recorded remaining balance/);
  assert.match(JSON.stringify(result.content), /no money is transferred/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

for (const amount of [undefined, 12.5]) {
  test(`refund_deposit sends only the ${amount === undefined ? "full" : "partial"} refund body and preserves the result`, async (t) => {
    const expected = resultFor(amount ?? 100, amount === undefined ? 0 : 100 - amount);
    const fetchMock = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(url, "https://api.frihet.io/v1/deposits/dep_1/refund");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), amount === undefined ? {} : { amount });
      assert.ok(new Headers(init?.headers).get("Idempotency-Key"));
      return Response.json({ data: expected, meta: { requestId: "req_1" } });
    });
    const client = await connect(t);
    const result = await client.callTool({ name: "refund_deposit", arguments: { id: "dep_1", confirm: true, ...(amount === undefined ? {} : { amount }) } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, expected);
    assert.match(JSON.stringify(result.content), /refund recorded \(no money transferred\)/);
    assert.equal(fetchMock.mock.callCount(), 1);
  });
}

test("refund_deposit does not claim to deduplicate separate partial-refund calls", async (t) => {
  const keys: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key")!);
    assert.deepEqual(JSON.parse(String(init?.body)), { amount: 25 });
    return Response.json({ data: resultFor(25, 100 - 25 * keys.length) });
  });
  const client = await connect(t);
  const request = { name: "refund_deposit", arguments: { id: "dep_1", confirm: true, amount: 25 } };
  const first = await client.callTool(request);
  const second = await client.callTool(request);
  assert.deepEqual(first.structuredContent, resultFor(25, 75));
  assert.deepEqual(second.structuredContent, resultFor(25, 50));
  assert.equal(keys.length, 2);
  assert.ok(keys[0]);
  assert.ok(keys[1]);
  assert.notEqual(keys[0], keys[1]);
});

test("refund_deposit preserves the key and body on the client's automatic 429 retry", async (t) => {
  const keys: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key")!);
    assert.deepEqual(JSON.parse(String(init?.body)), { amount: 25 });
    return keys.length === 1
      ? Response.json({ error: "rate_limit_exceeded" }, { status: 429, headers: { "Retry-After": "0" } })
      : Response.json({ data: resultFor(25, 75) });
  });
  const client = await connect(t);
  const result = await client.callTool({ name: "refund_deposit", arguments: { id: "dep_1", confirm: true, amount: 25 } });
  assert.notEqual(result.isError, true);
  assert.equal(keys.length, 2);
  assert.ok(keys[0]);
  assert.equal(keys[0], keys[1]);
});

for (const status of [400, 500]) {
  test(`refund_deposit sanitizes API ${status} and never blindly retries it`, async (t) => {
    const secret = "fri_private_provider_secret";
    const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({
      error: "refund_failed", message: `${secret} private customer data`, detail: "private provider body",
    }, { status }));
    const client = await connect(t);
    const result = await client.callTool({ name: "refund_deposit", arguments: { id: "dep_1", confirm: true } });
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /fri_private_provider_secret|private customer data|private provider body/);
    assert.equal(fetchMock.mock.callCount(), 1);
    if (status === 500) assert.equal(result._meta?.["io.frihet/operationOutcomeUnknown"], true);
  });
}

test("refund_deposit marks network failures as outcome unknown without repeating the write", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("private provider failure"); });
  const client = await connect(t);
  const result = await client.callTool({ name: "refund_deposit", arguments: { id: "dep_1", confirm: true } });
  assert.equal(result.isError, true);
  assert.equal(result._meta?.["io.frihet/operationOutcomeUnknown"], true);
  assert.doesNotMatch(JSON.stringify(result), /private provider failure/);
  assert.equal(fetchMock.mock.callCount(), 1);
});
