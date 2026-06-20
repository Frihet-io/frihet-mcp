/**
 * Payroll preparation tools for the Frihet MCP server — D4-B megasprint (2 tools).
 *
 * Tools:
 *   1. payroll_export    — export payroll for a month in gestoria format (A3, Contasol, Sage, Holded, Siltra)
 *   2. payroll_checklist — list employees with status (ready / missing_data / blocked) for a month
 *
 * REST surface: /v1/payroll/prep/export, /v1/payroll/prep/employees
 *
 * Frihet does NOT process payroll. It exports to gestoria-compatible formats so
 * the asesoria handles SS/IRPF/contracts. Output formats track the most common
 * Spanish payroll software clusters.
 *
 * NOTE: ERP backend endpoints land in parallel D4-A wave. 404s propagate as isError
 * until backend ships. TODO: confirm A3 columns + SILTRA file extension.
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
      title: "Export Payroll (Gestoria Format)",
      description:
        "Export payroll data for a month in gestoria-compatible format. " +
        "Supported formats:\n" +
        "  - 'a3'       — Wolters Kluwer A3 (CSV with Spanish payroll columns)\n" +
        "  - 'contasol' — Sage Contasol\n" +
        "  - 'sage'     — Sage 50/200\n" +
        "  - 'holded'   — Holded import format\n" +
        "  - 'siltra'   — SILTRA Seguridad Social XML\n" +
        "\n" +
        "Frihet does NOT calculate payroll — it exports staged data for the gestoria. " +
        "Month format: 'YYYY-MM'. " +
        "/ Exporta datos de nominas en formato compatible con gestoria. Mes en formato 'YYYY-MM'.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        format: z
          .enum(["a3", "contasol", "sage", "holded", "siltra"])
          .describe("Gestoria payroll software format / Formato del software de gestoria"),
        month: z.string().regex(/^\d{4}-\d{2}$/).describe("Month in 'YYYY-MM' format / Mes formato 'YYYY-MM'"),
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
        "List all employees for a given month with their payroll readiness status. " +
        "Status values:\n" +
        "  - 'ready'         — all required data present, ready to export\n" +
        "  - 'missing_data'  — some required fields missing (see missingFields[])\n" +
        "  - 'blocked'       — manually blocked or data inconsistency detected\n" +
        "\n" +
        "Use BEFORE payroll_export to identify gaps. Month format: 'YYYY-MM'. " +
        "/ Lista empleados con estado de preparacion para nomina. Usar antes de payroll_export.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        month: z.string().regex(/^\d{4}-\d{2}$/).describe("Month in 'YYYY-MM' format / Mes formato 'YYYY-MM'"),
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
