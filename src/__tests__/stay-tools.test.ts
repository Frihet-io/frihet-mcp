/**
 * Tests for Stay MCP tools — Wave 4 (5 tools).
 *
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Run: npm test (after build)
 *
 * Coverage:
 *   1. Tool registration — all 5 tools registered on McpServer
 *   2. list_reservations — success path + structuredContent shape
 *   3. get_reservation — success path + structuredContent shape
 *   4. create_reservation — success path + structuredContent shape
 *   5. list_properties — success path + structuredContent shape
 *   6. sync_channel — success path + structuredContent shape
 *   7. API error path — 404 propagated through handleToolError
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

const MOCK_RESERVATION = {
  id: "res_abc123",
  propertyId: "prop_xyz",
  guestId: "guest_def456",
  status: "confirmed",
  checkIn: "2026-06-01",
  checkOut: "2026-06-08",
  nights: 7,
  guestCount: 2,
  channelId: "ch_direct",
  totalAmount: 840,
  currency: "EUR",
  createdAt: "2026-05-10T10:00:00Z",
  updatedAt: "2026-05-10T10:00:00Z",
};

const MOCK_RESERVATIONS_LIST = {
  data: [MOCK_RESERVATION],
  total: 1,
  limit: 20,
  offset: 0,
};

const MOCK_PROPERTY = {
  id: "prop_xyz",
  name: "Casa Marina",
  address: { street: "Calle del Mar 1", city: "Tenerife", country: "ES" },
  capacity: 4,
  ownerName: "Ana Garcia",
  licenseNumber: "VV-TF-12345",
  isActive: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const MOCK_PROPERTIES_LIST = {
  data: [MOCK_PROPERTY],
  total: 1,
  limit: 20,
  offset: 0,
};

const MOCK_SYNC_RESULT = {
  channelId: "ch_airbnb_001",
  status: "ok",
  pulledCount: 3,
  pushedCount: 1,
  lastSyncAt: "2026-05-10T10:00:00Z",
};

function makeSuccessClient(): import("../client-interface.js").IFrihetClient {
  return {
    listReservations: async () => MOCK_RESERVATIONS_LIST,
    getReservation: async (_id: string) => MOCK_RESERVATION,
    createReservation: async (_data: Record<string, unknown>) => MOCK_RESERVATION,
    listProperties: async () => MOCK_PROPERTIES_LIST,
    syncChannel: async (_channelId: string, _direction: "pull" | "push" | "both") => MOCK_SYNC_RESULT,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

function make404Client(): import("../client-interface.js").IFrihetClient {
  const notFound = () => {
    const err = Object.assign(new Error("Not Found"), { statusCode: 404, errorCode: "not_found" });
    return Promise.reject(err);
  };
  return {
    listReservations: notFound,
    getReservation: notFound,
    createReservation: notFound,
    listProperties: notFound,
    syncChannel: notFound,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

// ── Helper ───────────────────────────────────────────────────────────────────

async function makeServer(
  clientFn: () => import("../client-interface.js").IFrihetClient,
): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  const { registerStayTools } = await import("../tools/stay.js");
  registerStayTools(
    server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    clientFn(),
  );
  return server;
}

// ── Registration tests ───────────────────────────────────────────────────────

describe("Stay Tools — Registration", () => {
  let server: StubMcpServer;

  beforeEach(async () => {
    server = await makeServer(makeSuccessClient);
  });

  test("registers exactly 5 stay tools", () => {
    assert.equal(server.tools.size, 5);
  });

  test("registers list_reservations", () => {
    assert.ok(server.tools.has("list_reservations"), "list_reservations not registered");
  });

  test("registers get_reservation", () => {
    assert.ok(server.tools.has("get_reservation"), "get_reservation not registered");
  });

  test("registers create_reservation", () => {
    assert.ok(server.tools.has("create_reservation"), "create_reservation not registered");
  });

  test("registers list_properties", () => {
    assert.ok(server.tools.has("list_properties"), "list_properties not registered");
  });

  test("registers sync_channel", () => {
    assert.ok(server.tools.has("sync_channel"), "sync_channel not registered");
  });
});

// ── list_reservations ────────────────────────────────────────────────────────

describe("list_reservations — success path", () => {
  test("returns structuredContent with data array", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_reservations")!;
    const result = await tool.handler({ limit: 20, offset: 0 });

    assert.ok(!result.isError, "should not be an error");
    assert.ok(result.structuredContent, "structuredContent missing");
    const sc = result.structuredContent!;
    assert.ok(Array.isArray(sc["data"]), "data should be an array");
    assert.equal((sc["data"] as unknown[]).length, 1);
    assert.equal(sc["total"], 1);
  });

  test("first reservation has expected fields", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_reservations")!;
    const result = await tool.handler({});

    const sc = result.structuredContent!;
    const first = (sc["data"] as Record<string, unknown>[])[0]!;
    assert.equal(first["id"], "res_abc123");
    assert.equal(first["status"], "confirmed");
    assert.equal(first["checkIn"], "2026-06-01");
    assert.equal(first["checkOut"], "2026-06-08");
    assert.equal(first["guestCount"], 2);
  });

  test("content block has type text", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_reservations")!;
    const result = await tool.handler({});

    assert.ok(Array.isArray(result.content), "content should be array");
    assert.equal(result.content[0]!.type, "text");
    assert.ok(typeof result.content[0]!.text === "string");
    assert.ok(result.content[0]!.text.includes("reservations"));
  });
});

// ── get_reservation ──────────────────────────────────────────────────────────

describe("get_reservation — success path", () => {
  test("returns single reservation by ID", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_reservation")!;
    const result = await tool.handler({ id: "res_abc123" });

    assert.ok(!result.isError, "should not be an error");
    const sc = result.structuredContent!;
    assert.equal(sc["id"], "res_abc123");
    assert.equal(sc["propertyId"], "prop_xyz");
    assert.equal(sc["status"], "confirmed");
  });

  test("404 error propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("get_reservation")!;
    const result = await tool.handler({ id: "res_missing" });

    assert.ok(result.isError, "should be an error on 404");
    assert.ok(result.content[0]!.text.includes("Error:"), "error message should start with Error:");
  });
});

// ── create_reservation ───────────────────────────────────────────────────────

describe("create_reservation — success path", () => {
  test("returns created reservation", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("create_reservation")!;
    const result = await tool.handler({
      propertyId: "prop_xyz",
      checkIn: "2026-06-01",
      checkOut: "2026-06-08",
      guestCount: 2,
    });

    assert.ok(!result.isError, "should not be an error");
    const sc = result.structuredContent!;
    assert.equal(sc["id"], "res_abc123");
    assert.equal(sc["status"], "confirmed");
  });

  test("content block is a mutate-type annotated text", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("create_reservation")!;
    const result = await tool.handler({
      propertyId: "prop_xyz",
      checkIn: "2026-06-01",
      checkOut: "2026-06-08",
      guestCount: 2,
    });
    assert.equal(result.content[0]!.type, "text");
    assert.ok(result.content[0]!.text.includes("Reservation created"));
  });
});

// ── list_properties ──────────────────────────────────────────────────────────

describe("list_properties — success path", () => {
  test("returns properties list with total", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_properties")!;
    const result = await tool.handler({});

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.ok(Array.isArray(sc["data"]));
    assert.equal(sc["total"], 1);
  });

  test("first property has expected fields", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_properties")!;
    const result = await tool.handler({});

    const first = (result.structuredContent!["data"] as Record<string, unknown>[])[0]!;
    assert.equal(first["id"], "prop_xyz");
    assert.equal(first["name"], "Casa Marina");
    assert.equal(first["capacity"], 4);
    assert.equal(first["licenseNumber"], "VV-TF-12345");
    assert.equal(first["isActive"], true);
  });
});

// ── sync_channel ─────────────────────────────────────────────────────────────

describe("sync_channel — success path", () => {
  test("returns sync status with counts", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("sync_channel")!;
    const result = await tool.handler({ channelId: "ch_airbnb_001", direction: "both" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["channelId"], "ch_airbnb_001");
    assert.equal(sc["status"], "ok");
    assert.equal(sc["pulledCount"], 3);
    assert.equal(sc["pushedCount"], 1);
    assert.ok(typeof sc["lastSyncAt"] === "string");
  });

  test("direction defaults to both (omitted in input)", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("sync_channel")!;
    // direction is optional — tool should still call syncChannel with "both"
    const result = await tool.handler({ channelId: "ch_booking_002" });
    assert.ok(!result.isError);
  });

  test("404 error propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("sync_channel")!;
    const result = await tool.handler({ channelId: "ch_missing" });
    assert.ok(result.isError, "should be an error on 404");
  });
});
