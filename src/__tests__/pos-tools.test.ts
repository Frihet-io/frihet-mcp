/**
 * Tests for POS MCP tools — Wave 5 (4 tools).
 *
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Run: npm test (after build)
 *
 * Coverage:
 *   1. Tool registration — all 4 tools registered on McpServer
 *   2. list_terminals — success path + structuredContent shape
 *   3. get_sale — success path + structuredContent shape
 *   4. list_sales — success path + structuredContent shape
 *   5. refund_sale — confirm=false blocked, confirm=true succeeds
 *   6. API error path — 404 propagated through handleToolError
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

const MOCK_TERMINAL = {
  id: "term_001",
  label: "Front Desk",
  deviceType: "bbpos_wisepos_e",
  locationId: "loc_tenerife",
  status: "online",
  stripeReaderId: "tmr_xxxx",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const MOCK_TERMINALS_LIST = {
  data: [MOCK_TERMINAL],
  total: 1,
  limit: 20,
  offset: 0,
};

const MOCK_SALE = {
  id: "sale_abc123",
  terminalId: "term_001",
  status: "succeeded",
  amountCents: 4200,
  currency: "EUR",
  paymentMethod: "card_present",
  items: [
    { description: "Menu del dia", quantity: 2, unitPriceCents: 1200 },
    { description: "Agua", quantity: 2, unitPriceCents: 150 },
  ],
  refundedAmountCents: 0,
  createdAt: "2026-05-10T12:30:00Z",
  updatedAt: "2026-05-10T12:30:00Z",
};

const MOCK_SALES_LIST = {
  data: [MOCK_SALE],
  total: 1,
  limit: 20,
  offset: 0,
};

const MOCK_REFUND = {
  id: "ref_xyz789",
  saleId: "sale_abc123",
  status: "succeeded",
  amountCents: 4200,
  currency: "EUR",
  reason: "requested_by_customer",
  createdAt: "2026-05-10T13:00:00Z",
};

function makeSuccessClient(): import("../client-interface.js").IFrihetClient {
  return {
    listTerminals: async () => MOCK_TERMINALS_LIST,
    getSale: async (_id: string) => MOCK_SALE,
    listSales: async () => MOCK_SALES_LIST,
    refundSale: async (_id: string, _data?: { amountCents?: number; reason?: string }) => MOCK_REFUND,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

function make404Client(): import("../client-interface.js").IFrihetClient {
  const notFound = () => {
    const err = Object.assign(new Error("Not Found"), { statusCode: 404, errorCode: "not_found" });
    return Promise.reject(err);
  };
  return {
    listTerminals: notFound,
    getSale: notFound,
    listSales: notFound,
    refundSale: notFound,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

// ── Helper ───────────────────────────────────────────────────────────────────

async function makeServer(
  clientFn: () => import("../client-interface.js").IFrihetClient,
): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  const { registerPosTools } = await import("../tools/pos.js");
  registerPosTools(
    server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    clientFn(),
  );
  return server;
}

// ── Registration tests ───────────────────────────────────────────────────────

describe("POS Tools — Registration", () => {
  let server: StubMcpServer;

  beforeEach(async () => {
    server = await makeServer(makeSuccessClient);
  });

  test("registers exactly 4 POS tools", () => {
    assert.equal(server.tools.size, 4);
  });

  test("registers list_terminals", () => {
    assert.ok(server.tools.has("list_terminals"), "list_terminals not registered");
  });

  test("registers get_sale", () => {
    assert.ok(server.tools.has("get_sale"), "get_sale not registered");
  });

  test("registers list_sales", () => {
    assert.ok(server.tools.has("list_sales"), "list_sales not registered");
  });

  test("registers refund_sale", () => {
    assert.ok(server.tools.has("refund_sale"), "refund_sale not registered");
  });
});

// ── list_terminals ───────────────────────────────────────────────────────────

describe("list_terminals — success path", () => {
  test("returns structuredContent with data array", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_terminals")!;
    const result = await tool.handler({});

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.ok(Array.isArray(sc["data"]));
    assert.equal((sc["data"] as unknown[]).length, 1);
    assert.equal(sc["total"], 1);
  });

  test("first terminal has expected fields", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_terminals")!;
    const result = await tool.handler({});

    const first = (result.structuredContent!["data"] as Record<string, unknown>[])[0]!;
    assert.equal(first["id"], "term_001");
    assert.equal(first["label"], "Front Desk");
    assert.equal(first["status"], "online");
    assert.equal(first["deviceType"], "bbpos_wisepos_e");
  });

  test("content block has type text", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_terminals")!;
    const result = await tool.handler({});

    assert.equal(result.content[0]!.type, "text");
    assert.ok(result.content[0]!.text.includes("terminals"));
  });
});

// ── get_sale ─────────────────────────────────────────────────────────────────

describe("get_sale — success path", () => {
  test("returns sale by ID", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_sale")!;
    const result = await tool.handler({ id: "sale_abc123" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["id"], "sale_abc123");
    assert.equal(sc["status"], "succeeded");
    assert.equal(sc["amountCents"], 4200);
    assert.equal(sc["currency"], "EUR");
  });

  test("items array present", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_sale")!;
    const result = await tool.handler({ id: "sale_abc123" });

    const sc = result.structuredContent!;
    assert.ok(Array.isArray(sc["items"]));
    assert.equal((sc["items"] as unknown[]).length, 2);
  });

  test("404 error propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("get_sale")!;
    const result = await tool.handler({ id: "sale_missing" });

    assert.ok(result.isError, "should be an error on 404");
    assert.ok(result.content[0]!.text.includes("Error:"));
  });
});

// ── list_sales ───────────────────────────────────────────────────────────────

describe("list_sales — success path", () => {
  test("returns sales list with total", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_sales")!;
    const result = await tool.handler({});

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.ok(Array.isArray(sc["data"]));
    assert.equal(sc["total"], 1);
  });

  test("filters accepted without error", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_sales")!;
    const result = await tool.handler({
      terminalId: "term_001",
      status: "succeeded",
      from: "2026-05-01",
      to: "2026-05-31",
      limit: 10,
      offset: 0,
    });
    assert.ok(!result.isError);
  });
});

// ── refund_sale ──────────────────────────────────────────────────────────────

describe("refund_sale — Trust Area confirmation gate", () => {
  test("confirm=false returns isError=true without calling API", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("refund_sale")!;
    const result = await tool.handler({ id: "sale_abc123", confirm: false });

    assert.ok(result.isError, "should be an error when confirm=false");
    assert.ok(
      result.content[0]!.text.includes("confirm=true"),
      "error message should mention confirm=true requirement",
    );
  });

  test("confirm=true proceeds and returns refund data", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("refund_sale")!;
    const result = await tool.handler({
      id: "sale_abc123",
      confirm: true,
      reason: "requested_by_customer",
    });

    assert.ok(!result.isError, "should succeed with confirm=true");
    const sc = result.structuredContent!;
    assert.equal(sc["saleId"], "sale_abc123");
    assert.equal(sc["status"], "succeeded");
    assert.equal(sc["amountCents"], 4200);
  });

  test("partial refund with amountCents", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("refund_sale")!;
    const result = await tool.handler({
      id: "sale_abc123",
      confirm: true,
      amountCents: 1200,
      reason: "duplicate",
    });
    assert.ok(!result.isError, "partial refund should succeed");
  });

  test("404 on refund propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("refund_sale")!;
    const result = await tool.handler({ id: "sale_gone", confirm: true });
    assert.ok(result.isError, "should be an error on 404");
  });
});
