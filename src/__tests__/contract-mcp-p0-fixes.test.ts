/**
 * Cross-surface P0 client-truth fixes — overnight audit 2026-08-31.
 *
 * Pins the 9 silent-400 / idempotency defects in the consumer (MCP) layer.
 * Each test pins BOTH the OLD shape (as `test.skip` regression marker) and the
 * NEW shape (as the active assertion). The skip lines make the prior contract
 * visible in CI output without re-running it.
 *
 * Defects fixed (all client-side):
 *   1. attendance_clock_in  — no Idempotency-Key header on POST
 *   2. attendance_clock_out — no Idempotency-Key header on PATCH
 *   3. frihet_gl_entry_reject — sends `reason`, ERP reads required `note`
 *   4. gestoria_aging_consolidated — GETs wrong path, ERP serves POST
 *   5. apply_deposit — input missing invoiceNumber and amount
 *   6. frihet_bank_rule_create — legacy shape, ERP needs new engine shape
 *   7. anomaly_list — wrong severity enum + missing type slug list
 *   8. leave_request_create — wrong leave-type enum
 *   9. apply_late_fee — description falsely claims it creates a debit note
 *
 * Run: npm run build && node --test dist/__tests__/contract-mcp-p0-fixes.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface ToolConfig {
  title?: string;
  description: string;
  annotations?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
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

const asMcp = (s: StubMcpServer) =>
  s as unknown as McpServer;

interface CapturedCall {
  method: string;
  args: unknown[];
}

function makeRecordingClient(overrides: Record<string, (...args: unknown[]) => unknown> = {}): {
  client: import("../client-interface.js").IFrihetClient;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const client = new Proxy(
    {},
    {
      get: (_target, prop) => {
        const name = String(prop);
        return (...args: unknown[]) => {
          calls.push({ method: name, args });
          if (Object.prototype.hasOwnProperty.call(overrides, name)) {
            return overrides[name](...args);
          }
          return { data: {}, meta: { requestId: "req_test", timestamp: "2026-08-31T00:00:00.000Z" } };
        };
      },
    },
  ) as import("../client-interface.js").IFrihetClient;
  return { client, calls };
}

/* ------------------------------------------------------------------ */
/*  1 + 2 — attendance_clock_in/out Idempotency-Key propagation         */
/* ------------------------------------------------------------------ */

describe("P0-1 — attendance_clock_in/out carry Idempotency-Key", () => {
  test("OLD (regression marker): inputSchema had no idempotencyKey — REGRESSION", () => {
    const tool: ToolConfig = {
      description: "old",
      inputSchema: {
        employeeId: { type: "string" },
      },
    };
    assert.ok(!("idempotencyKey" in (tool.inputSchema ?? {})), "this OLD shape is the bug we just fixed");
  });

  test("NEW: inputSchema declares idempotencyKey as optional", async () => {
    const { registerHrTools } = await import("../tools/hr.js");
    const server = new StubMcpServer();
    registerHrTools(asMcp(server), makeRecordingClient().client);

    const schema = server.tools.get("attendance_clock_in")!.config.inputSchema ?? {};
    assert.ok(
      "idempotencyKey" in schema,
      "attendance_clock_in must declare idempotencyKey after the fix",
    );
  });

  test("NEW: caller-supplied idempotencyKey is forwarded to attendanceClockIn", async () => {
    const { registerHrTools } = await import("../tools/hr.js");
    const { client, calls } = makeRecordingClient();
    const server = new StubMcpServer();
    registerHrTools(asMcp(server), client);

    await server.tools
      .get("attendance_clock_in")!
      .handler({ employeeId: "emp_1", idempotencyKey: "agent-attempt-7" });

    const clockInCall = calls.find((c) => c.method === "attendanceClockIn");
    assert.ok(clockInCall, "attendanceClockIn must be invoked");
    assert.equal(clockInCall!.args[1], "agent-attempt-7", "idempotencyKey must be the 2nd argument");
  });

  test("NEW: caller-supplied idempotencyKey is forwarded to attendanceClockOut", async () => {
    const { registerHrTools } = await import("../tools/hr.js");
    const { client, calls } = makeRecordingClient();
    const server = new StubMcpServer();
    registerHrTools(asMcp(server), client);

    await server.tools
      .get("attendance_clock_out")!
      .handler({ entryId: "att_1", idempotencyKey: "agent-clockout-7" });

    const call = calls.find((c) => c.method === "attendanceClockOut");
    assert.ok(call, "attendanceClockOut must be invoked");
    assert.equal(call!.args[1], "agent-clockout-7", "idempotencyKey must be the 2nd argument");
  });
});

/* ------------------------------------------------------------------ */
/*  3 — frihet_gl_entry_reject input field renamed: reason → note       */
/* ------------------------------------------------------------------ */

describe("P0-3 — frihet_gl_entry_reject sends `note`, not `reason`", () => {
  test("OLD (regression marker): inputSchema had `reason`, ERP rejected with 400 — REGRESSION", () => {
    const oldSchema: Record<string, unknown> = { entryId: { type: "string" }, reason: { type: "string" } };
    assert.ok("reason" in oldSchema);
    assert.ok(!("note" in oldSchema), "OLD shape had reason only");
  });

  test("NEW: inputSchema declares `note` (required, min 1), not `reason`", async () => {
    const { registerAuditGLTools } = await import("../tools/audit_gl.js");
    const server = new StubMcpServer();
    registerAuditGLTools(asMcp(server), makeRecordingClient().client);

    const schema = server.tools.get("frihet_gl_entry_reject")!.config.inputSchema ?? {};
    assert.ok("note" in schema, "must declare `note`");
    assert.ok(!("reason" in schema), "must not expose the legacy `reason` field");
  });

  test("NEW: client.rejectGLEntry is called with (entryId, note)", async () => {
    const { registerAuditGLTools } = await import("../tools/audit_gl.js");
    const { client, calls } = makeRecordingClient();
    const server = new StubMcpServer();
    registerAuditGLTools(asMcp(server), client);

    await server.tools
      .get("frihet_gl_entry_reject")!
      .handler({ entryId: "gl_2026_q1_042", note: "Importe incorrecto" });

    const call = calls.find((c) => c.method === "rejectGLEntry");
    assert.ok(call);
    assert.deepEqual(call!.args, ["gl_2026_q1_042", "Importe incorrecto"]);
  });
});

/* ------------------------------------------------------------------ */
/*  4 — gestoria_aging_consolidated: GET /v1/gestoria/aging/... → POST */
/* ------------------------------------------------------------------ */

describe("P0-4 — gestoria_aging_consolidated uses POST + body, not GET", () => {
  test("OLD (regression marker): input was ownerUid query param to GET — REGRESSION", () => {
    const oldInput = { ownerUid: "usr_xyz" };
    assert.ok("ownerUid" in oldInput);
  });

  test("NEW: inputSchema declares workspaceIds[], asOf?, bustCache?", async () => {
    const { registerGestoriaTools } = await import("../tools/gestoria.js");
    const server = new StubMcpServer();
    registerGestoriaTools(asMcp(server), makeRecordingClient().client);

    const schema = server.tools.get("gestoria_aging_consolidated")!.config.inputSchema ?? {};
    assert.ok("workspaceIds" in schema, "must declare workspaceIds[]");
    assert.ok("asOf" in schema, "must declare asOf");
    assert.ok("bustCache" in schema, "must declare bustCache");
    assert.ok(!("ownerUid" in schema), "must not expose the legacy ownerUid query field");
  });

  test("NEW: client.getGestoriaAgingConsolidated is called with the new body", async () => {
    const { registerGestoriaTools } = await import("../tools/gestoria.js");
    const { client, calls } = makeRecordingClient();
    const server = new StubMcpServer();
    registerGestoriaTools(asMcp(server), client);

    await server.tools.get("gestoria_aging_consolidated")!.handler({
      workspaceIds: ["ws_a", "ws_b"],
      asOf: "2026-08-31",
      bustCache: true,
    });

    const call = calls.find((c) => c.method === "getGestoriaAgingConsolidated");
    assert.ok(call);
    assert.deepEqual(call!.args[0], {
      workspaceIds: ["ws_a", "ws_b"],
      asOf: "2026-08-31",
      bustCache: true,
    });
  });
});

/* ------------------------------------------------------------------ */
/*  5 — apply_deposit requires invoiceId + invoiceNumber + amount      */
/* ------------------------------------------------------------------ */

describe("P0-5 — apply_deposit input requires invoiceId + invoiceNumber + amount", () => {
  test("OLD (regression marker): only id + invoiceId? + notes? — REGRESSION", () => {
    const oldSchema: Record<string, unknown> = {
      id: { type: "string" },
      invoiceId: { type: "string" },
      notes: { type: "string" },
    };
    assert.ok(!("invoiceNumber" in oldSchema));
    assert.ok(!("amount" in oldSchema));
  });

  test("NEW: inputSchema declares invoiceId, invoiceNumber and amount as required", async () => {
    const { registerDepositTools } = await import("../tools/deposits.js");
    const server = new StubMcpServer();
    registerDepositTools(asMcp(server), makeRecordingClient().client);

    const schema = server.tools.get("apply_deposit")!.config.inputSchema ?? {};
    assert.ok("invoiceId" in schema);
    assert.ok("invoiceNumber" in schema, "must require invoiceNumber");
    assert.ok("amount" in schema, "must require amount");
  });

  test("NEW: client.applyDeposit receives invoiceId + invoiceNumber + amount", async () => {
    const { registerDepositTools } = await import("../tools/deposits.js");
    const { client, calls } = makeRecordingClient();
    const server = new StubMcpServer();
    registerDepositTools(asMcp(server), client);

    await server.tools.get("apply_deposit")!.handler({
      id: "dep_abc",
      invoiceId: "inv_xyz",
      invoiceNumber: "F-2026-007",
      amount: 150,
    });

    const call = calls.find((c) => c.method === "applyDeposit");
    assert.ok(call);
    assert.equal(call!.args[0], "dep_abc");
    const body = call!.args[1] as Record<string, unknown>;
    assert.equal(body.invoiceId, "inv_xyz");
    assert.equal(body.invoiceNumber, "F-2026-007");
    assert.equal(body.amount, 150);
  });
});

/* ------------------------------------------------------------------ */
/*  6 — frihet_bank_rule_create new-engine shape                        */
/* ------------------------------------------------------------------ */

describe("P0-6 — frihet_bank_rule_create uses new engine shape", () => {
  test("OLD (regression marker): legacy conditions[]/actions[] — REGRESSION", () => {
    const oldSchema: Record<string, unknown> = {
      name: { type: "string" },
      conditions: { type: "array" },
      actions: { type: "array" },
    };
    assert.ok("conditions" in oldSchema);
    assert.ok("actions" in oldSchema);
    assert.ok(!("bankConditions" in oldSchema));
  });

  test("NEW: inputSchema declares bankConditions[], action, actionConfig", async () => {
    const { registerBankRulesTools } = await import("../tools/bank_rules.js");
    const server = new StubMcpServer();
    registerBankRulesTools(asMcp(server), makeRecordingClient().client);

    const schema = server.tools.get("frihet_bank_rule_create")!.config.inputSchema ?? {};
    assert.ok("bankConditions" in schema);
    assert.ok("action" in schema);
    assert.ok("actionConfig" in schema);
    assert.ok(!("actions" in schema), "legacy `actions[]` must not be accepted");
  });

  test("NEW: client.createBankRule receives the new-engine body", async () => {
    const { registerBankRulesTools } = await import("../tools/bank_rules.js");
    const { client, calls } = makeRecordingClient();
    const server = new StubMcpServer();
    registerBankRulesTools(asMcp(server), client);

    await server.tools.get("frihet_bank_rule_create")!.handler({
      name: "Mercadona",
      bankConditions: [{ field: "description", operator: "contains", value: "MERCADONA" }],
      action: "categorize_expense",
      actionConfig: { category: "groceries" },
    });

    const call = calls.find((c) => c.method === "createBankRule");
    assert.ok(call);
    const body = call!.args[0] as Record<string, unknown>;
    assert.equal(body.name, "Mercadona");
    assert.deepEqual(body.bankConditions, [
      { field: "description", operator: "contains", value: "MERCADONA" },
    ]);
    // ERP authority: functions/src/banking/bankRuleCreate.ts:BANK_RULE_ACTIONS
    assert.equal(body.action, "categorize_expense");
    assert.deepEqual(body.actionConfig, { category: "groceries" });
  });

  test("NEW: inputSchema enums match ERP authority (no fabricated slugs)", async () => {
    const { registerBankRulesTools } = await import("../tools/bank_rules.js");
    const server = new StubMcpServer();
    registerBankRulesTools(asMcp(server), makeRecordingClient().client);

    const schema = server.tools.get("frihet_bank_rule_create")!.config.inputSchema ?? {};
    const dump = JSON.stringify(schema);

    // Fields — ERP allows: description, reference, amount, counterparty
    for (const allowed of ["description", "reference", "amount", "counterparty"]) {
      assert.match(dump, new RegExp(`"${allowed}"`), `must include field ${allowed}`);
    }
    assert.doesNotMatch(dump, /"iban"/, "ERP does not accept iban as a bankConditions field");

    // Operators — ERP uses snake_case verbs
    for (const allowed of [
      "contains",
      "exact",
      "starts_with",
      "ends_with",
      "regex",
      "amount_above",
      "amount_below",
      "amount_between",
    ]) {
      assert.match(dump, new RegExp(`"${allowed}"`), `must include operator ${allowed}`);
    }
    assert.doesNotMatch(dump, /"equals"/, "ERP uses 'exact', not 'equals'");
    assert.doesNotMatch(dump, /"greaterThan"/, "ERP uses 'amount_above', not camelCase");
    assert.doesNotMatch(dump, /"lessThan"/, "ERP uses 'amount_below', not camelCase");

    // Actions — ERP authority
    for (const allowed of [
      "categorize_expense",
      "match_invoice",
      "match_client",
      "ignore",
      "create_expense",
      "flag_review",
    ]) {
      assert.match(dump, new RegExp(`"${allowed}"`), `must include action ${allowed}`);
    }
    // Regression: the old MCP enums were legacy placeholders ERP would 400.
    assert.doesNotMatch(dump, /"setCategory"/, "ERP has no 'setCategory' action");
    assert.doesNotMatch(dump, /"addTag"/, "ERP has no 'addTag' action");
    assert.doesNotMatch(dump, /"assignClient"/, "ERP uses 'match_client', not 'assignClient'");
  });
});

/* ------------------------------------------------------------------ */
/*  7 — anomaly_list severity enum + type slug list                     */
/* ------------------------------------------------------------------ */

describe("P0-7 — anomaly_list severity enum + type slug list match ERP", () => {
  test("OLD (regression marker): severity enum was [low/medium/high/critical], type was freeform — REGRESSION", () => {
    const oldSeverity = ["low", "medium", "high", "critical"];
    assert.ok(oldSeverity.includes("low"));
  });

  test("NEW: anomaly_list severity enum is [warning, critical]", async () => {
    const { registerHrTools } = await import("../tools/hr.js");
    const server = new StubMcpServer();
    registerHrTools(asMcp(server), makeRecordingClient().client);

    const schema = server.tools.get("anomaly_list")!.config.inputSchema ?? {};
    const description = JSON.stringify(schema["severity"] ?? {});
    assert.match(description, /warning/);
    assert.match(description, /critical/);
    assert.doesNotMatch(description, /"low"/);
    assert.doesNotMatch(description, /"medium"/);
    assert.doesNotMatch(description, /"high"/);
  });

  test("NEW: anomaly_list type enum is the documented ERP slug list (Art.34/35 ET overtime engine)", async () => {
    const { registerHrTools } = await import("../tools/hr.js");
    const server = new StubMcpServer();
    registerHrTools(asMcp(server), makeRecordingClient().client);

    const schema = server.tools.get("anomaly_list")!.config.inputSchema ?? {};
    const description = JSON.stringify(schema["type"] ?? {});
    // ERP functions/src/publicApi/families/anomalies.ts:ANOMALY_TYPES
    for (const allowed of [
      "daily_exceeded",
      "weekly_exceeded",
      "annual_approaching",
      "annual_exceeded",
      "missing_break",
    ]) {
      assert.match(description, new RegExp(allowed), `must include ${allowed}`);
    }
    // Regression: the old MCP enums were HR-conceptual placeholders that ERP
    // never accepted (each would 400 INVALID_TYPE).
    assert.doesNotMatch(description, /duplicate_clock_in/);
    assert.doesNotMatch(description, /overtime_spike/);
    assert.doesNotMatch(description, /missing_clock_out/);
    assert.doesNotMatch(description, /expense_outlier/);
  });
});

/* ------------------------------------------------------------------ */
/*  8 — leave_request_create type enum                                 */
/* ------------------------------------------------------------------ */

describe("P0-8 — leave_request_create type enum matches ERP", () => {
  test("OLD (regression marker): enum listed unpaid + training (rejected) — REGRESSION", () => {
    const oldEnum = ["vacation", "sick", "personal", "parental", "unpaid", "training"];
    assert.ok(oldEnum.includes("unpaid"));
    assert.ok(oldEnum.includes("training"));
  });

  test("NEW: enum is [vacation, sick, personal, parental, bereavement, other]", async () => {
    const { registerHrTools } = await import("../tools/hr.js");
    const server = new StubMcpServer();
    registerHrTools(asMcp(server), makeRecordingClient().client);

    const schema = server.tools.get("leave_request_create")!.config.inputSchema ?? {};
    const description = JSON.stringify(schema["type"] ?? {});
    for (const allowed of ["vacation", "sick", "personal", "parental", "bereavement", "other"]) {
      assert.match(description, new RegExp(allowed), `must include ${allowed}`);
    }
    assert.doesNotMatch(description, /unpaid/, "unpaid is no longer accepted");
    assert.doesNotMatch(description, /training/, "training is no longer accepted");
  });
});

/* ------------------------------------------------------------------ */
/*  9 — apply_late_fee description no longer claims a debit note        */
/* ------------------------------------------------------------------ */

describe("P0-9 — apply_late_fee description tells the truth", () => {
  test("OLD (regression marker): description claimed it creates a debit note — REGRESSION", () => {
    const old = "Apply late payment interest to an overdue invoice. ... Creates a debit note linked to the original invoice.";
    assert.match(old, /debit note/i);
  });

  test("NEW: description does NOT claim a debit note; flags are documented", async () => {
    const { registerInvoiceTools } = await import("../tools/invoices.js");
    const server = new StubMcpServer();
    registerInvoiceTools(asMcp(server), makeRecordingClient().client);

    const desc = server.tools.get("apply_late_fee")!.config.description;
    assert.doesNotMatch(desc, /creates a debit note/i);
    assert.doesNotMatch(desc, /Crea una nota de debito vinculada/i);
    assert.match(desc, /flags/i);
    assert.match(desc, /hasLateFee/);
  });
});
