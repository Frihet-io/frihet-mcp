/**
 * Tests for D4-B megasprint MCP tools — HR + Webhook test + Payroll + Onboarding + Permissions + Period close (20 tools).
 *
 * Uses Node.js built-in test runner (node:test + node:assert). Run: npm test (after build).
 *
 * Coverage:
 *   - Tool registration counts per module
 *   - Happy path for every tool (mock client returns fixture)
 *   - Error path: 404 propagated as isError=true
 *   - Trust-area gates: confirm=false for period_close / period_reopen returns isError
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

// ── Mock fixtures ────────────────────────────────────────────────────────────

const MOCK_LEAVE = {
  id: "leave_001",
  employeeId: "emp_001",
  type: "vacation",
  startDate: "2026-06-01",
  endDate: "2026-06-15",
  durationDays: 15,
  status: "pending",
  reason: "Summer break",
  createdAt: "2026-05-16T08:00:00Z",
};

const MOCK_LEAVES_LIST = { data: [MOCK_LEAVE], total: 1, limit: 20, offset: 0 };

const MOCK_ATTENDANCE = {
  id: "att_001",
  employeeId: "emp_001",
  clockInAt: "2026-05-16T09:00:00Z",
  status: "open",
};

const MOCK_OVERTIME = {
  period: "2026-05",
  totalRegularHours: 160,
  totalOvertimeHours: 12,
  estimatedCostEur: 480,
  byEmployee: [],
};

const MOCK_ANOMALY = {
  id: "anom_001",
  type: "overtime_spike",
  severity: "medium" as const,
  subjectId: "emp_001",
  detectedAt: "2026-05-16T10:00:00Z",
  status: "open" as const,
};

const MOCK_ANOMALIES_LIST = { data: [MOCK_ANOMALY], total: 1, limit: 20, offset: 0 };

const MOCK_WEBHOOK_TEST = {
  webhookId: "wh_abc",
  delivered: true,
  statusCode: 200,
  responseTimeMs: 142,
  eventType: "webhook.test",
  attemptedAt: "2026-05-16T10:30:00Z",
};

const MOCK_PAYROLL_EXPORT = {
  format: "a3" as const,
  month: "2026-05",
  fileUrl: "https://files.frihet.io/payroll/2026-05-a3.csv",
  filename: "payroll-2026-05.csv",
  rowCount: 12,
  generatedAt: "2026-05-16T10:00:00Z",
};

const MOCK_PAYROLL_CHECKLIST = {
  month: "2026-05",
  totalEmployees: 12,
  readyEmployees: 10,
  missingEmployees: 2,
  employees: [],
};

const MOCK_ONBOARDING_STATUS = {
  workspaceId: "ws_001",
  persona: "empresa" as const,
  completedSteps: ["create_workspace", "set_persona"],
  pendingSteps: ["connect_bank", "invite_team"],
  percentComplete: 50,
};

const MOCK_ONBOARDING_PERSONA_RESULT = {
  workspaceId: "ws_001",
  persona: "gestoria" as const,
  updatedAt: "2026-05-16T10:00:00Z",
};

const MOCK_PERMISSIONS_MATRIX = {
  roles: [{ role: "admin", permissions: ["invoices.*", "expenses.*"] }],
  resources: ["invoices", "expenses"],
};

const MOCK_PERMISSIONS_ME = {
  userId: "user_001",
  role: "admin",
  permissions: ["invoices.read", "invoices.write"],
  workspaceId: "ws_001",
};

const MOCK_PERIOD = {
  id: "period_2026_q2",
  type: "quarterly" as const,
  status: "open" as const,
  startDate: "2026-04-01",
  endDate: "2026-06-30",
};

const MOCK_PERIOD_CLOSED = { ...MOCK_PERIOD, status: "closed" as const, closedAt: "2026-05-16T10:00:00Z" };

// ── Client stubs ─────────────────────────────────────────────────────────────

function makeSuccessClient(): import("../client-interface.js").IFrihetClient {
  return {
    // HR
    listLeaves: async () => MOCK_LEAVES_LIST,
    createLeaveRequest: async (d: Record<string, unknown>) => ({ ...MOCK_LEAVE, ...d }),
    approveLeave: async (id: string) => ({ ...MOCK_LEAVE, id, status: "approved" }),
    rejectLeave: async (id: string, d: Record<string, unknown>) => ({ ...MOCK_LEAVE, id, status: "rejected", decisionReason: d["reason"] }),
    cancelLeave: async (id: string) => ({ ...MOCK_LEAVE, id, status: "cancelled" }),
    attendanceClockIn: async (d: Record<string, unknown>) => ({ ...MOCK_ATTENDANCE, ...d }),
    attendanceClockOut: async (id: string) => ({ ...MOCK_ATTENDANCE, id, clockOutAt: "2026-05-16T17:00:00Z", status: "closed", durationMinutes: 480 }),
    getOvertimeReport: async () => MOCK_OVERTIME,
    listAnomalies: async () => MOCK_ANOMALIES_LIST,

    // Webhook test (existing webhooks methods need stubs too for registerWebhookTools to call them)
    listWebhooks: async () => ({ data: [], total: 0, limit: 20, offset: 0 }),
    getWebhook: async () => ({ id: "wh_abc" }),
    createWebhook: async (d: Record<string, unknown>) => ({ id: "wh_new", ...d }),
    updateWebhook: async (id: string, d: Record<string, unknown>) => ({ id, ...d }),
    deleteWebhook: async () => undefined,
    testWebhook: async () => MOCK_WEBHOOK_TEST,

    // Payroll
    exportPayroll: async () => MOCK_PAYROLL_EXPORT,
    getPayrollChecklist: async () => MOCK_PAYROLL_CHECKLIST,

    // Onboarding
    getOnboardingStatus: async () => MOCK_ONBOARDING_STATUS,
    setOnboardingPersona: async (d: Record<string, unknown>) => ({ ...MOCK_ONBOARDING_PERSONA_RESULT, persona: d["persona"] }),

    // Permissions
    getPermissionsMatrix: async () => MOCK_PERMISSIONS_MATRIX,
    getMyPermissions: async () => MOCK_PERMISSIONS_ME,

    // Period close
    getCurrentPeriod: async () => MOCK_PERIOD,
    closePeriod: async () => MOCK_PERIOD_CLOSED,
    reopenPeriod: async (d: Record<string, unknown>) => ({ ...MOCK_PERIOD, status: "reopened", reopenReason: d["reason"] }),
  } as unknown as import("../client-interface.js").IFrihetClient;
}

function make404Client(): import("../client-interface.js").IFrihetClient {
  const notFound = () => {
    const err = Object.assign(new Error("Not Found"), { statusCode: 404, errorCode: "not_found" });
    return Promise.reject(err);
  };
  return new Proxy({}, { get: () => notFound }) as unknown as import("../client-interface.js").IFrihetClient;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeHrServer(clientFn: () => import("../client-interface.js").IFrihetClient): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  const { registerHrTools } = await import("../tools/hr.js");
  registerHrTools(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, clientFn());
  return server;
}

async function makeWebhookServer(clientFn: () => import("../client-interface.js").IFrihetClient): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  const { registerWebhookTools } = await import("../tools/webhooks.js");
  registerWebhookTools(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, clientFn());
  return server;
}

async function makePayrollServer(clientFn: () => import("../client-interface.js").IFrihetClient): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  const { registerPayrollTools } = await import("../tools/payroll.js");
  registerPayrollTools(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, clientFn());
  return server;
}

async function makeOnboardingServer(clientFn: () => import("../client-interface.js").IFrihetClient): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  const { registerOnboardingTools } = await import("../tools/onboarding.js");
  registerOnboardingTools(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, clientFn());
  return server;
}

async function makePermissionsServer(clientFn: () => import("../client-interface.js").IFrihetClient): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  const { registerPermissionsTools } = await import("../tools/permissions.js");
  registerPermissionsTools(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, clientFn());
  return server;
}

async function makeAccountingCloseServer(clientFn: () => import("../client-interface.js").IFrihetClient): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  const { registerAccountingCloseTools } = await import("../tools/accountingClose.js");
  registerAccountingCloseTools(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, clientFn());
  return server;
}

// ── Registration tests ───────────────────────────────────────────────────────

describe("D4-B Registration counts", () => {
  test("HR tools — 9 registered", async () => {
    const s = await makeHrServer(makeSuccessClient);
    assert.equal(s.tools.size, 9);
    for (const name of [
      "leave_request_create",
      "leave_approve",
      "leave_reject",
      "leave_cancel",
      "leave_list",
      "attendance_clock_in",
      "attendance_clock_out",
      "overtime_report",
      "anomaly_list",
    ]) {
      assert.ok(s.tools.has(name), `missing tool ${name}`);
    }
  });

  test("Webhook tools — 6 registered (5 existing + 1 test_webhook)", async () => {
    const s = await makeWebhookServer(makeSuccessClient);
    assert.equal(s.tools.size, 6);
    assert.ok(s.tools.has("test_webhook"));
  });

  test("Payroll tools — 2 registered", async () => {
    const s = await makePayrollServer(makeSuccessClient);
    assert.equal(s.tools.size, 2);
    assert.ok(s.tools.has("payroll_export"));
    assert.ok(s.tools.has("payroll_checklist"));
  });

  test("Onboarding tools — 2 registered", async () => {
    const s = await makeOnboardingServer(makeSuccessClient);
    assert.equal(s.tools.size, 2);
    assert.ok(s.tools.has("onboarding_status"));
    assert.ok(s.tools.has("onboarding_persona_set"));
  });

  test("Permissions tools — 2 registered", async () => {
    const s = await makePermissionsServer(makeSuccessClient);
    assert.equal(s.tools.size, 2);
    assert.ok(s.tools.has("permissions_matrix"));
    assert.ok(s.tools.has("permissions_me"));
  });

  test("Period close tools — 3 registered", async () => {
    const s = await makeAccountingCloseServer(makeSuccessClient);
    assert.equal(s.tools.size, 3);
    assert.ok(s.tools.has("period_close_status"));
    assert.ok(s.tools.has("period_close"));
    assert.ok(s.tools.has("period_reopen"));
  });
});

// ── HR happy-path tests ──────────────────────────────────────────────────────

describe("HR Tools — happy path", () => {
  let server: StubMcpServer;
  beforeEach(async () => { server = await makeHrServer(makeSuccessClient); });

  test("leave_request_create returns pending leave", async () => {
    const r = await server.tools.get("leave_request_create")!.handler({
      employeeId: "emp_001", type: "vacation", startDate: "2026-06-01", endDate: "2026-06-15",
    });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent!["status"], "pending");
    assert.equal(r.structuredContent!["employeeId"], "emp_001");
  });

  test("leave_approve sets status approved", async () => {
    const r = await server.tools.get("leave_approve")!.handler({ leaveId: "leave_001" });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent!["status"], "approved");
  });

  test("leave_reject requires reason and sets rejected", async () => {
    const r = await server.tools.get("leave_reject")!.handler({ leaveId: "leave_001", reason: "Coverage conflict" });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent!["status"], "rejected");
    assert.equal(r.structuredContent!["decisionReason"], "Coverage conflict");
  });

  test("leave_cancel sets status cancelled", async () => {
    const r = await server.tools.get("leave_cancel")!.handler({ leaveId: "leave_001" });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent!["status"], "cancelled");
  });

  test("leave_list returns paginated leaves", async () => {
    const r = await server.tools.get("leave_list")!.handler({ status: "pending" });
    assert.ok(!r.isError);
    assert.equal((r.structuredContent!["data"] as unknown[]).length, 1);
    assert.equal(r.structuredContent!["total"], 1);
  });

  test("attendance_clock_in returns open entry", async () => {
    const r = await server.tools.get("attendance_clock_in")!.handler({ employeeId: "emp_001", mood: "ok" });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent!["status"], "open");
  });

  test("attendance_clock_out closes entry with duration", async () => {
    const r = await server.tools.get("attendance_clock_out")!.handler({ entryId: "att_001" });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent!["status"], "closed");
    assert.equal(r.structuredContent!["durationMinutes"], 480);
  });

  test("overtime_report returns aggregated hours", async () => {
    const r = await server.tools.get("overtime_report")!.handler({ period: "2026-05" });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent!["totalOvertimeHours"], 12);
  });

  test("anomaly_list returns paginated anomalies", async () => {
    const r = await server.tools.get("anomaly_list")!.handler({ severity: "medium" });
    assert.ok(!r.isError);
    assert.equal((r.structuredContent!["data"] as unknown[]).length, 1);
  });
});

// ── Webhook test happy-path + error ──────────────────────────────────────────

describe("Webhook test_webhook", () => {
  test("happy path returns delivered=true", async () => {
    const server = await makeWebhookServer(makeSuccessClient);
    const r = await server.tools.get("test_webhook")!.handler({ id: "wh_abc", eventType: "invoice.paid" });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent!["delivered"], true);
    assert.equal(r.structuredContent!["statusCode"], 200);
  });

  test("404 propagates as isError=true", async () => {
    const server = await makeWebhookServer(make404Client);
    const r = await server.tools.get("test_webhook")!.handler({ id: "wh_missing" });
    assert.ok(r.isError);
  });
});

// ── Payroll ──────────────────────────────────────────────────────────────────

describe("Payroll Tools", () => {
  test("payroll_export returns CSV URL for A3 format", async () => {
    const server = await makePayrollServer(makeSuccessClient);
    const r = await server.tools.get("payroll_export")!.handler({ format: "a3", month: "2026-05" });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent!["format"], "a3");
    assert.equal(r.structuredContent!["rowCount"], 12);
  });

  test("payroll_checklist returns readiness counts", async () => {
    const server = await makePayrollServer(makeSuccessClient);
    const r = await server.tools.get("payroll_checklist")!.handler({ month: "2026-05" });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent!["readyEmployees"], 10);
    assert.equal(r.structuredContent!["missingEmployees"], 2);
  });

  test("payroll_export 404 → isError", async () => {
    const server = await makePayrollServer(make404Client);
    const r = await server.tools.get("payroll_export")!.handler({ format: "a3", month: "2026-05" });
    assert.ok(r.isError);
  });
});

// ── Onboarding ───────────────────────────────────────────────────────────────

describe("Onboarding Tools", () => {
  test("onboarding_status returns persona + steps", async () => {
    const server = await makeOnboardingServer(makeSuccessClient);
    const r = await server.tools.get("onboarding_status")!.handler({});
    assert.ok(!r.isError);
    assert.equal(r.structuredContent!["persona"], "empresa");
    assert.equal(r.structuredContent!["percentComplete"], 50);
  });

  test("onboarding_persona_set updates persona", async () => {
    const server = await makeOnboardingServer(makeSuccessClient);
    const r = await server.tools.get("onboarding_persona_set")!.handler({ persona: "gestoria" });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent!["persona"], "gestoria");
  });
});

// ── Permissions ──────────────────────────────────────────────────────────────

describe("Permissions Tools", () => {
  test("permissions_matrix returns roles + resources", async () => {
    const server = await makePermissionsServer(makeSuccessClient);
    const r = await server.tools.get("permissions_matrix")!.handler({});
    assert.ok(!r.isError);
    assert.ok(Array.isArray(r.structuredContent!["roles"]));
  });

  test("permissions_me returns caller role", async () => {
    const server = await makePermissionsServer(makeSuccessClient);
    const r = await server.tools.get("permissions_me")!.handler({});
    assert.ok(!r.isError);
    assert.equal(r.structuredContent!["role"], "admin");
  });
});

// ── Period close (TRUST AREA) ────────────────────────────────────────────────

describe("Period Close Tools", () => {
  test("period_close_status returns open period", async () => {
    const server = await makeAccountingCloseServer(makeSuccessClient);
    const r = await server.tools.get("period_close_status")!.handler({});
    assert.ok(!r.isError);
    assert.equal(r.structuredContent!["status"], "open");
  });

  test("period_close confirm=false returns isError without calling API", async () => {
    const server = await makeAccountingCloseServer(makeSuccessClient);
    const r = await server.tools.get("period_close")!.handler({ type: "quarterly", confirm: false });
    assert.ok(r.isError);
    assert.ok(r.content[0]!.text.includes("confirm=true"));
  });

  test("period_close confirm=true closes period", async () => {
    const server = await makeAccountingCloseServer(makeSuccessClient);
    const r = await server.tools.get("period_close")!.handler({ type: "quarterly", confirm: true });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent!["status"], "closed");
  });

  test("period_reopen confirm=false returns isError", async () => {
    const server = await makeAccountingCloseServer(makeSuccessClient);
    const r = await server.tools.get("period_reopen")!.handler({ periodId: "period_2026_q2", reason: "Audit correction", confirm: false });
    assert.ok(r.isError);
    assert.ok(r.content[0]!.text.includes("confirm=true"));
  });

  test("period_reopen confirm=true with reason reopens period", async () => {
    const server = await makeAccountingCloseServer(makeSuccessClient);
    const r = await server.tools.get("period_reopen")!.handler({ periodId: "period_2026_q2", reason: "Audit correction", confirm: true });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent!["status"], "reopened");
    assert.equal(r.structuredContent!["reopenReason"], "Audit correction");
  });

  test("period_close 404 → isError", async () => {
    const server = await makeAccountingCloseServer(make404Client);
    const r = await server.tools.get("period_close")!.handler({ type: "monthly", confirm: true });
    assert.ok(r.isError);
  });
});

// ── HR error paths ───────────────────────────────────────────────────────────

describe("HR Tools — error paths", () => {
  test("leave_list 404 → isError", async () => {
    const server = await makeHrServer(make404Client);
    const r = await server.tools.get("leave_list")!.handler({});
    assert.ok(r.isError);
  });

  test("leave_request_create 404 → isError", async () => {
    const server = await makeHrServer(make404Client);
    const r = await server.tools.get("leave_request_create")!.handler({
      employeeId: "emp_001", type: "vacation", startDate: "2026-06-01", endDate: "2026-06-15",
    });
    assert.ok(r.isError);
  });

  test("attendance_clock_out 404 → isError", async () => {
    const server = await makeHrServer(make404Client);
    const r = await server.tools.get("attendance_clock_out")!.handler({ entryId: "att_missing" });
    assert.ok(r.isError);
  });
});
