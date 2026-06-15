/**
 * Tests for Kitchen MCP tools — Wave 6 (6 tools).
 *
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Run: npm test (after build)
 *
 * Coverage:
 *   1. Tool registration — all 6 tools registered on McpServer
 *   2. list_kitchen_tickets — success path + structuredContent shape
 *   3. get_kitchen_ticket — success path + structuredContent shape
 *   4. update_kitchen_ticket — success path + structuredContent shape
 *   5. list_kitchen_stations — success path + structuredContent shape
 *   6. list_menu_items — success path + structuredContent shape
 *   7. kitchen_flow_summary — success path + bottleneck detection
 *   8. API error path — 404 propagated through handleToolError
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

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_TICKET = {
  id: "tkt_001",
  stationId: "sta_grill",
  status: "preparing",
  tableRef: "T4",
  items: [
    { id: "ti_001", menuItemId: "mi_burger", name: "Burger", quantity: 2, notes: "no onions", status: "preparing" },
  ],
  createdAt: "2026-06-15T12:00:00Z",
  updatedAt: "2026-06-15T12:01:00Z",
};

const MOCK_TICKET_2 = {
  id: "tkt_002",
  stationId: "sta_grill",
  status: "queued",
  tableRef: "T5",
  items: [
    { id: "ti_002", menuItemId: "mi_fries", name: "Fries", quantity: 1, notes: "", status: "queued" },
  ],
  createdAt: "2026-06-15T12:02:00Z",
  updatedAt: "2026-06-15T12:02:00Z",
};

const MOCK_TICKET_3 = {
  id: "tkt_003",
  stationId: "sta_bar",
  status: "ready",
  tableRef: "T2",
  items: [
    { id: "ti_003", menuItemId: "mi_mojito", name: "Mojito", quantity: 3, notes: "", status: "ready" },
  ],
  createdAt: "2026-06-15T12:05:00Z",
  updatedAt: "2026-06-15T12:06:00Z",
};

const MOCK_TICKETS_LIST = {
  data: [MOCK_TICKET, MOCK_TICKET_2, MOCK_TICKET_3],
  total: 3,
  limit: 100,
  offset: 0,
};

const MOCK_STATION = {
  id: "sta_grill",
  name: "Grill",
  isActive: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const MOCK_STATION_2 = {
  id: "sta_bar",
  name: "Bar",
  isActive: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const MOCK_STATIONS_LIST = {
  data: [MOCK_STATION, MOCK_STATION_2],
  total: 2,
  limit: 100,
  offset: 0,
};

const MOCK_MENU_ITEM = {
  id: "mi_burger",
  name: "Burger",
  description: "Classic beef burger",
  priceCents: 1200,
  category: "Main",
  isActive: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const MOCK_MENU_ITEMS_LIST = {
  data: [MOCK_MENU_ITEM],
  total: 1,
  limit: 20,
  offset: 0,
};

const MOCK_UPDATED_TICKET = { ...MOCK_TICKET, status: "ready" };

// ── Client stubs ─────────────────────────────────────────────────────────────

function makeSuccessClient(): import("../client-interface.js").IFrihetClient {
  return {
    listKitchenTickets: async () => MOCK_TICKETS_LIST,
    getKitchenTicket: async (_id: string) => MOCK_TICKET,
    updateKitchenTicket: async (_id: string, _data: Record<string, unknown>) => MOCK_UPDATED_TICKET,
    listKitchenStations: async () => MOCK_STATIONS_LIST,
    listMenuItems: async () => MOCK_MENU_ITEMS_LIST,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

function make404Client(): import("../client-interface.js").IFrihetClient {
  const notFound = () => {
    const err = Object.assign(new Error("Not Found"), { statusCode: 404, errorCode: "not_found" });
    return Promise.reject(err);
  };
  return {
    listKitchenTickets: notFound,
    getKitchenTicket: notFound,
    updateKitchenTicket: notFound,
    listKitchenStations: notFound,
    listMenuItems: notFound,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

// ── Helper ───────────────────────────────────────────────────────────────────

async function makeServer(
  clientFn: () => import("../client-interface.js").IFrihetClient,
): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  const { registerKitchenTools } = await import("../tools/kitchen.js");
  registerKitchenTools(
    server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    clientFn(),
  );
  return server;
}

// ── Registration tests ───────────────────────────────────────────────────────

describe("Kitchen Tools — Registration", () => {
  let server: StubMcpServer;

  beforeEach(async () => {
    server = await makeServer(makeSuccessClient);
  });

  test("registers exactly 6 kitchen tools", () => {
    assert.equal(server.tools.size, 6);
  });

  test("registers list_kitchen_tickets", () => {
    assert.ok(server.tools.has("list_kitchen_tickets"), "list_kitchen_tickets not registered");
  });

  test("registers get_kitchen_ticket", () => {
    assert.ok(server.tools.has("get_kitchen_ticket"), "get_kitchen_ticket not registered");
  });

  test("registers update_kitchen_ticket", () => {
    assert.ok(server.tools.has("update_kitchen_ticket"), "update_kitchen_ticket not registered");
  });

  test("registers list_kitchen_stations", () => {
    assert.ok(server.tools.has("list_kitchen_stations"), "list_kitchen_stations not registered");
  });

  test("registers list_menu_items", () => {
    assert.ok(server.tools.has("list_menu_items"), "list_menu_items not registered");
  });

  test("registers kitchen_flow_summary", () => {
    assert.ok(server.tools.has("kitchen_flow_summary"), "kitchen_flow_summary not registered");
  });
});

// ── Output schemas ────────────────────────────────────────────────────────────

describe("Kitchen Tools — Output schemas", () => {
  test("all tools have an outputSchema", async () => {
    const server = await makeServer(makeSuccessClient);
    const expected = [
      "list_kitchen_tickets",
      "get_kitchen_ticket",
      "update_kitchen_ticket",
      "list_kitchen_stations",
      "list_menu_items",
      "kitchen_flow_summary",
    ];
    for (const name of expected) {
      const tool = server.tools.get(name)!;
      assert.ok(tool.config.outputSchema, `${name} must have outputSchema`);
    }
  });
});

// ── list_kitchen_tickets ──────────────────────────────────────────────────────

describe("list_kitchen_tickets — success path", () => {
  test("returns structuredContent with data array", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_kitchen_tickets")!;
    const result = await tool.handler({ limit: 100, offset: 0 });

    assert.ok(!result.isError, "should not be an error");
    assert.ok(result.structuredContent, "structuredContent missing");
    const sc = result.structuredContent!;
    assert.ok(Array.isArray(sc["data"]), "data should be an array");
    assert.equal((sc["data"] as unknown[]).length, 3);
    assert.equal(sc["total"], 3);
  });

  test("first ticket has expected fields", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_kitchen_tickets")!;
    const result = await tool.handler({});

    const sc = result.structuredContent!;
    const first = (sc["data"] as Record<string, unknown>[])[0]!;
    assert.equal(first["id"], "tkt_001");
    assert.equal(first["status"], "preparing");
    assert.equal(first["stationId"], "sta_grill");
    assert.equal(first["tableRef"], "T4");
  });

  test("content block has type text and mentions tickets", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_kitchen_tickets")!;
    const result = await tool.handler({});

    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0]!.type, "text");
    assert.ok(result.content[0]!.text.includes("kitchen tickets"));
  });

  test("404 error propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("list_kitchen_tickets")!;
    const result = await tool.handler({});
    assert.ok(result.isError, "should be an error on 404");
    assert.ok(result.content[0]!.text.includes("Error:"));
  });
});

// ── get_kitchen_ticket ────────────────────────────────────────────────────────

describe("get_kitchen_ticket — success path", () => {
  test("returns single ticket by ID", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_kitchen_ticket")!;
    const result = await tool.handler({ id: "tkt_001" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["id"], "tkt_001");
    assert.equal(sc["status"], "preparing");
    assert.equal(sc["stationId"], "sta_grill");
  });

  test("404 error propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("get_kitchen_ticket")!;
    const result = await tool.handler({ id: "tkt_missing" });

    assert.ok(result.isError, "should be an error on 404");
    assert.ok(result.content[0]!.text.includes("Error:"));
  });
});

// ── update_kitchen_ticket ─────────────────────────────────────────────────────

describe("update_kitchen_ticket — success path", () => {
  test("returns updated ticket with new status", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("update_kitchen_ticket")!;
    const result = await tool.handler({ id: "tkt_001", status: "ready" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["id"], "tkt_001");
    assert.equal(sc["status"], "ready");
  });

  test("content block is a mutate-type annotated text", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("update_kitchen_ticket")!;
    const result = await tool.handler({ id: "tkt_001", status: "ready" });

    assert.equal(result.content[0]!.type, "text");
    assert.ok(result.content[0]!.text.includes("Kitchen ticket updated"));
  });

  test("calls client.updateKitchenTicket with correct args", async () => {
    let calledId: string | undefined;
    let calledData: Record<string, unknown> | undefined;
    const client = {
      updateKitchenTicket: async (id: string, data: Record<string, unknown>) => {
        calledId = id;
        calledData = data;
        return MOCK_UPDATED_TICKET;
      },
    } as unknown as import("../client-interface.js").IFrihetClient;

    const server = new StubMcpServer();
    const { registerKitchenTools } = await import("../tools/kitchen.js");
    registerKitchenTools(
      server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      client,
    );

    await server.tools.get("update_kitchen_ticket")!.handler({ id: "tkt_001", status: "ready", stationId: "sta_bar" });
    assert.equal(calledId, "tkt_001");
    assert.equal(calledData?.["status"], "ready");
    assert.equal(calledData?.["stationId"], "sta_bar");
  });
});

// ── list_kitchen_stations ─────────────────────────────────────────────────────

describe("list_kitchen_stations — success path", () => {
  test("returns stations list with total", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_kitchen_stations")!;
    const result = await tool.handler({});

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.ok(Array.isArray(sc["data"]));
    assert.equal(sc["total"], 2);
  });

  test("first station has expected fields", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_kitchen_stations")!;
    const result = await tool.handler({});

    const first = (result.structuredContent!["data"] as Record<string, unknown>[])[0]!;
    assert.equal(first["id"], "sta_grill");
    assert.equal(first["name"], "Grill");
    assert.equal(first["isActive"], true);
  });
});

// ── list_menu_items ───────────────────────────────────────────────────────────

describe("list_menu_items — success path", () => {
  test("returns menu items list with total", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_menu_items")!;
    const result = await tool.handler({});

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.ok(Array.isArray(sc["data"]));
    assert.equal(sc["total"], 1);
  });

  test("first menu item has expected fields", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_menu_items")!;
    const result = await tool.handler({ isActive: true });

    const first = (result.structuredContent!["data"] as Record<string, unknown>[])[0]!;
    assert.equal(first["id"], "mi_burger");
    assert.equal(first["name"], "Burger");
    assert.equal(first["priceCents"], 1200);
    assert.equal(first["category"], "Main");
    assert.equal(first["isActive"], true);
  });
});

// ── kitchen_flow_summary ──────────────────────────────────────────────────────

describe("kitchen_flow_summary — success path", () => {
  test("returns summary with stations array and totalOpenTickets", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("kitchen_flow_summary")!;
    const result = await tool.handler({});

    assert.ok(!result.isError, "should not be an error");
    const sc = result.structuredContent!;
    assert.ok(Array.isArray(sc["stations"]), "stations must be an array");
    assert.ok(typeof sc["totalOpenTickets"] === "number", "totalOpenTickets must be a number");
    assert.ok(typeof sc["generatedAt"] === "string", "generatedAt must be a string");
  });

  test("counts open tickets per station (2 grill, 1 bar — served/cancelled excluded)", async () => {
    // MOCK_TICKETS_LIST has tkt_001 (grill/preparing), tkt_002 (grill/queued), tkt_003 (bar/ready)
    // All are open (none served or cancelled)
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("kitchen_flow_summary")!;
    const result = await tool.handler({});

    const sc = result.structuredContent!;
    const stations = sc["stations"] as Array<Record<string, unknown>>;
    assert.equal(sc["totalOpenTickets"], 3);

    const grill = stations.find((s) => s["stationId"] === "sta_grill");
    const bar = stations.find((s) => s["stationId"] === "sta_bar");
    assert.ok(grill, "grill station should be present");
    assert.ok(bar, "bar station should be present");
    assert.equal(grill!["openTickets"], 2);
    assert.equal(bar!["openTickets"], 1);
  });

  test("flags grill as bottleneck (2 open tickets > bar 1)", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("kitchen_flow_summary")!;
    const result = await tool.handler({});

    const sc = result.structuredContent!;
    assert.equal(sc["bottleneckStationId"], "sta_grill");

    const stations = sc["stations"] as Array<Record<string, unknown>>;
    const grill = stations.find((s) => s["stationId"] === "sta_grill");
    const bar = stations.find((s) => s["stationId"] === "sta_bar");
    assert.equal(grill!["isBottleneck"], true);
    assert.equal(bar!["isBottleneck"], false);
  });

  test("excludes served and cancelled tickets from counts", async () => {
    const servedTicket = { ...MOCK_TICKET, id: "tkt_served", stationId: "sta_grill", status: "served" };
    const cancelledTicket = { ...MOCK_TICKET, id: "tkt_cancelled", stationId: "sta_bar", status: "cancelled" };
    const client = {
      listKitchenTickets: async () => ({
        data: [MOCK_TICKET, servedTicket, cancelledTicket],
        total: 3,
        limit: 100,
        offset: 0,
      }),
      listKitchenStations: async () => MOCK_STATIONS_LIST,
    } as unknown as import("../client-interface.js").IFrihetClient;

    const server = new StubMcpServer();
    const { registerKitchenTools } = await import("../tools/kitchen.js");
    registerKitchenTools(
      server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      client,
    );

    const result = await server.tools.get("kitchen_flow_summary")!.handler({});
    const sc = result.structuredContent!;
    // Only tkt_001 (grill/preparing) is open
    assert.equal(sc["totalOpenTickets"], 1);

    const stations = sc["stations"] as Array<Record<string, unknown>>;
    const grill = stations.find((s) => s["stationId"] === "sta_grill");
    const bar = stations.find((s) => s["stationId"] === "sta_bar");
    assert.equal(grill!["openTickets"], 1);
    assert.equal(bar!["openTickets"], 0);
  });

  test("content block mentions summary", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("kitchen_flow_summary")!;
    const result = await tool.handler({});

    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0]!.type, "text");
    assert.ok(result.content[0]!.text.includes("Kitchen flow summary"));
  });

  test("404 error propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("kitchen_flow_summary")!;
    const result = await tool.handler({});
    assert.ok(result.isError, "should be an error on 404");
  });
});
