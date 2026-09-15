/**
 * Impuesto sobre Sociedades (IS) tools for the Frihet MCP server — Day 1 Megasprint (2 tools).
 *
 * Tools:
 *   1. frihet_modelo_200_summary — Modelo 200 IS anual (annual corporate tax return)
 *   2. frihet_modelo_202_summary — Modelo 202 IS pagos fraccionados (3 installment payments)
 *
 * REST surface: Frihet-ERP functions/src/publicApi.ts has NO /v1/is/* route,
 * so both tools return NOT_DEPLOYED without calling (capability truth:
 * `unavailable`, src/capability-truth.ts).
 *
 * Scope: Spanish SLs (Sociedad Limitada) and SAs filing corporate tax with AEAT.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import {
  withToolLogging,
  openObjectOutput,
  READ_ONLY_ANNOTATIONS,
} from "./shared.js";
import { notDeployedError } from "./backend-availability.js";

export function registerImpuestoSociedadesTools(server: McpServer, _client: IFrihetClient): void {
  // -- frihet_modelo_200_summary -------------------------------------------

  server.registerTool(
    "frihet_modelo_200_summary",
    {
      title: "Get Modelo 200 Summary (Corporate Tax — Annual IS)",
      description:
        "NOT DEPLOYED: Modelo 200 (annual corporate income tax return, Impuesto sobre Sociedades) has no Frihet backend yet; " +
        "calling this tool returns a NOT_DEPLOYED error and never data. " +
        "/ NO DESPLEGADO: el Modelo 200 (declaracion anual del Impuesto sobre Sociedades) aun no tiene backend en Frihet; " +
        "devuelve un error NOT_DEPLOYED y nunca datos.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        year: z.string().optional().describe("Fiscal year (e.g. '2025', defaults to last closed year) / Ejercicio fiscal (ej. '2025', por defecto ultimo ejercicio cerrado)"),
      },
      outputSchema: openObjectOutput(
        "Modelo 200 annual corporate tax summary: taxable base, deductions, rate, net payable / Resumen anual IS: base, deducciones, tipo, cuota",
      ),
    },
    async () => withToolLogging("frihet_modelo_200_summary", async () =>
      notDeployedError("frihet_modelo_200_summary", "/v1/is/modelo/200"),
    ),
  );

  // -- frihet_modelo_202_summary -------------------------------------------

  server.registerTool(
    "frihet_modelo_202_summary",
    {
      title: "Get Modelo 202 Summary (Corporate Tax — Installment Payments)",
      description:
        "NOT DEPLOYED: Modelo 202 (Impuesto sobre Sociedades installment payments, 1P/2P/3P) has no Frihet backend yet; " +
        "calling this tool returns a NOT_DEPLOYED error and never data. " +
        "/ NO DESPLEGADO: el Modelo 202 (pagos fraccionados del Impuesto sobre Sociedades) aun no tiene backend en Frihet; " +
        "devuelve un error NOT_DEPLOYED y nunca datos.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        year: z.string().optional().describe("Fiscal year of the installments (e.g. '2026') / Ejercicio de los pagos fraccionados (ej. '2026')"),
        installment: z.enum(["1P", "2P", "3P"]).optional().describe("Specific installment (1P=April, 2P=October, 3P=December) or omit for all three / Plazo especifico (1P=abril, 2P=octubre, 3P=diciembre) u omitir para los tres"),
      },
      outputSchema: openObjectOutput(
        "Modelo 202 installment payments: amounts, due dates, payment status / Pagos fraccionados Modelo 202: importes, plazos, estado",
      ),
    },
    async () => withToolLogging("frihet_modelo_202_summary", async () =>
      notDeployedError("frihet_modelo_202_summary", "/v1/is/modelo/202"),
    ),
  );
}
