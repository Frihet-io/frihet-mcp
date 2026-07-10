/**
 * Stay tools for the Frihet MCP server.
 *
 * Wave 4 — 5 tools for vacation rental management:
 *   list_reservations, get_reservation, create_reservation,
 *   list_properties, sync_channel
 *
 * ERP backend endpoints land separately (Frihet-ERP S2 sprint).
 * Tools target /v1/stay/reservations, /v1/stay/properties, /v1/stay/channels.
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
  CREATE_ANNOTATIONS,
  UPDATE_ANNOTATIONS,
  paginatedOutput,
  reservationItemOutput,
  propertyItemOutput,
} from "./shared.js";

export function registerStayTools(server: McpServer, client: IFrihetClient): void {
  // -- list_reservations --

  server.registerTool(
    "list_reservations",
    {
      title: "List Reservations",
      description:
        "List all reservations for the workspace, with optional filters by " +
        "property, status, or date range. Returns guest, dates, channel, and total. " +
        "/ Lista todas las reservas del espacio de trabajo, con filtros opcionales " +
        "por propiedad, estado o rango de fechas.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        propertyId: z
          .string()
          .optional()
          .describe("Filter by property ID / Filtrar por propiedad"),
        status: z
          .enum(["confirmed", "pending", "cancelled", "completed", "no_show"])
          .optional()
          .describe("Filter by reservation status / Filtrar por estado"),
        checkInFrom: z
          .string()
          .optional()
          .describe("Check-in from date YYYY-MM-DD / Entrada desde (YYYY-MM-DD)"),
        checkInTo: z
          .string()
          .optional()
          .describe("Check-in to date YYYY-MM-DD / Entrada hasta (YYYY-MM-DD)"),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated fields to return / Campos a devolver"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100)"),
        offset: z.number().int().min(0).optional().describe("Offset for pagination / Desplazamiento"),
        after: z
          .string()
          .optional()
          .describe("Cursor for cursor-based pagination / Cursor de paginacion"),
      },
      outputSchema: paginatedOutput(reservationItemOutput, { projectable: true }),
    },
    async (args) =>
      withToolLogging("list_reservations", async () => {
        const result = await client.listReservations(args);
        return {
          content: [listContent(formatPaginatedResponse("reservations", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- get_reservation --

  server.registerTool(
    "get_reservation",
    {
      title: "Get Reservation",
      description:
        "Get a single reservation by ID. Returns full booking details: guest, " +
        "property, dates, channel, payment status, and notes. " +
        "/ Obtiene una reserva por ID. Devuelve todos los detalles de la reserva.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Reservation ID / ID de reserva"),
      },
      outputSchema: reservationItemOutput,
    },
    async ({ id }) =>
      withToolLogging("get_reservation", async () => {
        const result = await client.getReservation(id);
        return {
          content: [getContent(formatRecord("Reservation", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- create_reservation --

  server.registerTool(
    "create_reservation",
    {
      title: "Create Reservation",
      description:
        "Create a new reservation manually (not via channel sync). Requires property ID, " +
        "check-in/check-out dates, and guest count. Optionally provide a guest ID or " +
        "inline guest data to create a new guest. " +
        "/ Crea una nueva reserva manualmente. Requiere propiedad, fechas y numero de huespedes.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        propertyId: z.string().describe("Property ID / ID de propiedad"),
        guestId: z
          .string()
          .optional()
          .describe("Existing guest ID (if known) / ID de huesped existente"),
        guest: z
          .object({
            name: z.string().describe("Guest full name / Nombre completo del huesped"),
            email: z.string().optional().describe("Guest email / Email del huesped"),
            phone: z.string().optional().describe("Guest phone / Telefono del huesped"),
            idDocument: z
              .string()
              .optional()
              .describe("DNI/passport number / Numero de DNI o pasaporte"),
            country: z
              .string()
              .optional()
              .describe("Country ISO 3166-1 alpha-2 (e.g. ES, DE) / Pais"),
          })
          .optional()
          .describe(
            "New guest data (used if guestId not provided) / Datos del nuevo huesped si no se proporciona guestId",
          ),
        checkIn: z.string().describe("Check-in date YYYY-MM-DD / Fecha de entrada"),
        checkOut: z.string().describe("Check-out date YYYY-MM-DD / Fecha de salida"),
        guestCount: z.number().int().min(1).describe("Number of guests / Numero de huespedes"),
        channelId: z
          .string()
          .optional()
          .describe("Booking channel ID (Airbnb, Booking.com, Direct) / Canal de reserva"),
        totalAmount: z
          .number()
          .nonnegative()
          .optional()
          .describe("Total amount in workspace currency / Importe total"),
        currency: z
          .string()
          .optional()
          .describe("ISO 4217 currency (defaults to workspace currency) / Divisa"),
        notes: z.string().optional().describe("Internal notes / Notas internas"),
      },
      outputSchema: reservationItemOutput,
    },
    async (args) =>
      withToolLogging("create_reservation", async () => {
        const result = await client.createReservation(args);
        return {
          content: [mutateContent(formatRecord("Reservation created", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- list_properties --

  server.registerTool(
    "list_properties",
    {
      title: "List Properties",
      description:
        "List all rental properties for the workspace. Returns name, address, " +
        "capacity, owner info, and license number. " +
        "/ Lista todas las propiedades de alquiler vacacional. Devuelve nombre, " +
        "direccion, capacidad, datos del propietario y numero de licencia.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        q: z
          .string()
          .optional()
          .describe("Search by name or address / Buscar por nombre o direccion"),
        isActive: z
          .boolean()
          .optional()
          .describe("Filter by active status / Filtrar por activas"),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated fields to return / Campos a devolver"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100)"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
        after: z
          .string()
          .optional()
          .describe("Cursor for cursor-based pagination / Cursor de paginacion"),
      },
      outputSchema: paginatedOutput(propertyItemOutput, { projectable: true }),
    },
    async (args) =>
      withToolLogging("list_properties", async () => {
        const result = await client.listProperties(args);
        return {
          content: [listContent(formatPaginatedResponse("properties", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- sync_channel --

  server.registerTool(
    "sync_channel",
    {
      title: "Sync Channel",
      description:
        "Trigger a manual sync of a booking channel (Airbnb, Booking.com, etc.). " +
        "Pulls new reservations and/or pushes calendar updates. Returns sync status and counts. " +
        "/ Dispara sincronizacion manual de un canal de reservas. Importa reservas nuevas " +
        "y/o envia actualizaciones de calendario.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        channelId: z.string().describe("Channel ID / ID de canal"),
        direction: z
          .enum(["pull", "push", "both"])
          .optional()
          .describe(
            "Sync direction: pull (import reservations), push (export calendar), or both (default). " +
            "/ Direccion: pull (importar), push (exportar) o both (ambas, por defecto).",
          ),
      },
      outputSchema: z.object({
        channelId: z.string(),
        status: z.enum(["ok", "partial", "failed"]),
        pulledCount: z.number().int().nonnegative(),
        pushedCount: z.number().int().nonnegative(),
        errors: z.array(z.string()).optional(),
        lastSyncAt: z.string(),
      }),
    },
    async ({ channelId, direction }) =>
      withToolLogging("sync_channel", async () => {
        const result = await client.syncChannel(channelId, direction ?? "both");
        return {
          content: [mutateContent(formatRecord("Channel sync", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );
}
