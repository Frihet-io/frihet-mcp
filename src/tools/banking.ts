/**
 * Banking tools for the Frihet MCP server — Wave 6 (5 tools).
 *
 * Tools:
 *   1. list_bank_accounts  — list connected bank accounts per workspace
 *   2. get_bank_account    — get single account with balance + last sync
 *   3. list_transactions   — list bank transactions (filter: account, dateRange, status, category)
 *   4. categorize_transaction — apply category to a transaction (manual classification)
 *   5. match_transaction_to_invoice — link transaction to invoice/expense (reconciliation)
 *
 * REST surface: /v1/banking/accounts, /v1/banking/transactions
 *
 * NOTE: ERP backend endpoints /v1/banking/* are LIVE in Frihet-ERP (#848):
 * accounts list/get, transactions list/categorize/match. Tools are wired and
 * hit the shipped server actions. Client contract smoke:
 * src/__tests__/banking-client-contract.test.ts.
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
  UPDATE_ANNOTATIONS,
  paginatedOutput,
  bankAccountItemOutput,
  bankTransactionItemOutput,
} from "./shared.js";

export function registerBankingTools(server: McpServer, client: IFrihetClient): void {
  // -- list_bank_accounts --

  server.registerTool(
    "list_bank_accounts",
    {
      title: "List Bank Accounts",
      description:
        "List all connected bank accounts for the workspace. " +
        "Returns alias, IBAN (last 4 digits only for security), currency, balance, and last sync timestamp. " +
        "/ Lista todas las cuentas bancarias conectadas al espacio de trabajo. " +
        "Devuelve alias, IBAN (solo ultimos 4 digitos por seguridad), divisa, saldo y ultima sincronizacion.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100) / Resultados maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
      },
      outputSchema: paginatedOutput(bankAccountItemOutput),
    },
    async ({ limit, offset }) => withToolLogging("list_bank_accounts", async () => {
      const result = await client.listBankAccounts({ limit, offset });
      return {
        content: [listContent(formatPaginatedResponse("bank_accounts", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_bank_account --

  server.registerTool(
    "get_bank_account",
    {
      title: "Get Bank Account",
      description:
        "Get a single connected bank account by ID. " +
        "Returns alias, IBAN (last 4 digits), currency, current balance, and last sync timestamp. " +
        "/ Obtiene una cuenta bancaria conectada por su ID. " +
        "Devuelve alias, IBAN (ultimos 4 digitos), divisa, saldo actual y ultima sincronizacion.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Bank account ID / ID de la cuenta bancaria"),
      },
      outputSchema: bankAccountItemOutput,
    },
    async ({ id }) => withToolLogging("get_bank_account", async () => {
      const result = await client.getBankAccount(id);
      return {
        content: [getContent(formatRecord("Bank Account", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- list_transactions --

  server.registerTool(
    "list_transactions",
    {
      title: "List Bank Transactions",
      description:
        "List bank transactions with optional filters. " +
        "Filter by account, date range, status (pending/posted/excluded), or category. " +
        "Useful for reconciliation, expense matching, and cash flow analysis. " +
        "/ Lista movimientos bancarios con filtros opcionales. " +
        "Filtra por cuenta, rango de fechas, estado (pendiente/contabilizado/excluido) o categoria. " +
        "Util para conciliacion, asignacion de gastos y analisis de flujo de caja.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        accountId: z.string().optional().describe("Filter by bank account ID / Filtrar por ID de cuenta"),
        from: z.string().optional().describe("Start date ISO 8601 (YYYY-MM-DD) / Fecha inicio"),
        to: z.string().optional().describe("End date ISO 8601 (YYYY-MM-DD) / Fecha fin"),
        status: z
          .enum(["pending", "posted", "excluded"])
          .optional()
          .describe("Filter by transaction status / Filtrar por estado"),
        category: z.string().optional().describe("Filter by category slug / Filtrar por categoria"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100) / Resultados maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
        after: z.string().optional().describe("Cursor for cursor-based pagination / Cursor para paginacion"),
      },
      outputSchema: paginatedOutput(bankTransactionItemOutput),
    },
    async ({ accountId, from, to, status, category, limit, offset, after }) =>
      withToolLogging("list_transactions", async () => {
        const result = await client.listTransactions({ accountId, from, to, status, category, limit, offset, after });
        return {
          content: [listContent(formatPaginatedResponse("transactions", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- categorize_transaction --

  server.registerTool(
    "categorize_transaction",
    {
      title: "Categorize Transaction",
      description:
        "Apply a category to a bank transaction for manual classification. " +
        "Categories map to expense categories for tax deduction tracking. " +
        "Example: id='tx_abc', category='supplies', notes='Office paper Q1' " +
        "/ Asigna una categoria a un movimiento bancario. " +
        "Las categorias se mapean a categorias de gastos para el control de deducciones fiscales.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Transaction ID / ID del movimiento"),
        category: z.string().describe("Category slug (e.g. 'supplies', 'travel', 'software') / Categoria"),
        notes: z.string().optional().describe("Optional notes for this classification / Notas opcionales"),
      },
      outputSchema: bankTransactionItemOutput,
    },
    async ({ id, category, notes }) => withToolLogging("categorize_transaction", async () => {
      const result = await client.categorizeTransaction(id, { category, notes });
      return {
        content: [mutateContent(formatRecord("Transaction categorized", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- match_transaction_to_invoice --

  server.registerTool(
    "match_transaction_to_invoice",
    {
      title: "Match Transaction to Invoice",
      description:
        "TRUST AREA — RECONCILIATION. Link a bank transaction to an invoice or expense document. " +
        "This affects fiscal reconciliation records. Requires confirm=true to proceed. " +
        "Idempotent: re-matching to same document is a no-op. " +
        "Example: transactionId='tx_abc', documentId='inv_xyz', documentType='invoice', confirm=true " +
        "/ AREA DE CONFIANZA — CONCILIACION. Vincula un movimiento bancario a una factura o gasto. " +
        "Afecta registros de conciliacion fiscal. Requiere confirm=true para ejecutar.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        transactionId: z.string().describe("Bank transaction ID / ID del movimiento bancario"),
        documentId: z.string().describe("Invoice or expense ID to link / ID de la factura o gasto a vincular"),
        documentType: z
          .enum(["invoice", "expense"])
          .describe("Type of document being matched / Tipo de documento"),
        confirm: z
          .boolean()
          .describe("Must be true to confirm fiscal reconciliation / Debe ser true para confirmar conciliacion fiscal"),
        notes: z.string().optional().describe("Optional reconciliation notes / Notas de conciliacion opcionales"),
      },
      outputSchema: bankTransactionItemOutput,
    },
    async ({ transactionId, documentId, documentType, confirm, notes }) =>
      withToolLogging("match_transaction_to_invoice", async () => {
        if (!confirm) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: confirm=true is required to perform fiscal reconciliation. " +
                  "This action links a bank transaction to a fiscal document and cannot be undone easily. " +
                  "Set confirm=true when you are certain about the match. / " +
                  "Se requiere confirm=true para realizar la conciliacion fiscal.",
              },
            ],
            isError: true,
          };
        }
        const result = await client.matchTransactionToDocument(transactionId, { documentId, documentType, notes });
        return {
          content: [mutateContent(formatRecord("Transaction matched", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );
}
