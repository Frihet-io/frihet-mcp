/**
 * Quote tools for the Frihet MCP server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import { withToolLogging, formatPaginatedResponse, formatRecord, listContent, getContent, mutateContent, enrichResponse, READ_ONLY_ANNOTATIONS, CREATE_ANNOTATIONS, UPDATE_ANNOTATIONS, DELETE_ANNOTATIONS, paginatedOutput, documentDeleteResultOutput, quoteItemOutput, actionResultOutput } from "./shared.js";

const quoteItemSchema = z.object({
  description: z.string().trim().min(1).max(500).describe("Description of the line item / Descripcion del concepto"),
  quantity: z.number().finite().min(0.0001).max(1_000_000).describe("Quantity / Cantidad"),
  unitPrice: z.number().finite().min(0).max(10_000_000).describe("Unit price in EUR / Precio unitario en EUR"),
}).strict();

// Optional client-identity + ES fiscal fields the Frihet API accepts on quote
// create+update (mirrors the invoice subset the backend supports for quotes).
const quoteOptionalFields = {
  clientId: z
    .string()
    .optional()
    .describe("Existing client ID — stored client details are used for the document / ID de cliente existente"),
  clientTaxId: z
    .string()
    .optional()
    .describe("Client tax ID (NIF/CIF/VAT) / NIF/CIF del cliente"),
  clientAddress: z
    .string()
    .optional()
    .describe("Client billing address / Direccion fiscal del cliente"),
  issueDate: z
    .iso.date()
    .optional()
    .describe("Issue date in ISO 8601 (YYYY-MM-DD), defaults to today / Fecha de emision"),
  dueDate: z
    .iso.date()
    .optional()
    .describe("Due date in ISO 8601 (YYYY-MM-DD) / Fecha de vencimiento"),
  taxRate: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Tax rate % (e.g. 21 IVA, 7 IGIC) / Porcentaje de impuesto"),
  irpfRate: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("IRPF withholding % (retencion autonomo ES) / Retencion IRPF %"),
  equivalenceSurchargeRate: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Recargo de equivalencia % / Recargo de equivalencia %"),
  clientLocation: z
    .enum(["peninsula", "canarias", "ceuta_melilla", "eu", "world"])
    .optional()
    .describe("Fiscal zone driving IVA vs IGIC vs exempt / Zona fiscal"),
};

export function registerQuoteTools(server: McpServer, client: IFrihetClient): void {
  // -- list_quotes --

  server.registerTool(
    "list_quotes",
    {
      title: "List Quotes",
      description:
        "List all quotes/estimates with optional pagination and filters. " +
        "Quotes are proposals sent to clients before they become invoices. " +
        "Supports filtering by status (draft/sent/accepted/rejected/expired) and date range. " +
        "Example: status='sent', from='2026-01-01', limit=20 " +
        "/ Lista todos los presupuestos con paginacion y filtros opcionales. " +
        "Soporta filtrado por estado y rango de fechas.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        status: z
          .enum(["draft", "sent", "accepted", "rejected", "expired"])
          .optional()
          .describe("Filter by quote status / Filtrar por estado"),
        clientId: z
          .string()
          .optional()
          .describe("Filter by client ID / Filtrar por ID de cliente"),
        seriesId: z
          .string()
          .optional()
          .describe("Filter by quote series ID / Filtrar por ID de serie"),
        from: z
          .string()
          .optional()
          .describe("Start date filter (YYYY-MM-DD) / Fecha inicio"),
        to: z
          .string()
          .optional()
          .describe("End date filter (YYYY-MM-DD) / Fecha fin"),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated field names to return (e.g. 'id,clientName,total') / Campos a devolver"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100) / Resultados maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
        after: z
          .string()
          .optional()
          .describe("Cursor for cursor-based pagination (document ID) / Cursor para paginacion basada en cursor"),
      },
      outputSchema: paginatedOutput(quoteItemOutput, { projectable: true }),
    },
    async ({ status, from, to, limit, offset, clientId, seriesId, fields, after }) => withToolLogging("list_quotes", async () => {
      const result = await client.listQuotes({ limit, offset, after, fields, status, from, to, clientId, seriesId });
      return {
        content: [listContent(formatPaginatedResponse("quotes", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_quote --

  server.registerTool(
    "get_quote",
    {
      title: "Get Quote",
      description:
        "Get a single quote/estimate by its ID. Returns the full quote with line items and totals. " +
        "/ Obtiene un presupuesto por su ID. Devuelve el presupuesto completo con conceptos y totales.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Quote ID / ID del presupuesto"),
      },
      outputSchema: quoteItemOutput,
    },
    async ({ id }) => withToolLogging("get_quote", async () => {
      const result = await client.getQuote(id);
      return {
        content: [getContent(formatRecord("Quote", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- create_quote --

  server.registerTool(
    "create_quote",
    {
      title: "Create Quote",
      description:
        "Create a new quote/estimate for a client. Requires client name and at least one line item. " +
        "Quotes can later be converted to invoices. Defaults to draft status. " +
        "Example: clientName='Acme Corp', items=[{description:'Design', quantity:1, unitPrice:3000}], validUntil='2026-04-30' " +
        "/ Crea un nuevo presupuesto. Requiere nombre del cliente y al menos un concepto. " +
        "Los presupuestos se pueden convertir en facturas despues.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        clientName: z.string().trim().min(1).max(200).describe("Client name / Nombre del cliente"),
        ...quoteOptionalFields,
        items: z
          .array(quoteItemSchema)
          .min(1)
          .describe("Line items (each with description, quantity, unitPrice) / Conceptos del presupuesto"),
        validUntil: z
          .iso.date()
          .optional()
          .describe("Expiry date in ISO 8601 (YYYY-MM-DD) / Fecha de validez"),
        notes: z.string().max(10_000).optional().describe("Additional notes shown on the quote / Notas adicionales"),
        status: z
          .enum(["draft", "sent", "accepted", "rejected", "expired"])
          .optional()
          .describe("Quote status (default: draft) / Estado del presupuesto"),
      },
      outputSchema: quoteItemOutput,
    },
    async (input) => withToolLogging("create_quote", async () => {
      const result = await client.createQuote(input);
      const hints = enrichResponse("quotes", "create", result);
      return {
        content: [mutateContent(formatRecord("Quote created", result) + hints)],
        structuredContent: { ...result } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- update_quote --

  server.registerTool(
    "update_quote",
    {
      title: "Update Quote",
      description:
        "Update an existing quote using PATCH semantics. Only the provided fields will be changed. " +
        "Example: id='abc123', status='accepted' to mark a quote as accepted. " +
        "/ Actualiza un presupuesto existente. Solo se modifican los campos proporcionados.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Quote ID / ID del presupuesto"),
        clientName: z.string().optional().describe("Client name / Nombre del cliente"),
        ...quoteOptionalFields,
        items: z.array(quoteItemSchema).min(1).optional().describe("Line items / Conceptos"),
        validUntil: z.string().optional().describe("Expiry date (YYYY-MM-DD) / Fecha de validez"),
        notes: z.string().optional().describe("Notes / Notas"),
        status: z
          .enum(["draft", "sent", "accepted", "rejected", "expired"])
          .optional()
          .describe("Status / Estado"),
      },
      outputSchema: quoteItemOutput,
    },
    async ({ id, ...data }) => withToolLogging("update_quote", async () => {
      const result = await client.updateQuote(id, data);
      return {
        content: [mutateContent(formatRecord("Quote updated", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- delete_quote --

  server.registerTool(
    "delete_quote",
    {
      title: "Delete Quote",
      description:
        "Delete a quote by its ID. Requires confirm=true. " +
        "Only a clean DRAFT with no delivery, response, attachment, or conversion evidence is removed permanently; a protected draft is refused and left unchanged. A sent/accepted/rejected/expired quote is NOT " +
        "destroyed: the backend CANCELS it (status=cancelled) — the same non-destructive path invoices " +
        "take — and it stays readable via get_quote. The result reports which happened in `outcome` " +
        "(\"deleted\" or \"cancelled\"). " +
        "/ Elimina un presupuesto por su ID. Requiere confirm=true. Solo un BORRADOR limpio sin evidencia de entrega, respuesta, adjuntos o conversion se " +
        "elimina de forma permanente; un borrador protegido se rechaza sin cambios. Uno ya enviado/aceptado/rechazado NO se destruye: se CANCELA " +
        "(status=cancelled) y sigue consultable con get_quote.",
      annotations: DELETE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Quote ID / ID del presupuesto"),
        confirm: z
          .boolean()
          .describe("Must be true to confirm deletion / Debe ser true para confirmar la eliminacion"),
      },
      outputSchema: documentDeleteResultOutput,
    },
    async ({ id, confirm }) => withToolLogging("delete_quote", async () => {
      if (!confirm) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: confirm=true is required to delete a quote. " +
                "A clean draft without delivery, response, attachment, or conversion evidence is removed permanently; a protected draft is refused; a sent/accepted quote is CANCELLED " +
                "(status=cancelled) instead and remains in the record. " +
                "Set confirm=true to proceed. / " +
                "Se requiere confirm=true para eliminar un presupuesto.",
            },
          ],
          isError: true,
        };
      }
      // 204 → undefined (draft row destroyed). 200 → soft-cancel body. See GAP-12.
      const outcome = await client.deleteQuote(id);
      const cancelled = !!outcome && typeof outcome === "object";
      const body = cancelled ? (outcome as Record<string, unknown>) : {};
      const previous = typeof body["previousStatus"] === "string" ? ` (was ${body["previousStatus"]})` : "";
      return {
        content: [mutateContent(
          cancelled
            ? `Quote ${id} was CANCELLED, not deleted${previous}: it still exists with status=cancelled. / ` +
              `Presupuesto ${id} CANCELADO, no eliminado: sigue existiendo con status=cancelled.`
            : `Quote ${id} deleted permanently (it was a draft). / ` +
              `Presupuesto ${id} eliminado permanentemente (era un borrador).`,
        )],
        structuredContent: {
          success: true,
          id,
          ...body,
          outcome: cancelled ? "cancelled" : "deleted",
        } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- send_quote --

  server.registerTool(
    "send_quote",
    {
      title: "Send Quote",
      description:
        "Send a quote/estimate to the client via email. Requires confirm=true. " +
        "Optionally override the recipient email address. " +
        "The quote must exist and should not already be expired or rejected. " +
        "Sending reaches a third party and cannot be recalled. " +
        "/ Envia un presupuesto al cliente por email. Requiere confirm=true. " +
        "Opcionalmente se puede cambiar el email destinatario. El envio llega a un tercero y no se puede anular.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Quote ID / ID del presupuesto"),
        to: z.string().optional().describe("Override recipient email / Email destinatario alternativo"),
        confirm: z
          .boolean()
          .describe("Must be true to confirm sending / Debe ser true para confirmar el envio"),
      },
      outputSchema: actionResultOutput,
    },
    async ({ id, to, confirm }) => withToolLogging("send_quote", async () => {
      if (!confirm) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: confirm=true is required to send a quote. " +
                "This delivers an email to the client — a third party outside this workspace — " +
                "and it cannot be recalled once sent. Set confirm=true to proceed. / " +
                "Se requiere confirm=true para enviar un presupuesto por email a un tercero.",
            },
          ],
          isError: true,
        };
      }
      const quote = await client.getQuote(id);
      const status = typeof quote["status"] === "string" ? quote["status"] : undefined;
      if (status && ["expired", "rejected", "cancelled"].includes(status)) {
        return {
          content: [{ type: "text" as const, text: `Error: a ${status} quote cannot be sent.` }],
          isError: true,
        };
      }
      let recipientEmail = to;
      if (!recipientEmail) {
        const clientId = typeof quote["clientId"] === "string" ? quote["clientId"] : undefined;
        if (!clientId) {
          return {
            content: [{ type: "text" as const, text: "Error: this quote has no linked client with a saved email address." }],
            isError: true,
          };
        }
        const linkedClient = await client.getClient(clientId);
        recipientEmail = typeof linkedClient["email"] === "string" && linkedClient["email"].trim()
          ? linkedClient["email"].trim()
          : undefined;
        if (!recipientEmail) {
          return {
            content: [{ type: "text" as const, text: "Error: the linked client has no saved email address." }],
            isError: true,
          };
        }
      }
      const result = await client.sendQuote(id, recipientEmail);
      return {
        content: [mutateContent(formatRecord("Quote sent", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );
}
