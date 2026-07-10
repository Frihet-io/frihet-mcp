/**
 * Invoice tools for the Frihet MCP server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import { withToolLogging, formatPaginatedResponse, formatRecord, listContent, getContent, mutateContent, enrichResponse, READ_ONLY_ANNOTATIONS, CREATE_ANNOTATIONS, UPDATE_ANNOTATIONS, DELETE_ANNOTATIONS, paginatedOutput, deleteResultOutput, invoiceItemOutput, actionResultOutput, creditNoteResultOutput, pdfResultOutput } from "./shared.js";

const invoiceItemSchema = z.object({
  description: z.string().describe("Description of the line item / Descripcion del concepto"),
  quantity: z.number().describe("Quantity / Cantidad"),
  unitPrice: z.number().describe("Unit price in EUR / Precio unitario en EUR"),
});

// Optional client-identity fields the Frihet API accepts on invoice/quote
// create+update. When clientId is supplied the server back-fills taxId/address
// from the stored client; clientTaxId/clientAddress override per-document.
const clientIdentityFields = {
  clientId: z
    .string()
    .optional()
    .describe("Existing client ID — server back-fills taxId/address / ID de cliente existente"),
  clientTaxId: z
    .string()
    .optional()
    .describe("Client tax ID (NIF/CIF/VAT) shown on the invoice / NIF/CIF del cliente"),
  clientAddress: z
    .string()
    .optional()
    .describe("Client billing address shown on the invoice / Direccion fiscal del cliente"),
};

// Optional Spanish fiscal fields the Frihet API accepts on invoice create+update.
// irpfRate is the freelancer withholding (retencion IRPF) — critical for ES
// autonomos; equivalenceSurchargeRate is recargo de equivalencia.
const invoiceFiscalFields = {
  irpfRate: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("IRPF withholding % (retencion autonomo ES, e.g. 15 or 7) / Retencion IRPF %"),
  equivalenceSurchargeRate: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Recargo de equivalencia % (ES retail regime) / Recargo de equivalencia %"),
  clientLocation: z
    .enum(["peninsula", "canarias", "ceuta_melilla", "eu", "world"])
    .optional()
    .describe("Fiscal zone driving IVA vs IGIC vs exempt / Zona fiscal (IVA/IGIC/exento)"),
  prepayment: z
    .number()
    .min(0)
    .optional()
    .describe("Prepaid/advance amount already collected in EUR / Anticipo cobrado en EUR"),
  discountRate: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Global discount % applied to the invoice / Descuento global %"),
  seriesId: z
    .string()
    .optional()
    .describe("Invoice numbering series ID / ID de serie de numeracion"),
  documentNumber: z
    .string()
    .max(50)
    .optional()
    .describe("Externally-issued number for import (honored verbatim) / Numero externo para importacion"),
  poNumber: z
    .string()
    .optional()
    .describe("Client purchase-order reference / Numero de pedido del cliente"),
  operationType: z
    .enum(["service", "goods"])
    .optional()
    .describe("Operation type (service or goods) / Tipo de operacion"),
};

export function registerInvoiceTools(server: McpServer, client: IFrihetClient): void {
  // -- list_invoices --

  server.registerTool(
    "list_invoices",
    {
      title: "List Invoices",
      description:
        "List all invoices with optional pagination and filters. " +
        "Returns a paginated list sorted by issue date (newest first). " +
        "Supports filtering by status (draft/sent/paid/overdue/cancelled) and date range. " +
        "Example: status='paid', from='2026-01-01', to='2026-03-31', limit=20 " +
        "/ Lista facturas con paginacion y filtros opcionales. " +
        "Soporta filtrado por estado y rango de fechas.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        status: z
          .enum(["draft", "sent", "paid", "overdue", "cancelled"])
          .optional()
          .describe("Filter by invoice status / Filtrar por estado"),
        clientId: z
          .string()
          .optional()
          .describe("Filter by client ID / Filtrar por ID de cliente"),
        seriesId: z
          .string()
          .optional()
          .describe("Filter by invoice series ID / Filtrar por ID de serie"),
        from: z
          .string()
          .optional()
          .describe("Start date filter in ISO 8601 (YYYY-MM-DD) / Fecha inicio"),
        to: z
          .string()
          .optional()
          .describe("End date filter in ISO 8601 (YYYY-MM-DD) / Fecha fin"),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated field names to return (e.g. 'id,clientName,total') / Campos a devolver"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results per page (1-100, default 50) / Resultados por pagina"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Number of results to skip / Resultados a saltar"),
        after: z
          .string()
          .optional()
          .describe("Cursor for cursor-based pagination (document ID) / Cursor para paginacion basada en cursor"),
      },
      outputSchema: paginatedOutput(invoiceItemOutput),
    },
    async ({ status, from, to, limit, offset, clientId, seriesId, fields, after }) => withToolLogging("list_invoices", async () => {
      const result = await client.listInvoices({ limit, offset, after, fields, status, from, to, clientId, seriesId });
      const hints = enrichResponse("invoices", "list", result.data);
      return {
        content: [listContent(formatPaginatedResponse("invoices", result))],
        structuredContent: { ...result, ...hints } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_invoice --

  server.registerTool(
    "get_invoice",
    {
      title: "Get Invoice",
      description:
        "Get a single invoice by its ID. Returns the full invoice including line items, totals, and status. " +
        "/ Obtiene una factura por su ID. Devuelve la factura completa con conceptos, totales y estado.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Invoice ID / ID de la factura"),
      },
      outputSchema: invoiceItemOutput,
    },
    async ({ id }) => withToolLogging("get_invoice", async () => {
      const result = await client.getInvoice(id);
      return {
        content: [getContent(formatRecord("Invoice", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- create_invoice --

  server.registerTool(
    "create_invoice",
    {
      title: "Create Invoice",
      description:
        "Create a new invoice. Requires client name and at least one line item. " +
        "The invoice number is auto-generated. Defaults to draft status and today's date. " +
        "Example: clientName='Acme Corp', items=[{description:'Consulting', quantity:10, unitPrice:150}], taxRate=21, irpfRate=15 " +
        "/ Crea una nueva factura. Requiere nombre del cliente y al menos un concepto. " +
        "El numero se genera automaticamente. Por defecto estado borrador y fecha de hoy. " +
        "Soporta retencion IRPF (autonomos ES), recargo de equivalencia, serie, anticipo y descuento global.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        clientName: z.string().describe("Client/customer name / Nombre del cliente"),
        ...clientIdentityFields,
        items: z
          .array(invoiceItemSchema)
          .min(1)
          .describe("Line items (each with description, quantity, unitPrice) / Conceptos de la factura"),
        issueDate: z
          .string()
          .optional()
          .describe("Issue date in ISO 8601 format (YYYY-MM-DD), defaults to today / Fecha de emision"),
        dueDate: z
          .string()
          .optional()
          .describe("Due date in ISO 8601 format (YYYY-MM-DD) / Fecha de vencimiento"),
        status: z
          .enum(["draft", "sent", "paid", "overdue", "cancelled"])
          .optional()
          .describe("Invoice status (default: draft) / Estado de la factura"),
        notes: z
          .string()
          .optional()
          .describe("Additional notes shown on the invoice / Notas adicionales"),
        taxRate: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Tax rate percentage (e.g. 21 for 21% IVA, 7 for IGIC) / Porcentaje de impuesto"),
        ...invoiceFiscalFields,
      },
      outputSchema: invoiceItemOutput,
    },
    async (input) => withToolLogging("create_invoice", async () => {
      const result = await client.createInvoice(input);
      const hints = enrichResponse("invoices", "create", result);
      return {
        content: [mutateContent(formatRecord("Invoice created", result))],
        structuredContent: { ...result, ...hints } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- update_invoice --

  server.registerTool(
    "update_invoice",
    {
      title: "Update Invoice",
      description:
        "Update an existing invoice using PATCH semantics. Only the provided fields will be changed. " +
        "Example: id='abc123', status='paid' to mark an invoice as paid. " +
        "/ Actualiza una factura existente. Solo se modifican los campos proporcionados.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Invoice ID / ID de la factura"),
        clientName: z.string().optional().describe("Client name / Nombre del cliente"),
        ...clientIdentityFields,
        items: z
          .array(invoiceItemSchema)
          .min(1)
          .optional()
          .describe("Line items / Conceptos"),
        issueDate: z.string().optional().describe("Issue date (YYYY-MM-DD) / Fecha de emision"),
        dueDate: z.string().optional().describe("Due date (YYYY-MM-DD) / Fecha de vencimiento"),
        status: z
          .enum(["draft", "sent", "paid", "overdue", "cancelled"])
          .optional()
          .describe("Invoice status / Estado"),
        notes: z.string().optional().describe("Notes / Notas"),
        taxRate: z.number().min(0).max(100).optional().describe("Tax rate % / IVA %"),
        ...invoiceFiscalFields,
      },
      outputSchema: invoiceItemOutput,
    },
    async ({ id, ...data }) => withToolLogging("update_invoice", async () => {
      const result = await client.updateInvoice(id, data);
      const hints = enrichResponse("invoices", "update", result);
      return {
        content: [mutateContent(formatRecord("Invoice updated", result))],
        structuredContent: { ...result, ...hints } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- delete_invoice --

  server.registerTool(
    "delete_invoice",
    {
      title: "Delete Invoice",
      description:
        "Permanently delete an invoice by its ID. This action cannot be undone. " +
        "/ Elimina permanentemente una factura por su ID. Esta accion no se puede deshacer.",
      annotations: DELETE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Invoice ID / ID de la factura"),
      },
      outputSchema: deleteResultOutput,
    },
    async ({ id }) => withToolLogging("delete_invoice", async () => {
      await client.deleteInvoice(id);
      const hints = enrichResponse("invoices", "delete", { id });
      return {
        content: [mutateContent(`Invoice ${id} deleted successfully. / Factura ${id} eliminada correctamente.`)],
        structuredContent: { success: true, id, ...hints } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- search_invoices --

  server.registerTool(
    "search_invoices",
    {
      title: "Search Invoices",
      description:
        "Search and filter invoices. Supports filtering by status and date range. " +
        "The query parameter searches across client names and invoice content. " +
        "Example: query='Acme', status='paid', from='2026-01-01', to='2026-03-31' " +
        "/ Busca y filtra facturas. Soporta filtrado por estado y rango de fechas. " +
        "El parametro query busca en nombres de clientes y contenido de facturas.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        query: z.string().optional().describe("Search text (client name, etc.) / Texto de busqueda"),
        status: z
          .enum(["draft", "sent", "paid", "overdue", "cancelled"])
          .optional()
          .describe("Filter by status / Filtrar por estado"),
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
          .describe("Comma-separated field names to return / Campos a devolver"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100) / Resultados maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
        after: z
          .string()
          .optional()
          .describe("Cursor for cursor-based pagination (document ID) / Cursor para paginacion"),
      },
      outputSchema: paginatedOutput(invoiceItemOutput),
    },
    async ({ query, status, from, to, limit, offset, fields, after }) => withToolLogging("search_invoices", async () => {
      const result = query
        ? await client.searchInvoices(query, { limit, offset, after, fields, status, from, to })
        : await client.listInvoices({ limit, offset, after, fields, status, from, to });
      const label = query ? `invoices matching "${query}"` : "invoices";
      const hints = enrichResponse("invoices", "list", result.data);
      return {
        content: [listContent(formatPaginatedResponse(label, result))],
        structuredContent: { ...result, ...hints } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- send_invoice --

  server.registerTool(
    "send_invoice",
    {
      title: "Send Invoice",
      description:
        "Send an invoice to the client via email. Optionally override the recipient email address. " +
        "The invoice must exist and should not already be cancelled. " +
        "/ Envia una factura al cliente por email. Opcionalmente se puede cambiar el email destinatario.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Invoice ID / ID de la factura"),
        to: z.string().optional().describe("Override recipient email / Email destinatario alternativo"),
      },
      outputSchema: actionResultOutput,
    },
    async ({ id, to }) => withToolLogging("send_invoice", async () => {
      const result = await client.sendInvoice(id, to);
      return {
        content: [mutateContent(formatRecord("Invoice sent", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- mark_invoice_paid --

  server.registerTool(
    "mark_invoice_paid",
    {
      title: "Mark Invoice Paid",
      description:
        "Mark an invoice as paid. Optionally specify the payment date. " +
        "Defaults to today if no date is provided. " +
        "/ Marca una factura como pagada. Opcionalmente especifica la fecha de pago.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Invoice ID / ID de la factura"),
        paidDate: z.string().optional().describe("Payment date (YYYY-MM-DD), defaults to today / Fecha de pago"),
      },
      outputSchema: actionResultOutput,
    },
    async ({ id, paidDate }) => withToolLogging("mark_invoice_paid", async () => {
      const result = await client.markInvoicePaid(id, paidDate);
      return {
        content: [mutateContent(formatRecord("Invoice marked as paid", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_invoice_pdf --

  server.registerTool(
    "get_invoice_pdf",
    {
      title: "Get Invoice PDF",
      description:
        "Get the PDF for an invoice. Returns a URL to download the PDF or binary info. " +
        "/ Obtiene el PDF de una factura. Devuelve una URL de descarga o informacion del binario.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Invoice ID / ID de la factura"),
      },
      outputSchema: pdfResultOutput,
    },
    async ({ id }) => withToolLogging("get_invoice_pdf", async () => {
      const result = await client.getInvoicePdf(id);
      return {
        content: [getContent(formatRecord("Invoice PDF", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_invoice_einvoice --

  server.registerTool(
    "get_invoice_einvoice",
    {
      title: "Get Invoice E-Invoice XML",
      description:
        "Download the e-invoice XML for an invoice. Returns EN16931-compliant XML in the auto-detected format " +
        "(UBL, CII, XRechnung, Factur-X, FatturaPA, PEPPOL). " +
        "Only available after the invoice has been saved/sent. " +
        "/ Descarga el XML de factura electronica para una factura. Devuelve XML conforme a EN16931 en el formato " +
        "auto-detectado (UBL, CII, XRechnung, Factur-X, FatturaPA, PEPPOL). " +
        "Solo disponible despues de guardar o enviar la factura.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Invoice ID / ID de la factura"),
      },
      outputSchema: z.object({
        xml: z.string().optional(),
        filename: z.string().optional(),
        format: z.string().optional(),
      }).passthrough(),
    },
    async ({ id }) => withToolLogging("get_invoice_einvoice", async () => {
      const result = await client.getInvoiceEInvoice(id);
      return {
        content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
        structuredContent: (typeof result === "object" && result !== null ? result : { xml: result }) as Record<string, unknown>,
      };
    }),
  );

  // -- create_credit_note --

  server.registerTool(
    "create_credit_note",
    {
      title: "Create Credit Note",
      description:
        "Create a credit note (factura rectificativa) for an existing invoice. " +
        "This reverses all or part of an invoice for compliance. " +
        "Spanish market: generates VeriFactu-compliant R1-R5 rectificativa. " +
        "Other markets: standard credit note with negative amounts. " +
        "/ Crea una factura rectificativa para una factura existente. " +
        "Mercado espanol: genera rectificativa R1-R5 conforme a VeriFactu. " +
        "Otros mercados: nota de credito estandar con importes negativos.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        invoiceId: z
          .string()
          .describe("ID of the original invoice to credit / ID de la factura original a rectificar"),
        reason: z
          .enum(["refund", "discount", "error", "cancellation", "other"])
          .describe(
            "Reason for the credit note. Maps to Spanish R-types: error→R1 (art. 80.1), refund/discount/cancellation/other→R4 " +
            "/ Motivo de la rectificacion. error→R1, resto→R4",
          ),
        reasonDescription: z
          .string()
          .optional()
          .describe("Optional free-text description of the reason / Descripcion libre del motivo"),
        fullCredit: z
          .boolean()
          .optional()
          .describe(
            "true = full credit (tipo S, sustitucion), false = partial (tipo I, diferencias). Default: true " +
            "/ true = abono total (tipo S), false = parcial (tipo I). Por defecto: true",
          ),
        issueDate: z
          .string()
          .optional()
          .describe("ISO date for the credit note (YYYY-MM-DD). Defaults to today. / Fecha de emision (YYYY-MM-DD). Por defecto hoy."),
      },
      outputSchema: creditNoteResultOutput,
    },
    async ({ invoiceId, reason, reasonDescription, fullCredit, issueDate }) => withToolLogging("create_credit_note", async () => {
      const result = await client.createCreditNote(invoiceId, {
        reason,
        reasonDescription,
        fullCredit: fullCredit ?? true,
        issueDate,
      });
      const hints = enrichResponse("invoices", "create", result);
      return {
        content: [mutateContent(formatRecord("Credit note created", result))],
        structuredContent: { ...result, ...hints } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- apply_late_fee --

  server.registerTool(
    "apply_late_fee",
    {
      title: "Apply Late Fee",
      description:
        "Apply late payment interest to an overdue invoice. Calculates interest based on EU Late Payment Directive (8% default) " +
        "or auto-calculates from days overdue. Creates a debit note linked to the original invoice. " +
        "/ Aplica intereses de demora a una factura vencida. Calcula intereses segun la Directiva Europea de Morosidad (8% por defecto) " +
        "o los calcula automaticamente a partir de los dias de retraso. Crea una nota de debito vinculada a la factura original.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        invoiceId: z.string().describe("ID of the overdue invoice / ID de la factura vencida"),
        amount: z
          .number()
          .optional()
          .describe("Override fee amount. If omitted, auto-calculated from days overdue and legal rate. / Importe de la comision. Si se omite, se calcula automaticamente."),
        daysOverdue: z
          .number()
          .int()
          .optional()
          .describe("Override days overdue count. If omitted, calculated from due date. / Dias de retraso. Si se omite, se calcula a partir de la fecha de vencimiento."),
      },
      outputSchema: actionResultOutput,
    },
    async ({ invoiceId, amount, daysOverdue }) => withToolLogging("apply_late_fee", async () => {
      const data: { amount?: number; daysOverdue?: number } = {};
      if (amount !== undefined) data.amount = amount;
      if (daysOverdue !== undefined) data.daysOverdue = daysOverdue;
      const result = await client.applyLateFee(invoiceId, data);
      return {
        content: [mutateContent(formatRecord("Late fee applied", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );
}
