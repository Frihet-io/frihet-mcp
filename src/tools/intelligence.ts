/**
 * Intelligence tools for the Frihet MCP server.
 *
 * These tools go beyond CRUD — they provide contextual business intelligence
 * that helps AI agents understand the user's business at a glance.
 *
 * - get_business_context: Full business snapshot (call FIRST in any session)
 * - get_monthly_summary: Monthly P&L and invoice stats
 * - get_quarterly_taxes: Tax prep data for Modelo 303/130
 * - duplicate_invoice: Clone an invoice for a new period
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import {
  withToolLogging,
  formatRecord,
  getContent,
  mutateContent,
  openObjectOutput,
  READ_ONLY_ANNOTATIONS,
  CREATE_ANNOTATIONS,
} from "./shared.js";

export function registerIntelligenceTools(server: McpServer, client: IFrihetClient): void {
  // -- get_business_context --

  server.registerTool(
    "get_business_context",
    {
      title: "Get Business Context",
      description:
        "Get complete business context — profile, defaults, plan limits, recent activity, top clients, " +
        "and current month summary. Call this FIRST in any session to understand the user's business. " +
        "Returns everything an AI agent needs to provide personalized help without multiple round-trips. " +
        "/ Obtiene el contexto completo del negocio — perfil, limites del plan, actividad reciente, " +
        "principales clientes y resumen del mes actual. Llama a esto PRIMERO en cualquier sesion.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {},
      outputSchema: openObjectOutput(
        "Business context snapshot: workspace profile, fiscal setup, recent activity / Contexto de negocio: perfil, configuración fiscal y actividad reciente",
      ),
    },
    async () => withToolLogging("get_business_context", async () => {
      const result = await client.getBusinessContext();
      return {
        content: [getContent(formatRecord("Business Context", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_monthly_summary --

  server.registerTool(
    "get_monthly_summary",
    {
      title: "Get Monthly Summary",
      description:
        "Get complete monthly financial summary — revenue, expenses, profit, tax liability, " +
        "invoice stats, expense breakdown by category. Defaults to current month. " +
        "Use this to answer questions about financial performance, cash flow, or monthly P&L. " +
        "/ Resumen financiero mensual completo — ingresos, gastos, beneficio, impuestos, " +
        "estadisticas de facturas, desglose de gastos por categoria. Por defecto el mes actual.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        month: z
          .string()
          .optional()
          .describe(
            "Month in YYYY-MM format (defaults to current month). Example: '2026-03' " +
            "/ Mes en formato YYYY-MM (por defecto el mes actual)",
          ),
      },
      outputSchema: openObjectOutput(
        "Monthly P&L summary: revenue, expenses, profit, tax liability, invoice stats / Resumen mensual: ingresos, gastos, beneficio, impuestos",
      ),
    },
    async ({ month }) => withToolLogging("get_monthly_summary", async () => {
      const result = await client.getMonthlySummary(month);
      const label = month ? `Monthly Summary (${month})` : "Monthly Summary (current month)";
      return {
        content: [getContent(formatRecord(label, result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_quarterly_taxes --

  server.registerTool(
    "get_quarterly_taxes",
    {
      title: "Get Quarterly Taxes",
      description:
        "Get quarterly tax preparation data — Modelo 303 (IVA/IGIC), Modelo 130 (IRPF income tax advance), " +
        "revenue/expense totals, tax collected vs deductible. Defaults to current quarter. " +
        "Essential for filing quarterly tax returns with AEAT or ATC (Canary Islands). " +
        "/ Datos de preparacion de impuestos trimestrales — Modelo 303, Modelo 130, " +
        "totales de ingresos/gastos, impuesto repercutido vs soportado. Por defecto trimestre actual.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        quarter: z
          .string()
          .optional()
          .describe(
            "Quarter in YYYY-Q# format (defaults to current quarter). Example: '2026-Q1' " +
            "/ Trimestre en formato YYYY-Q# (por defecto trimestre actual)",
          ),
      },
      outputSchema: openObjectOutput(
        "Quarterly tax prep data: Modelo 303/130 totals, tax collected vs deductible / Datos trimestrales: Modelo 303/130, impuesto repercutido vs soportado",
      ),
    },
    async ({ quarter }) => withToolLogging("get_quarterly_taxes", async () => {
      const result = await client.getQuarterlyTaxes(quarter);
      const label = quarter ? `Quarterly Taxes (${quarter})` : "Quarterly Taxes (current quarter)";
      return {
        content: [getContent(formatRecord(label, result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- duplicate_invoice --

  server.registerTool(
    "duplicate_invoice",
    {
      title: "Duplicate Invoice",
      description:
        "Duplicate an existing invoice for a new period. Copies all line items, client data, tax rate, and notes. " +
        "Strips the original ID, document number, status, and timestamps. " +
        "The new invoice starts as 'draft' with today's date (or the provided date). " +
        "Perfect for recurring invoices — duplicate last month's invoice and adjust if needed. " +
        "/ Duplica una factura existente para un nuevo periodo. Copia conceptos, cliente, impuestos y notas. " +
        "La nueva factura empieza como 'borrador' con fecha de hoy.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("ID of the invoice to duplicate / ID de la factura a duplicar"),
        newIssueDate: z
          .string()
          .optional()
          .describe("Issue date for the new invoice (YYYY-MM-DD), defaults to today / Fecha de emision de la nueva factura"),
        newDueDate: z
          .string()
          .optional()
          .describe("Due date for the new invoice (YYYY-MM-DD) / Fecha de vencimiento de la nueva factura"),
      },
      outputSchema: openObjectOutput(
        "The newly created draft invoice, cloned from the original / La nueva factura borrador, clonada de la original",
      ),
    },
    async ({ id, newIssueDate, newDueDate }) => withToolLogging("duplicate_invoice", async () => {
      // 1. Fetch the original invoice (returns the FULL raw stored document —
      //    payments, verifactu, eInvoice, operationType, createdBy, etc.)
      const original = await client.getInvoice(id);

      // 2. Allowlist-PICK only the fields the create endpoint actually accepts.
      //    The create POST validates against a Zod `.strict()` schema that
      //    REJECTS unknown keys (HTTP 400). Spreading the raw GET doc and only
      //    blacklisting a handful of fields left stored-only fields (payments,
      //    amountPaid, verifactu, eInvoice, operationType, poNumber, createdBy,
      //    sentTo/sentAt, cancelled*, attachments, …) in the body, so any paid /
      //    sent / cancelled / e-invoiced invoice failed to duplicate. Picking
      //    the writable subset mirrors the create schema and never 400s.
      //    Deliberately NOT copied: documentNumber (fresh gapless number),
      //    status (forced draft), recurring (a copy is a one-off), and every
      //    lifecycle/computed field (total, payments, verifactu, …).
      const COPYABLE_INVOICE_FIELDS = [
        "clientName",
        "clientId",
        "clientAddress",
        "clientTaxId",
        "items",
        "dueDate",
        "notes",
        "taxRate",
        "irpfRate",
        "equivalenceSurchargeRate",
        "clientLocation",
        "prepayment",
        "seriesId",
      ] as const;

      // 3. Build the duplicate from the writable subset + new values.
      const today = new Date().toISOString().split("T")[0];
      const invoiceData: Record<string, unknown> = {};
      for (const field of COPYABLE_INVOICE_FIELDS) {
        if (original[field] !== undefined) invoiceData[field] = original[field];
      }
      invoiceData.status = "draft";
      invoiceData.issueDate = newIssueDate || today;

      if (newDueDate) {
        invoiceData.dueDate = newDueDate;
      }

      // 4. Create the duplicate
      const result = await client.createInvoice(invoiceData);
      return {
        content: [
          mutateContent(
            formatRecord("Invoice duplicated", result) +
            `\n\nDuplicated from invoice ${id}. Status set to 'draft'. / Duplicada de la factura ${id}. Estado: borrador.`,
          ),
        ],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );
}
