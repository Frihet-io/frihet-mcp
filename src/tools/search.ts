/**
 * Cross-resource global search tool — Phase 10 second-wave safe parity.
 *
 * Wraps `GET /v1/search/global?q=&types=&limit=&offset=` (publicApi.ts:4476).
 * Read-only fan-out across invoices / expenses / vendors / clients / products
 * with workspace scoping preserved by Firestore subcollection paths on the
 * server. No mutating counterpart; no auth boundary different from any other
 * list tool.
 *
 * Why this lives alone (not in clients.ts): it is not a clients/* endpoint,
 * has its own canonical envelope (`{data, total, ..., query, types,
 * truncated?}` instead of the standard paginated one), and is the only
 * server-side fan-out tool — coupling it with one resource would mislead the
 * tool listing.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import {
  withToolLogging,
  listContent,
  READ_ONLY_ANNOTATIONS,
  formatPaginatedResponse,
} from "./shared.js";

const GLOBAL_SEARCH_TYPES = ["invoices", "expenses", "vendors", "clients", "products"] as const;

const globalSearchOutputSchema = z.object({
  data: z.array(z.record(z.string(), z.unknown())),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  query: z.string(),
  types: z.array(z.enum(GLOBAL_SEARCH_TYPES)),
  truncated: z.boolean().optional(),
});

export function registerSearchTools(server: McpServer, client: IFrihetClient): void {
  server.registerTool(
    "global_search",
    {
      title: "Global Search",
      description:
        "Search across invoices, expenses, vendors, clients, and products in one call. " +
        "Use this to resolve an entity name/email/number when you do not yet know the resource type. " +
        "Returns per-hit {type, id, name, ...} so the caller can dispatch to the right list/get tool. " +
        "Read-only and workspace-scoped. " +
        "Example: q='acme', types=['clients','invoices'], limit=10 " +
        "/ Busca en facturas, gastos, proveedores, clientes y productos en una sola llamada. " +
        "Util para resolver un nombre/correo/numero cuando no se sabe aun el tipo de recurso.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        q: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("Free-text query (1-200 chars) / Texto a buscar"),
        types: z
          .array(z.enum(GLOBAL_SEARCH_TYPES))
          .optional()
          .describe(
            "Restrict to these resource types. Defaults to all 5. / Tipos a incluir (por defecto todos)",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results across all types (1-50, default 25) / Resultados maximos"),
        offset: z
          .number()
          .int()
          .min(0)
          .max(1000)
          .optional()
          .describe("Offset / Desplazamiento"),
      },
      outputSchema: globalSearchOutputSchema,
    },
    async ({ q, types, limit, offset }) =>
      withToolLogging("global_search", async () => {
        // Trim defensively: the JSON Schema serialization of `z.string().trim()`
        // drops the trim hint, so leading/trailing whitespace survives MCP's
        // input validation and would reach the ERP's q-length check as junk.
        const cleanQ = q.trim();
        const result = await client.globalSearch({
          q: cleanQ,
          types: types as ReadonlyArray<(typeof GLOBAL_SEARCH_TYPES)[number]> | undefined,
          limit,
          offset,
        });
        return {
          content: [listContent(formatPaginatedResponse("search", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );
}
