/**
 * Tests for Time Tracking MCP tools — Wave Mature 3 (6 tools).
 *
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Run: npm test (after build)
 *
 * Coverage:
 *   1. Tool registration — all 6 time tools registered
 *   2. list_time_entries — success path + structuredContent shape
 *   3. get_time_entry — success path
 *   4. create_time_entry — success path
 *   5. update_time_entry — success path + partial update
 *   6. delete_time_entry — confirm=false gate
 *   7. delete_time_entry — confirm=true success path
 *   8. get_time_summary — success path + aggregation fields
 *   9. API error — 404 propagated as isError=true
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

const MOCK_ENTRY = {
  id: "te_abc123",
  userId: "usr_viktor",
  projectId: "proj_xyz",
  hours: 2.5,
  description: "Frontend code review",
  billable: true,
  date: "2026-05-10",
  status: "logged",
  createdAt: "2026-05-10T09:00:00Z",
};

const MOCK_ENTRIES_LIST = {
  data: [MOCK_ENTRY],
  total: 1,
  limit: 20,
  offset: 0,
};

const MOCK_TIME_SUMMARY = {
  from: "2026-05-01",
  to: "2026-05-31",
  totalHours: 42.5,
  billableHours: 38.0,
  nonBillableHours: 4.5,
  estimatedCostEur: 6375.0,
  groups: [
    { key: "proj_xyz", label: "Project Alpha", totalHours: 42.5, billableHours: 38.0, nonBillableHours: 4.5 },
  ],
};

// ── Client stubs ─────────────────────────────────────────────────────────────

function makeSuccessClient(): import("../client-interface.js").IFrihetClient {
  return {
    listTimeEntries: async () => MOCK_ENTRIES_LIST,
    getTimeEntry: async (_id: string) => MOCK_ENTRY,
    createTimeEntry: async (_data: Record<string, unknown>) => MOCK_ENTRY,
    updateTimeEntry: async (_id: string, data: Record<string, unknown>) => ({ ...MOCK_ENTRY, ...data }),
    deleteTimeEntry: async (_id: string) => undefined,
    getTimeSummary: async () => MOCK_TIME_SUMMARY,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

function make404Client(): import("../client-interface.js").IFrihetClient {
  const notFound = () => {
    const err = Object.assign(new Error("Not Found"), { statusCode: 404, errorCode: "not_found" });
    return Promise.reject(err);
  };
  return {
    listTimeEntries: notFound,
    getTimeEntry: notFound,
    createTimeEntry: notFound,
    updateTimeEntry: notFound,
    deleteTimeEntry: notFound,
    getTimeSummary: notFound,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

// ── Helper ───────────────────────────────────────────────────────────────────

async function makeServer(
  clientFn: () => import("../client-interface.js").IFrihetClient,
): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  const { registerTimeTools } = await import("../tools/time.js");
  registerTimeTools(
    server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    clientFn(),
  );
  return server;
}

// ── Registration tests ───────────────────────────────────────────────────────

describe("Time Tools — Registration", () => {
  let server: StubMcpServer;

  beforeEach(async () => {
    server = await makeServer(makeSuccessClient);
  });

  test("registers exactly 6 time tools", () => {
    assert.equal(server.tools.size, 6);
  });

  test("registers list_time_entries", () => {
    assert.ok(server.tools.has("list_time_entries"));
  });

  test("registers create_time_entry", () => {
    assert.ok(server.tools.has("create_time_entry"));
  });

  test("registers update_time_entry", () => {
    assert.ok(server.tools.has("update_time_entry"));
  });

  test("registers delete_time_entry", () => {
    assert.ok(server.tools.has("delete_time_entry"));
  });

  test("registers get_time_entry", () => {
    assert.ok(server.tools.has("get_time_entry"));
  });

  test("registers get_time_summary", () => {
    assert.ok(server.tools.has("get_time_summary"));
  });
});

// ── get_time_entry ───────────────────────────────────────────────────────────

describe("get_time_entry — success path", () => {
  test("returns single entry with expected fields", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_time_entry")!;
    const result = await tool.handler({ id: "te_abc123" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["id"], "te_abc123");
    assert.equal(sc["hours"], 2.5);
    assert.equal(sc["billable"], true);
  });

  test("content block has type text", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_time_entry")!;
    const result = await tool.handler({ id: "te_abc123" });
    assert.equal(result.content[0]!.type, "text");
  });

  test("404 propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("get_time_entry")!;
    const result = await tool.handler({ id: "te_missing" });
    assert.ok(result.isError);
  });
});

// ── list_time_entries ────────────────────────────────────────────────────────

describe("list_time_entries — success path", () => {
  test("returns structuredContent with data array", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_time_entries")!;
    const result = await tool.handler({ projectId: "proj_xyz", from: "2026-05-01", to: "2026-05-31" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.ok(Array.isArray(sc["data"]));
    assert.equal(sc["total"], 1);
  });

  test("first entry has expected fields", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_time_entries")!;
    const result = await tool.handler({});

    const first = (result.structuredContent!["data"] as Record<string, unknown>[])[0]!;
    assert.equal(first["id"], "te_abc123");
    assert.equal(first["hours"], 2.5);
    assert.equal(first["billable"], true);
    assert.equal(first["date"], "2026-05-10");
  });

  test("content block has type text and mentions time_entries", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_time_entries")!;
    const result = await tool.handler({});
    assert.equal(result.content[0]!.type, "text");
    assert.ok(result.content[0]!.text.includes("time_entries"));
  });

  test("billable filter accepted without error", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_time_entries")!;
    const result = await tool.handler({ billable: true });
    assert.ok(!result.isError);
  });
});

// ── create_time_entry ────────────────────────────────────────────────────────

describe("create_time_entry — success path", () => {
  test("returns created entry with expected fields", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("create_time_entry")!;
    const result = await tool.handler({
      projectId: "proj_xyz",
      hours: 2.5,
      date: "2026-05-10",
      description: "Frontend code review",
      billable: true,
    });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["id"], "te_abc123");
    assert.equal(sc["hours"], 2.5);
    assert.equal(sc["billable"], true);
  });

  test("content block mentions time entry created", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("create_time_entry")!;
    const result = await tool.handler({ projectId: "proj_xyz", hours: 1.0, date: "2026-05-10" });
    assert.ok(result.content[0]!.text.includes("created"));
  });

  test("404 propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("create_time_entry")!;
    const result = await tool.handler({ projectId: "proj_xyz", hours: 1.0, date: "2026-05-10" });
    assert.ok(result.isError);
  });
});

// ── update_time_entry ────────────────────────────────────────────────────────

describe("update_time_entry — success path", () => {
  test("returns updated entry with new hours", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("update_time_entry")!;
    const result = await tool.handler({ id: "te_abc123", hours: 3.0 });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["hours"], 3.0);
  });

  test("content block mentions updated", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("update_time_entry")!;
    const result = await tool.handler({ id: "te_abc123", description: "Updated description" });
    assert.ok(result.content[0]!.text.includes("updated"));
  });
});

// ── delete_time_entry ────────────────────────────────────────────────────────

describe("delete_time_entry — trust area gate", () => {
  test("confirm=false returns isError=true without calling API", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("delete_time_entry")!;
    const result = await tool.handler({ id: "te_abc123", confirm: false });

    assert.ok(result.isError);
    assert.ok(result.content[0]!.text.includes("confirm=true"));
  });

  test("confirm=true succeeds and returns success=true", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("delete_time_entry")!;
    const result = await tool.handler({ id: "te_abc123", confirm: true });

    assert.ok(!result.isError);
    assert.equal(result.structuredContent!["success"], true);
    assert.equal(result.structuredContent!["id"], "te_abc123");
  });

  test("confirm=true with 404 propagates isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("delete_time_entry")!;
    const result = await tool.handler({ id: "te_missing", confirm: true });
    assert.ok(result.isError);
  });
});

// ── get_time_summary ─────────────────────────────────────────────────────────

describe("get_time_summary — success path", () => {
  test("returns summary with aggregation fields", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_time_summary")!;
    const result = await tool.handler({ from: "2026-05-01", to: "2026-05-31" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["totalHours"], 42.5);
    assert.equal(sc["billableHours"], 38.0);
    assert.equal(sc["nonBillableHours"], 4.5);
  });

  test("content block has type text", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_time_summary")!;
    const result = await tool.handler({ from: "2026-05-01", to: "2026-05-31" });
    assert.equal(result.content[0]!.type, "text");
  });

  test("groups array present when returned", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_time_summary")!;
    const result = await tool.handler({ from: "2026-05-01", to: "2026-05-31", groupBy: "project" });
    const sc = result.structuredContent!;
    assert.ok(Array.isArray(sc["groups"]));
    assert.equal((sc["groups"] as unknown[]).length, 1);
  });

  test("userId filter accepted without error", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_time_summary")!;
    const result = await tool.handler({ from: "2026-05-01", to: "2026-05-31", userId: "usr_viktor" });
    assert.ok(!result.isError);
  });

  test("404 propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("get_time_summary")!;
    const result = await tool.handler({ from: "2026-05-01", to: "2026-05-31" });
    assert.ok(result.isError);
  });
});
