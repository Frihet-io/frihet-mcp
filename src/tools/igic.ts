/**
 * IGIC (Canary Islands indirect tax) tools for the Frihet MCP server — Day 1 Megasprint (4 tools).
 *
 * Tools:
 *   1. frihet_modelo_415_summary — M415 operations >€3,005 annual (Canarias)
 *   2. frihet_modelo_425_summary — M425 resumen anual IGIC (Canarias)
 *   3. frihet_modelo_418_summary — M418 mensual grandes empresas IGIC (Canarias)
 *   4. frihet_aiem_calculate     — Arbitrio sobre Importaciones y Entrega de Mercancías calculation
 *
 * NOTE: ATC SOAP integration skipped — internal infrastructure, not exposed via MCP.
 *
 * REST surface: /v1/igic/* — service-layer reads of workspace fiscal data.
 *   Backend callables: #390 IGIC services (Frihet-ERP PR #390).
 *   Tools surface 404 until REST shell ships.
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

export function registerIgicTools(server: McpServer, client: IFrihetClient): void {
  // -- frihet_modelo_415_summary -------------------------------------------

  server.registerTool(
    "frihet_modelo_415_summary",
    {
      title: "Get Modelo 415 Summary (IGIC Annual Operations >€3,005)",
      description:
        "Get IGIC Modelo 415 summary — annual declaration of operations with third parties exceeding €3,005. " +
        "Canary Islands equivalent of Modelo 347 (peninsular Spain). " +
        "Returns counterparty list, operation totals, and filing deadline. " +
        "Example: year='2025'. " +
        "/ Resumen del Modelo 415 IGIC — declaracion anual de operaciones con terceros > €3.005. " +
        "Equivalente canario del Modelo 347. Devuelve listado de contrapartes, totales y plazo.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        year: z.string().optional().describe("Tax year (e.g. '2025', defaults to previous year) / Ejercicio fiscal (ej. '2025', por defecto ejercicio anterior)"),
      },
    },
    async ({ year }) => withToolLogging("frihet_modelo_415_summary", async () => {
      const result = await client.getIgicModeloSummary("415", { year });
      return {
        content: [getContent(formatRecord("Modelo 415 Summary (IGIC)", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- frihet_modelo_425_summary -------------------------------------------

  server.registerTool(
    "frihet_modelo_425_summary",
    {
      title: "Get Modelo 425 Summary (IGIC Annual Recap)",
      description:
        "Get IGIC Modelo 425 summary — annual IGIC recap for Canary Islands businesses. " +
        "Returns aggregated IGIC collected, deductible IGIC, net payable, and filing status. " +
        "Example: year='2025'. " +
        "/ Resumen del Modelo 425 IGIC — resumen anual IGIC para empresas canarias. " +
        "Devuelve IGIC repercutido, IGIC soportado, cuota neta y estado de presentacion.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        year: z.string().optional().describe("Tax year (e.g. '2025', defaults to previous year) / Ejercicio fiscal (ej. '2025', por defecto ejercicio anterior)"),
      },
    },
    async ({ year }) => withToolLogging("frihet_modelo_425_summary", async () => {
      const result = await client.getIgicModeloSummary("425", { year });
      return {
        content: [getContent(formatRecord("Modelo 425 Summary (IGIC)", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- frihet_modelo_418_summary -------------------------------------------

  server.registerTool(
    "frihet_modelo_418_summary",
    {
      title: "Get Modelo 418 Summary (IGIC Monthly Large Enterprises)",
      description:
        "Get IGIC Modelo 418 summary — monthly IGIC return for large enterprises (grandes empresas) in the Canary Islands. " +
        "Returns monthly IGIC collected, deductible, net due, and any carryover. " +
        "Applicable when annual turnover exceeds the grandes empresas threshold. " +
        "Example: period='2026-04'. " +
        "/ Resumen del Modelo 418 IGIC — declaracion mensual para grandes empresas en Canarias. " +
        "Devuelve IGIC repercutido, soportado, cuota a ingresar y saldo a compensar.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        period: z.string().optional().describe("Period in YYYY-MM format (defaults to last month) / Periodo YYYY-MM (por defecto mes anterior)"),
      },
    },
    async ({ period }) => withToolLogging("frihet_modelo_418_summary", async () => {
      const result = await client.getIgicModeloSummary("418", { period });
      return {
        content: [getContent(formatRecord("Modelo 418 Summary (IGIC Monthly)", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- frihet_aiem_calculate ------------------------------------------------

  server.registerTool(
    "frihet_aiem_calculate",
    {
      title: "Calculate AIEM (Arbitrio Importación Canarias)",
      description:
        "Calculate the AIEM (Arbitrio sobre Importaciones y Entrega de Mercancias) for goods imported " +
        "to or produced in the Canary Islands. " +
        "Returns applicable AIEM rate, tax base, and amount due for the given product. " +
        "AIEM is a Canarian surcharge on top of IGIC for protected local industries. " +
        "Example: ncCode='8471', amount=1000, description='Ordenadores portatiles'. " +
        "/ Calcula el AIEM para mercancias importadas o producidas en Canarias. " +
        "Devuelve tipo aplicable, base imponible y cuota. El AIEM protege la industria local canaria.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        ncCode: z.string().describe("Nomenclatura Combinada (NC) tariff code / Codigo NC (nomenclatura combinada)"),
        amount: z.number().describe("Taxable base amount in EUR / Base imponible en EUR"),
        description: z.string().optional().describe("Product description for audit reference / Descripcion del producto (referencia auditoria)"),
      },
    },
    async ({ ncCode, amount, description }) => withToolLogging("frihet_aiem_calculate", async () => {
      const result = await client.calculateAiem({ ncCode, amount, description });
      return {
        content: [getContent(formatRecord(`AIEM Calculation (NC: ${ncCode})`, result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );
}
