import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { erpServer, fixture, mcpSurface } from "./helpers/erp-parity.js";
import { CAPABILITY_META_KEY } from "../capability-truth.js";

const ID = "inv_2026_104";

describe("Headless issuance and series OpenAPI parity", () => {
  test("issue_invoice preserves fiscal status URL and forwards the caller key without body or email", async (t) => {
    const envelope = fixture<{ data: Record<string, unknown>; fiscal: Record<string, unknown> }>("invoice-issue");
    const { backend, requests } = await erpServer(t, (_req, res) => res.end(JSON.stringify(envelope)));
    const client = await mcpSurface(t, backend);
    const result = await client.callTool({ name: "issue_invoice", arguments: { id: ID, confirm: true, idempotencyKey: "issue-key-1" } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { ...envelope.data, fiscal: envelope.fiscal });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url.pathname, `/v1/invoices/${ID}/issue`);
    assert.equal(requests[0].body, "");
    assert.equal(requests[0].headers["idempotency-key"], "issue-key-1");
    const tool = (await client.listTools()).tools.find((tool) => tool.name === "issue_invoice")!;
    assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    assert.deepEqual((tool._meta?.[CAPABILITY_META_KEY] as { externalSideEffects: string[] }).externalSideEffects,
      ["webhook_delivery_or_configuration", "fiscal_or_einvoice_submission"]);
  });

  test("same issuance key converges, including a rate-limited retry; omitted keys are generated", async (t) => {
    let limited = true;
    const numbers = new Map<string, string>();
    const { backend, requests } = await erpServer(t, (req, res) => {
      if (limited) {
        limited = false;
        res.statusCode = 429;
        res.setHeader("Retry-After", "0");
        res.end(JSON.stringify({ error: "rate_limited" }));
        return;
      }
      const key = String(req.headers["idempotency-key"]);
      if (!numbers.has(key)) numbers.set(key, `F${numbers.size + 1}`);
      const envelope = fixture<{ data: Record<string, unknown> }>("invoice-issue");
      envelope.data.documentNumber = numbers.get(key);
      res.end(JSON.stringify(envelope));
    });
    const client = await mcpSurface(t, backend);
    const args = { id: ID, confirm: true, idempotencyKey: "same-issuance" };
    const first = await client.callTool({ name: "issue_invoice", arguments: args });
    const second = await client.callTool({ name: "issue_invoice", arguments: args });
    assert.equal(first.isError, undefined);
    assert.equal(second.isError, undefined);
    assert.deepEqual(first.structuredContent, second.structuredContent);
    assert.equal(numbers.size, 1);
    assert.deepEqual(requests.map((r) => r.headers["idempotency-key"]), ["same-issuance", "same-issuance", "same-issuance"]);
    await client.callTool({ name: "issue_invoice", arguments: { id: ID, confirm: true } });
    assert.match(String(requests.at(-1)!.headers["idempotency-key"]), /^[a-f0-9-]{36}$/i);
  });

  test("confirmation guard and strict issue schema reject unapproved or unsupported fields locally", async (t) => {
    const { backend, requests } = await erpServer(t, (_req, res) => res.end("{}"));
    const client = await mcpSurface(t, backend);
    for (const args of [
      { id: ID, confirm: false }, { id: ID }, { confirm: true },
      { id: ID, confirm: true, seriesId: "other" }, { id: ID, confirm: true, to: "x@example.com" },
      { id: ID, confirm: true, idempotencyKey: " " }, { id: ID, confirm: true, idempotencyKey: "x".repeat(65) },
    ]) {
      assert.equal((await client.callTool({ name: "issue_invoice", arguments: args })).isError, true);
    }
    assert.equal(requests.length, 0);
  });

  for (const status of [403, 404, 409, 422]) {
    test(`issuance HTTP ${status} cannot become success or echo raw errors`, async (t) => {
      const { backend } = await erpServer(t, (_req, res) => {
        res.statusCode = status;
        res.end(JSON.stringify({ error: "fri_live_PRIVATE-provider-body", code: "ALREADY_ISSUED" }));
      });
      const client = await mcpSurface(t, backend);
      const result = await client.callTool({ name: "issue_invoice", arguments: { id: ID, confirm: true } });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.equal(JSON.stringify(result).includes("fri_live_PRIVATE"), false);
    });
  }

  test("missing fiscal sibling fails output validation instead of losing the status contract silently", async (t) => {
    const { backend } = await erpServer(t, (_req, res) => res.end(JSON.stringify({ data: fixture<{data: unknown}>("invoice-issue").data })));
    const client = await mcpSurface(t, backend);
    assert.equal((await client.callTool({ name: "issue_invoice", arguments: { id: ID, confirm: true } })).isError, true);
  });

  test("list_series preserves default, rectificativa and unresolved configuration without invented pagination", async (t) => {
    const envelope = fixture("invoice-series");
    const { backend, requests } = await erpServer(t, (_req, res) => res.end(JSON.stringify(envelope)));
    const client = await mcpSurface(t, backend);
    const result = await client.callTool({ name: "list_series", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { data: envelope.data });
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[0].url.pathname, "/v1/series");
    assert.equal(requests[0].url.search, "");
    assert.equal(requests[0].headers["idempotency-key"], undefined);
    const tool = (await client.listTools()).tools.find((tool) => tool.name === "list_series")!;
    assert.equal(tool.annotations?.readOnlyHint, true);
  });

  test("list_series rejects pagination and write arguments with no request", async (t) => {
    const { backend, requests } = await erpServer(t, (_req, res) => res.end("{}"));
    const client = await mcpSurface(t, backend);
    for (const args of [{ limit: 5 }, { offset: 0 }, { seriesId: "default" }]) {
      assert.equal((await client.callTool({ name: "list_series", arguments: args })).isError, true);
    }
    assert.equal(requests.length, 0);
  });

  test("empty series lists validate; raw/malformed envelopes fail closed", async (t) => {
    let body: unknown = { data: [] };
    const { backend } = await erpServer(t, (_req, res) => res.end(JSON.stringify(body)));
    const client = await mcpSurface(t, backend);
    assert.deepEqual((await client.callTool({ name: "list_series", arguments: {} })).structuredContent, { data: [] });
    for (body of [{ data: {} }, { data: [{ id: "bad" }] }, {}]) {
      assert.equal((await client.callTool({ name: "list_series", arguments: {} })).isError, true);
    }
  });
});
