/**
 * Payroll preparation tools for the Frihet MCP server — D4-B megasprint (2 tools).
 *
 * Tools:
 *   1. payroll_export    — read the normalized export-ready employee dataset
 *   2. payroll_checklist — read payroll-profile readiness for payable employees
 *
 * REST surface: /v1/payroll/prep/export, /v1/payroll/prep/employees
 *
 * The ERP validates and echoes a destination-format label but returns the same
 * normalized JSON dataset for each value. It does not generate a format-specific
 * file, and Frihet does not process payroll. These read routes are live.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import {
  withToolLogging,
  formatRecord,
  getContent,
  READ_ONLY_ANNOTATIONS,
  payrollExportOutput,
  payrollChecklistOutput,
} from "./shared.js";
import { withBackendGuard } from "./backend-availability.js";

export function registerPayrollTools(server: McpServer, client: IFrihetClient): void {
  // -- payroll_export --

  server.registerTool(
    "payroll_export",
    {
      title: "Payroll Export-Ready Data",
      description:
        "Read the normalized payroll-ready employee dataset for a month. " +
        "The ERP accepts 'a3', 'contasol', 'sage', or 'siltra' as a destination label and echoes it; " +
        "the response is JSON and is identical across formats apart from that label. " +
        "No CSV, XML, PDF, or provider-specific file is generated. Frihet does not calculate payroll. " +
        "/ Lee los datos normalizados listos para nomina; no genera un archivo especifico del proveedor.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        format: z
          .enum(["a3", "contasol", "sage", "siltra"])
          .describe("Echoed destination label; does not change JSON serialization / Etiqueta de destino"),
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).describe("Month in 'YYYY-MM' format / Mes formato 'YYYY-MM'"),
      },
      outputSchema: payrollExportOutput,
    },
    async ({ format, month }) => withToolLogging("payroll_export", () =>
      withBackendGuard("payroll_export", "/v1/payroll/prep/export", async () => {
        const result = await client.exportPayroll({ format, month });
        return {
          content: [getContent(formatRecord("Payroll export", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );

  // -- payroll_checklist --

  server.registerTool(
    "payroll_checklist",
    {
      title: "Payroll Readiness Checklist",
      description:
        "List payable employees (active or on leave) for a month, whether each has a payroll profile, " +
        "whether its required fields are ready, which fields are missing, and monthly review state. " +
        "Suspended and offboarded employees are excluded. Use before payroll_export. " +
        "/ Lista empleados pagables y la preparacion real de su perfil de nomina.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).describe("Month in 'YYYY-MM' format / Mes formato 'YYYY-MM'"),
      },
      outputSchema: payrollChecklistOutput,
    },
    async ({ month }) => withToolLogging("payroll_checklist", () =>
      withBackendGuard("payroll_checklist", "/v1/payroll/prep/employees", async () => {
        const result = await client.getPayrollChecklist({ month });
        return {
          content: [getContent(formatRecord("Payroll checklist", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );
}
