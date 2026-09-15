/**
 * IGIC (Canary Islands indirect tax) tools for the Frihet MCP server — Day 1 Megasprint (4 tools).
 *
 * Tools:
 *   1. frihet_modelo_415_summary — M415 operations >€3,005 annual (Canarias) — NOT DEPLOYED
 *   2. frihet_modelo_425_summary — M425 resumen anual IGIC (Canarias) — NOT DEPLOYED
 *   3. frihet_modelo_418_summary — M418 autoliquidacion mensual individual, regimen especial
 *                                  del grupo de entidades (ATC) — NOT DEPLOYED
 *   4. frihet_aiem_calculate     — AIEM (Arbitrio sobre Importaciones y Entrega de Mercancías) — NOT DEPLOYED
 *
 * NOTE: ATC SOAP integration skipped — internal infrastructure, not exposed via MCP.
 *
 * REST surface: Frihet-ERP functions/src/publicApi.ts has NO /v1/igic/* route
 * (neither modelo summaries nor AIEM), so all four tools return NOT_DEPLOYED
 * without calling (capability truth: `unavailable`, src/capability-truth.ts).
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

export function registerIgicTools(server: McpServer, _client: IFrihetClient): void {
  // -- frihet_modelo_415_summary -------------------------------------------

  server.registerTool(
    "frihet_modelo_415_summary",
    {
      title: "Get Modelo 415 Summary (IGIC Annual Operations >€3,005)",
      description:
        "NOT DEPLOYED: IGIC Modelo 415 (annual declaration of operations with third parties exceeding €3,005, Canary Islands) " +
        "has no Frihet backend yet; calling this tool returns a NOT_DEPLOYED error and never data. " +
        "/ NO DESPLEGADO: el Modelo 415 IGIC (operaciones con terceros > €3.005) aun no tiene backend en Frihet; " +
        "devuelve un error NOT_DEPLOYED y nunca datos.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        year: z.string().optional().describe("Tax year (e.g. '2025', defaults to previous year) / Ejercicio fiscal (ej. '2025', por defecto ejercicio anterior)"),
      },
      outputSchema: openObjectOutput(
        "Modelo 415 summary: counterparty operations, totals and filing deadline / Resumen Modelo 415: operaciones, totales y plazo",
      ),
    },
    async () => withToolLogging("frihet_modelo_415_summary", async () =>
      notDeployedError("frihet_modelo_415_summary", "/v1/igic/modelo/415"),
    ),
  );

  // -- frihet_modelo_425_summary -------------------------------------------

  server.registerTool(
    "frihet_modelo_425_summary",
    {
      title: "Get Modelo 425 Summary (IGIC Annual Recap)",
      description:
        "NOT DEPLOYED: IGIC Modelo 425 (annual IGIC recap, Canary Islands) has no Frihet backend yet; " +
        "calling this tool returns a NOT_DEPLOYED error and never data. " +
        "/ NO DESPLEGADO: el Modelo 425 IGIC (resumen anual) aun no tiene backend en Frihet; " +
        "devuelve un error NOT_DEPLOYED y nunca datos.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        year: z.string().optional().describe("Tax year (e.g. '2025', defaults to previous year) / Ejercicio fiscal (ej. '2025', por defecto ejercicio anterior)"),
      },
      outputSchema: openObjectOutput(
        "Modelo 425 annual IGIC recap: IGIC collected, deductible, net payable / Resumen anual IGIC: repercutido, soportado, cuota",
      ),
    },
    async () => withToolLogging("frihet_modelo_425_summary", async () =>
      notDeployedError("frihet_modelo_425_summary", "/v1/igic/modelo/425"),
    ),
  );

  // -- frihet_modelo_418_summary -------------------------------------------

  server.registerTool(
    "frihet_modelo_418_summary",
    {
      title: "Get Modelo 418 Summary (IGIC Monthly, Group of Entities)",
      description:
        "NOT DEPLOYED: IGIC Modelo 418 is the monthly individual self-assessment filed by each entity (dominant and dependent) " +
        "under the special regime for groups of entities (regimen especial del grupo de entidades, Agencia Tributaria Canaria). " +
        "It has no Frihet backend yet; calling this tool returns a NOT_DEPLOYED error and never data. " +
        "/ NO DESPLEGADO: el Modelo 418 IGIC es la autoliquidacion mensual individual de cada entidad del regimen especial " +
        "del grupo de entidades (ATC). Aun no tiene backend en Frihet; devuelve un error NOT_DEPLOYED y nunca datos.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        period: z.string().optional().describe("Period in YYYY-MM format (defaults to last month) / Periodo YYYY-MM (por defecto mes anterior)"),
      },
      outputSchema: openObjectOutput(
        "Modelo 418 monthly IGIC summary (group of entities) / Resumen mensual IGIC del grupo de entidades",
      ),
    },
    async () => withToolLogging("frihet_modelo_418_summary", async () =>
      notDeployedError("frihet_modelo_418_summary", "/v1/igic/modelo/418"),
    ),
  );

  // -- frihet_aiem_calculate ------------------------------------------------

  server.registerTool(
    "frihet_aiem_calculate",
    {
      title: "Calculate AIEM (Arbitrio Importación Canarias)",
      description:
        "NOT DEPLOYED: AIEM (Arbitrio sobre Importaciones y Entrega de Mercancias, Canary Islands) calculation " +
        "has no Frihet backend yet; calling this tool returns a NOT_DEPLOYED error and never a rate or amount. " +
        "/ NO DESPLEGADO: el calculo del AIEM (Canarias) aun no tiene backend en Frihet; " +
        "devuelve un error NOT_DEPLOYED y nunca un tipo ni una cuota.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        ncCode: z.string().describe("Nomenclatura Combinada (NC) tariff code / Codigo NC (nomenclatura combinada)"),
        amount: z.number().describe("Taxable base amount in EUR / Base imponible en EUR"),
        description: z.string().optional().describe("Product description for audit reference / Descripcion del producto (referencia auditoria)"),
      },
      outputSchema: openObjectOutput(
        "AIEM calculation result: applicable rate, tax base and amount due / Resultado AIEM: tipo aplicable, base imponible y cuota",
      ),
    },
    async () => withToolLogging("frihet_aiem_calculate", async () =>
      notDeployedError("frihet_aiem_calculate", "/v1/igic/aiem/calculate"),
    ),
  );
}
