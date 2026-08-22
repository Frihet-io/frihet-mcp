/**
 * Tests for the `create_expense` paidDate contract (ERP #1062).
 *
 * Scope: optional ISO YYYY-MM-DD with REAL calendar validation
 * (regex-only would silently accept 2026-02-29, 2026-04-31, or
 * non-zero-padded forms). Forwarded verbatim to the REST paidDate field —
 * the existing pass-through in client.createExpense handles the wire shape.
 *
 * Coverage:
 *   1.  Schema rejects 2026-02-29 (Feb 29 on a non-leap year) — RED.
 *   2.  Schema rejects 2026-04-31 (April has 30 days) — RED.
 *   3.  Schema rejects non-zero-padded dates (2026-4-1, 2026-04-1) — RED.
 *   4.  Schema rejects malformed shapes (empty, slash form, ISO datetime).
 *   5.  Schema accepts 2028-02-29 (Feb 29 on a leap year) — PASS.
 *   6.  Schema accepts valid exact dates (today, year-end, leap boundary).
 *   7.  Handler forwards paidDate EXACTLY to client.createExpense.
 *   8.  Handler forwards the rest of the input unchanged alongside paidDate.
 *   9.  Handler preserves backward-compat when paidDate is omitted.
 *   10. Tool description mentions paidDate so the field is discoverable.
 *   11. Registration still reports exactly 5 expense tools.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod/v4";
import { createExpenseInputSchema, registerExpenseTools } from "../tools/expenses.js";
import type { IFrihetClient } from "../client-interface.js";

// ── Minimal McpServer stub ───────────────────────────────────────────────────

interface ToolConfig {
  title: string;
  description: string;
  annotations?: Record<string, unknown>;
  inputSchema: unknown;
  outputSchema?: unknown;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

interface RegisteredTool {
  name: string;
  config: ToolConfig;
  handler: ToolHandler;
}

class StubMcpServer {
  tools: Map<string, RegisteredTool> = new Map();

  registerTool(name: string, config: ToolConfig, handler: ToolHandler): void {
    this.tools.set(name, { name, config, handler });
  }
}

// ── Client stubs ─────────────────────────────────────────────────────────────

const MOCK_EXPENSE = {
  id: "exp_abc123",
  description: "Office supplies",
  amount: 49.99,
  category: "office",
  vendor: "Amazon",
  taxDeductible: true,
  date: "2026-03-15",
  paidDate: "2026-03-15",
  createdAt: "2026-03-15T10:00:00Z",
  updatedAt: "2026-03-15T10:00:00Z",
};

/** Captures every createExpense call so the test can assert exact passthrough. */
const capturedCreateCalls: Array<Record<string, unknown>> = [];

function makeCapturingClient(): IFrihetClient {
  return {
    listExpenses: async () => ({ data: [], total: 0, limit: 50, offset: 0 }),
    getExpense: async () => MOCK_EXPENSE,
    createExpense: async (data: Record<string, unknown>) => {
      capturedCreateCalls.push({ ...data });
      return { ...MOCK_EXPENSE, ...data };
    },
    updateExpense: async () => MOCK_EXPENSE,
    deleteExpense: async () => undefined,
  } as unknown as IFrihetClient;
}

// ── Server helper ───────────────────────────────────────────────────────────

async function makeServer(): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  registerExpenseTools(
    server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    makeCapturingClient(),
  );
  return server;
}

// ── Schema unit tests (exercise the exported Zod object directly) ────────────

describe("create_expense input schema — paidDate calendar validation (#1062)", () => {
  const schema = createExpenseInputSchema;
  const base = { description: "Office supplies", amount: 49.99 };

  // ── RED cases ──────────────────────────────────────────────────────────

  test("2026-02-29 (Feb 29 on a non-leap year) is REJECTED", () => {
    const result = schema.safeParse({ ...base, paidDate: "2026-02-29" });
    assert.equal(result.success, false, "non-leap-year Feb 29 must not pass");
    if (!result.success) {
      const path = result.error.issues.map((i) => i.path.join(".")).join(", ");
      assert.equal(path, "paidDate");
    }
  });

  test("2026-04-31 (April has 30 days) is REJECTED", () => {
    const result = schema.safeParse({ ...base, paidDate: "2026-04-31" });
    assert.equal(result.success, false, "Apr 31 must not pass");
    if (!result.success) {
      const path = result.error.issues.map((i) => i.path.join(".")).join(", ");
      assert.equal(path, "paidDate");
    }
  });

  test("2025-02-29 (non-leap year, edge) is REJECTED", () => {
    const result = schema.safeParse({ ...base, paidDate: "2025-02-29" });
    assert.equal(result.success, false);
  });

  test("2026-13-01 (month 13) is REJECTED", () => {
    const result = schema.safeParse({ ...base, paidDate: "2026-13-01" });
    assert.equal(result.success, false);
  });

  test("non-zero-padded 2026-4-1 is REJECTED", () => {
    const result = schema.safeParse({ ...base, paidDate: "2026-4-1" });
    assert.equal(result.success, false, "single-digit month must not pass");
  });

  test("non-zero-padded 2026-04-1 is REJECTED", () => {
    const result = schema.safeParse({ ...base, paidDate: "2026-04-1" });
    assert.equal(result.success, false, "single-digit day must not pass");
  });

  test("slash-separated 2026/03/15 is REJECTED", () => {
    const result = schema.safeParse({ ...base, paidDate: "2026/03/15" });
    assert.equal(result.success, false);
  });

  test("ISO datetime 2026-03-15T10:00:00Z is REJECTED", () => {
    const result = schema.safeParse({ ...base, paidDate: "2026-03-15T10:00:00Z" });
    assert.equal(result.success, false, "datetime must not pass as a date");
  });

  test("empty string is REJECTED", () => {
    const result = schema.safeParse({ ...base, paidDate: "" });
    assert.equal(result.success, false);
  });

  test("non-string types are REJECTED (number)", () => {
    const result = schema.safeParse({ ...base, paidDate: 20260315 });
    assert.equal(result.success, false);
  });

  // ── PASS cases ─────────────────────────────────────────────────────────

  test("2028-02-29 (leap year) PASSES", () => {
    const result = schema.safeParse({ ...base, paidDate: "2028-02-29" });
    assert.equal(result.success, true, "leap-year Feb 29 must pass");
  });

  test("2024-02-29 (past leap year) PASSES", () => {
    const result = schema.safeParse({ ...base, paidDate: "2024-02-29" });
    assert.equal(result.success, true);
  });

  test("2026-03-15 (canonical valid date) PASSES", () => {
    const result = schema.safeParse({ ...base, paidDate: "2026-03-15" });
    assert.equal(result.success, true);
  });

  test("2026-12-31 (year-end) PASSES", () => {
    const result = schema.safeParse({ ...base, paidDate: "2026-12-31" });
    assert.equal(result.success, true);
  });

  test("omitted paidDate PASSES (backward-compat)", () => {
    const result = schema.safeParse(base);
    assert.equal(result.success, true);
  });

  test("explicit undefined paidDate PASSES (backward-compat)", () => {
    const result = schema.safeParse({ ...base, paidDate: undefined });
    assert.equal(result.success, true);
  });

  test("strict schema REJECTS unknown keys", () => {
    const result = schema.safeParse({ ...base, mysteryField: "x" });
    assert.equal(result.success, false, "strict schema must reject extras");
  });
});

// ── Tool registration + handler behaviour ───────────────────────────────────

describe("create_expense — registration and handler contract (#1062)", () => {
  let server: StubMcpServer;

  beforeEach(async () => {
    capturedCreateCalls.length = 0;
    server = await makeServer();
  });

  test("registers exactly 5 expense tools", () => {
    assert.equal(server.tools.size, 5);
    assert.ok(server.tools.has("list_expenses"));
    assert.ok(server.tools.has("get_expense"));
    assert.ok(server.tools.has("create_expense"));
    assert.ok(server.tools.has("update_expense"));
    assert.ok(server.tools.has("delete_expense"));
  });

  test("create_expense description advertises paidDate so the field is discoverable", () => {
    const tool = server.tools.get("create_expense");
    assert.ok(tool);
    assert.match(
      String(tool.config.description),
      /paidDate/,
      "description must surface paidDate so an agent can find it without knowing the REST implementation",
    );
  });

  test("create_expense description is bilingual (EN + ES)", () => {
    const tool = server.tools.get("create_expense");
    assert.ok(tool);
    const desc = String(tool.config.description);
    assert.match(desc, /Create|Record|expense/i);
    assert.match(desc, /Registra|gasto/i, "Spanish translation must remain present");
  });

  test("handler forwards paidDate EXACTLY to client.createExpense", async () => {
    const tool = server.tools.get("create_expense");
    assert.ok(tool);
    await tool.handler({
      description: "Adobe Creative Cloud",
      amount: 59.99,
      paidDate: "2026-03-15",
    });
    assert.equal(capturedCreateCalls.length, 1);
    assert.equal(capturedCreateCalls[0]?.paidDate, "2026-03-15");
    // The rest of the input is forwarded unchanged.
    assert.equal(capturedCreateCalls[0]?.description, "Adobe Creative Cloud");
    assert.equal(capturedCreateCalls[0]?.amount, 59.99);
  });

  test("handler forwards leap-day paidDate 2028-02-29 EXACTLY to client.createExpense", async () => {
    const tool = server.tools.get("create_expense");
    assert.ok(tool);
    await tool.handler({
      description: "Quarterly hosting",
      amount: 1200,
      paidDate: "2028-02-29",
    });
    assert.equal(capturedCreateCalls.length, 1);
    assert.equal(capturedCreateCalls[0]?.paidDate, "2028-02-29");
  });

  test("handler preserves all other fields alongside paidDate", async () => {
    const tool = server.tools.get("create_expense");
    assert.ok(tool);
    await tool.handler({
      description: "Adobe Creative Cloud",
      amount: 59.99,
      category: "technology",
      date: "2026-03-10",
      vendor: "Adobe",
      taxDeductible: true,
      paidDate: "2026-03-15",
    });
    assert.equal(capturedCreateCalls.length, 1);
    const forwarded = capturedCreateCalls[0];
    assert.deepEqual(forwarded, {
      description: "Adobe Creative Cloud",
      amount: 59.99,
      category: "technology",
      date: "2026-03-10",
      vendor: "Adobe",
      taxDeductible: true,
      paidDate: "2026-03-15",
    });
  });

  test("handler preserves backward-compat when paidDate is omitted", async () => {
    const tool = server.tools.get("create_expense");
    assert.ok(tool);
    await tool.handler({
      description: "Adobe Creative Cloud",
      amount: 59.99,
      category: "technology",
    });
    assert.equal(capturedCreateCalls.length, 1);
    assert.equal(capturedCreateCalls[0]?.paidDate, undefined, "omitted paidDate must NOT be sent as a field");
    assert.equal(capturedCreateCalls[0]?.description, "Adobe Creative Cloud");
    assert.equal(capturedCreateCalls[0]?.amount, 59.99);
    assert.equal(capturedCreateCalls[0]?.category, "technology");
  });

  test("handler returns structuredContent with the backend payload", async () => {
    const tool = server.tools.get("create_expense");
    assert.ok(tool);
    const result = await tool.handler({
      description: "Adobe Creative Cloud",
      amount: 59.99,
      paidDate: "2026-03-15",
    });
    assert.ok(!("isError" in result && result.isError), "happy path must not be isError");
    const sc = result.structuredContent as Record<string, unknown>;
    assert.equal(sc.id, "exp_abc123");
    assert.equal(sc.paidDate, "2026-03-15");
  });
});
