/**
 * Fiscal tools for the Frihet MCP server — Wave 6 (7 tools).
 *
 * Tools:
 *   1. get_modelo_303_summary   — IVA quarterly Spain
 *   2. get_modelo_130_summary   — IRPF estimated payment Spain
 *   3. get_modelo_390_summary   — IVA annual recap Spain
 *   4. get_modelo_180_summary   — IRPF rentals annual Spain
 *   5. get_modelo_347_summary   — Operations >€3005 annual third-party recap
 *   6. verifactu_status         — VeriFactu submission status for an invoice
 *   7. verifactu_resubmit       — Re-submit a failed VeriFactu submission (TRUST AREA)
 *
 * NOTE: ticketbai_status is registered by einvoice.ts (canonical, more complete impl).
 *
 * REST surface: /v1/fiscal/* (documented: pending — backend ships separately)
 *
 * NOTE: ERP backend endpoints /v1/fiscal/* are planned. Tools are wired
 * and will surface 404 errors until the backend ships.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import {
  withToolLogging,
  formatRecord,
  getContent,
  mutateContent,
  READ_ONLY_ANNOTATIONS,
  fiscalModeloSummaryOutput,
  verifactuStatusOutput,
} from "./shared.js";

export function registerFiscalTools(server: McpServer, client: IFrihetClient): void {
  // -- get_modelo_303_summary --

  server.registerTool(
    "get_modelo_303_summary",
    {
      title: "Get Modelo 303 Summary (IVA Quarterly)",
      description:
        "Get IVA (VAT) quarterly summary for Modelo 303 filing in Spain. " +
        "Returns aggregated totals by tax rate, deductible IVA, net amount due, and filing deadline. " +
        "Example: period='2026-Q1' / " +
        "Obtiene el resumen trimestral del IVA para el Modelo 303 en Espana. " +
        "Devuelve totales por tipo impositivo, IVA deducible, cuota a ingresar y plazo.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        period: z
          .string()
          .optional()
          .describe("Period in format YYYY-QN (e.g. '2026-Q1') or YYYY for annual / Periodo en formato YYYY-QN o YYYY"),
      },
      outputSchema: fiscalModeloSummaryOutput,
    },
    async ({ period }) => withToolLogging("get_modelo_303_summary", async () => {
      const result = await client.getFiscalModeloSummary("303", period);
      return {
        content: [getContent(formatRecord("Modelo 303 Summary", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_modelo_130_summary --

  server.registerTool(
    "get_modelo_130_summary",
    {
      title: "Get Modelo 130 Summary (IRPF Estimated Payment)",
      description:
        "Get IRPF estimated payment summary for Modelo 130 filing (freelancers/self-employed in Spain). " +
        "Returns quarterly net income, deductible expenses, previous payments, and amount due. " +
        "Example: period='2026-Q1' / " +
        "Obtiene el resumen del pago fraccionado IRPF para el Modelo 130 (autonomos). " +
        "Devuelve rendimiento neto, gastos deducibles, pagos previos y cuota a ingresar.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        period: z
          .string()
          .optional()
          .describe("Period in format YYYY-QN (e.g. '2026-Q1') / Periodo en formato YYYY-QN"),
      },
      outputSchema: fiscalModeloSummaryOutput,
    },
    async ({ period }) => withToolLogging("get_modelo_130_summary", async () => {
      const result = await client.getFiscalModeloSummary("130", period);
      return {
        content: [getContent(formatRecord("Modelo 130 Summary", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_modelo_390_summary --

  server.registerTool(
    "get_modelo_390_summary",
    {
      title: "Get Modelo 390 Summary (IVA Annual Recap)",
      description:
        "Get IVA annual summary for Modelo 390 filing in Spain. " +
        "Returns full-year totals by rate, total deductible IVA, and annual balance. " +
        "Example: period='2025' / " +
        "Obtiene el resumen anual del IVA para el Modelo 390. " +
        "Devuelve totales anuales por tipo, IVA deducible total y resultado anual.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        period: z
          .string()
          .optional()
          .describe("Year in format YYYY (e.g. '2025') / Ejercicio en formato YYYY"),
      },
      outputSchema: fiscalModeloSummaryOutput,
    },
    async ({ period }) => withToolLogging("get_modelo_390_summary", async () => {
      const result = await client.getFiscalModeloSummary("390", period);
      return {
        content: [getContent(formatRecord("Modelo 390 Summary", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_modelo_180_summary --

  server.registerTool(
    "get_modelo_180_summary",
    {
      title: "Get Modelo 180 Summary (IRPF Rentals Annual)",
      description:
        "Get IRPF annual informative summary for rental income withholdings (Modelo 180, Spain). " +
        "Returns total retentions per tenant, property, and annual aggregate. " +
        "Example: period='2025' / " +
        "Obtiene el resumen anual de retenciones sobre alquileres para el Modelo 180. " +
        "Devuelve retenciones totales por inquilino, inmueble y agregado anual.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        period: z
          .string()
          .optional()
          .describe("Year in format YYYY (e.g. '2025') / Ejercicio en formato YYYY"),
      },
      outputSchema: fiscalModeloSummaryOutput,
    },
    async ({ period }) => withToolLogging("get_modelo_180_summary", async () => {
      const result = await client.getFiscalModeloSummary("180", period);
      return {
        content: [getContent(formatRecord("Modelo 180 Summary", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_modelo_347_summary --

  server.registerTool(
    "get_modelo_347_summary",
    {
      title: "Get Modelo 347 Summary (Operations >€3,005 Annual Recap)",
      description:
        "Get annual informative summary of operations exceeding €3,005 per counterparty (Modelo 347, Spain). " +
        "Returns per-party totals for clients and vendors above the threshold. " +
        "Example: period='2025' / " +
        "Obtiene el resumen anual de operaciones con terceros superiores a 3.005€ (Modelo 347). " +
        "Devuelve totales por cliente/proveedor que superen el umbral.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        period: z
          .string()
          .optional()
          .describe("Year in format YYYY (e.g. '2025') / Ejercicio en formato YYYY"),
      },
      outputSchema: fiscalModeloSummaryOutput,
    },
    async ({ period }) => withToolLogging("get_modelo_347_summary", async () => {
      const result = await client.getFiscalModeloSummary("347", period);
      return {
        content: [getContent(formatRecord("Modelo 347 Summary", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- verifactu_status --

  server.registerTool(
    "verifactu_status",
    {
      title: "Get VeriFactu Submission Status",
      description:
        "Get the VeriFactu (AEAT Spanish e-invoice chain) submission status for a specific invoice. " +
        "Returns last submission timestamp, hash, AEAT response code, and QR verification URL. " +
        "/ Obtiene el estado de envio VeriFactu (AEAT) para una factura especifica. " +
        "Devuelve timestamp del ultimo envio, hash, respuesta AEAT y URL del codigo QR.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        invoiceId: z.string().describe("Invoice ID / ID de la factura"),
      },
      outputSchema: verifactuStatusOutput,
    },
    async ({ invoiceId }) => withToolLogging("verifactu_status", async () => {
      const result = await client.getVerifactuStatus(invoiceId);
      return {
        content: [getContent(formatRecord("VeriFactu Status", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- verifactu_resubmit --

  server.registerTool(
    "verifactu_resubmit",
    {
      title: "Re-submit VeriFactu Submission",
      description:
        "TRUST AREA — COMPLIANCE. Re-submit a failed or rejected VeriFactu submission to AEAT. " +
        "Idempotent: uses the same hash chain; AEAT deduplicates by hash. " +
        "Creates an audit trail entry for every resubmission attempt. " +
        "Requires confirm=true. Only use on invoices with status='failed'. " +
        "/ AREA DE CONFIANZA — COMPLIANCE. Reenvio de una factura VeriFactu fallida a AEAT. " +
        "Idempotente: misma cadena hash. Registra entrada de auditoria en cada intento. " +
        "Requiere confirm=true. Solo para facturas con status='failed'.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        invoiceId: z.string().describe("Invoice ID to resubmit / ID de la factura a reenviar"),
        confirm: z
          .boolean()
          .describe("Must be true to confirm VeriFactu resubmission / Debe ser true para confirmar el reenvio"),
      },
      outputSchema: verifactuStatusOutput,
    },
    async ({ invoiceId, confirm }) => withToolLogging("verifactu_resubmit", async () => {
      if (!confirm) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: confirm=true is required for VeriFactu resubmission. " +
                "This is a COMPLIANCE action that submits fiscal data to AEAT. " +
                "Verify the invoice data is correct before setting confirm=true. / " +
                "Se requiere confirm=true para el reenvio VeriFactu. Accion de COMPLIANCE que envia datos fiscales a AEAT.",
            },
          ],
          isError: true,
        };
      }
      const result = await client.resubmitVerifactu(invoiceId);
      return {
        content: [mutateContent(formatRecord("VeriFactu Resubmitted", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

}

