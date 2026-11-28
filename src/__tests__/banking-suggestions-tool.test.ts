import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { erpServer, fixture, mcpSurface } from "./helpers/erp-parity.js";
import type { BankTransactionSuggestions } from "../types.js";
import { DemoFrihetClient } from "../demo-client.js";
import { CAPABILITY_META_KEY } from "../capability-truth.js";
import { remoteMcpSurfaceComposition } from "../server-composition.js";

const response = () => fixture<{ data: BankTransactionSuggestions }>("banking-transaction-suggestions");
const ID = "tx_2026_104";
const NAME = "get_banking_transaction_suggestions";

describe("Read-only banking reconciliation suggestions", () => {
  test("unwraps server-ranked candidates and preserves reasons, scores and unknown-date sentinel", async (t) => {
    const envelope = response();
    const { backend, requests } = await erpServer(t, (_req, res) => res.end(JSON.stringify(envelope)));
    const client = await mcpSurface(t, backend);
    const result = await client.callTool({ name: NAME, arguments: { transactionId: ID } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, envelope.data);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[0].url.pathname, `/v1/banking/transactions/${ID}/suggestions`);
    assert.equal(requests[0].url.search, "");
    assert.equal(requests[0].body, "");
    assert.equal(requests[0].headers["idempotency-key"], undefined);
    const tools = (await client.listTools()).tools.filter((tool) => tool.name === NAME);
    assert.equal(tools.length, 1);
    assert.deepEqual(tools[0].annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const capability = tools[0]._meta?.[CAPABILITY_META_KEY] as { writesFrihet: boolean; externalSideEffects: string[] };
    assert.equal(capability.writesFrihet, false);
    assert.deepEqual(capability.externalSideEffects, []);
  });

  test("optional limit reaches the wire at both bounds; repeated reads never invoke matching", async (t) => {
    const { backend, requests } = await erpServer(t, (req, res) => {
      const envelope = response();
      envelope.data.limit = Number(req.url.searchParams.get("limit"));
      envelope.data.suggestions = envelope.data.suggestions.slice(0, envelope.data.limit);
      res.end(JSON.stringify(envelope));
    });
    const client = await mcpSurface(t, backend);
    for (const limit of [1, 10, 10]) {
      const result = await client.callTool({ name: NAME, arguments: { transactionId: ID, limit } });
      assert.equal(result.isError, undefined);
      assert.equal((result.structuredContent as BankTransactionSuggestions).limit, limit);
    }
    assert.deepEqual(requests.map((request) => request.url.search), ["?limit=1", "?limit=10", "?limit=10"]);
    assert.ok(requests.every((request) => request.method === "GET" && request.body === ""));
  });

  test("strict schema rejects invalid limits, identifiers and mutation fields before I/O", async (t) => {
    const { backend, requests } = await erpServer(t, (_req, res) => res.end("{}"));
    const client = await mcpSurface(t, backend);
    const invalid: Array<Record<string, unknown>> = [
      {}, { id: ID }, { transactionId: ID, confirm: true }, { transactionId: ID, documentId: "inv_1" },
      ...["", " ", "..", "__reserved", "one/two", "nul\0id", "x".repeat(1501)].map((transactionId) => ({ transactionId })),
      ...[0, 11, -1, 1.5, "5"].map((limit) => ({ transactionId: ID, limit })),
    ];
    for (const args of invalid) {
      assert.equal((await client.callTool({ name: NAME, arguments: args })).isError, true);
    }
    assert.equal(requests.length, 0);
  });

  test("already reconciled or unmatched transactions may return empty suggestions without fake pagination", async (t) => {
    const data = { transactionId: ID, limit: 5, suggestions: [] };
    const { backend } = await erpServer(t, (_req, res) => res.end(JSON.stringify({ data })));
    const client = await mcpSurface(t, backend);
    const result = await client.callTool({ name: NAME, arguments: { transactionId: ID } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, data);
  });

  test("mismatched transactions and malformed successes fail output validation", async (t) => {
    let body: unknown;
    const { backend } = await erpServer(t, (_req, res) => res.end(JSON.stringify(body)));
    const client = await mcpSurface(t, backend);
    const data = response().data;
    for (body of [
      {}, { data: {} }, { data: { ...data, transactionId: "other_tx" } },
      { data: { ...data, suggestions: [{ ...data.suggestions[0], confidence: 101 }] } },
      { data: { ...data, suggestions: [{ ...data.suggestions[0], documentType: "quote" }] } },
      { data: { ...data, suggestions: [{ ...data.suggestions[0], amountDiff: null }] } },
      { data: { ...data, suggestions: [{ ...data.suggestions[0], breakdown: [{ signal: "unverified" }] }] } },
    ]) {
      assert.equal((await client.callTool({ name: NAME, arguments: { transactionId: ID } })).isError, true);
    }
  });

  for (const status of [400, 403, 404]) {
    test(`HTTP ${status} propagates as a sanitized error, with no success payload`, async (t) => {
      const { backend } = await erpServer(t, (_req, res) => {
        res.statusCode = status;
        res.end(JSON.stringify({ error: "fri_live_PRIVATE-provider-body" }));
      });
      const client = await mcpSurface(t, backend);
      const result = await client.callTool({ name: NAME, arguments: { transactionId: ID } });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.equal(JSON.stringify(result).includes("fri_live_PRIVATE"), false);
    });
  }

  test("grouped discovery puts suggestions in banking and leaves them callable", async (t) => {
    const { backend } = await erpServer(t, (_req, res) => res.end(JSON.stringify(response())));
    const client = await mcpSurface(t, backend, remoteMcpSurfaceComposition(false, true));
    const descriptor = await client.callTool({ name: "describe_tool", arguments: { name: NAME } });
    assert.equal(descriptor.isError, undefined);
    assert.equal((descriptor.structuredContent as Record<string, unknown>).group, "banking");
    const result = await client.callTool({ name: NAME, arguments: { transactionId: ID } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, response().data);
  });

  test("demo returns labelled empty candidates with the same schema and limit", async (t) => {
    const client = await mcpSurface(t, new DemoFrihetClient());
    const result = await client.callTool({ name: NAME, arguments: { transactionId: ID, limit: 2 } });
    assert.equal(result.isError, undefined);
    const output = result.structuredContent as unknown as BankTransactionSuggestions;
    assert.equal(output._demo, true);
    assert.equal(output.limit, 2);
    assert.deepEqual(output.suggestions, []);
  });
});
