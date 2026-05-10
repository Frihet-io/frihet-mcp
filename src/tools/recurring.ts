/**
 * Recurring invoice tools for the Frihet MCP server — Wave Mature 3 (7 tools).
 *
 * Tools:
 *   1. list_recurring_invoices   — list recurring invoice templates
 *   2. get_recurring_invoice     — get single recurring template by ID
 *   3. create_recurring_invoice  — create a new recurring invoice template
 *   4. update_recurring_invoice  — update template fields (PATCH semantics)
 *   5. pause_recurring_invoice   — pause an active recurring template
 *   6. resume_recurring_invoice  — resume a paused recurring template
 *   7. delete_recurring_invoice  — permanently delete a recurring template (Trust Area)
 *   8. run_recurring_now         — manually trigger generation of next instance from template
 *
 * REST surface: /v1/recurring/invoices
 *
 * Backend: /v1/recurring/* endpoints live as of Wave 4-A (Frihet-ERP functions/src/publicApi.ts).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import {
  withToolLogging,
  formatPaginatedResponse,
  formatRecord,
  listContent,
  getContent,
  mutateContent,
  READ_ONLY_ANNOTATIONS,
  CREATE_ANNOTATIONS,
  UPDATE_ANNOTATIONS,
  DELETE_ANNOTATIONS,
  paginatedOutput,
  actionResultOutput,
  deleteResultOutput,
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

  // -- get_recurring_invoice --

  server.registerTool(
    "get_recurring_invoice",
    {
      title: "Get Recurring Invoice",
      description:
        "Get full details of a recurring invoice template by ID. " +
        "Returns template name, frequency, next run date, recipient, line items, and active/paused status. " +
        "/ Obtiene los detalles completos de una plantilla de factura recurrente por ID. " +
        "Devuelve nombre, frecuencia, proxima ejecucion, destinatario, lineas y estado.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Recurring invoice template ID / ID de la plantilla de factura recurrente"),
      },
      outputSchema: recurringInvoiceItemOutput,
    },
    async ({ id }) => withToolLogging("get_recurring_invoice", async () => {
      const result = await client.getRecurringInvoice(id);
      return {
        content: [getContent(formatRecord("Recurring invoice template", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- create_recurring_invoice --

  server.registerTool(
    "create_recurring_invoice",
    {
      title: "Create Recurring Invoice",
      description:
        "Create a new recurring invoice template. " +
        "Specify frequency (daily/weekly/monthly/quarterly/yearly), recipient client, line items, and optional start date. " +
        "The first invoice instance is generated on the next scheduled run date. " +
        "Example: clientId='cli_abc', frequency='monthly', templateName='Servicio mensual', lineItems=[{description:'SaaS', quantity:1, unitPrice:299}] " +
        "/ Crea una nueva plantilla de factura recurrente. " +
        "Especifica frecuencia, cliente destinatario, lineas y fecha de inicio opcional. " +
        "La primera instancia se genera en la proxima fecha programada.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        templateName: z.string().describe("Name for this recurring template / Nombre de la plantilla"),
        clientId: z.string().describe("Client ID (recipient of generated invoices) / ID del cliente destinatario"),
        frequency: z
          .enum(["daily", "weekly", "monthly", "quarterly", "yearly"])
          .describe("Billing frequency / Frecuencia de facturacion"),
        lineItems: z
          .array(
            z.object({
              description: z.string().describe("Line item description / Descripcion de la linea"),
              quantity: z.number().describe("Quantity / Cantidad"),
              unitPrice: z.number().describe("Unit price / Precio unitario"),
            }),
          )
          .describe("Invoice line items / Lineas de la factura"),
        startDate: z
          .string()
          .optional()
          .describe("First billing date ISO 8601 (YYYY-MM-DD). Defaults to next natural cycle date. / Primera fecha de facturacion (por defecto proximo ciclo natural)"),
        taxRate: z.number().optional().describe("Tax rate percentage (e.g. 21 for 21% IVA) / Tipo impositivo (e.g. 21 para IVA 21%)"),
        notes: z.string().optional().describe("Notes to include on generated invoices / Notas a incluir en las facturas generadas"),
      },
      outputSchema: recurringInvoiceItemOutput,
    },
    async ({ templateName, clientId, frequency, lineItems, startDate, taxRate, notes }) =>
      withToolLogging("create_recurring_invoice", async () => {
        const result = await client.createRecurringInvoice({ templateName, clientId, frequency, lineItems, startDate, taxRate, notes });
        return {
          content: [mutateContent(formatRecord("Recurring invoice template created", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- update_recurring_invoice --

  server.registerTool(
    "update_recurring_invoice",
    {
      title: "Update Recurring Invoice",
      description:
        "Update an existing recurring invoice template using PATCH semantics. Only provided fields are changed. " +
        "Changing lineItems or taxRate affects future generated invoices only, not already-created ones. " +
        "/ Actualiza una plantilla de factura recurrente existente. Solo se modifican los campos proporcionados. " +
        "Cambiar lineas o tipo impositivo afecta solo a futuras facturas generadas.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Recurring invoice template ID / ID de la plantilla"),
        templateName: z.string().optional().describe("Updated template name / Nombre actualizado"),
        frequency: z
          .enum(["daily", "weekly", "monthly", "quarterly", "yearly"])
          .optional()
          .describe("Updated frequency / Frecuencia actualizada"),
        lineItems: z
          .array(
            z.object({
              description: z.string(),
              quantity: z.number(),
              unitPrice: z.number(),
            }),
          )
          .optional()
          .describe("Updated line items (replaces all) / Lineas actualizadas (reemplaza todas)"),
        taxRate: z.number().optional().describe("Updated tax rate percentage / Tipo impositivo actualizado"),
        notes: z.string().optional().describe("Updated notes / Notas actualizadas"),
      },
      outputSchema: recurringInvoiceItemOutput,
    },
    async ({ id, ...data }) => withToolLogging("update_recurring_invoice", async () => {
      const result = await client.updateRecurringInvoice(id, data as Record<string, unknown>);
      return {
        content: [mutateContent(formatRecord("Recurring invoice template updated", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- pause_recurring_invoice --

  server.registerTool(
    "pause_recurring_invoice",
    {
      title: "Pause Recurring Invoice",
      description:
        "Pause an active recurring invoice template. " +
        "No new invoices are generated while paused. The template is preserved — use resume_recurring_invoice to restart. " +
        "/ Pausa una plantilla de factura recurrente activa. " +
        "No se generan nuevas facturas mientras esta pausada. Usa resume_recurring_invoice para reanudarla.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        id: z.string().describe("Recurring invoice template ID / ID de la plantilla de factura recurrente"),
      },
      outputSchema: actionResultOutput,
    },
    async ({ id }) => withToolLogging("pause_recurring_invoice", async () => {
      const result = await client.pauseRecurringInvoice(id);
      return {
        content: [mutateContent(formatRecord("Recurring invoice paused", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- resume_recurring_invoice --

  server.registerTool(
    "resume_recurring_invoice",
    {
      title: "Resume Recurring Invoice",
      description:
        "Resume a paused recurring invoice template. " +
        "The next invoice will be generated on the next scheduled cycle date after resumption. " +
        "/ Reanuda una plantilla de factura recurrente pausada. " +
        "La proxima factura se generara en el siguiente ciclo programado tras la reanudacion.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        id: z.string().describe("Recurring invoice template ID / ID de la plantilla de factura recurrente"),
      },
      outputSchema: actionResultOutput,
    },
    async ({ id }) => withToolLogging("resume_recurring_invoice", async () => {
      const result = await client.resumeRecurringInvoice(id);
      return {
        content: [mutateContent(formatRecord("Recurring invoice resumed", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- delete_recurring_invoice --

  server.registerTool(
    "delete_recurring_invoice",
    {
      title: "Delete Recurring Invoice",
      description:
        "Permanently delete a recurring invoice template. " +
        "This does NOT delete previously generated invoices — only the template and future scheduled runs. " +
        "Requires confirm=true to prevent accidental deletion. " +
        "/ Elimina permanentemente una plantilla de factura recurrente. " +
        "No elimina facturas ya generadas — solo la plantilla y las ejecuciones futuras. " +
        "Requiere confirm=true para evitar eliminaciones accidentales.",
      annotations: DELETE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Recurring invoice template ID / ID de la plantilla"),
        confirm: z
          .boolean()
          .describe("Must be true to confirm deletion / Debe ser true para confirmar la eliminacion"),
      },
      outputSchema: deleteResultOutput,
    },
    async ({ id, confirm }) => withToolLogging("delete_recurring_invoice", async () => {
      if (!confirm) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: confirm=true is required to delete a recurring invoice template. " +
                "This will stop all future invoice generation from this template. Set confirm=true to proceed. / " +
                "Se requiere confirm=true para eliminar la plantilla de factura recurrente.",
            },
          ],
          isError: true,
        };
      }
      await client.deleteRecurringInvoice(id);
      return {
        content: [mutateContent(`Recurring invoice template ${id} deleted. / Plantilla ${id} eliminada.`)],
        structuredContent: { success: true, id } as unknown as Record<string, unknown>,
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
