/**
 * POS (Point of Sale) tools for the Frihet MCP server.
 *
 * Wave 5 — 4 tools for point-of-sale management:
 *   list_terminals, get_sale, list_sales, refund_sale
 *
 * ERP backend endpoints land separately (Frihet-ERP S2 sprint).
 * Tools target /v1/pos/terminals and /v1/pos/sales.
 *
 * Trust Area: refund_sale requires explicit confirmation (destructive).
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
  DELETE_ANNOTATIONS,
  paginatedOutput,
  posTerminalItemOutput,
  posSaleItemOutput,
} from "./shared.js";

export function registerPosTools(server: McpServer, client: IFrihetClient): void {
  // -- list_terminals --

  server.registerTool(
    "list_terminals",
    {
      title: "List POS Terminals",
      description:
        "List all configured POS terminals (Stripe Terminal readers) for the workspace. " +
        "Returns terminal label, device type, location, and connection status. " +
        "/ Lista todos los terminales de punto de venta (lectores Stripe Terminal). " +
        "Devuelve etiqueta, tipo de dispositivo, ubicacion y estado de conexion.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        locationId: z
          .string()
          .optional()
          .describe("Filter by location ID / Filtrar por ubicacion"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100)"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
      },
      outputSchema: paginatedOutput(posTerminalItemOutput),
    },
    async (args) =>
      withToolLogging("list_terminals", async () => {
        const result = await client.listTerminals(args);
        return {
          content: [listContent(formatPaginatedResponse("terminals", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- get_sale --

  server.registerTool(
    "get_sale",
    {
      title: "Get POS Sale",
      description:
        "Get a single POS sale by ID. Returns full sale details: terminal, items, " +
        "payment method, amounts, and status. " +
        "/ Obtiene una venta POS por ID. Devuelve todos los detalles: terminal, " +
        "articulos, metodo de pago, importes y estado.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Sale ID / ID de venta"),
      },
      outputSchema: posSaleItemOutput,
    },
    async ({ id }) =>
      withToolLogging("get_sale", async () => {
        const result = await client.getSale(id);
        return {
          content: [getContent(formatRecord("Sale", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- list_sales --

  server.registerTool(
    "list_sales",
    {
      title: "List POS Sales",
      description:
        "List POS sales with optional filters by date range, terminal, or status. " +
        "/ Lista las ventas POS con filtros opcionales por fecha, terminal o estado.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        terminalId: z
          .string()
          .optional()
          .describe("Filter by terminal ID / Filtrar por terminal"),
        status: z
          .enum(["succeeded", "pending", "cancelled", "refunded", "partially_refunded"])
          .optional()
          .describe("Filter by sale status / Filtrar por estado"),
        from: z
          .string()
          .optional()
          .describe("Start date YYYY-MM-DD / Fecha de inicio"),
        to: z
          .string()
          .optional()
          .describe("End date YYYY-MM-DD / Fecha de fin"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100)"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
        after: z
          .string()
          .optional()
          .describe("Cursor for cursor-based pagination / Cursor de paginacion"),
      },
      outputSchema: paginatedOutput(posSaleItemOutput),
    },
    async (args) =>
      withToolLogging("list_sales", async () => {
        const result = await client.listSales(args);
        return {
          content: [listContent(formatPaginatedResponse("sales", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- refund_sale --
  // Trust Area: destructive action. Requires explicit `confirm: true` flag.

  server.registerTool(
    "refund_sale",
    {
      title: "Refund POS Sale",
      description:
        "Refund a POS sale in full or partially. This action is irreversible — " +
        "the customer will receive a refund to their original payment method. " +
        "You MUST pass confirm=true to proceed. Optionally specify amountCents for " +
        "a partial refund (defaults to full refund). " +
        "/ Reembolsa una venta POS total o parcialmente. Accion irreversible. " +
        "Debes pasar confirm=true. Pasa amountCents para reembolso parcial.",
      annotations: DELETE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Sale ID to refund / ID de venta a reembolsar"),
        confirm: z
          .boolean()
          .describe(
            "Must be true to proceed. Safety gate for destructive action. " +
            "/ Debe ser true para continuar. Confirmacion obligatoria.",
          ),
        amountCents: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Partial refund amount in cents. Omit for full refund. " +
            "/ Importe parcial en centimos. Omitir para reembolso completo.",
          ),
        reason: z
          .enum(["duplicate", "fraudulent", "requested_by_customer", "other"])
          .optional()
          .describe("Refund reason / Motivo del reembolso"),
      },
      outputSchema: z.object({
        id: z.string(),
        saleId: z.string(),
        status: z.enum(["succeeded", "pending", "failed"]),
        amountCents: z.number().int().nonnegative(),
        currency: z.string(),
        reason: z.string().optional(),
        createdAt: z.string(),
      }).passthrough(),
    },
    async ({ id, confirm, amountCents, reason }) =>
      withToolLogging("refund_sale", async () => {
        if (!confirm) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "Error: refund_sale requires confirm=true to proceed. " +
                  "This action is irreversible — the customer will receive a refund. " +
                  "/ Se requiere confirm=true. Esta accion es irreversible.",
                annotations: { audience: ["user"], priority: 1.0 },
              },
            ],
            isError: true,
          };
        }
        const result = await client.refundSale(id, { amountCents, reason });
        return {
          content: [mutateContent(formatRecord("Refund created", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );
}
