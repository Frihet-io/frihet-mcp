/**
 * Real-SDK validator tests for Team Management tools.
 *
 * Unlike `team-tools.test.ts` (StubMcpServer), this file mounts the tools on a
 * real `McpServer`, connects a real `Client` over `InMemoryTransport`, and
 * drives `client.callTool()` so the SDK's own Ajv-backed input/output validator
 * runs against every tool. Any input enum mismatch, output null, or output
 * enum that the contract leaves out surfaces as `isError: true` with a
 * deterministic MCP `-32602` message.
 *
 * Wave Mature 3 contract (RESUME #122):
 *   - OUTPUT `role` enum = owner | admin | editor | accountant | viewer
 *     (drop `member`; keep `owner` for OpenAPI compat).
 *   - OUTPUT name/email/invitedAt/joinedAt/createdAt/updatedAt: nullable.
 *   - INPUT `invite_team_member.role` = admin | editor | accountant | viewer.
 *   - INPUT `update_team_member_role.role` = admin | editor | accountant | viewer.
 *   - INPUT `list_team_members.role` keeps `owner` for filter back-compat.
 *   - List returns active members + pending invites; owner is NOT a member row.
 *
 * Run: npm run build && node --test dist/__tests__/team-tools-real-sdk.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerTeamTools } from "../tools/team.js";
import type { IFrihetClient } from "../client-interface.js";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

const ACTIVE_ACCOUNTANT = {
  id: "mbr_acc1",
  name: "Ana Contable",
  email: "ana@example.com",
  role: "accountant",
  status: "active",
  joinedAt: "2026-01-15T10:00:00Z",
  createdAt: "2026-01-15T10:00:00Z",
};

const ACTIVE_EDITOR = {
  id: "mbr_edt1",
  name: "Eli Editor",
  email: "eli@example.com",
  role: "editor",
  status: "active",
  joinedAt: "2026-02-01T10:00:00Z",
  createdAt: "2026-02-01T10:00:00Z",
};

const PENDING_INVITE_NULL_NAME = {
  id: "mbr_pen1",
  name: null,
  email: null,
  role: "viewer",
  status: "pending",
  invitedAt: "2026-05-10T09:00:00Z",
  createdAt: "2026-05-10T09:00:00Z",
};

const PENDING_INVITE_NULL_DATES = {
  id: "mbr_pen2",
  email: "late@example.com",
  role: "viewer",
  status: "pending",
  invitedAt: null,
  joinedAt: null,
  createdAt: null,
  updatedAt: null,
};

function makeClient(overrides: Partial<IFrihetClient> = {}): IFrihetClient {
  return {
    listTeamMembers: async () => ({
      data: [ACTIVE_ACCOUNTANT, ACTIVE_EDITOR, PENDING_INVITE_NULL_NAME, PENDING_INVITE_NULL_DATES],
      total: 4,
      limit: 20,
      offset: 0,
    }),
    inviteTeamMember: async (data: { email: string; role: string; name?: string }) => ({
      id: "mbr_new1",
      name: data.name ?? null,
      email: data.email,
      role: data.role,
      status: "pending",
      invitedAt: "2026-08-09T00:00:00Z",
    }),
    updateTeamMemberRole: async (id: string, role: string) => ({ success: true, id, role }),
    removeTeamMember: async () => undefined,
    ...overrides,
  } as unknown as IFrihetClient;
}

interface Harness {
  client: Client;
  server: McpServer;
}

async function makeHarness(clientImpl: IFrihetClient): Promise<Harness> {
  const server = new McpServer({ name: "frihet-test", version: "0.0.0" }, { capabilities: { tools: {} } });
  registerTeamTools(server, clientImpl);
  const [txA, txB] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "frihet-test-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(txA), server.connect(txB)]);
  return { client, server };
}

async function dispose(h: Harness): Promise<void> {
  await h.client.close();
  await h.server.close();
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("Team Tools — real SDK (McpServer + Client + InMemoryTransport)", () => {
  test("registers exactly 4 team tools", async () => {
    const h = await makeHarness(makeClient());
    try {
      const { tools } = await h.client.listTools();
      const team = tools.filter((t) =>
        ["list_team_members", "invite_team_member", "update_team_member_role", "remove_team_member"].includes(t.name)
      );
      assert.equal(team.length, 4);
    } finally {
      await dispose(h);
    }
  });
});

// ---------------------------------------------------------------------------
// list_team_members — output contract (real validator)
// ---------------------------------------------------------------------------

describe("list_team_members — output contract (real SDK)", () => {
  test("output accepts role=accountant (enum includes accountant)", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({ name: "list_team_members", arguments: {} });
      assert.equal(res.isError, undefined, "no output validation error");
      const rows = (res.structuredContent as { data: Array<{ role: string }> }).data;
      assert.ok(rows.some((r) => r.role === "accountant"), "accountant row kept");
    } finally {
      await dispose(h);
    }
  });

  test("output accepts role=editor (enum includes editor)", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({ name: "list_team_members", arguments: {} });
      assert.equal(res.isError, undefined);
      const rows = (res.structuredContent as { data: Array<{ role: string }> }).data;
      assert.ok(rows.some((r) => r.role === "editor"), "editor row kept");
    } finally {
      await dispose(h);
    }
  });

  test("output accepts name=null (nullable)", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({ name: "list_team_members", arguments: {} });
      assert.equal(res.isError, undefined, "null name must not fail output validation");
    } finally {
      await dispose(h);
    }
  });

  test("output accepts email=null (nullable)", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({ name: "list_team_members", arguments: {} });
      assert.equal(res.isError, undefined, "null email must not fail output validation");
    } finally {
      await dispose(h);
    }
  });

  test("output accepts invitedAt/joinedAt/createdAt/updatedAt = null (nullable)", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({ name: "list_team_members", arguments: {} });
      assert.equal(res.isError, undefined, "null dates must not fail output validation");
    } finally {
      await dispose(h);
    }
  });

  test("input filter role=owner accepted (back-compat for owner filter)", async () => {
    let called = false;
    const h = await makeHarness(makeClient({
      listTeamMembers: async (params) => {
        called = true;
        assert.equal(params?.role, "owner");
        return { data: [], total: 0, limit: 20, offset: 0 };
      },
    }));
    try {
      const res = await h.client.callTool({ name: "list_team_members", arguments: { role: "owner" } });
      assert.equal(res.isError, undefined);
      assert.equal(called, true, "filter reached the client");
    } finally {
      await dispose(h);
    }
  });

  test("input filter role=accountant accepted (list supports all output roles)", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({ name: "list_team_members", arguments: { role: "accountant" } });
      assert.equal(res.isError, undefined);
    } finally {
      await dispose(h);
    }
  });

  test("input filter role=editor accepted (list supports all output roles)", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({ name: "list_team_members", arguments: { role: "editor" } });
      assert.equal(res.isError, undefined);
    } finally {
      await dispose(h);
    }
  });

  test("output rejects role=member (dropped from output enum per Wave Mature 3 contract)", async () => {
    const legacy = {
      data: [{ id: "mbr_old", email: "old@example.com", role: "member", status: "active" }],
      total: 1,
      limit: 20,
      offset: 0,
    };
    const h = await makeHarness(makeClient({ listTeamMembers: async () => legacy }));
    try {
      const res = await h.client.callTool({ name: "list_team_members", arguments: {} });
      assert.equal(res.isError, true, "member must NOT be a valid output role");
      const first = Array.isArray(res.content) ? res.content[0] : undefined;
      const msg = (first && typeof first === "object" && "text" in first ? (first as { text?: string }).text : "") ?? "";
      assert.ok(msg.includes("Output validation error"), "real SDK output error surfaces");
    } finally {
      await dispose(h);
    }
  });
});

// ---------------------------------------------------------------------------
// invite_team_member — input contract (real validator)
// ---------------------------------------------------------------------------

describe("invite_team_member — input contract (real SDK)", () => {
  test("accepts role=admin", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({
        name: "invite_team_member",
        arguments: { email: "a@b.com", role: "admin" },
      });
      assert.equal(res.isError, undefined);
    } finally {
      await dispose(h);
    }
  });

  test("accepts role=editor", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({
        name: "invite_team_member",
        arguments: { email: "a@b.com", role: "editor" },
      });
      assert.equal(res.isError, undefined, "editor must be a valid invite role");
    } finally {
      await dispose(h);
    }
  });

  test("accepts role=accountant", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({
        name: "invite_team_member",
        arguments: { email: "a@b.com", role: "accountant" },
      });
      assert.equal(res.isError, undefined, "accountant must be a valid invite role");
    } finally {
      await dispose(h);
    }
  });

  test("accepts role=viewer", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({
        name: "invite_team_member",
        arguments: { email: "a@b.com", role: "viewer" },
      });
      assert.equal(res.isError, undefined);
    } finally {
      await dispose(h);
    }
  });

  test("rejects role=member (dropped from input enum per Wave Mature 3 contract)", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({
        name: "invite_team_member",
        arguments: { email: "a@b.com", role: "member" },
      });
      assert.equal(res.isError, true, "member must NOT be a valid invite role");
      const first = Array.isArray(res.content) ? res.content[0] : undefined;
      const msg = (first && typeof first === "object" && "text" in first ? (first as { text?: string }).text : "") ?? "";
      assert.ok(msg.includes("Input validation error"), "real SDK input error surfaces");
    } finally {
      await dispose(h);
    }
  });

  test("rejects role=owner (owner cannot be invited, must be transferred)", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({
        name: "invite_team_member",
        arguments: { email: "a@b.com", role: "owner" },
      });
      assert.equal(res.isError, true);
    } finally {
      await dispose(h);
    }
  });

  test("rejects bad email", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({
        name: "invite_team_member",
        arguments: { email: "not-an-email", role: "viewer" },
      });
      assert.equal(res.isError, true);
    } finally {
      await dispose(h);
    }
  });
});

// ---------------------------------------------------------------------------
// update_team_member_role — input contract (real validator)
// ---------------------------------------------------------------------------

describe("update_team_member_role — input contract (real SDK)", () => {
  test("accepts role=admin", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({
        name: "update_team_member_role",
        arguments: { memberId: "mbr_abc", role: "admin" },
      });
      assert.equal(res.isError, undefined);
    } finally {
      await dispose(h);
    }
  });

  test("accepts role=editor", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({
        name: "update_team_member_role",
        arguments: { memberId: "mbr_abc", role: "editor" },
      });
      assert.equal(res.isError, undefined, "editor must be a valid update role");
    } finally {
      await dispose(h);
    }
  });

  test("accepts role=accountant", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({
        name: "update_team_member_role",
        arguments: { memberId: "mbr_abc", role: "accountant" },
      });
      assert.equal(res.isError, undefined, "accountant must be a valid update role");
    } finally {
      await dispose(h);
    }
  });

  test("accepts role=viewer", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({
        name: "update_team_member_role",
        arguments: { memberId: "mbr_abc", role: "viewer" },
      });
      assert.equal(res.isError, undefined);
    } finally {
      await dispose(h);
    }
  });

  test("rejects role=member (dropped from input enum)", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({
        name: "update_team_member_role",
        arguments: { memberId: "mbr_abc", role: "member" },
      });
      assert.equal(res.isError, true, "member must NOT be a valid update role");
    } finally {
      await dispose(h);
    }
  });

  test("rejects role=owner (owner cannot be changed via this tool)", async () => {
    const h = await makeHarness(makeClient());
    try {
      const res = await h.client.callTool({
        name: "update_team_member_role",
        arguments: { memberId: "mbr_abc", role: "owner" },
      });
      assert.equal(res.isError, true);
    } finally {
      await dispose(h);
    }
  });
});

// ---------------------------------------------------------------------------
// remove_team_member — confirm gate (real validator)
// ---------------------------------------------------------------------------

describe("remove_team_member — confirm gate (real SDK)", () => {
  test("confirm=false returns isError=true without reaching the client", async () => {
    let called = false;
    const h = await makeHarness(makeClient({
      removeTeamMember: async () => {
        called = true;
      },
    }));
    try {
      const res = await h.client.callTool({
        name: "remove_team_member",
        arguments: { memberId: "mbr_abc", confirm: false },
      });
      assert.equal(res.isError, true);
      assert.equal(called, false, "client must not be called when confirm=false");
    } finally {
      await dispose(h);
    }
  });

  test("confirm=true reaches the client and returns success=true", async () => {
    let calledWith: string | undefined;
    const h = await makeHarness(makeClient({
      removeTeamMember: async (id: string) => {
        calledWith = id;
      },
    }));
    try {
      const res = await h.client.callTool({
        name: "remove_team_member",
        arguments: { memberId: "mbr_abc", confirm: true },
      });
      assert.equal(res.isError, undefined);
      assert.equal(calledWith, "mbr_abc");
      const sc = res.structuredContent as { success: boolean; id: string };
      assert.equal(sc.success, true);
      assert.equal(sc.id, "mbr_abc");
    } finally {
      await dispose(h);
    }
  });
});
