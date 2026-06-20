/**
 * Impuesto sobre Sociedades (IS) tools for the Frihet MCP server — Day 1 Megasprint (2 tools).
 *
 * Tools:
 *   1. frihet_modelo_200_summary — Modelo 200 IS anual (annual corporate tax return)
 *   2. frihet_modelo_202_summary — Modelo 202 IS pagos fraccionados (3 installment payments)
 *
 * REST surface: /v1/is/* — service-layer reads of workspace IS data.
 *   Backend callables: #392 Modelo 200/202 IS (Frihet-ERP PR #392).
 *   Tools surface 404 until REST shell ships.
 *
 * Scope: Spanish SLs (Sociedad Limitada) and SAs filing corporate tax with AEAT.
 * Canary Islands variant: same models apply; ATC collects IS with territorial adjustments.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import {
  withToolLogging,
  formatRecord,
  getContent,
  READ_ONLY_ANNOTATIONS,
} from "./shared.js";
import { withBackendGuard } from "./backend-availability.js";

export function registerImpuestoSociedadesTools(server: McpServer, client: IFrihetClient): void {
  // -- frihet_modelo_200_summary -------------------------------------------

  server.registerTool(
    "frihet_modelo_200_summary",
    {
      title: "Get Modelo 200 Summary (Corporate Tax — Annual IS)",
      description:
        "Get Modelo 200 summary — annual corporate income tax return (Impuesto sobre Sociedades) " +
        "for Spanish SLs and SAs. Returns taxable base, deductions, tax rate, withholdings, " +
        "installment payments made (M202), and net payable/refundable. " +
        "Filing deadline: 25 days after 6 months from fiscal year end (typically 25 July for Dec FY). " +
        "Example: year='2025'. " +
        "/ Resumen Modelo 200 — declaracion anual del Impuesto sobre Sociedades para SL/SA. " +
        "Devuelve base imponible, deducciones, tipo, retenciones, pagos fraccionados y cuota.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        year: z.string().optional().describe("Fiscal year (e.g. '2025', defaults to last closed year) / Ejercicio fiscal (ej. '2025', por defecto ultimo ejercicio cerrado)"),
      },
    },
    async ({ year }) => withToolLogging("frihet_modelo_200_summary", () =>
      withBackendGuard("frihet_modelo_200_summary", "/v1/is/200", async () => {
        const result = await client.getISSummary("200", { year });
        return {
          content: [getContent(formatRecord("Modelo 200 Summary (IS Anual)", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );

  // -- frihet_modelo_202_summary -------------------------------------------

  server.registerTool(
    "frihet_modelo_202_summary",
    {
      title: "Get Modelo 202 Summary (Corporate Tax — Installment Payments)",
      description:
        "Get Modelo 202 summary — installment payments (pagos fraccionados) for Impuesto sobre Sociedades. " +
        "Three annual payments: April (1P), October (2P), December (3P). " +
        "Returns each installment amount, due date, payment status, and cumulative total vs M200 projection. " +
        "Example: year='2026', installment='1P'. " +
        "/ Resumen Modelo 202 — pagos fraccionados del Impuesto sobre Sociedades. " +
        "Tres plazos: abril (1P), octubre (2P), diciembre (3P). Devuelve importes, plazos y estado de pago.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        year: z.string().optional().describe("Fiscal year of the installments (e.g. '2026') / Ejercicio de los pagos fraccionados (ej. '2026')"),
        installment: z.enum(["1P", "2P", "3P"]).optional().describe("Specific installment (1P=April, 2P=October, 3P=December) or omit for all three / Plazo especifico (1P=abril, 2P=octubre, 3P=diciembre) u omitir para los tres"),
      },
    },
    async ({ year, installment }) => withToolLogging("frihet_modelo_202_summary", () =>
      withBackendGuard("frihet_modelo_202_summary", "/v1/is/202", async () => {
        const result = await client.getISSummary("202", { year, installment });
        const label = installment
          ? `Modelo 202 Summary (${installment} ${year ?? ""})`
          : `Modelo 202 Summary (all installments ${year ?? ""})`;
        return {
          content: [getContent(formatRecord(label.trim(), result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );
}
