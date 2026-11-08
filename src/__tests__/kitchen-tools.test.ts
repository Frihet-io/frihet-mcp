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

import { test, describe, beforeEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FrihetClient } from "../client.js";
import { registerKitchenTools } from "../tools/kitchen.js";
import { claudeToolResult } from "../claude-output-privacy.js";

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

async function connectKitchen(t: TestContext): Promise<Client> {
  const server = new McpServer({ name: "kitchen-contract", version: "0.0.0" });
  registerKitchenTools(server, new FrihetClient("fri_test_kitchen", "https://api.frihet.io/v1"));
  const client = new Client({ name: "kitchen-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test("update_kitchen_ticket maps stationId to the strict API stationIds field through the real SDK", async (t) => {
  const expected = { ...MOCK_UPDATED_TICKET, stationIds: ["sta_bar"] };
  const fetchMock = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, "https://api.frihet.io/v1/kitchen/tickets/tkt%2F001");
    assert.equal(init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(init?.body)), { status: "ready", stationIds: ["sta_bar"] });
    assert.ok(new Headers(init?.headers).get("Idempotency-Key"));
    return Response.json({ data: expected });
  });
  const client = await connectKitchen(t);
  const result = await client.callTool({ name: "update_kitchen_ticket", arguments: { id: "tkt/001", status: "ready", stationId: "sta_bar" } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, expected);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("updateKitchenTicket preserves status-only and native stationIds patches without mutating input", async (t) => {
  const bodies: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ data: MOCK_UPDATED_TICKET });
  });
  const api = new FrihetClient("fri_test_kitchen", "https://api.frihet.io/v1");
  const statusOnly = Object.freeze({ status: "ready" });
  const nativePatch = Object.freeze({ stationIds: ["sta_grill", "sta_bar"], priority: "rush" });
  const toolPatch = Object.freeze({ stationId: "sta_bar", status: "ready" });
  await api.updateKitchenTicket("tkt_001", statusOnly);
  await api.updateKitchenTicket("tkt_001", nativePatch);
  await api.updateKitchenTicket("tkt_001", toolPatch);
  assert.deepEqual(bodies, [statusOnly, nativePatch, { status: "ready", stationIds: ["sta_bar"] }]);
  assert.deepEqual(toolPatch, { stationId: "sta_bar", status: "ready" });
});

test("repeating the same kitchen station assignment keeps the same assignment", async (t) => {
  let stationIds = ["sta_grill"];
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    const patch = JSON.parse(String(init?.body));
    assert.equal(Object.hasOwn(patch, "stationId"), false);
    assert.deepEqual(patch, { stationIds: ["sta_bar"] });
    stationIds = patch.stationIds;
    return Response.json({ data: { ...MOCK_TICKET, stationIds } });
  });
  const client = await connectKitchen(t);
  const request = { name: "update_kitchen_ticket", arguments: { id: "tkt_001", stationId: "sta_bar" } };
  const first = await client.callTool(request);
  const second = await client.callTool(request);
  assert.notEqual(first.isError, true);
  assert.notEqual(second.isError, true);
  assert.deepEqual(first.structuredContent, second.structuredContent);
  assert.deepEqual(stationIds, ["sta_bar"]);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("update_kitchen_ticket rejects a non-string stationId before HTTP", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected API call"); });
  const client = await connectKitchen(t);
  const result = await client.callTool({ name: "update_kitchen_ticket", arguments: { id: "tkt_001", stationId: 42 } });
  assert.equal(result.isError, true);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("kitchen_flow_summary counts canonical multi-station tickets once and excludes voided tickets", async (t) => {
  const tickets = [
    { ...MOCK_TICKET, stationId: "stale_legacy_station", stationIds: ["sta_grill", "sta_bar", "sta_bar"] },
    { ...MOCK_TICKET_2, stationId: undefined, stationIds: ["sta_bar"] },
    { id: "unassigned", status: "on_hold", stationIds: [] },
    { id: "voided", status: "voided", stationIds: ["sta_grill"] },
    { id: "served", status: "served", stationIds: ["sta_grill"] },
  ];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/kitchen/tickets") return Response.json({ data: tickets, total: tickets.length, limit: 100, offset: 0 });
    assert.equal(path, "/v1/kitchen/stations");
    return Response.json(MOCK_STATIONS_LIST);
  });
  const client = await connectKitchen(t);
  const result = await client.callTool({ name: "kitchen_flow_summary", arguments: {} });
  assert.notEqual(result.isError, true);
  const summary = result.structuredContent as Record<string, unknown>;
  assert.equal(summary.totalOpenTickets, 3);
  assert.equal(summary.bottleneckStationId, "sta_bar");
  const stations = summary.stations as Array<Record<string, unknown>>;
  assert.deepEqual(stations.map(({ stationId, openTickets }) => ({ stationId, openTickets })), [
    { stationId: "sta_grill", openTickets: 1 },
    { stationId: "sta_bar", openTickets: 2 },
    { stationId: "__unassigned__", openTickets: 1 },
  ]);
});

test("empty kitchen_flow_summary omits the optional bottleneck before and after Claude privacy", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [], total: 0, limit: 100, offset: 0 }));
  // Inspect the raw result as well: JSON transport alone would silently omit
  // an undefined property before the privacy boundary could encounter it.
  const emptyClient = new FrihetClient("fri_test_kitchen", "https://api.frihet.io/v1");
  const server = await makeServer(() => emptyClient);
  const raw = await server.tools.get("kitchen_flow_summary")!.handler({});
  const client = await connectKitchen(t);
  const transported = await client.callTool({ name: "kitchen_flow_summary", arguments: {} });
  for (const result of [raw, transported, claudeToolResult(raw, "kitchen_flow_summary")]) {
    assert.notEqual(result.isError, true);
    const summary = result.structuredContent as Record<string, unknown>;
    assert.deepEqual(summary.stations, []);
    assert.equal(summary.totalOpenTickets, 0);
    assert.equal(Object.hasOwn(summary, "bottleneckStationId"), false);
    assert.doesNotMatch(JSON.stringify(result), /\[redacted\]/u);
  }
});

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
