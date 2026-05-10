/**
 * Tests for Recurring Invoice MCP tools — Wave 6 (2 tools).
 *
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Run: npm test (after build)
 *
 * Coverage:
 *   1. Tool registration — both recurring tools registered
 *   2. list_recurring_invoices — success path + structuredContent shape
 *   3. list_recurring_invoices — status filter accepted
 *   4. run_recurring_now — success path (default draftOnly=true)
 *   5. run_recurring_now — draftOnly=false passes through
 *   6. API error — 404 propagated as isError=true
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

// ── Client stubs ─────────────────────────────────────────────────────────────

function makeSuccessClient(): import("../client-interface.js").IFrihetClient {
  return {
    listRecurringInvoices: async () => MOCK_RECURRING_LIST,
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

  test("registers exactly 2 recurring tools", () => {
    assert.equal(server.tools.size, 2);
  });

  test("registers list_recurring_invoices", () => {
    assert.ok(server.tools.has("list_recurring_invoices"));
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
