/**
 * Time tracking tools for the Frihet MCP server — Wave Mature 3 (6 tools).
 *
 * Tools:
 *   1. list_time_entries   — list timesheets (filter: user, project, date range)
 *   2. get_time_entry      — get a single time entry by ID
 *   3. create_time_entry   — log time (project, hours, description, billable flag)
 *   4. update_time_entry   — modify existing time entry
 *   5. delete_time_entry   — soft delete (Trust Area: requires confirm)
 *   6. get_time_summary    — aggregate hours/cost by workspace or member
 *
 * REST surface: /v1/time/entries, /v1/time/summary
 *
 * NOTE: ERP backend endpoints /v1/time/* are planned. Tools are wired
 * and will surface 404 errors until the backend ships.
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
  deleteResultOutput,
  timeEntryItemOutput,
  timeSummaryOutput,
} from "./shared.js";

export function registerTimeTools(server: McpServer, client: IFrihetClient): void {
  // -- list_time_entries --

  server.registerTool(
    "list_time_entries",
    {
      title: "List Time Entries",
      description:
        "List time tracking entries with optional filters. " +
        "Filter by user, project, date range, or billable status. " +
        "Useful for generating timesheets, billing reports, and project cost analysis. " +
        "/ Lista entradas de tiempo con filtros opcionales. " +
        "Filtra por usuario, proyecto, rango de fechas o facturabilidad. " +
        "Util para partes de trabajo, informes de facturacion y analisis de costes por proyecto.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        userId: z.string().optional().describe("Filter by user ID / Filtrar por ID de usuario"),
        projectId: z.string().optional().describe("Filter by project ID / Filtrar por ID de proyecto"),
        from: z.string().optional().describe("Start date ISO 8601 (YYYY-MM-DD) / Fecha inicio"),
        to: z.string().optional().describe("End date ISO 8601 (YYYY-MM-DD) / Fecha fin"),
        billable: z.boolean().optional().describe("Filter by billable flag / Filtrar por facturabilidad"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100) / Resultados maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
        after: z.string().optional().describe("Cursor for cursor-based pagination / Cursor para paginacion"),
      },
      outputSchema: paginatedOutput(timeEntryItemOutput),
    },
    async ({ userId, projectId, from, to, billable, limit, offset, after }) =>
      withToolLogging("list_time_entries", async () => {
        const result = await client.listTimeEntries({ userId, projectId, from, to, billable, limit, offset, after });
        return {
          content: [listContent(formatPaginatedResponse("time_entries", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- get_time_entry --

  server.registerTool(
    "get_time_entry",
    {
      title: "Get Time Entry",
      description:
        "Get full details of a single time tracking entry by ID. " +
        "Returns project, user, hours, description, billable flag, date and status. " +
        "/ Obtiene los detalles completos de una entrada de tiempo por su ID. " +
        "Devuelve proyecto, usuario, horas, descripcion, facturabilidad, fecha y estado.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Time entry ID / ID de la entrada de tiempo"),
      },
      outputSchema: timeEntryItemOutput,
    },
    async ({ id }) => withToolLogging("get_time_entry", async () => {
      const result = await client.getTimeEntry(id);
      return {
        content: [getContent(formatRecord("Time entry", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- create_time_entry --

  server.registerTool(
    "create_time_entry",
    {
      title: "Create Time Entry",
      description:
        "Log a time entry for a project. " +
        "Requires projectId, hours (decimal), and date. " +
        "Mark as billable=true to include in client invoicing. " +
        "Example: projectId='proj_abc', hours=2.5, description='Frontend review', billable=true, date='2026-05-10' " +
        "/ Registra una entrada de tiempo para un proyecto. " +
        "Requiere projectId, horas (decimal) y fecha. " +
        "Marca billable=true para incluirlo en la facturacion al cliente.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        projectId: z.string().describe("Project ID / ID del proyecto"),
        hours: z.number().min(0.01).describe("Hours worked (decimal, e.g. 1.5) / Horas trabajadas (decimal)"),
        date: z.string().describe("Work date ISO 8601 (YYYY-MM-DD) / Fecha del trabajo"),
        description: z.string().optional().describe("Description of work done / Descripcion del trabajo realizado"),
        billable: z.boolean().optional().describe("Whether hours are billable to client (default true) / Si las horas son facturables"),
        userId: z.string().optional().describe("User ID (defaults to API key owner) / ID del usuario (por defecto el propietario de la API key)"),
      },
      outputSchema: timeEntryItemOutput,
    },
    async ({ projectId, hours, date, description, billable, userId }) =>
      withToolLogging("create_time_entry", async () => {
        const result = await client.createTimeEntry({ projectId, hours, date, description, billable, userId });
        return {
          content: [mutateContent(formatRecord("Time entry created", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- update_time_entry --

  server.registerTool(
    "update_time_entry",
    {
      title: "Update Time Entry",
      description:
        "Update an existing time entry using PATCH semantics. Only provided fields are changed. " +
        "Example: id='te_abc123', hours=3.0, description='Frontend review + testing' " +
        "/ Actualiza una entrada de tiempo existente. Solo se modifican los campos proporcionados.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Time entry ID / ID de la entrada de tiempo"),
        hours: z.number().min(0.01).optional().describe("Updated hours / Horas actualizadas"),
        date: z.string().optional().describe("Updated date ISO 8601 / Fecha actualizada"),
        description: z.string().optional().describe("Updated description / Descripcion actualizada"),
        billable: z.boolean().optional().describe("Updated billable flag / Facturabilidad actualizada"),
        projectId: z.string().optional().describe("Reassign to different project / Reasignar a otro proyecto"),
      },
      outputSchema: timeEntryItemOutput,
    },
    async ({ id, ...data }) => withToolLogging("update_time_entry", async () => {
      const result = await client.updateTimeEntry(id, data);
      return {
        content: [mutateContent(formatRecord("Time entry updated", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- delete_time_entry --

  server.registerTool(
    "delete_time_entry",
    {
      title: "Delete Time Entry",
      description:
        "Soft-delete a time entry by ID. " +
        "Requires confirm=true to prevent accidental deletion. " +
        "Deleted entries are excluded from billing reports but retained for audit. " +
        "/ Elimina (soft-delete) una entrada de tiempo por su ID. " +
        "Requiere confirm=true para evitar eliminaciones accidentales. " +
        "Las entradas eliminadas se excluyen de informes de facturacion pero se retienen en auditoria.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        id: z.string().describe("Time entry ID / ID de la entrada de tiempo"),
        confirm: z
          .boolean()
          .describe("Must be true to confirm deletion / Debe ser true para confirmar la eliminacion"),
      },
      outputSchema: deleteResultOutput,
    },
    async ({ id, confirm }) => withToolLogging("delete_time_entry", async () => {
      if (!confirm) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: confirm=true is required to delete a time entry. " +
                "Deleted entries affect billing reports. Set confirm=true to proceed. / " +
                "Se requiere confirm=true para eliminar una entrada de tiempo.",
            },
          ],
          isError: true,
        };
      }
      await client.deleteTimeEntry(id);
      return {
        content: [mutateContent(`Time entry ${id} deleted (soft). / Entrada de tiempo ${id} eliminada.`)],
        structuredContent: { success: true, id } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_time_summary --

  server.registerTool(
    "get_time_summary",
    {
      title: "Get Time Summary",
      description:
        "Get aggregated time tracking summary for a workspace or specific team member. " +
        "Returns total hours, billable hours, non-billable hours, and estimated cost for the period. " +
        "Filter by date range and optionally by user ID for per-member breakdowns. " +
        "/ Obtiene el resumen agregado de seguimiento de tiempo para el espacio de trabajo o un miembro. " +
        "Devuelve horas totales, facturables, no facturables y coste estimado del periodo. " +
        "Filtra por rango de fechas y opcionalmente por usuario para desglose por miembro.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        from: z.string().describe("Start date ISO 8601 (YYYY-MM-DD) / Fecha inicio"),
        to: z.string().describe("End date ISO 8601 (YYYY-MM-DD) / Fecha fin"),
        userId: z.string().optional().describe("Filter to a specific member (omit for workspace total) / Filtrar a un miembro concreto (omitir para total workspace)"),
        projectId: z.string().optional().describe("Filter to a specific project / Filtrar a un proyecto concreto"),
        groupBy: z.enum(["user", "project", "day"]).optional().describe("Group results by user, project, or day (default: no grouping) / Agrupar resultados por usuario, proyecto o dia"),
      },
      outputSchema: timeSummaryOutput,
    },
    async ({ from, to, userId, projectId, groupBy }) =>
      withToolLogging("get_time_summary", async () => {
        const result = await client.getTimeSummary({ from, to, userId, projectId, groupBy });
        return {
          content: [getContent(formatRecord("Time summary", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );
}
