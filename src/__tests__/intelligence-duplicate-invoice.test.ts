/**
 * Regression test for duplicate_invoice (intelligence.ts).
 *
 * Bug: duplicate_invoice fetched the FULL raw stored invoice (getInvoice returns
 * the entire Firestore doc) and spread it into createInvoice, only blacklisting
 * 6 fields. The create endpoint validates against a Zod `.strict()` schema that
 * REJECTS unknown keys → HTTP 400, so any paid/sent/cancelled/e-invoiced invoice
 * failed to duplicate. Fix: allowlist-PICK only the writable create fields.
 *
 * This test asserts the body sent to createInvoice contains ONLY allowlisted
 * fields (no payments/verifactu/operationType/documentNumber/total/…).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

interface ToolConfig {
  title: string;
  description: string;
  annotations?: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputSchema?: unknown;
}
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

class StubMcpServer {
  tools: Map<string, { name: string; config: ToolConfig; handler: ToolHandler }> = new Map();
  registerTool(name: string, config: ToolConfig, handler: ToolHandler): void {
    this.tools.set(name, { name, config, handler });
  }
}

// A realistic FULL stored invoice doc as getInvoice returns it: writable fields
// PLUS many stored-only fields the strict create schema rejects.
const STORED_INVOICE = {
  id: "inv_123",
  documentNumber: "2026-0042",
  status: "paid",
  total: 1210,
  createdAt: "2026-05-01T10:00:00Z",
  updatedAt: "2026-05-02T10:00:00Z",
  // ── writable (must be copied) ──
  clientName: "Acme Corp",
  clientId: "cli_9",
  clientAddress: "Gran Via 1, Madrid",
  clientTaxId: "B12345678",
  items: [{ description: "Consulting", quantity: 10, unitPrice: 100 }],
  dueDate: "2026-06-01",
  notes: "Thanks",
  taxRate: 21,
  irpfRate: 15,
  equivalenceSurchargeRate: 0,
  clientLocation: "peninsula",
  prepayment: 0,
  seriesId: "A",
  // ── stored-only (must NOT be copied — would 400 the strict create schema) ──
  payments: [{ amount: 1210, date: "2026-05-10" }],
  amountPaid: 1210,
  verifactu: { hash: "abc", chained: true },
  eInvoice: { format: "facturae" },
  operationType: "S1",
  poNumber: "PO-77",
  discountRate: 5,
  createdBy: "user_x",
  sentTo: "billing@acme.com",
  sentAt: "2026-05-02T10:00:00Z",
  cancelledAt: null,
  attachments: ["a.pdf"],
} as const;

const REJECTED_FIELDS = [
  "payments", "amountPaid", "verifactu", "eInvoice", "operationType",
  "poNumber", "discountRate", "createdBy", "sentTo", "sentAt",
  "cancelledAt", "attachments", "documentNumber", "total", "createdAt", "updatedAt", "id",
];
const COPYABLE_FIELDS = [
  "clientName", "clientId", "clientAddress", "clientTaxId", "items",
  "notes", "taxRate", "irpfRate", "equivalenceSurchargeRate",
  "clientLocation", "prepayment", "seriesId",
];

async function makeServerCapturing(captured: { body?: Record<string, unknown> }): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  const client = {
    getInvoice: async (_id: string) => ({ ...STORED_INVOICE }),
    createInvoice: async (data: Record<string, unknown>) => {
      captured.body = data;
      return { id: "inv_dup", status: "draft", ...data };
    },
  } as unknown as import("../client-interface.js").IFrihetClient;

  const { registerIntelligenceTools } = await import("../tools/intelligence.js");
  registerIntelligenceTools(
    server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    client,
  );
  return server;
}

describe("duplicate_invoice — allowlist pick", () => {
  test("sends ONLY writable fields to createInvoice (no strict-schema rejects)", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    const server = await makeServerCapturing(captured);
    const tool = server.tools.get("duplicate_invoice");
    assert.ok(tool, "duplicate_invoice should be registered");

    const result = await tool.handler({ id: "inv_123" });
    assert.notEqual(result.isError, true, "duplicate should not error");
    assert.ok(captured.body, "createInvoice should have been called");

    for (const f of REJECTED_FIELDS) {
      assert.equal(f in captured.body!, false, `create body must NOT carry stored-only field "${f}"`);
    }
    for (const f of COPYABLE_FIELDS) {
      assert.equal(f in captured.body!, true, `create body must carry writable field "${f}"`);
    }
    assert.equal(captured.body!.status, "draft", "status forced to draft");
    assert.equal(typeof captured.body!.issueDate, "string", "issueDate set");
  });

  test("honors newIssueDate + newDueDate overrides", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    const server = await makeServerCapturing(captured);
    const tool = server.tools.get("duplicate_invoice")!;

    await tool.handler({ id: "inv_123", newIssueDate: "2026-07-01", newDueDate: "2026-08-01" });
    assert.equal(captured.body!.issueDate, "2026-07-01");
    assert.equal(captured.body!.dueDate, "2026-08-01");
  });
});
