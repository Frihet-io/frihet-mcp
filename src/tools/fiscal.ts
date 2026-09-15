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
 * REST surface: Frihet-ERP functions/src/publicApi.ts serves READ-ONLY
 * GET /v1/fiscal/modelo/{303,130,390,347}. Modelo 180 has no route; its tool
 * returns NOT_DEPLOYED without calling. Period params: src/fiscal-period.ts.
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
  ERROR_CONTENT_ANNOTATIONS,
  fiscalModeloSummaryOutput,
  verifactuStatusOutput,
} from "./shared.js";
import { withBackendGuard, isBackendNotFound, notDeployedError } from "./backend-availability.js";
import { FISCAL_PERIOD_RULES } from "../fiscal-period.js";

function fiscalPeriodError(
  toolName: string,
  structured: Record<string, unknown>,
  message: string,
) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}`, annotations: ERROR_CONTENT_ANNOTATIONS }],
    structuredContent: { ...structured, tool: toolName, message },
    isError: true as const,
  };
}

/**
 * READ-ONLY modelo summary with a fail-closed period contract:
 *   1. a supplied period must match the backend's own format, or no call is made;
 *   2. the modelo the backend reports (`modeloCode`/`model`) must be the one
 *      requested, or the figures are withheld (MODELO_MISMATCH);
 *   3. the period the backend reports must be well-formed and, when one was
 *      requested, identical to it — otherwise the figures belong to another
 *      period and are withheld (PERIOD_MISMATCH), never shown under the
 *      requested label.
 */
function invalidFiscalPeriod(toolName: string, modeloCode: string, period: string | undefined) {
  const rule = FISCAL_PERIOD_RULES[modeloCode];
  if (!rule) {
    return notDeployedError(toolName, `/v1/fiscal/modelo/${modeloCode}`);
  }
  if (period === undefined || rule.pattern.test(period)) return undefined;
  return fiscalPeriodError(
    toolName,
    { error: "invalid_period", code: "INVALID_PERIOD", modeloCode, requested: period, expectedFormat: rule.format },
    `Invalid period for Modelo ${modeloCode}: use ${rule.format}. No request was sent. ` +
      `/ Periodo no valido para el Modelo ${modeloCode}: usa ${rule.format}. No se ha enviado ninguna peticion.`,
  );
}

async function fiscalModeloSummary(
  client: IFrihetClient,
  toolName: string,
  modeloCode: string,
  period: string | undefined,
  title: string,
) {
  const rule = FISCAL_PERIOD_RULES[modeloCode];
  if (!rule) {
    return notDeployedError(toolName, `/v1/fiscal/modelo/${modeloCode}`);
  }
  const result = await client.getFiscalModeloSummary(modeloCode, period);
  // The backend names the modelo in `modeloCode` and/or legacy `model`
  // (Frihet-ERP publicApi.ts). Every key present must name the requested
  // modelo, and at least one must be present; otherwise another modelo's
  // figures would be shown under this one's label.
  const returnedModelos = [result["modeloCode"], result["model"]].filter((v) => v !== undefined);
  const modeloAgrees =
    returnedModelos.length > 0 && returnedModelos.every((v) => v === modeloCode);
  if (!modeloAgrees) {
    return fiscalPeriodError(
      toolName,
      {
        error: "modelo_mismatch",
        code: "MODELO_MISMATCH",
        requestedModelo: modeloCode,
        returnedModelo: returnedModelos.map((v) => (typeof v === "string" ? v : null)),
      },
      `Frihet returned a summary that is not identifiable as Modelo ${modeloCode}, so no figures are shown ` +
        `(they would be mislabelled). Do NOT state any amount for this modelo; retry or contact support. ` +
        `/ Frihet devolvio un resumen que no corresponde al Modelo ${modeloCode}; no se muestran cifras. ` +
        `NO indiques ningun importe para este modelo.`,
    );
  }
  const returned = typeof result["period"] === "string" ? result["period"] : null;
  const year = result["year"];
  const yearAgrees = year === undefined || (returned !== null && String(year) === returned);
  const matches =
    returned !== null &&
    rule.pattern.test(returned) &&
    yearAgrees &&
    (period === undefined || returned === period);
  if (!matches) {
    return fiscalPeriodError(
      toolName,
      { error: "period_mismatch", code: "PERIOD_MISMATCH", modeloCode, requested: period ?? null, returned },
      `Frihet returned a Modelo ${modeloCode} summary whose period does not match the request, so no figures are shown ` +
        `(they would be mislabelled). Do NOT state any amount for this period; retry or contact support. ` +
        `/ Frihet devolvio un resumen del Modelo ${modeloCode} de un periodo distinto al solicitado; no se muestran cifras. ` +
        `NO indiques ningun importe para este periodo.`,
    );
  }
  return {
    content: [getContent(formatRecord(title, result))],
    structuredContent: result as unknown as Record<string, unknown>,
  };
}

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
          .describe("Quarter in format YYYY-QN (e.g. '2026-Q1'); defaults to the current quarter / Trimestre en formato YYYY-QN; por defecto el trimestre actual"),
      },
      outputSchema: fiscalModeloSummaryOutput,
    },
    async ({ period }) => withToolLogging("get_modelo_303_summary", async () =>
      invalidFiscalPeriod("get_modelo_303_summary", "303", period) ??
        withBackendGuard("get_modelo_303_summary", "/v1/fiscal/modelo/303", () =>
          fiscalModeloSummary(client, "get_modelo_303_summary", "303", period, "Modelo 303 Summary"),
        ),
    ),
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
          .describe("Quarter in format YYYY-QN (e.g. '2026-Q1'); defaults to the current quarter / Trimestre en formato YYYY-QN; por defecto el trimestre actual"),
      },
      outputSchema: fiscalModeloSummaryOutput,
    },
    async ({ period }) => withToolLogging("get_modelo_130_summary", async () =>
      invalidFiscalPeriod("get_modelo_130_summary", "130", period) ??
        withBackendGuard("get_modelo_130_summary", "/v1/fiscal/modelo/130", () =>
          fiscalModeloSummary(client, "get_modelo_130_summary", "130", period, "Modelo 130 Summary"),
        ),
    ),
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
    async ({ period }) => withToolLogging("get_modelo_390_summary", async () =>
      invalidFiscalPeriod("get_modelo_390_summary", "390", period) ??
        withBackendGuard("get_modelo_390_summary", "/v1/fiscal/modelo/390", () =>
          fiscalModeloSummary(client, "get_modelo_390_summary", "390", period, "Modelo 390 Summary"),
        ),
    ),
  );

  // -- get_modelo_180_summary --

  server.registerTool(
    "get_modelo_180_summary",
    {
      title: "Get Modelo 180 Summary (IRPF Rentals Annual)",
      description:
        "NOT DEPLOYED: Modelo 180 (annual informative return of IRPF withholdings on rental income, Spain) has no Frihet backend yet; " +
        "calling this tool returns a NOT_DEPLOYED error and never data. " +
        "/ NO DESPLEGADO: el Modelo 180 (resumen anual de retenciones sobre alquileres) aun no tiene backend en Frihet; " +
        "esta herramienta devuelve un error NOT_DEPLOYED y nunca datos.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        period: z
          .string()
          .optional()
          .describe("Year in format YYYY (e.g. '2025') / Ejercicio en formato YYYY"),
      },
      outputSchema: fiscalModeloSummaryOutput,
    },
    async () => withToolLogging("get_modelo_180_summary", async () =>
      notDeployedError("get_modelo_180_summary", "/v1/fiscal/modelo/180"),
    ),
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
    async ({ period }) => withToolLogging("get_modelo_347_summary", async () =>
      invalidFiscalPeriod("get_modelo_347_summary", "347", period) ??
        withBackendGuard("get_modelo_347_summary", "/v1/fiscal/modelo/347", () =>
          fiscalModeloSummary(client, "get_modelo_347_summary", "347", period, "Modelo 347 Summary"),
        ),
    ),
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
    async ({ invoiceId }) => withToolLogging("verifactu_status", () =>
      withBackendGuard("verifactu_status", "/v1/fiscal/verifactu/status", async () => {
        // The status endpoint IS deployed (publicApi GET /fiscal/verifactu/:id/status)
        // and uses 404 for two APP-LEVEL states that must NOT be reported as
        // "backend unavailable" by the guard:
        //   - "No VeriFactu submission found ..." → the invoice simply has never
        //     been submitted to AEAT. Normal state, not an error.
        //   - "Invoice '<id>' not found"          → wrong/foreign invoice id.
        // Only a 404 with any OTHER body still falls through to the guard
        // (genuinely undeployed endpoint).
        let result: Record<string, unknown>;
        try {
          result = await client.getVerifactuStatus(invoiceId);
        } catch (error) {
          if (isBackendNotFound(error) && error instanceof Error) {
            if (/No VeriFactu submission found/i.test(error.message)) {
              const structured = {
                invoiceId,
                status: "not_submitted",
                accepted: false,
                submittedAt: null,
              };
              return {
                content: [getContent(
                  "This invoice has NOT been submitted to VeriFactu (AEAT) yet — no submission record exists. " +
                  "This is a normal state for an invoice that was never sent, NOT an error and NOT a disabled feature. " +
                  "Submit it first via the VeriFactu submission flow if AEAT reporting is required. " +
                  "/ Esta factura AUN NO se ha enviado a VeriFactu (AEAT) — no existe registro de envio. " +
                  "Es un estado normal para una factura nunca enviada, NO un error ni una funcion desactivada. " +
                  "Enviala primero mediante el flujo VeriFactu si procede.",
                )],
                structuredContent: structured as unknown as Record<string, unknown>,
              };
            }
            if (/Invoice '.+' not found/i.test(error.message)) {
              return {
                content: [{
                  type: "text" as const,
                  text: `Error: Invoice '${invoiceId}' not found in this workspace. Use the internal invoice id ` +
                    "(from list_invoices / create_invoice), not the human invoice number. " +
                    `/ Factura '${invoiceId}' no encontrada en este workspace. Usa el id interno ` +
                    "(de list_invoices / create_invoice), no el numero de factura.",
                  annotations: ERROR_CONTENT_ANNOTATIONS,
                }],
                structuredContent: { error: "invoice_not_found", invoiceId } as Record<string, unknown>,
                isError: true as const,
              };
            }
          }
          throw error;
        }
        return {
          content: [getContent(formatRecord("VeriFactu Status", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
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
      return withBackendGuard("verifactu_resubmit", "/v1/fiscal/verifactu/resubmit", async () => {
        const result = await client.resubmitVerifactu(invoiceId);
        return {
          content: [mutateContent(formatRecord("VeriFactu Resubmitted", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      });
    }),
  );

}

