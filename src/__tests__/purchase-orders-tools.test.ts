/**
 * Tests for Purchase-Order MCP tools — ADR 0027 S2 (read-only surface).
 *
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Run: npm test (after build).
 *
 * Scope (this file): list_purchase_orders + get_purchase_order. The WRITE
 * surface (create draft, send, confirm, cancel, receive, reverse-receipt,
 * bill) is intentionally NOT exposed by the MCP server — see
 * docs/proposals/purchase-orders-write-tools.md.
 *
 * Coverage:
 *   1. Tool registration — both tools registered on McpServer
 *   2. list_purchase_orders — success path + structuredContent shape
 *   3. get_purchase_order — success path + structuredContent shape
 *   4. list_purchase_orders — filter by status / vendorId is forwarded
 *   5. 404 propagates as isError
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

// ── Client stubs ─────────────────────────────────────────────────────────────

// Mirrors the documented live API response: id, poNumber, vendorId, vendorName,
// status, items, totals, dates, currency. Stays inside the live family shape so
// the output schema is exercised end-to-end.
const MOCK_PO = {
  id: "po_abc123",
  poNumber: "PO-2026-0042",
  vendorId: "ven_001",
  vendorName: "Proveedor Cloud SL",
  status: "confirmed",
  items: [
    { description: "Hosting VPS 4 vCPU", quantity: 12, unitPrice: 45, productId: "prod_001" },
  ],
  issueDate: "2026-09-01",
  expectedDate: "2026-10-01",
  taxRate: 21,
  subtotal: 540,
  tax: 113.4,
  total: 653.4,
  currency: "EUR",
  notes: "Renovacion anual",
  createdAt: "2026-09-01T09:00:00Z",
  updatedAt: "2026-09-15T11:00:00Z",
};

const MOCK_PO_LIST = {
  data: [MOCK_PO, { ...MOCK_PO, id: "po_def456", status: "draft" }],
  total: 2,
  limit: 20,
  offset: 0,
};

function makeSuccessClient(): import("../client-interface.js").IFrihetClient {
  const calls: Array<{ method: string; args?: unknown }> = [];
  return {
    listPurchaseOrders: async (params?: { status?: string; vendorId?: string; limit?: number; offset?: number }) => {
      calls.push({ method: "listPurchaseOrders", args: params });
      return MOCK_PO_LIST;
    },
    getPurchaseOrder: async (id: string) => {
      calls.push({ method: "getPurchaseOrder", args: { id } });
      return { ...MOCK_PO, id };
    },
    _calls: calls,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

function make404Client(): import("../client-interface.js").IFrihetClient {
  const notFound = () => {
    const err = Object.assign(new Error("Not Found"), { statusCode: 404, errorCode: "not_found" });
    return Promise.reject(err);
  };
  return {
    listPurchaseOrders: notFound,
    getPurchaseOrder: notFound,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

// ── Helper ───────────────────────────────────────────────────────────────────

async function makeServer(
  clientFn: () => import("../client-interface.js").IFrihetClient,
): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  const { registerPurchaseOrderTools } = await import("../tools/purchaseOrders.js");
  registerPurchaseOrderTools(
    server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    clientFn(),
  );
  return server;
}

// ── Registration tests ───────────────────────────────────────────────────────

describe("PurchaseOrder Tools — Registration", () => {
  let server: StubMcpServer;

  beforeEach(async () => {
    server = await makeServer(makeSuccessClient);
  });

  test("registers exactly 2 purchase-order tools", () => {
    assert.equal(server.tools.size, 2, `expected 2 tools, got ${server.tools.size}`);
  });

  test("registers list_purchase_orders", () => {
    assert.ok(server.tools.has("list_purchase_orders"), "list_purchase_orders not registered");
  });

  test("registers get_purchase_order", () => {
    assert.ok(server.tools.has("get_purchase_order"), "get_purchase_order not registered");
  });

  test("both tools carry READ_ONLY_ANNOTATIONS", () => {
    for (const name of ["list_purchase_orders", "get_purchase_order"]) {
      const tool = server.tools.get(name)!;
      assert.equal(tool.config.annotations?.readOnlyHint, true, `${name} must be read-only`);
      assert.equal(tool.config.annotations?.destructiveHint, false, `${name} must not be destructive`);
      assert.equal(tool.config.annotations?.idempotentHint, true, `${name} must be idempotent`);
    }
  });
});

// ── list_purchase_orders ─────────────────────────────────────────────────────

describe("list_purchase_orders — success path", () => {
  test("returns structuredContent with data array", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_purchase_orders")!;
    const result = await tool.handler({});

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.ok(Array.isArray(sc["data"]));
    assert.equal((sc["data"] as unknown[]).length, 2);
    assert.equal(sc["total"], 2);
  });

  test("first PO has expected lifecycle fields", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_purchase_orders")!;
    const result = await tool.handler({});

    const first = (result.structuredContent!["data"] as Record<string, unknown>[])[0]!;
    assert.equal(first["id"], "po_abc123");
    assert.equal(first["poNumber"], "PO-2026-0042");
    assert.equal(first["vendorId"], "ven_001");
    assert.equal(first["status"], "confirmed");
    assert.equal(first["currency"], "EUR");
    assert.equal(first["total"], 653.4);
  });

  test("items array present with description / quantity / unitPrice", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_purchase_orders")!;
    const result = await tool.handler({});

    const first = (result.structuredContent!["data"] as Record<string, unknown>[])[0]!;
    const items = first["items"] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(items));
    assert.equal(items.length, 1);
    assert.equal(items[0]!["description"], "Hosting VPS 4 vCPU");
    assert.equal(items[0]!["quantity"], 12);
    assert.equal(items[0]!["unitPrice"], 45);
  });

  test("content block has type text and mentions purchase_orders", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_purchase_orders")!;
    const result = await tool.handler({});

    assert.equal(result.content[0]!.type, "text");
    assert.ok(
      result.content[0]!.text.toLowerCase().includes("purchase"),
      `expected 'purchase' in content text, got: ${result.content[0]!.text.slice(0, 120)}`,
    );
  });

  test("forwards status and vendorId filters to the client", async () => {
    const client = makeSuccessClient();
    const server = await makeServer(() => client);
    const tool = server.tools.get("list_purchase_orders")!;
    await tool.handler({ status: "sent", vendorId: "ven_001", limit: 5, offset: 10 });

    const calls = (client as unknown as { _calls: Array<{ method: string; args?: unknown }> })._calls;
    const call = calls.find((c) => c.method === "listPurchaseOrders");
    assert.ok(call, "listPurchaseOrders was not called");
    const args = call!.args as Record<string, unknown>;
    assert.equal(args["status"], "sent");
    assert.equal(args["vendorId"], "ven_001");
    assert.equal(args["limit"], 5);
    assert.equal(args["offset"], 10);
  });

  test("404 propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("list_purchase_orders")!;
    const result = await tool.handler({});

    assert.ok(result.isError, "should be an error on 404");
    assert.ok(result.content[0]!.text.includes("Error:"));
  });
});

// ── get_purchase_order ───────────────────────────────────────────────────────

describe("get_purchase_order — success path", () => {
  test("returns a single PO by ID", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_purchase_order")!;
    const result = await tool.handler({ id: "po_abc123" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["id"], "po_abc123");
    assert.equal(sc["status"], "confirmed");
    assert.equal(sc["total"], 653.4);
    assert.equal(sc["currency"], "EUR");
  });

  test("items array present on the single read", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_purchase_order")!;
    const result = await tool.handler({ id: "po_abc123" });

    const sc = result.structuredContent!;
    assert.ok(Array.isArray(sc["items"]));
    assert.equal((sc["items"] as unknown[]).length, 1);
  });

  test("forwards id to the client verbatim", async () => {
    const client = makeSuccessClient();
    const server = await makeServer(() => client);
    const tool = server.tools.get("get_purchase_order")!;
    await tool.handler({ id: "po_xyz789" });

    const calls = (client as unknown as { _calls: Array<{ method: string; args?: unknown }> })._calls;
    const call = calls.find((c) => c.method === "getPurchaseOrder");
    assert.ok(call, "getPurchaseOrder was not called");
    assert.equal((call!.args as { id: string }).id, "po_xyz789");
  });

  test("404 propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("get_purchase_order")!;
    const result = await tool.handler({ id: "po_missing" });

    assert.ok(result.isError, "should be an error on 404");
    assert.ok(result.content[0]!.text.includes("Error:"));
  });
});
