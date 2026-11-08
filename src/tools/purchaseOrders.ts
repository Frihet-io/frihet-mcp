/**
 * Purchase-order read tools for the Frihet MCP server.
 *
 * READ-ONLY surface for the /v1/purchase-orders family (ADR 0027 S2, server
 * authority shipped in Frihet-ERP #2359). The single-object read returns the
 * stored document as it lives in the workspace; list returns the same shape
 * paged by status and vendorId, ordered by createdAt desc.
 *
 * Scope semantics: list_purchase_orders and get_purchase_order both classify
 * as `read` under the family router (functions/src/publicApi/apiKeyScopes.ts
 * → requiredPurchaseOrderApiAccess), so a restricted API key needs at least
 * one of `*`, `read`, `purchase-orders:*` or `purchase-orders:read`.
 *
 * WRITE tools (create draft, send, confirm, cancel, receive, reverse-receipt,
 * bill) are deliberately NOT exposed here: they move money or stock and need
 * human-authority semantics (draft → show → confirm) that this surface does not
 * define. No write route is called from this file or from the client methods.
 *
 * NOT IN SCOPE for this surface (correction to a prior brief):
 *   - Physical count truth (#2355): no callable, no API route. Not designed.
 *   - Inventory balances (/v1/inventory/balances): ADR 0027 S4, not landed.
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
  READ_ONLY_ANNOTATIONS,
  paginatedOutput,
  purchaseOrderItemOutput,
} from "./shared.js";

/**
 * Read tools for purchase orders. Tool names follow the canonical
 * snake_case convention used across the catalog.
 */
export function registerPurchaseOrderTools(server: McpServer, client: IFrihetClient): void {
  // -- list_purchase_orders --

  server.registerTool(
    "list_purchase_orders",
    {
      title: "List Purchase Orders",
      description:
        "List purchase orders in the workspace with optional filters. " +
        "Returns one entry per PO with vendor, status, line items and totals. " +
        "Statuses reflect the server-owned lifecycle (ADR 0027 S2): " +
        "draft → sent → confirmed → received → billed, with cancel as a terminal branch. " +
        "/ Lista pedidos de compra del workspace con filtros opcionales. " +
        "Devuelve un registro por pedido con proveedor, estado, lineas y totales. " +
        "Los estados reflejan el ciclo de vida del servidor (ADR 0027 S2): " +
        "borrador → enviado → confirmado → recibido → facturado, con cancelado como rama terminal.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        status: z
          .string()
          .optional()
          .describe(
            "Filter by PO status (draft, sent, confirmed, received, billed, cancelled) / " +
              "Filtro por estado del pedido",
          ),
        vendorId: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .optional()
          .describe("Filter by vendor ID / Filtro por ID de proveedor"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results (1-100) / Resultados maximos"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Offset / Desplazamiento"),
      },
      outputSchema: paginatedOutput(purchaseOrderItemOutput),
    },
    async ({ status, vendorId, limit, offset }) =>
      withToolLogging("list_purchase_orders", async () => {
        const result = await client.listPurchaseOrders({ status, vendorId, limit, offset });
        return {
          content: [listContent(formatPaginatedResponse("purchase_orders", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- get_purchase_order --

  server.registerTool(
    "get_purchase_order",
    {
      title: "Get Purchase Order",
      description:
        "Get a single purchase order by its ID. Returns the full document: " +
        "vendor, line items, totals, status, issue/expected dates and currency. " +
        "/ Obtiene un pedido de compra por su ID. Devuelve el documento completo: " +
        "proveedor, lineas, totales, estado, fechas de emision y esperada y moneda.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .describe("Purchase-order ID / ID del pedido de compra"),
      },
      outputSchema: purchaseOrderItemOutput,
    },
    async ({ id }) =>
      withToolLogging("get_purchase_order", async () => {
        const result = await client.getPurchaseOrder(id);
        return {
          content: [getContent(formatRecord("PurchaseOrder", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );
}
