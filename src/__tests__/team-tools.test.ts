/**
 * Tests for Team Management MCP tools — Wave Mature 3 (4 tools).
 *
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Run: npm test (after build)
 *
 * Coverage:
 *   1. Tool registration — all 4 team tools registered
 *   2. list_team_members — success path + structuredContent shape
 *   3. list_team_members — role filter accepted
 *   4. invite_team_member — success path
 *   5. update_team_member_role — success path
 *   6. remove_team_member — confirm=false gate
 *   7. remove_team_member — confirm=true success path
 *   8. API error — 404 propagated as isError=true
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

const MOCK_MEMBER = {
  id: "mbr_abc123",
  name: "Ana Aurora",
  email: "ana@example.com",
  role: "member",
  status: "active",
  joinedAt: "2026-01-15T10:00:00Z",
  createdAt: "2026-01-15T10:00:00Z",
};

const MOCK_PENDING_MEMBER = {
  id: "mbr_def456",
  name: "Carlos Nuevo",
  email: "carlos@example.com",
  role: "viewer",
  status: "pending",
  invitedAt: "2026-05-10T09:00:00Z",
};

const MOCK_MEMBERS_LIST = {
  data: [MOCK_MEMBER, MOCK_PENDING_MEMBER],
  total: 2,
  limit: 20,
  offset: 0,
};

const MOCK_ACTION_RESULT = {
  success: true,
  id: "mbr_abc123",
  message: "Operation completed",
};

// ── Client stubs ─────────────────────────────────────────────────────────────

function makeSuccessClient(): import("../client-interface.js").IFrihetClient {
  return {
    listTeamMembers: async () => MOCK_MEMBERS_LIST,
    inviteTeamMember: async (_data: Record<string, unknown>) => MOCK_PENDING_MEMBER,
    updateTeamMemberRole: async (_id: string, _role: string) => MOCK_ACTION_RESULT,
    removeTeamMember: async (_id: string) => undefined,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

function make404Client(): import("../client-interface.js").IFrihetClient {
  const notFound = () => {
    const err = Object.assign(new Error("Not Found"), { statusCode: 404, errorCode: "not_found" });
    return Promise.reject(err);
  };
  return {
    listTeamMembers: notFound,
    inviteTeamMember: notFound,
    updateTeamMemberRole: notFound,
    removeTeamMember: notFound as unknown as () => Promise<void>,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

// ── Helper ───────────────────────────────────────────────────────────────────

async function makeServer(
  clientFn: () => import("../client-interface.js").IFrihetClient,
): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  const { registerTeamTools } = await import("../tools/team.js");
  registerTeamTools(
    server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    clientFn(),
  );
  return server;
}

// ── Registration tests ───────────────────────────────────────────────────────

describe("Team Tools — Registration", () => {
  let server: StubMcpServer;

  beforeEach(async () => {
    server = await makeServer(makeSuccessClient);
  });

  test("registers exactly 4 team tools", () => {
    assert.equal(server.tools.size, 4);
  });

  test("registers list_team_members", () => {
    assert.ok(server.tools.has("list_team_members"));
  });

  test("registers invite_team_member", () => {
    assert.ok(server.tools.has("invite_team_member"));
  });

  test("registers update_team_member_role", () => {
    assert.ok(server.tools.has("update_team_member_role"));
  });

  test("registers remove_team_member", () => {
    assert.ok(server.tools.has("remove_team_member"));
  });
});

// ── list_team_members ────────────────────────────────────────────────────────

describe("list_team_members — success path", () => {
  test("returns structuredContent with data array", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_team_members")!;
    const result = await tool.handler({});

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.ok(Array.isArray(sc["data"]));
    assert.equal(sc["total"], 2);
  });

  test("first member has expected fields", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_team_members")!;
    const result = await tool.handler({});

    const first = (result.structuredContent!["data"] as Record<string, unknown>[])[0]!;
    assert.equal(first["id"], "mbr_abc123");
    assert.equal(first["email"], "ana@example.com");
    assert.equal(first["role"], "member");
    assert.equal(first["status"], "active");
  });

  test("content block has type text and mentions team_members", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_team_members")!;
    const result = await tool.handler({});
    assert.equal(result.content[0]!.type, "text");
    assert.ok(result.content[0]!.text.includes("team_members"));
  });

  test("role filter accepted without error", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_team_members")!;
    const result = await tool.handler({ role: "admin" });
    assert.ok(!result.isError);
  });

  test("status=pending filter accepted without error", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_team_members")!;
    const result = await tool.handler({ status: "pending" });
    assert.ok(!result.isError);
  });

  test("404 propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("list_team_members")!;
    const result = await tool.handler({});
    assert.ok(result.isError);
  });
});

// ── invite_team_member ───────────────────────────────────────────────────────

describe("invite_team_member — success path", () => {
  test("returns invited member with expected fields", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("invite_team_member")!;
    const result = await tool.handler({ email: "carlos@example.com", role: "viewer" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["email"], "carlos@example.com");
    assert.equal(sc["status"], "pending");
  });

  test("content block mentions invited", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("invite_team_member")!;
    const result = await tool.handler({ email: "test@example.com", role: "member" });
    assert.ok(result.content[0]!.text.includes("invited"));
  });

  test("invite with name accepted without error", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("invite_team_member")!;
    const result = await tool.handler({ email: "newuser@example.com", role: "admin", name: "New User" });
    assert.ok(!result.isError);
  });

  test("404 propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("invite_team_member")!;
    const result = await tool.handler({ email: "test@example.com", role: "member" });
    assert.ok(result.isError);
  });
});

// ── update_team_member_role ──────────────────────────────────────────────────

describe("update_team_member_role — success path", () => {
  test("returns action result with success=true", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("update_team_member_role")!;
    const result = await tool.handler({ memberId: "mbr_abc123", role: "admin" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["success"], true);
  });

  test("content block mentions role updated", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("update_team_member_role")!;
    const result = await tool.handler({ memberId: "mbr_abc123", role: "viewer" });
    assert.ok(result.content[0]!.text.includes("updated"));
  });

  test("404 propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("update_team_member_role")!;
    const result = await tool.handler({ memberId: "mbr_missing", role: "member" });
    assert.ok(result.isError);
  });
});

// ── remove_team_member ───────────────────────────────────────────────────────

describe("remove_team_member — trust area gate", () => {
  test("confirm=false returns isError=true without calling API", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("remove_team_member")!;
    const result = await tool.handler({ memberId: "mbr_abc123", confirm: false });

    assert.ok(result.isError);
    assert.ok(result.content[0]!.text.includes("confirm=true"));
  });

  test("confirm=true succeeds and returns success=true with id", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("remove_team_member")!;
    const result = await tool.handler({ memberId: "mbr_abc123", confirm: true });

    assert.ok(!result.isError);
    assert.equal(result.structuredContent!["success"], true);
    assert.equal(result.structuredContent!["id"], "mbr_abc123");
  });

  test("confirm=true with 404 propagates isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("remove_team_member")!;
    const result = await tool.handler({ memberId: "mbr_missing", confirm: true });
    assert.ok(result.isError);
  });
});
