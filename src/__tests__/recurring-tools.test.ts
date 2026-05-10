/**
 * Tests for Recurring Invoice MCP tools — Wave Mature 3 (8 tools: 2 original + 6 new).
 *
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Run: npm test (after build)
 *
 * Coverage:
 *   1.  Tool registration — all 8 recurring tools registered
 *   2.  list_recurring_invoices — success path + structuredContent shape
 *   3.  list_recurring_invoices — status filter accepted
 *   4.  get_recurring_invoice — success path
 *   5.  create_recurring_invoice — success path
 *   6.  update_recurring_invoice — success path + partial update
 *   7.  pause_recurring_invoice — success path
 *   8.  resume_recurring_invoice — success path
 *   9.  delete_recurring_invoice — confirm=false gate
 *   10. delete_recurring_invoice — confirm=true success path
 *   11. run_recurring_now — success path (default draftOnly=true)
 *   12. run_recurring_now — draftOnly=false passes through
 *   13. API error — 404 propagated as isError=true
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Minimal McpServer stub ───────────────────────────────────────────────────

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

// ── Mock data ────────────────────────────────────────────────────────────────

const MOCK_RECURRING_INVOICE = {
  id: "rec_abc123",
  templateName: "Factura mensual Acme",
  frequency: "monthly",
  nextRun: "2026-06-01",
  recipient: "billing@acme.com",
  lineItems: [
    { description: "Servicio SaaS", quantity: 1, unitPrice: 299.0 },
  ],
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
};

const MOCK_RECURRING_LIST = {
  data: [MOCK_RECURRING_INVOICE],
  total: 1,
  limit: 20,
  offset: 0,
};

const MOCK_RUN_RESULT = {
  success: true,
  id: "inv_new_001",
  message: "Invoice draft created from template rec_abc123",
};

const MOCK_ACTION = {
  success: true,
  id: "rec_abc123",
  message: "Operation completed",
};

// ── Client stubs ─────────────────────────────────────────────────────────────

function makeSuccessClient(): import("../client-interface.js").IFrihetClient {
  return {
    listRecurringInvoices: async () => MOCK_RECURRING_LIST,
    getRecurringInvoice: async (_id: string) => MOCK_RECURRING_INVOICE,
    createRecurringInvoice: async (_data: Record<string, unknown>) => MOCK_RECURRING_INVOICE,
    updateRecurringInvoice: async (_id: string, data: Record<string, unknown>) => ({ ...MOCK_RECURRING_INVOICE, ...data }),
    pauseRecurringInvoice: async (_id: string) => ({ ...MOCK_ACTION, message: "Template paused" }),
    resumeRecurringInvoice: async (_id: string) => ({ ...MOCK_ACTION, message: "Template resumed" }),
    deleteRecurringInvoice: async (_id: string) => undefined,
    runRecurringNow: async (_templateId: string, _options?: Record<string, unknown>) => MOCK_RUN_RESULT,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

function make404Client(): import("../client-interface.js").IFrihetClient {
  const notFound = () => {
    const err = Object.assign(new Error("Not Found"), { statusCode: 404, errorCode: "not_found" });
    return Promise.reject(err);
  };
  return {
    listRecurringInvoices: notFound,
    getRecurringInvoice: notFound,
    createRecurringInvoice: notFound,
    updateRecurringInvoice: notFound,
    pauseRecurringInvoice: notFound,
    resumeRecurringInvoice: notFound,
    deleteRecurringInvoice: notFound,
    runRecurringNow: notFound,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

// ── Helper ───────────────────────────────────────────────────────────────────

async function makeServer(
  clientFn: () => import("../client-interface.js").IFrihetClient,
): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  const { registerRecurringTools } = await import("../tools/recurring.js");
  registerRecurringTools(
    server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    clientFn(),
  );
  return server;
}

// ── Registration tests ───────────────────────────────────────────────────────

describe("Recurring Tools — Registration", () => {
  let server: StubMcpServer;

  beforeEach(async () => {
    server = await makeServer(makeSuccessClient);
  });

  test("registers exactly 8 recurring tools", () => {
    assert.equal(server.tools.size, 8);
  });

  test("registers list_recurring_invoices", () => {
    assert.ok(server.tools.has("list_recurring_invoices"));
  });

  test("registers get_recurring_invoice", () => {
    assert.ok(server.tools.has("get_recurring_invoice"));
  });

  test("registers create_recurring_invoice", () => {
    assert.ok(server.tools.has("create_recurring_invoice"));
  });

  test("registers update_recurring_invoice", () => {
    assert.ok(server.tools.has("update_recurring_invoice"));
  });

  test("registers pause_recurring_invoice", () => {
    assert.ok(server.tools.has("pause_recurring_invoice"));
  });

  test("registers resume_recurring_invoice", () => {
    assert.ok(server.tools.has("resume_recurring_invoice"));
  });

  test("registers delete_recurring_invoice", () => {
    assert.ok(server.tools.has("delete_recurring_invoice"));
  });

  test("registers run_recurring_now", () => {
    assert.ok(server.tools.has("run_recurring_now"));
  });
});

// ── list_recurring_invoices ──────────────────────────────────────────────────

describe("list_recurring_invoices — success path", () => {
  test("returns structuredContent with data array", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_recurring_invoices")!;
    const result = await tool.handler({});

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.ok(Array.isArray(sc["data"]));
    assert.equal(sc["total"], 1);
  });

  test("first template has expected fields", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_recurring_invoices")!;
    const result = await tool.handler({});

    const first = (result.structuredContent!["data"] as Record<string, unknown>[])[0]!;
    assert.equal(first["id"], "rec_abc123");
    assert.equal(first["templateName"], "Factura mensual Acme");
    assert.equal(first["frequency"], "monthly");
    assert.equal(first["status"], "active");
    assert.equal(first["nextRun"], "2026-06-01");
  });

  test("content block has type text and mentions recurring_invoices", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_recurring_invoices")!;
    const result = await tool.handler({});
    assert.equal(result.content[0]!.type, "text");
    assert.ok(result.content[0]!.text.includes("recurring_invoices"));
  });

  test("status=active filter accepted without error", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_recurring_invoices")!;
    const result = await tool.handler({ status: "active" });
    assert.ok(!result.isError);
  });

  test("status=paused filter accepted without error", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_recurring_invoices")!;
    const result = await tool.handler({ status: "paused" });
    assert.ok(!result.isError);
  });

  test("404 propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("list_recurring_invoices")!;
    const result = await tool.handler({});
    assert.ok(result.isError);
  });
});

// ── get_recurring_invoice ────────────────────────────────────────────────────

describe("get_recurring_invoice — success path", () => {
  test("returns template with expected fields", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_recurring_invoice")!;
    const result = await tool.handler({ id: "rec_abc123" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["id"], "rec_abc123");
    assert.equal(sc["frequency"], "monthly");
    assert.equal(sc["status"], "active");
  });

  test("content block has type text", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_recurring_invoice")!;
    const result = await tool.handler({ id: "rec_abc123" });
    assert.equal(result.content[0]!.type, "text");
  });

  test("404 propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("get_recurring_invoice")!;
    const result = await tool.handler({ id: "rec_missing" });
    assert.ok(result.isError);
  });
});

// ── create_recurring_invoice ─────────────────────────────────────────────────

describe("create_recurring_invoice — success path", () => {
  test("returns created template with expected fields", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("create_recurring_invoice")!;
    const result = await tool.handler({
      templateName: "Factura mensual Acme",
      clientId: "cli_acme",
      frequency: "monthly",
      lineItems: [{ description: "Servicio SaaS", quantity: 1, unitPrice: 299.0 }],
    });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["id"], "rec_abc123");
    assert.equal(sc["frequency"], "monthly");
  });

  test("content block mentions created", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("create_recurring_invoice")!;
    const result = await tool.handler({
      templateName: "Test",
      clientId: "cli_test",
      frequency: "weekly",
      lineItems: [],
    });
    assert.ok(result.content[0]!.text.includes("created"));
  });

  test("404 propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("create_recurring_invoice")!;
    const result = await tool.handler({ templateName: "T", clientId: "c", frequency: "monthly", lineItems: [] });
    assert.ok(result.isError);
  });
});

// ── update_recurring_invoice ─────────────────────────────────────────────────

describe("update_recurring_invoice — success path", () => {
  test("returns updated template", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("update_recurring_invoice")!;
    const result = await tool.handler({ id: "rec_abc123", templateName: "Factura mensual Acme v2" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["templateName"], "Factura mensual Acme v2");
  });

  test("content block mentions updated", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("update_recurring_invoice")!;
    const result = await tool.handler({ id: "rec_abc123", frequency: "quarterly" });
    assert.ok(result.content[0]!.text.includes("updated"));
  });
});

// ── pause_recurring_invoice ──────────────────────────────────────────────────

describe("pause_recurring_invoice — success path", () => {
  test("returns action result with success=true", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("pause_recurring_invoice")!;
    const result = await tool.handler({ id: "rec_abc123" });

    assert.ok(!result.isError);
    assert.equal(result.structuredContent!["success"], true);
  });

  test("content block mentions paused", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("pause_recurring_invoice")!;
    const result = await tool.handler({ id: "rec_abc123" });
    assert.ok(result.content[0]!.text.includes("paused"));
  });

  test("404 propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("pause_recurring_invoice")!;
    const result = await tool.handler({ id: "rec_missing" });
    assert.ok(result.isError);
  });
});

// ── resume_recurring_invoice ─────────────────────────────────────────────────

describe("resume_recurring_invoice — success path", () => {
  test("returns action result with success=true", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("resume_recurring_invoice")!;
    const result = await tool.handler({ id: "rec_abc123" });

    assert.ok(!result.isError);
    assert.equal(result.structuredContent!["success"], true);
  });

  test("content block mentions resumed", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("resume_recurring_invoice")!;
    const result = await tool.handler({ id: "rec_abc123" });
    assert.ok(result.content[0]!.text.includes("resumed"));
  });

  test("404 propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("resume_recurring_invoice")!;
    const result = await tool.handler({ id: "rec_missing" });
    assert.ok(result.isError);
  });
});

// ── delete_recurring_invoice ─────────────────────────────────────────────────

describe("delete_recurring_invoice — trust area gate", () => {
  test("confirm=false returns isError=true without calling API", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("delete_recurring_invoice")!;
    const result = await tool.handler({ id: "rec_abc123", confirm: false });

    assert.ok(result.isError);
    assert.ok(result.content[0]!.text.includes("confirm=true"));
  });

  test("confirm=true succeeds and returns success=true", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("delete_recurring_invoice")!;
    const result = await tool.handler({ id: "rec_abc123", confirm: true });

    assert.ok(!result.isError);
    assert.equal(result.structuredContent!["success"], true);
    assert.equal(result.structuredContent!["id"], "rec_abc123");
  });

  test("confirm=true with 404 propagates isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("delete_recurring_invoice")!;
    const result = await tool.handler({ id: "rec_missing", confirm: true });
    assert.ok(result.isError);
  });
});

// ── run_recurring_now ────────────────────────────────────────────────────────

describe("run_recurring_now — success path", () => {
  test("returns action result with success=true and new invoice ID", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("run_recurring_now")!;
    const result = await tool.handler({ templateId: "rec_abc123" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["success"], true);
    assert.equal(sc["id"], "inv_new_001");
    assert.ok(typeof sc["message"] === "string");
  });

  test("draftOnly=false accepted without error", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("run_recurring_now")!;
    const result = await tool.handler({ templateId: "rec_abc123", draftOnly: false });
    assert.ok(!result.isError);
  });

  test("content block mentions triggered", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("run_recurring_now")!;
    const result = await tool.handler({ templateId: "rec_abc123" });
    assert.ok(result.content[0]!.text.includes("triggered"));
  });

  test("404 propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("run_recurring_now")!;
    const result = await tool.handler({ templateId: "rec_missing" });
    assert.ok(result.isError);
  });
});
