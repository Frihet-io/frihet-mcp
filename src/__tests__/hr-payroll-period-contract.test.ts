/**
 * Current ERP contract regression for the four read tools tracked by #138.
 *
 * This suite uses both the real HTTP client and the real MCP SDK validator.
 * The mock HTTP server returns the standard ERP `{ data, meta }` response so
 * raw-envelope leaks, double GETs, and stale output schemas are all observable.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { FrihetClient } from "../client.js";
import { DemoFrihetClient } from "../demo-client.js";
import { registerAccountingCloseTools } from "../tools/accountingClose.js";
import { registerHrTools } from "../tools/hr.js";
import { registerPayrollTools } from "../tools/payroll.js";
import {
  overtimeReportOutput,
  payrollChecklistOutput,
  payrollExportOutput,
  currentPeriodOutput,
} from "../tools/shared.js";

const OVERTIME = {
  period: "2026-07",
  employeeId: null,
  recordCount: 2,
  dailyOvertime: [
    { date: "2026-07-01", minutes: 60, exceedsDaily: false },
  ],
  weeklyOvertime: [
    { weekStart: "2026-06-29", totalMinutes: 1_020, overtimeMinutes: 60 },
  ],
  monthlyTotal: {
    workedMinutes: 1_020,
    overtimeMinutes: 60,
    regularMinutes: 960,
  },
  annualOvertimeHours: 1,
  alerts: [
    {
      type: "weekly_exceeded",
      severity: "warning",
      message: "overtime.alert.weeklyExceeded",
      date: "2026-06-29",
    },
  ],
};

const PAYROLL_EXPORT = {
  month: "2026-07",
  format: "a3",
  employees: [
    {
      id: "emp_001",
      name: "Example Employee",
      nss: "TEST-NSS-001",
      irpfPct: 15,
      salaryGrossAnnual: 30_000,
      convenioColectivo: null,
      categoriaProfesional: null,
      prorrateoPagasExtras: true,
      formaPago: "efectivo",
      iban: null,
    },
  ],
  summary: {
    exportedCount: 1,
    skippedNotReady: 1,
    totalGrossAnnual: 30_000,
  },
};

const PAYROLL_CHECKLIST = {
  month: "2026-07",
  employees: [
    {
      id: "emp_001",
      name: "Example Employee",
      status: "active",
      hasPayrollProfile: true,
      ready: true,
      missingFields: [],
      reviewedForMonth: "2026-07",
      reviewedThisMonth: true,
      reviewedAt: "2026-07-15T10:00:00.000Z",
    },
    {
      id: "emp_002",
      name: "Example Leave Employee",
      status: "onLeave",
      hasPayrollProfile: false,
      ready: false,
      missingFields: ["nss", "irpfPct", "salaryGrossAnnual", "formaPago"],
      reviewedForMonth: null,
      reviewedThisMonth: false,
      reviewedAt: null,
    },
  ],
  summary: {
    total: 2,
    ready: 1,
    notReady: 1,
    reviewedThisMonth: 1,
  },
};

const CURRENT_PERIOD = {
  fiscalYear: "2026",
  fiscalYearStart: "01-01",
  status: "closed",
  dateRange: { from: "2026-01-01", to: "2026-12-31" },
  closing: {
    status: "closed",
    closedAt: "2027-01-15T10:00:00.000Z",
    netIncome: 22_000,
    totalIncome: 30_000,
    totalExpenses: 8_000,
    journalEntries: 42,
  },
};

const PERIOD_2025 = {
  fiscalYear: "2025",
  fiscalYearStart: "01-01",
  status: "open",
  dateRange: { from: "2025-01-01", to: "2025-12-31" },
  closing: null,
};

const requestCounts = new Map<string, number>();
let httpServer: Server;
let baseUrl: string;

function envelope(data: unknown): { data: unknown; meta: { requestId: string } } {
  return { data, meta: { requestId: "req_contract_138" } };
}

function count(path: string): number {
  return requestCounts.get(path) ?? 0;
}

before(async () => {
  httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requestCounts.set(url.pathname, count(url.pathname) + 1);
    res.setHeader("Content-Type", "application/json");

    const send = (data: unknown): void => {
      res.end(JSON.stringify(envelope(data)));
    };

    if (req.method === "GET" && url.pathname === "/time-entries/overtime") {
      assert.equal(url.searchParams.get("period"), "2026-07");
      if (url.searchParams.get("employeeId") === "double-envelope") {
        return send(envelope(OVERTIME));
      }
      assert.equal(url.searchParams.has("employeeId"), false);
      return send(OVERTIME);
    }
    if (req.method === "GET" && url.pathname === "/payroll/prep/export") {
      assert.equal(url.searchParams.get("format"), "a3");
      assert.equal(url.searchParams.get("month"), "2026-07");
      return send(PAYROLL_EXPORT);
    }
    if (req.method === "GET" && url.pathname === "/payroll/prep/employees") {
      assert.equal(url.searchParams.get("month"), "2026-07");
      return send(PAYROLL_CHECKLIST);
    }
    if (req.method === "GET" && url.pathname === "/periods/current") {
      return send(CURRENT_PERIOD);
    }
    if (req.method === "GET" && url.pathname === "/periods/2025") {
      return send(PERIOD_2025);
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function realClient(): FrihetClient {
  return new FrihetClient("fri_test_key", baseUrl);
}

function assertOneGet(path: string, beforeCount: number): void {
  assert.equal(count(path), beforeCount + 1, `${path} must perform exactly one GET`);
}

function assertUnwrapped(result: Record<string, unknown>): void {
  assert.equal("data" in result, false, "ERP data envelope must be removed exactly once");
  assert.equal("meta" in result, false, "ERP meta envelope must not reach MCP output");
}

describe("real client — unwraps each #138 read envelope with one GET", () => {
  test("overtime report", async () => {
    const beforeCount = count("/time-entries/overtime");
    const result = await realClient().getOvertimeReport({ period: "2026-07" });
    assertOneGet("/time-entries/overtime", beforeCount);
    assertUnwrapped(result);
    assert.deepEqual(result, OVERTIME);
  });

  test("nested data envelope is unwrapped exactly once without a second GET", async () => {
    const beforeCount = count("/time-entries/overtime");
    const result = await realClient().getOvertimeReport({
      period: "2026-07",
      employeeId: "double-envelope",
    });
    assertOneGet("/time-entries/overtime", beforeCount);
    assert.deepEqual(result, envelope(OVERTIME), "client must remove only the transport's outer envelope");
  });

  test("payroll export", async () => {
    const beforeCount = count("/payroll/prep/export");
    const result = await realClient().exportPayroll({ format: "a3", month: "2026-07" });
    assertOneGet("/payroll/prep/export", beforeCount);
    assertUnwrapped(result);
    assert.deepEqual(result, PAYROLL_EXPORT);
  });

  test("payroll checklist", async () => {
    const beforeCount = count("/payroll/prep/employees");
    const result = await realClient().getPayrollChecklist({ month: "2026-07" });
    assertOneGet("/payroll/prep/employees", beforeCount);
    assertUnwrapped(result);
    assert.deepEqual(result, PAYROLL_CHECKLIST);
  });

  test("current period", async () => {
    const beforeCount = count("/periods/current");
    const result = await realClient().getCurrentPeriod();
    assertOneGet("/periods/current", beforeCount);
    assertUnwrapped(result);
    assert.deepEqual(result, CURRENT_PERIOD);
  });

  test("explicit fiscal-year period", async () => {
    const beforeCount = count("/periods/2025");
    const result = await realClient().getCurrentPeriod({ fiscalYear: "2025" });
    assertOneGet("/periods/2025", beforeCount);
    assertUnwrapped(result);
    assert.deepEqual(result, PERIOD_2025);
  });
});

describe("current ERP DTO schemas", () => {
  test("accept current DTOs", () => {
    assert.equal(overtimeReportOutput.safeParse(OVERTIME).success, true);
    assert.equal(payrollExportOutput.safeParse(PAYROLL_EXPORT).success, true);
    assert.equal(payrollChecklistOutput.safeParse(PAYROLL_CHECKLIST).success, true);
    assert.equal(currentPeriodOutput.safeParse(CURRENT_PERIOD).success, true);
  });

  test("accepts both nullable and populated current-period closing DTOs", () => {
    assert.equal(currentPeriodOutput.safeParse(PERIOD_2025).success, true);
    assert.equal(currentPeriodOutput.safeParse(CURRENT_PERIOD).success, true);
    assert.equal(currentPeriodOutput.safeParse({
      ...CURRENT_PERIOD,
      closing: {
        status: "closed",
        closedAt: null,
        netIncome: null,
        totalIncome: null,
        totalExpenses: null,
        journalEntries: null,
      },
    }).success, true);
  });

  test("all four schemas reject raw {data,meta} envelopes", () => {
    assert.equal(overtimeReportOutput.safeParse(envelope(OVERTIME)).success, false);
    assert.equal(payrollExportOutput.safeParse(envelope(PAYROLL_EXPORT)).success, false);
    assert.equal(payrollChecklistOutput.safeParse(envelope(PAYROLL_CHECKLIST)).success, false);
    assert.equal(currentPeriodOutput.safeParse(envelope(CURRENT_PERIOD)).success, false);
  });

  test("overtime rejects fabricated quarterly/cost shape", () => {
    assert.equal(overtimeReportOutput.safeParse({
      period: "2026-Q3",
      totalRegularHours: 480,
      totalOvertimeHours: 12,
      estimatedCostEur: 480,
      byEmployee: [],
    }).success, false);
    assert.equal(overtimeReportOutput.safeParse({ ...OVERTIME, generatedAt: "2026-07-31T00:00:00Z" }).success, false);
  });

  test("payroll export rejects fabricated generated-file shape", () => {
    assert.equal(payrollExportOutput.safeParse({
      month: "2026-07",
      format: "holded",
      fileUrl: "https://files.example.test/payroll.csv",
      filename: "payroll.csv",
      rowCount: 2,
    }).success, false);
  });

  test("payroll checklist rejects obsolete aggregate shape", () => {
    assert.equal(payrollChecklistOutput.safeParse({
      month: "2026-07",
      totalEmployees: 2,
      readyEmployees: 1,
      missingEmployees: 1,
      employees: [],
    }).success, false);
  });

  test("current period rejects fabricated quarterly-period shape", () => {
    assert.equal(currentPeriodOutput.safeParse({
      id: "period_2026_q3",
      type: "quarterly",
      status: "open",
      startDate: "2026-07-01",
      endDate: "2026-09-30",
    }).success, false);
    assert.equal(currentPeriodOutput.safeParse({
      ...CURRENT_PERIOD,
      closedAt: "2027-01-15T10:00:00.000Z",
      closedBy: "user_001",
      reopenedAt: null,
      reopenReason: null,
      generatedAt: "2027-01-15T10:00:00.000Z",
    }).success, false);
  });

  test("overtime requires every field emitted by the ERP DTO", () => {
    const incomplete = { ...OVERTIME, monthlyTotal: undefined };
    assert.equal(overtimeReportOutput.safeParse(incomplete).success, false);
  });

  test("payroll export requires ready-employee identity, tax, salary, and payment fields", () => {
    const incomplete = {
      ...PAYROLL_EXPORT,
      employees: [{ ...PAYROLL_EXPORT.employees[0], nss: undefined }],
    };
    assert.equal(payrollExportOutput.safeParse(incomplete).success, false);
  });

  test("payroll checklist requires the ERP summary and readiness fields", () => {
    const incomplete = { ...PAYROLL_CHECKLIST, summary: undefined };
    assert.equal(payrollChecklistOutput.safeParse(incomplete).success, false);
  });

  test("current period requires fiscal-year range and nullable closing field", () => {
    const incomplete = { ...CURRENT_PERIOD, closing: undefined };
    assert.equal(currentPeriodOutput.safeParse(incomplete).success, false);
  });

  test("demo read fixtures satisfy the same four current DTO schemas", async () => {
    const demo = new DemoFrihetClient();
    assert.equal(overtimeReportOutput.safeParse(await demo.getOvertimeReport({ period: "2026-07" })).success, true);
    assert.equal(payrollExportOutput.safeParse(await demo.exportPayroll({ format: "a3", month: "2026-07" })).success, true);
    assert.equal(payrollChecklistOutput.safeParse(await demo.getPayrollChecklist({ month: "2026-07" })).success, true);
    assert.equal(currentPeriodOutput.safeParse(await demo.getCurrentPeriod()).success, true);
  });

  test("public leak gate scans every functional payroll contract copy", async () => {
    const gate = await readFile("scripts/no-public-leak.sh", "utf8");
    for (const source of [
      "src/client.ts",
      "src/client-interface.ts",
      "src/demo-client.ts",
      "src/tools/payroll.ts",
      "src/tools/shared.ts",
    ]) {
      assert.match(gate, new RegExp(source.replace(/[./]/g, "\\$&")));
    }
    assert.doesNotMatch(gate, /lawful referential|intentionally NOT scanned/i);
  });
});

describe("real MCP SDK — current DTOs survive output validation", () => {
  test("all four tools return flat current ERP records", async () => {
    const server = new McpServer(
      { name: "frihet-contract-138-test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    const implementation = realClient();
    registerHrTools(server, implementation);
    registerPayrollTools(server, implementation);
    registerAccountingCloseTools(server, implementation);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "frihet-contract-138-client", version: "0.0.0" },
      { capabilities: {} },
    );

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const { tools } = await client.listTools();
      const byName = (name: string) => tools.find((tool) => tool.name === name);
      const overtimeDescription = byName("overtime_report")?.description ?? "";
      assert.doesNotMatch(overtimeDescription, /quarter|estimated cost/i);
      assert.match(overtimeDescription, /daily and weekly overtime/i);
      assert.match(overtimeDescription, /selected period/i);
      assert.match(overtimeDescription, /periodo seleccionado/i);
      const exportDescription = byName("payroll_export")?.description ?? "";
      assert.doesNotMatch(exportDescription, /holded|fileUrl|generated URL/i);
      assert.match(exportDescription, /identical across formats/i);
      assert.match(exportDescription, /No CSV, XML, PDF/i);
      const checklistDescription = byName("payroll_checklist")?.description ?? "";
      assert.match(checklistDescription, /payroll profile/i);
      assert.match(checklistDescription, /fields are missing/i);
      assert.doesNotMatch(checklistDescription, /pending leaves|anomalies|blocked/i);
      const periodDescription = byName("period_close_status")?.description ?? "";
      assert.match(periodDescription, /four-digit fiscal-year label/i);

      const calls = [
        ["overtime_report", { period: "2026-07" }, OVERTIME, "/time-entries/overtime"],
        ["payroll_export", { format: "a3", month: "2026-07" }, PAYROLL_EXPORT, "/payroll/prep/export"],
        ["payroll_checklist", { month: "2026-07" }, PAYROLL_CHECKLIST, "/payroll/prep/employees"],
        ["period_close_status", {}, CURRENT_PERIOD, "/periods/current"],
      ] as const;

      for (const [name, args, expected, path] of calls) {
        const beforeCount = count(path);
        const result = await client.callTool({ name, arguments: args });
        assertOneGet(path, beforeCount);
        assert.equal(result.isError, undefined, `${name} must pass real SDK output validation`);
        assert.deepEqual(result.structuredContent, expected);
      }

      const explicitBefore = count("/periods/2025");
      const explicit = await client.callTool({
        name: "period_close_status",
        arguments: { periodId: "2025" },
      });
      assertOneGet("/periods/2025", explicitBefore);
      assert.equal(explicit.isError, undefined);
      assert.deepEqual(explicit.structuredContent, PERIOD_2025);

      const quarterlyBefore = count("/time-entries/overtime");
      const quarterly = await client.callTool({
        name: "overtime_report",
        arguments: { period: "2026-Q3" },
      });
      assert.equal(quarterly.isError, true, "quarterly overtime input is not an ERP capability");
      assert.equal(count("/time-entries/overtime"), quarterlyBefore, "invalid overtime input must not call ERP");

      const emptyEmployee = await client.callTool({
        name: "overtime_report",
        arguments: { period: "2026-07", employeeId: "" },
      });
      assert.equal(emptyEmployee.isError, true, "empty employeeId must fail input validation");
      assert.equal(count("/time-entries/overtime"), quarterlyBefore, "empty employeeId must not call ERP");

      const holdedBefore = count("/payroll/prep/export");
      const holded = await client.callTool({
        name: "payroll_export",
        arguments: { format: "holded", month: "2026-07" },
      });
      assert.equal(holded.isError, true, "holded is not an accepted ERP payroll format");
      assert.equal(count("/payroll/prep/export"), holdedBefore, "invalid format must not call ERP");

      const checklistBefore = count("/payroll/prep/employees");
      const invalidMonth = await client.callTool({
        name: "payroll_checklist",
        arguments: { month: "2026-13" },
      });
      assert.equal(invalidMonth.isError, true, "payroll month must be a real YYYY-MM month");
      assert.equal(count("/payroll/prep/employees"), checklistBefore, "invalid month must not call ERP");

      const exportBefore = count("/payroll/prep/export");
      const zeroMonth = await client.callTool({
        name: "payroll_export",
        arguments: { format: "a3", month: "2026-00" },
      });
      assert.equal(zeroMonth.isError, true, "month 00 must fail input validation");
      assert.equal(count("/payroll/prep/export"), exportBefore, "month 00 must not call ERP");

      const invalidFiscalYear = await client.callTool({
        name: "period_close_status",
        arguments: { periodId: "period_2026_q3" },
      });
      assert.equal(invalidFiscalYear.isError, true, "periodId compatibility input must be exactly YYYY");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
