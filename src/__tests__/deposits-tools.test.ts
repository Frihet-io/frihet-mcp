import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FrihetClient } from "../client.js";
import { registerDepositTools } from "../tools/deposits.js";
import { backend132ApplyDepositSchema, backend132DepositSchema } from "./fixtures/deposit-backend132-schema.js";
import { DepositInputError } from "../deposit-contract.js";

async function connect(t: TestContext, api = new FrihetClient("fri_test_deposit", "https://api.frihet.io/v1")): Promise<Client> {
  const server = new McpServer({ name: "deposit-contract", version: "0.0.0" });
  registerDepositTools(server, api);
  const client = new Client({ name: "deposit-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

const resultFor = (amount: number, remainingBalance: number) => ({
  success: true, depositId: "dep_1", refundedAmount: amount, remainingBalance,
});

const createInput = () => ({
  clientId: "synthetic-client", clientName: "Synthetic client", amount: 1,
  date: "2026-10-21", description: "Synthetic deposit contract",
  reference: "QA-reference", paymentMethod: "bank_transfer",
});

test("deposit descriptors expose only writable fields and retain the seven tool names", async (t) => {
  const client = await connect(t);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(({ name }) => name).sort(), ["apply_deposit", "create_deposit", "delete_deposit", "get_deposit", "list_deposits", "refund_deposit", "update_deposit"]);
  const create = tools.find(({ name }) => name === "create_deposit")!;
  assert.deepEqual(create.inputSchema.required?.slice().sort(), ["amount", "clientId", "clientName", "date", "description"]);
  const apply = tools.find(({ name }) => name === "apply_deposit")!;
  assert.deepEqual(Object.keys(apply.inputSchema.properties!).sort(), ["amount", "id", "invoiceId", "invoiceNumber"]);
  assert.deepEqual(apply.inputSchema.required?.slice().sort(), ["amount", "id", "invoiceId", "invoiceNumber"]);
  for (const name of ["apply_deposit", "create_deposit", "update_deposit"]) {
    const schema = tools.find((tool) => tool.name === name)!.inputSchema;
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties?.notes, undefined);
    assert.equal(schema.properties?.status, undefined);
  }
});

test("create_deposit maps established date/reference arguments into the exact backend132 wire contract", async (t) => {
  const input = createInput();
  const expected = { clientId: input.clientId, clientName: input.clientName, amount: 1, currency: "EUR", description: input.description, receivedDate: input.date, paymentMethod: input.paymentMethod, paymentReference: input.reference };
  const fetchMock = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, "https://api.frihet.io/v1/deposits");
    assert.equal(init?.method, "POST");
    const wire = JSON.parse(String(init?.body));
    assert.deepEqual(wire, expected);
    assert.deepEqual(backend132DepositSchema.parse(wire), expected);
    assert.ok(new Headers(init?.headers).get("Idempotency-Key"));
    return Response.json({ data: { id: "dep_synthetic", ...wire, status: "active" } });
  });
  const client = await connect(t);
  const result = await client.callTool({ name: "create_deposit", arguments: input });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, { id: "dep_synthetic", ...expected, status: "active" });
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(input, createInput());
});

for (const [label, change] of [
  ["missing clientName", { clientName: undefined }],
  ["missing description", { description: undefined }],
  ["missing date", { date: undefined }],
  ["nonpositive amount", { amount: 0 }],
  ["invalid currency", { currency: "EURO" }],
  ["invalid date format", { date: "21/10/2026" }],
  ["oversized client", { clientId: "x".repeat(129) }],
  ["oversized reference", { reference: "x".repeat(201) }],
  ["unsupported status", { status: "pending" }],
  ["unsupported notes", { notes: "must not be silently discarded" }],
] as const) {
  test(`create_deposit rejects ${label} before the API`, async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected API call"); });
    const client = await connect(t);
    const result = await client.callTool({ name: "create_deposit", arguments: { ...createInput(), ...change } });
    assert.equal(result.isError, true);
    assert.equal(fetchMock.mock.callCount(), 0);
    if ("notes" in change || "status" in change) {
      assert.match(JSON.stringify(result.content), "notes" in change ? /notes/ : /status/);
      assert.doesNotMatch(JSON.stringify(result.content), /must not be silently discarded/);
    }
  });
}

test("update_deposit preserves PATCH semantics and maps only the supplied reference", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, "https://api.frihet.io/v1/deposits/dep_synthetic");
    assert.equal(init?.method, "PATCH");
    const wire = JSON.parse(String(init?.body));
    assert.deepEqual(wire, { paymentReference: "new-reference" });
    assert.equal(backend132DepositSchema.partial().safeParse(wire).success, true);
    assert.ok(new Headers(init?.headers).get("Idempotency-Key"));
    return Response.json({ data: { id: "dep_synthetic", clientId: "synthetic-client", amount: 1, ...wire } });
  });
  const client = await connect(t);
  const result = await client.callTool({ name: "update_deposit", arguments: { id: "dep_synthetic", reference: "new-reference" } });
  assert.notEqual(result.isError, true);
  assert.equal((result.structuredContent as Record<string, unknown>)?.paymentReference, "new-reference");
  assert.equal(fetchMock.mock.callCount(), 1);
});

for (const args of [{ id: "dep_synthetic" }, { id: "dep_synthetic", notes: "unsupported" }, { id: "dep_synthetic", status: "active" }, { id: "dep_synthetic", amount: -1 }]) {
  test(`update_deposit rejects empty or unsupported partial input ${Object.keys(args).join(",")}`, async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected API call"); });
    const client = await connect(t);
    const result = await client.callTool({ name: "update_deposit", arguments: args });
    assert.equal(result.isError, true);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

for (const partial of [false, true]) {
  test(`${partial ? "update" : "create"}Deposit accepts canonical date/reference fields without legacy aliases`, async (t) => {
    const { date, reference, ...fields } = createInput();
    const input = { ...fields, receivedDate: date, paymentReference: reference };
    t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const wire = JSON.parse(String(init?.body));
      assert.equal(wire.receivedDate, date);
      assert.equal(wire.paymentReference, reference);
      assert.equal((partial ? backend132DepositSchema.partial() : backend132DepositSchema).safeParse(wire).success, true);
      return Response.json({ data: { id: "dep_synthetic", ...wire } });
    });
    const client = new FrihetClient("fri_test_deposit", "https://api.frihet.io/v1");
    await (partial ? client.updateDeposit("dep_synthetic", input) : client.createDeposit(input));
  });

  test(`${partial ? "update" : "create"}Deposit accepts canonical fields and matching aliases without mutating caller input`, async (t) => {
    const input = { ...createInput(), receivedDate: "2026-10-21", paymentReference: "QA-reference" };
    const original = structuredClone(input);
    const fetchMock = t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const wire = JSON.parse(String(init?.body));
      assert.equal(wire.receivedDate, input.date);
      assert.equal(wire.paymentReference, input.reference);
      assert.equal("date" in wire, false);
      assert.equal("reference" in wire, false);
      assert.equal((partial ? backend132DepositSchema.partial() : backend132DepositSchema).safeParse(wire).success, true);
      return Response.json({ data: { id: "dep_synthetic", ...wire } });
    });
    const client = new FrihetClient("fri_test_deposit", "https://api.frihet.io/v1");
    await (partial ? client.updateDeposit("dep_synthetic", input) : client.createDeposit(input));
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.deepEqual(input, original);
  });

  for (const extra of [{ receivedDate: "2026-10-22" }, { paymentReference: "conflict" }, { notes: "private unsupported text" }, { status: "pending" }, { unexpected: true }]) {
    test(`${partial ? "update" : "create"}Deposit refuses conflicting or unsupported legacy input ${Object.keys(extra)[0]}`, async (t) => {
      const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected API call"); });
      const client = new FrihetClient("fri_test_deposit", "https://api.frihet.io/v1");
      const input = { ...createInput(), ...extra };
      await assert.rejects(partial ? client.updateDeposit("dep_synthetic", input) : client.createDeposit(input), (error: unknown) => {
        assert.ok(error instanceof DepositInputError);
        assert.equal(error.statusCode, 400);
        assert.equal(error.errorCode, "invalid_deposit_input");
        if ("notes" in extra || "status" in extra) {
          assert.match(error.message, /not writable/);
          assert.doesNotMatch(error.message, /private unsupported text/);
        } else if ("receivedDate" in extra || "paymentReference" in extra) {
          assert.match(error.message, /Conflicting deposit fields/);
        }
        return true;
      });
      assert.equal(fetchMock.mock.callCount(), 0);
    });
  }

  test(`${partial ? "update" : "create"}Deposit retains its idempotency key across a rate-limit retry`, async (t) => {
    const keys: string[] = [];
    t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key")!);
      const wire = JSON.parse(String(init?.body));
      assert.equal(wire.receivedDate, "2026-10-21");
      assert.equal((partial ? backend132DepositSchema.partial() : backend132DepositSchema).safeParse(wire).success, true);
      return keys.length === 1 ? Response.json({ error: "rate_limit_exceeded" }, { status: 429, headers: { "Retry-After": "0" } }) : Response.json({ data: { id: "dep_synthetic", ...wire } });
    });
    const client = new FrihetClient("fri_test_deposit", "https://api.frihet.io/v1");
    await (partial ? client.updateDeposit("dep_synthetic", createInput()) : client.createDeposit(createInput()));
    assert.equal(keys.length, 2);
    assert.ok(keys[0]);
    assert.equal(keys[0], keys[1]);
  });
}

test("updateDeposit rejects an empty or undefined-only patch before the API", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected API call"); });
  const client = new FrihetClient("fri_test_deposit", "https://api.frihet.io/v1");
  await assert.rejects(client.updateDeposit("dep_synthetic", {}));
  await assert.rejects(client.updateDeposit("dep_synthetic", { currency: undefined }));
  assert.equal(fetchMock.mock.callCount(), 0);
});

for (const partial of [false, true]) {
  test(`${partial ? "update" : "create"}_deposit keeps local validation guidance visible through the real SDK`, async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected API call"); });
    const api = new FrihetClient("fri_test_deposit", "https://api.frihet.io/v1");
    if (partial) {
      const original = api.updateDeposit.bind(api);
      t.mock.method(api, "updateDeposit", (id: string, data: Record<string, unknown>) => original(id, { ...data, notes: "private value must stay local" }));
    } else {
      const original = api.createDeposit.bind(api);
      t.mock.method(api, "createDeposit", (data: Record<string, unknown>) => original({ ...data, notes: "private value must stay local" }));
    }
    const client = await connect(t, api);
    const result = await client.callTool({ name: partial ? "update_deposit" : "create_deposit", arguments: partial ? { id: "dep_synthetic", reference: "new-reference" } : createInput() });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /notes.*not writable/);
    assert.doesNotMatch(JSON.stringify(result), /unexpected error|Contact support|private value must stay local/);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

test("direct createDeposit validation names missing canonical fields without exposing input values", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected API call"); });
  const api = new FrihetClient("fri_test_deposit", "https://api.frihet.io/v1");
  await assert.rejects(api.createDeposit({ ...createInput(), description: undefined, clientName: "private customer name" }), (error: unknown) => {
    assert.ok(error instanceof DepositInputError);
    assert.match(error.message, /description/);
    assert.match(error.message, /positive amount/);
    assert.doesNotMatch(error.message, /private customer name/);
    return true;
  });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("apply_deposit maps arguments into the exact backend132 wire contract without notes", async (t) => {
  const input = { id: "dep_apply_1", invoiceId: "inv_1", invoiceNumber: "F-2026-007", amount: 150 };
  const expectedWire = { invoiceId: "inv_1", invoiceNumber: "F-2026-007", amount: 150 };
  const fetchMock = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, "https://api.frihet.io/v1/deposits/dep_apply_1/apply");
    assert.equal(init?.method, "POST");
    const wire = JSON.parse(String(init?.body));
    assert.deepEqual(wire, expectedWire);
    assert.deepEqual(backend132ApplyDepositSchema.parse(wire), expectedWire);
    assert.ok(new Headers(init?.headers).get("Idempotency-Key"));
    return Response.json({ data: { success: true, depositId: "dep_apply_1", appliedAmount: 150, remainingBalance: 0, status: "fully_applied" } });
  });
  const client = await connect(t);
  const result = await client.callTool({ name: "apply_deposit", arguments: input });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, { success: true, depositId: "dep_apply_1", appliedAmount: 150, remainingBalance: 0, status: "fully_applied" });
  assert.equal(fetchMock.mock.callCount(), 1);
});

for (const [label, args] of [
  ["unsupported notes", { id: "dep_1", invoiceId: "inv_1", invoiceNumber: "F-2026-007", amount: 150, notes: "must not reach backend" }],
  ["missing invoiceId", { id: "dep_1", invoiceNumber: "F-2026-007", amount: 150 }],
  ["empty invoiceId", { id: "dep_1", invoiceId: "", invoiceNumber: "F-2026-007", amount: 150 }],
  ["oversized invoiceId", { id: "dep_1", invoiceId: "x".repeat(129), invoiceNumber: "F-2026-007", amount: 150 }],
  ["missing invoiceNumber", { id: "dep_1", invoiceId: "inv_1", amount: 150 }],
  ["empty invoiceNumber", { id: "dep_1", invoiceId: "inv_1", invoiceNumber: "", amount: 150 }],
  ["oversized invoiceNumber", { id: "dep_1", invoiceId: "inv_1", invoiceNumber: "x".repeat(201), amount: 150 }],
  ["zero amount", { id: "dep_1", invoiceId: "inv_1", invoiceNumber: "F-2026-007", amount: 0 }],
  ["negative amount", { id: "dep_1", invoiceId: "inv_1", invoiceNumber: "F-2026-007", amount: -10 }],
  ["empty deposit id", { id: "", invoiceId: "inv_1", invoiceNumber: "F-2026-007", amount: 150 }],
] as const) {
  test(`apply_deposit rejects ${label} before the API`, async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected API call"); });
    const client = await connect(t);
    const result = await client.callTool({ name: "apply_deposit", arguments: args });
    assert.equal(result.isError, true);
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.doesNotMatch(JSON.stringify(result.content), /must not reach backend/);
  });
}

test("apply_deposit keeps local validation guidance visible through the real SDK when client.applyDeposit rejects unsupported fields", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected API call"); });
  const api = new FrihetClient("fri_test_deposit", "https://api.frihet.io/v1");
  const original = api.applyDeposit.bind(api);
  t.mock.method(api, "applyDeposit", (id: string, data?: Record<string, unknown>) => original(id, { ...data, notes: "private value must stay local" }));
  const client = await connect(t, api);
  const result = await client.callTool({ name: "apply_deposit", arguments: { id: "dep_1", invoiceId: "inv_1", invoiceNumber: "F-2026-007", amount: 150 } });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /notes.*not writable/);
  assert.doesNotMatch(JSON.stringify(result), /unexpected error|Contact support|private value must stay local/);
  assert.equal(fetchMock.mock.callCount(), 0);
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
