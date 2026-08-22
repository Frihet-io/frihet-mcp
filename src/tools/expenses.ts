/**
 * Expense tools for the Frihet MCP server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import { withToolLogging, formatPaginatedResponse, formatRecord, listContent, getContent, mutateContent, enrichResponse, READ_ONLY_ANNOTATIONS, CREATE_ANNOTATIONS, UPDATE_ANNOTATIONS, DELETE_ANNOTATIONS, paginatedOutput, deleteResultOutput, expenseItemOutput } from "./shared.js";

/**
 * Strict calendar-valid ISO date (YYYY-MM-DD). Regex gates the SHAPE
 * (exactly 4-2-2 digits, zero-padded) and `isStrictIsoDate` proves the date
 * exists on the calendar — JS Date overflow silently rolls `2026-02-29`
 * forward to `2026-03-01` and `2026-04-31` to `2026-05-01`, so a round-trip
 * via `getUTCDate()` catches both cases. `2028-02-29` (leap year) passes.
 * Non-zero-padded forms (`2026-4-1`) are rejected by the regex.
 */
const STRICT_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isStrictIsoDate(value: unknown): value is string {
  // The field is optional; Zod calls the refine predicate with the post-
  // optional value, which can be `undefined` for the absent case. Accept and
  // treat undefined as "valid" — Zod's optional() short-circuits before refine
  // for the undefined input in practice, but the type contract requires us to
  // handle it defensively.
  if (typeof value !== "string") return false;
  if (!STRICT_ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  // Construct at UTC midnight to dodge local-timezone day-shift (e.g. parsing
  // 2026-02-29 in a +01 zone can flip to 2026-02-28 if the constructor is
  // local). Then compare every component back so any overflow (Feb 30, Apr 31)
  // is detected as a mismatch.
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return (
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() === m - 1 &&
    parsed.getUTCDate() === d
  );
}

/**
 * Public Zod schema for `create_expense` input — exported for tests so the
 * validation contract can be exercised directly without spinning up a stub
 * MCP server. The registered tool's inputSchema MUST wrap this exact object
 * (MCP serializes the live Zod object to JSON Schema).
 */
export const createExpenseInputSchema = z
  .object({
    description: z.string().describe("Expense description / Descripcion del gasto"),
    amount: z.number().describe("Amount in EUR / Importe en EUR"),
    category: z
      .string()
      .optional()
      .describe("Expense category (e.g. 'office', 'travel', 'software') / Categoria"),
    date: z
      .string()
      .optional()
      .describe("Expense date in ISO 8601 (YYYY-MM-DD) / Fecha del gasto"),
    vendor: z.string().optional().describe("Vendor/supplier name / Nombre del proveedor"),
    taxDeductible: z
      .boolean()
      .optional()
      .describe("Whether the expense is tax deductible / Si el gasto es deducible fiscalmente"),
    paidDate: z
      .string()
      .optional()
      .refine(isStrictIsoDate, {
        message:
          "paidDate must be a calendar-valid ISO 8601 date (YYYY-MM-DD, zero-padded) / Fecha de pago invalida",
      })
      .describe(
        "Optional payment date in ISO 8601 (YYYY-MM-DD). Drives the Modelo 111/115/130 cash-basis period selector. " +
          "Must be a real calendar date (2028-02-29 is valid, 2026-02-29 is not). " +
          "/ Fecha de pago opcional en ISO 8601 (YYYY-MM-DD). Determina el periodo de caja del Modelo 111/115/130.",
      ),
  })
  .strict();

export function registerExpenseTools(server: McpServer, client: IFrihetClient): void {
  // -- list_expenses --

  server.registerTool(
    "list_expenses",
    {
      title: "List Expenses",
      description:
        "List all expenses with optional pagination and date range filters. " +
        "Returns expenses sorted by date (newest first). " +
        "Example: from='2026-01-01', to='2026-03-31', limit=50 " +
        "/ Lista todos los gastos con paginacion y filtros de fecha opcionales.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        vendorId: z
          .string()
          .optional()
          .describe("Filter by vendor ID / Filtrar por ID de proveedor"),
        category: z
          .string()
          .optional()
          .describe("Filter by expense category (e.g. 'office', 'travel') / Filtrar por categoria"),
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
          .describe("Comma-separated field names to return (e.g. 'id,description,amount') / Campos a devolver"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100) / Resultados maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
        after: z
          .string()
          .optional()
          .describe("Cursor for cursor-based pagination (document ID) / Cursor para paginacion basada en cursor"),
      },
      outputSchema: paginatedOutput(expenseItemOutput, { projectable: true }),
    },
    async ({ from, to, limit, offset, vendorId, category, fields, after }) => withToolLogging("list_expenses", async () => {
      const result = await client.listExpenses({ limit, offset, after, fields, from, to, vendorId, category });
      const hints = enrichResponse("expenses", "list", result.data);
      return {
        content: [listContent(formatPaginatedResponse("expenses", result) + hints)],
        structuredContent: { ...result } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_expense --

  server.registerTool(
    "get_expense",
    {
      title: "Get Expense",
      description:
        "Get a single expense by its ID. " +
        "/ Obtiene un gasto por su ID.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Expense ID / ID del gasto"),
      },
      outputSchema: expenseItemOutput,
    },
    async ({ id }) => withToolLogging("get_expense", async () => {
      const result = await client.getExpense(id);
      return {
        content: [getContent(formatRecord("Expense", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- create_expense --
  // paidDate (#1062): optional ISO calendar date. Strict shape (zero-padded
  // YYYY-MM-DD) AND real-calendar validity (rejects 2026-02-29, 2026-04-31,
  // non-zero-padded forms). Forwards verbatim to the REST paidDate field —
  // the existing pass-through in client.createExpense handles the wire shape.

  server.registerTool(
    "create_expense",
    {
      title: "Create Expense",
      description:
        "Record a new expense. Requires a description and amount. " +
        "Useful for tracking business costs, deductible expenses, and vendor payments. " +
        "Example: description='Office supplies', amount=49.99, category='office', vendor='Amazon', taxDeductible=true, paidDate='2026-03-15' " +
        "/ Registra un nuevo gasto. Requiere descripcion e importe. " +
        "Util para seguimiento de costes, gastos deducibles y pagos a proveedores.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: createExpenseInputSchema,
      outputSchema: expenseItemOutput,
    },
    async (input) => withToolLogging("create_expense", async () => {
      const result = await client.createExpense(input);
      const hints = enrichResponse("expenses", "create", result);
      return {
        content: [mutateContent(formatRecord("Expense created", result) + hints)],
        structuredContent: { ...result } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- update_expense --

  server.registerTool(
    "update_expense",
    {
      title: "Update Expense",
      description:
        "Update an existing expense using PATCH semantics. Only the provided fields will be changed. " +
        "Example: id='abc123', amount=75.00, category='travel' " +
        "/ Actualiza un gasto existente. Solo se modifican los campos proporcionados.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Expense ID / ID del gasto"),
        description: z.string().optional().describe("Description / Descripcion"),
        amount: z.number().optional().describe("Amount in EUR / Importe"),
        category: z.string().optional().describe("Category / Categoria"),
        date: z.string().optional().describe("Date (YYYY-MM-DD) / Fecha"),
        vendor: z.string().optional().describe("Vendor / Proveedor"),
        taxDeductible: z.boolean().optional().describe("Tax deductible / Deducible"),
      },
      outputSchema: expenseItemOutput,
    },
    async ({ id, ...data }) => withToolLogging("update_expense", async () => {
      const result = await client.updateExpense(id, data);
      return {
        content: [mutateContent(formatRecord("Expense updated", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- delete_expense --

  server.registerTool(
    "delete_expense",
    {
      title: "Delete Expense",
      description:
        "Permanently delete an expense by its ID. This action cannot be undone. " +
        "/ Elimina permanentemente un gasto por su ID. Esta accion no se puede deshacer.",
      annotations: DELETE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Expense ID / ID del gasto"),
      },
      outputSchema: deleteResultOutput,
    },
    async ({ id }) => withToolLogging("delete_expense", async () => {
      await client.deleteExpense(id);
      const hints = enrichResponse("expenses", "delete", { id });
      return {
        content: [mutateContent(`Expense ${id} deleted successfully. / Gasto ${id} eliminado correctamente.` + hints)],
        structuredContent: { success: true, id } as unknown as Record<string, unknown>,
      };
    }),
  );
}
