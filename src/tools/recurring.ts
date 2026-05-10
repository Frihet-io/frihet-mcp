/**
 * Recurring invoice tools for the Frihet MCP server — Wave 6 (2 tools).
 *
 * Tools:
 *   1. list_recurring_invoices — list recurring invoice templates
 *   2. run_recurring_now       — manually trigger generation of next instance from template
 *
 * REST surface: /v1/recurring/invoices
 *
 * NOTE: ERP backend endpoints /v1/recurring/* are planned. Tools are wired
 * and will surface 404 errors until the backend ships.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import {
  withToolLogging,
  formatPaginatedResponse,
  formatRecord,
  listContent,
  mutateContent,
  READ_ONLY_ANNOTATIONS,
  paginatedOutput,
  actionResultOutput,
  recurringInvoiceItemOutput,
} from "./shared.js";

export function registerRecurringTools(server: McpServer, client: IFrihetClient): void {
  // -- list_recurring_invoices --

  server.registerTool(
    "list_recurring_invoices",
    {
      title: "List Recurring Invoices",
      description:
        "List all recurring invoice templates. " +
        "Returns template name, frequency, next scheduled run date, recipient, line items, and active/paused status. " +
        "/ Lista todas las plantillas de facturas recurrentes. " +
        "Devuelve nombre de la plantilla, frecuencia, proxima fecha de ejecucion, destinatario, lineas y estado.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        status: z
          .enum(["active", "paused"])
          .optional()
          .describe("Filter by status / Filtrar por estado"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100) / Resultados maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
      },
      outputSchema: paginatedOutput(recurringInvoiceItemOutput),
    },
    async ({ status, limit, offset }) => withToolLogging("list_recurring_invoices", async () => {
      const result = await client.listRecurringInvoices({ status, limit, offset });
      return {
        content: [listContent(formatPaginatedResponse("recurring_invoices", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- run_recurring_now --

  server.registerTool(
    "run_recurring_now",
    {
      title: "Run Recurring Invoice Now",
      description:
        "Manually trigger immediate generation of the next invoice instance from a recurring template. " +
        "Useful for billing ahead of schedule or recovering from a missed automated run. " +
        "The generated invoice is created as a draft; review and send separately. " +
        "Example: templateId='rec_abc123' " +
        "/ Genera manualmente la siguiente instancia de una factura recurrente. " +
        "Util para facturar antes de lo programado o recuperar un ciclo perdido. " +
        "La factura generada se crea como borrador; revisar y enviar por separado.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        templateId: z.string().describe("Recurring invoice template ID / ID de la plantilla de factura recurrente"),
        draftOnly: z
          .boolean()
          .optional()
          .describe("If true, create as draft only (default true). Set false to create and mark as sent immediately. / Si true, crea como borrador. Set false para crear y marcar como enviada."),
      },
      outputSchema: actionResultOutput,
    },
    async ({ templateId, draftOnly }) => withToolLogging("run_recurring_now", async () => {
      const result = await client.runRecurringNow(templateId, { draftOnly: draftOnly ?? true });
      return {
        content: [mutateContent(formatRecord("Recurring invoice triggered", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );
}
