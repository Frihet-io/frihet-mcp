/**
 * Kitchen (KDS) tools for the Frihet MCP server.
 *
 * Wave 6 — 6 tools for kitchen display system management:
 *   list_kitchen_tickets, get_kitchen_ticket, update_kitchen_ticket,
 *   list_kitchen_stations, list_menu_items, kitchen_flow_summary
 *
 * ERP backend endpoints at /v1/kitchen/* are live.
 * Flow summary aggregates ticket + station data to surface bottlenecks.
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
  kitchenTicketItemOutput,
  kitchenStationItemOutput,
  kitchenMenuItemOutput,
  kitchenFlowSummaryItemOutput,
} from "./shared.js";

export function registerKitchenTools(server: McpServer, client: IFrihetClient): void {
  // -- list_kitchen_tickets --

  server.registerTool(
    "list_kitchen_tickets",
    {
      title: "List Kitchen Tickets",
      description:
        "List all kitchen order tickets for the live order board, with optional filters by " +
        "status or station. Returns ticket id, station, status, table ref, and items. " +
        "/ Lista todos los tickets de cocina del panel en vivo, con filtros opcionales " +
        "por estado o estacion. Devuelve id, estacion, estado, mesa e items.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        status: z
          .enum(["on_hold", "queued", "preparing", "ready", "served", "voided"])
          .optional()
          .describe(
            "Filter by ticket status: on_hold, queued, preparing, ready, served, voided. " +
            "/ Filtrar por estado: on_hold, queued, preparing, ready, served, voided.",
          ),
        stationId: z
          .string()
          .optional()
          .describe("Filter by station ID / Filtrar por ID de estacion"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100)"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
        after: z
          .string()
          .optional()
          .describe("Cursor for cursor-based pagination / Cursor de paginacion"),
      },
      outputSchema: paginatedOutput(kitchenTicketItemOutput),
    },
    async (args) =>
      withToolLogging("list_kitchen_tickets", async () => {
        const result = await client.listKitchenTickets(args);
        return {
          content: [listContent(formatPaginatedResponse("kitchen tickets", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- get_kitchen_ticket --

  server.registerTool(
    "get_kitchen_ticket",
    {
      title: "Get Kitchen Ticket",
      description:
        "Get a single kitchen ticket by ID. Returns full ticket details including all items, " +
        "their individual statuses, station assignment, and table reference. " +
        "/ Obtiene un ticket de cocina por ID. Devuelve todos los detalles: items, " +
        "estados individuales, estacion asignada y referencia de mesa.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Ticket ID / ID del ticket"),
      },
      outputSchema: kitchenTicketItemOutput,
    },
    async ({ id }) =>
      withToolLogging("get_kitchen_ticket", async () => {
        const result = await client.getKitchenTicket(id);
        return {
          content: [getContent(formatRecord("Kitchen ticket", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- update_kitchen_ticket --

  server.registerTool(
    "update_kitchen_ticket",
    {
      title: "Update Kitchen Ticket",
      description:
        "Advance a kitchen ticket through the workflow — update its status (e.g. queued → " +
        "preparing → ready → served) or reassign it to a different station. " +
        "/ Avanza un ticket de cocina en el flujo: actualiza estado (queued → preparing → " +
        "ready → served) o reasigna a otra estacion.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Ticket ID to update / ID del ticket a actualizar"),
        status: z
          .enum(["on_hold", "queued", "preparing", "ready", "served", "voided"])
          .optional()
          .describe(
            "New ticket status: on_hold, queued, preparing, ready, served, voided. " +
            "/ Nuevo estado: on_hold, queued, preparing, ready, served, voided.",
          ),
        stationId: z
          .string()
          .optional()
          .describe("Reassign to station ID / Reasignar a estacion"),
      },
      outputSchema: kitchenTicketItemOutput,
    },
    async ({ id, ...rest }) =>
      withToolLogging("update_kitchen_ticket", async () => {
        const result = await client.updateKitchenTicket(id, rest as Record<string, unknown>);
        return {
          content: [mutateContent(formatRecord("Kitchen ticket updated", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- list_kitchen_stations --

  server.registerTool(
    "list_kitchen_stations",
    {
      title: "List Kitchen Stations",
      description:
        "List all kitchen stations. Returns station id, name, and active status. " +
        "Use kitchen_flow_summary to see per-station ticket load and bottlenecks. " +
        "/ Lista todas las estaciones de cocina. Devuelve id, nombre y estado activo. " +
        "Usa kitchen_flow_summary para ver carga por estacion y cuellos de botella.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100)"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
      },
      outputSchema: paginatedOutput(kitchenStationItemOutput),
    },
    async (args) =>
      withToolLogging("list_kitchen_stations", async () => {
        const result = await client.listKitchenStations(args);
        return {
          content: [listContent(formatPaginatedResponse("kitchen stations", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- list_menu_items --

  server.registerTool(
    "list_menu_items",
    {
      title: "List Menu Items",
      description:
        "List the kitchen menu catalog. Supports free-text search and active/inactive filter. " +
        "Returns item id, name, description, price, category, and active status. " +
        "/ Lista el catálogo de menu de cocina. Admite búsqueda de texto y filtro activo/inactivo. " +
        "Devuelve id, nombre, descripcion, precio, categoria y estado activo.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        q: z
          .string()
          .optional()
          .describe("Free-text search by name or description / Busqueda por nombre o descripcion"),
        isActive: z
          .boolean()
          .optional()
          .describe("Filter by active status / Filtrar por activos"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100)"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
        after: z
          .string()
          .optional()
          .describe("Cursor for cursor-based pagination / Cursor de paginacion"),
      },
      outputSchema: paginatedOutput(kitchenMenuItemOutput),
    },
    async (args) =>
      withToolLogging("list_menu_items", async () => {
        const result = await client.listMenuItems(args);
        return {
          content: [listContent(formatPaginatedResponse("menu items", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- kitchen_flow_summary --

  server.registerTool(
    "kitchen_flow_summary",
    {
      title: "Kitchen Flow Summary",
      description:
        "Slow-station detection: aggregates open kitchen tickets per station and flags the " +
        "bottleneck (station with the highest open-ticket count). Returns per-station openTickets " +
        "count, oldest wait time in seconds, and an isBottleneck flag. Call this first to " +
        "diagnose kitchen throughput issues before drilling into individual tickets. " +
        "/ Deteccion de cuello de botella: agrega tickets abiertos por estacion y marca la " +
        "mas saturada. Devuelve openTickets, tiempo de espera mas antiguo y flag isBottleneck " +
        "por estacion. Llamar primero para diagnosticar problemas de rendimiento de cocina.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {},
      outputSchema: z.object({
        stations: z.array(kitchenFlowSummaryItemOutput),
        bottleneckStationId: z.string().optional(),
        totalOpenTickets: z.number().int().nonnegative(),
        generatedAt: z.string(),
      }),
    },
    async () =>
      withToolLogging("kitchen_flow_summary", async () => {
        // Fetch all open tickets and all stations in parallel
        const [ticketsResult, stationsResult] = await Promise.all([
          client.listKitchenTickets({ limit: 100 }),
          client.listKitchenStations({ limit: 100 }),
        ]);

        const now = Date.now();

        // Build a per-station map from the stations list
        const stationMap = new Map<string, string>(); // id → name
        for (const s of stationsResult.data) {
          const station = s as Record<string, unknown>;
          if (typeof station["id"] === "string") {
            stationMap.set(station["id"], typeof station["name"] === "string" ? station["name"] : station["id"]);
          }
        }

        // Aggregate open tickets (all non-served/non-cancelled) per station
        interface StationAgg {
          openTickets: number;
          oldestCreatedAt: number | null;
        }
        const agg = new Map<string, StationAgg>();

        for (const t of ticketsResult.data) {
          const ticket = t as Record<string, unknown>;
          const status = typeof ticket["status"] === "string" ? ticket["status"] : "";
          if (status === "served" || status === "cancelled") continue;

          const stationId = typeof ticket["stationId"] === "string" ? ticket["stationId"] : "__unassigned__";
          const createdAt = typeof ticket["createdAt"] === "string"
            ? new Date(ticket["createdAt"]).getTime()
            : null;

          const existing = agg.get(stationId) ?? { openTickets: 0, oldestCreatedAt: null };
          existing.openTickets += 1;
          if (createdAt !== null && (existing.oldestCreatedAt === null || createdAt < existing.oldestCreatedAt)) {
            existing.oldestCreatedAt = createdAt;
          }
          agg.set(stationId, existing);
        }

        // Build station summaries, also include stations with zero open tickets
        let maxLoad = 0;
        let bottleneckId: string | undefined;

        const summaries: Array<{
          stationId: string;
          stationName: string | undefined;
          openTickets: number;
          oldestWaitSeconds: number | undefined;
          isBottleneck: boolean;
        }> = [];

        // Include all known stations (even idle ones)
        for (const [stationId, stationName] of stationMap) {
          const data = agg.get(stationId) ?? { openTickets: 0, oldestCreatedAt: null };
          summaries.push({
            stationId,
            stationName,
            openTickets: data.openTickets,
            oldestWaitSeconds: data.oldestCreatedAt !== null
              ? Math.round((now - data.oldestCreatedAt) / 1000)
              : undefined,
            isBottleneck: false,
          });
          if (data.openTickets > maxLoad) {
            maxLoad = data.openTickets;
            bottleneckId = stationId;
          }
        }

        // Include __unassigned__ bucket if present
        const unassigned = agg.get("__unassigned__");
        if (unassigned) {
          summaries.push({
            stationId: "__unassigned__",
            stationName: "Unassigned / Sin estacion",
            openTickets: unassigned.openTickets,
            oldestWaitSeconds: unassigned.oldestCreatedAt !== null
              ? Math.round((now - unassigned.oldestCreatedAt) / 1000)
              : undefined,
            isBottleneck: false,
          });
          if (unassigned.openTickets > maxLoad) {
            maxLoad = unassigned.openTickets;
            bottleneckId = "__unassigned__";
          }
        }

        // Mark the bottleneck (only if there are open tickets)
        if (bottleneckId && maxLoad > 0) {
          for (const s of summaries) {
            if (s.stationId === bottleneckId) {
              s.isBottleneck = true;
              break;
            }
          }
        }

        const totalOpenTickets = summaries.reduce((acc, s) => acc + s.openTickets, 0);

        const result = {
          stations: summaries,
          bottleneckStationId: maxLoad > 0 ? bottleneckId : undefined,
          totalOpenTickets,
          generatedAt: new Date().toISOString(),
        };

        return {
          content: [getContent(formatRecord("Kitchen flow summary", result as unknown as Record<string, unknown>))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );
}
