/**
 * Deposit tools for the Frihet MCP server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import { withToolLogging, formatPaginatedResponse, formatRecord, listContent, getContent, mutateContent, enrichResponse, READ_ONLY_ANNOTATIONS, CREATE_ANNOTATIONS, UPDATE_ANNOTATIONS, DELETE_ANNOTATIONS, paginatedOutput, deleteResultOutput, depositItemOutput, actionResultOutput } from "./shared.js";

export function registerDepositTools(server: McpServer, client: IFrihetClient): void {
  // -- list_deposits --

  server.registerTool(
    "list_deposits",
    {
      title: "List Deposits",
      description:
        "List all deposits with optional pagination and date range filters. " +
        "Returns deposits sorted by date (newest first). " +
        "Example: from='2026-01-01', to='2026-03-31', clientId='abc', limit=50 " +
        "/ Lista todos los depositos con paginacion y filtros de fecha opcionales.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        clientId: z
          .string()
          .optional()
          .describe("Filter by client ID / Filtrar por ID de cliente"),
        status: z
          .string()
          .optional()
          .describe("Filter by status (e.g. 'pending', 'applied', 'refunded') / Filtrar por estado"),
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
          .describe("Comma-separated field names to return (e.g. 'id,amount,status') / Campos a devolver"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100) / Resultados maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
        after: z
          .string()
          .optional()
          .describe("Cursor for cursor-based pagination (document ID) / Cursor para paginacion basada en cursor"),
      },
      outputSchema: paginatedOutput(depositItemOutput, { projectable: true }),
    },
    async ({ from, to, limit, offset, clientId, status, fields, after }) => withToolLogging("list_deposits", async () => {
      const result = await client.listDeposits({ limit, offset, after, fields, from, to, clientId, status });
      const hints = enrichResponse("deposits", "list", result.data);
      return {
        content: [listContent(formatPaginatedResponse("deposits", result) + hints)],
        structuredContent: { ...result } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_deposit --

  server.registerTool(
    "get_deposit",
    {
      title: "Get Deposit",
      description:
        "Get a single deposit by its ID. " +
        "/ Obtiene un deposito por su ID.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Deposit ID / ID del deposito"),
      },
      outputSchema: depositItemOutput,
    },
    async ({ id }) => withToolLogging("get_deposit", async () => {
      const result = await client.getDeposit(id);
      return {
        content: [getContent(formatRecord("Deposit", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- create_deposit --

  server.registerTool(
    "create_deposit",
    {
      title: "Create Deposit",
      description:
        "Record a new deposit from a client. Requires clientId and amount. " +
        "Useful for tracking advance payments, retainers, and security deposits. " +
        "Example: clientId='abc123', amount=500, currency='EUR', description='Project retainer' " +
        "/ Registra un nuevo deposito de un cliente. Requiere clientId e importe. " +
        "Util para adelantos, retenciones y depositos de garantia.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        clientId: z.string().describe("Client ID / ID del cliente"),
        clientName: z.string().optional().describe("Client name (denormalized) / Nombre del cliente"),
        amount: z.number().describe("Deposit amount / Importe del deposito"),
        currency: z.string().optional().describe("Currency code (e.g. 'EUR', 'USD') / Codigo de moneda"),
        date: z
          .string()
          .optional()
          .describe("Deposit date in ISO 8601 (YYYY-MM-DD) / Fecha del deposito"),
        description: z.string().optional().describe("Deposit description / Descripcion del deposito"),
        status: z
          .string()
          .optional()
          .describe("Status (e.g. 'pending', 'applied', 'refunded') / Estado"),
        paymentMethod: z
          .string()
          .optional()
          .describe("Payment method (e.g. 'bank_transfer', 'card') / Metodo de pago"),
        reference: z.string().optional().describe("External reference or receipt number / Referencia externa"),
        notes: z.string().optional().describe("Internal notes / Notas internas"),
      },
      outputSchema: depositItemOutput,
    },
    async (input) => withToolLogging("create_deposit", async () => {
      const result = await client.createDeposit(input);
      const hints = enrichResponse("deposits", "create", result);
      return {
        content: [mutateContent(formatRecord("Deposit created", result) + hints)],
        structuredContent: { ...result } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- update_deposit --

  server.registerTool(
    "update_deposit",
    {
      title: "Update Deposit",
      description:
        "Update an existing deposit using PATCH semantics. Only the provided fields will be changed. " +
        "Example: id='abc123', amount=750, notes='Updated retainer amount' " +
        "/ Actualiza un deposito existente. Solo se modifican los campos proporcionados.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Deposit ID / ID del deposito"),
        clientId: z.string().optional().describe("Client ID / ID del cliente"),
        clientName: z.string().optional().describe("Client name / Nombre del cliente"),
        amount: z.number().optional().describe("Amount / Importe"),
        currency: z.string().optional().describe("Currency code / Moneda"),
        date: z.string().optional().describe("Date (YYYY-MM-DD) / Fecha"),
        description: z.string().optional().describe("Description / Descripcion"),
        status: z.string().optional().describe("Status / Estado"),
        paymentMethod: z.string().optional().describe("Payment method / Metodo de pago"),
        reference: z.string().optional().describe("Reference / Referencia"),
        notes: z.string().optional().describe("Notes / Notas"),
      },
      outputSchema: depositItemOutput,
    },
    async ({ id, ...data }) => withToolLogging("update_deposit", async () => {
      const result = await client.updateDeposit(id, data);
      return {
        content: [mutateContent(formatRecord("Deposit updated", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- delete_deposit --

  server.registerTool(
    "delete_deposit",
    {
      title: "Delete Deposit",
      description:
        "Permanently delete a deposit by its ID. This action cannot be undone. " +
        "/ Elimina permanentemente un deposito por su ID. Esta accion no se puede deshacer.",
      annotations: DELETE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Deposit ID / ID del deposito"),
      },
      outputSchema: deleteResultOutput,
    },
    async ({ id }) => withToolLogging("delete_deposit", async () => {
      await client.deleteDeposit(id);
      const hints = enrichResponse("deposits", "delete", { id });
      return {
        content: [mutateContent(`Deposit ${id} deleted successfully. / Deposito ${id} eliminado correctamente.` + hints)],
        structuredContent: { success: true, id } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- apply_deposit --

  server.registerTool(
    "apply_deposit",
    {
      title: "Apply Deposit",
      description:
        "Apply a deposit to an invoice or mark it as used. " +
        "Transitions the deposit status to 'applied'. " +
        "ERP requires invoiceId + invoiceNumber + amount on the body; id is the deposit ID. " +
        "Example: id='dep_abc123', invoiceId='inv_xyz', invoiceNumber='F-2026-007', amount=150 " +
        "/ Aplica un deposito a una factura o lo marca como utilizado. Requiere invoiceId, invoiceNumber y amount.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Deposit ID / ID del deposito"),
        invoiceId: z
          .string()
          .describe("Invoice ID to apply the deposit to / ID de la factura a la que aplicar el deposito"),
        invoiceNumber: z
          .string()
          .describe("Invoice number (document number) the deposit applies to / Numero de la factura"),
        amount: z
          .number()
          .describe("Amount of the deposit to apply in EUR / Importe del deposito a aplicar en EUR"),
        notes: z.string().optional().describe("Application notes / Notas de aplicacion"),
      },
      outputSchema: actionResultOutput,
    },
    async ({ id, ...data }) => withToolLogging("apply_deposit", async () => {
      const result = await client.applyDeposit(id, data);
      return {
        content: [mutateContent(formatRecord("Deposit applied", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- refund_deposit --

  server.registerTool(
    "refund_deposit",
    {
      title: "Record Deposit Refund",
      description:
        "Record a full or partial deposit refund in Frihet's bookkeeping; no money is transferred. Requires confirm=true. " +
        "Omit amount to record a refund of the remaining balance. Only a full refund sets status='refunded'. " +
        "A new call can record another partial refund; after an uncertain result, check get_deposit before retrying. " +
        "Example: id='dep_abc123', amount=50, confirm=true " +
        "/ Registra una devolución total o parcial del depósito sin transferir dinero. Requiere confirm=true. " +
        "Omite amount para registrar la devolución del saldo restante. Solo la devolución total marca el estado 'refunded'. " +
        "Una nueva llamada puede registrar otra devolución parcial; ante un resultado incierto, consulta get_deposit antes de repetir.",
      annotations: { ...UPDATE_ANNOTATIONS, destructiveHint: true, idempotentHint: false },
      inputSchema: z.object({
        id: z.string().min(1).describe("Deposit ID / ID del depósito"),
        amount: z.number().positive().optional().describe("Positive refund amount in the deposit currency; omit for the remaining balance / Importe positivo en la moneda del depósito; omite para el saldo restante"),
        confirm: z
          .boolean()
          .describe("Must be true to record the refund; no money is transferred / Debe ser true para registrar la devolución; no se transfiere dinero"),
      }).strict(),
      outputSchema: actionResultOutput,
    },
    async ({ id, confirm, amount }) => withToolLogging("refund_deposit", async () => {
      if (confirm !== true) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: confirm=true is required to record a deposit refund. " +
                "This reduces the recorded remaining balance; no money is transferred and this tool cannot undo the entry. / " +
                "Se requiere confirm=true para registrar la devolución y reducir el saldo contable. " +
                "No se transfiere dinero y esta herramienta no permite deshacer el registro.",
            },
          ],
          isError: true,
        };
      }
      const result = await client.refundDeposit(id, amount === undefined ? {} : { amount });
      return {
        content: [mutateContent(formatRecord("Deposit refund recorded (no money transferred)", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );
}
