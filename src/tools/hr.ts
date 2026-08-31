/**
 * HR (Human Resources) tools for the Frihet MCP server — D4-B megasprint (9 tools).
 *
 * Tools:
 *   1. leave_request_create — create a leave/PTO request
 *   2. leave_approve        — approve a pending leave (logs decision)
 *   3. leave_reject         — reject a pending leave with reason
 *   4. leave_cancel         — cancel own leave request
 *   5. leave_list           — list leaves (filter: employee, status, period)
 *   6. attendance_clock_in  — clock in with optional mood + location
 *   7. attendance_clock_out — close an open time entry
 *   8. overtime_report      — aggregated overtime by period
 *   9. anomaly_list         — list HR/operational anomalies
 *
 * REST surface: /v1/leaves, /v1/time-entries, /v1/anomalies
 *
 * These ERP REST routes are live. The backend guard remains a rollout/workspace
 * safety net so an unavailable route is never misreported as an empty result.
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
  leaveRequestItemOutput,
  attendanceEntryItemOutput,
  overtimeReportOutput,
  anomalyItemOutput,
} from "./shared.js";
import { withBackendGuard } from "./backend-availability.js";

export function registerHrTools(server: McpServer, client: IFrihetClient): void {
  // -- leave_request_create --

  server.registerTool(
    "leave_request_create",
    {
      title: "Create Leave Request",
      description:
        "Create a new leave/PTO request for an employee. " +
        "Types: 'vacation', 'sick', 'personal', 'parental', 'bereavement', 'other'. " +
        "Dates must be ISO 8601 (YYYY-MM-DD). Status starts as 'pending' awaiting manager approval. " +
        "/ Crea una nueva solicitud de vacaciones/permiso. Estado inicial 'pending' pendiente aprobacion.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        employeeId: z.string().describe("Employee ID / ID del empleado"),
        type: z
          .enum(["vacation", "sick", "personal", "parental", "bereavement", "other"])
          .describe("Leave type slug (vacation, sick, personal, parental, bereavement, other) / Tipo de permiso"),
        startDate: z.string().describe("Start date ISO 8601 (YYYY-MM-DD) / Fecha inicio"),
        endDate: z.string().describe("End date ISO 8601 (YYYY-MM-DD) / Fecha fin"),
        reason: z.string().optional().describe("Optional reason / Motivo opcional"),
      },
      outputSchema: leaveRequestItemOutput,
    },
    async (input) => withToolLogging("leave_request_create", () =>
      withBackendGuard("leave_request_create", "/v1/leaves", async () => {
        const result = await client.createLeaveRequest(input);
        return {
          content: [mutateContent(formatRecord("Leave request created", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );

  // -- leave_approve --

  server.registerTool(
    "leave_approve",
    {
      title: "Approve Leave Request",
      description:
        "TRUST AREA — HR DECISION. Approve a pending leave request. Logs decision with timestamp and approver. " +
        "Idempotent: re-approving an already approved leave is a no-op. " +
        "/ AREA DE CONFIANZA — DECISION RRHH. Aprueba una solicitud de permiso pendiente. Registra la decision.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        leaveId: z.string().describe("Leave request ID / ID de la solicitud"),
        reason: z.string().optional().describe("Optional approval note / Nota de aprobacion opcional"),
      },
      outputSchema: leaveRequestItemOutput,
    },
    async ({ leaveId, reason }) => withToolLogging("leave_approve", () =>
      withBackendGuard("leave_approve", "/v1/leaves/approve", async () => {
        const result = await client.approveLeave(leaveId, { reason });
        return {
          content: [mutateContent(formatRecord("Leave approved", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );

  // -- leave_reject --

  server.registerTool(
    "leave_reject",
    {
      title: "Reject Leave Request",
      description:
        "TRUST AREA — HR DECISION. Reject a pending leave request with a required reason. " +
        "Reason is mandatory for transparency and labor-law compliance. " +
        "/ AREA DE CONFIANZA — DECISION RRHH. Rechaza una solicitud con motivo obligatorio.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        leaveId: z.string().describe("Leave request ID / ID de la solicitud"),
        reason: z.string().min(1).describe("Required rejection reason / Motivo obligatorio de rechazo"),
      },
      outputSchema: leaveRequestItemOutput,
    },
    async ({ leaveId, reason }) => withToolLogging("leave_reject", () =>
      withBackendGuard("leave_reject", "/v1/leaves/reject", async () => {
        const result = await client.rejectLeave(leaveId, { reason });
        return {
          content: [mutateContent(formatRecord("Leave rejected", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );

  // -- leave_cancel --

  server.registerTool(
    "leave_cancel",
    {
      title: "Cancel Leave Request",
      description:
        "Cancel a leave request. Typically used by the requesting employee before approval, " +
        "or by HR after approval (which may trigger schedule rollback). " +
        "/ Cancela una solicitud de permiso (por el empleado o RRHH).",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        leaveId: z.string().describe("Leave request ID / ID de la solicitud"),
      },
      outputSchema: leaveRequestItemOutput,
    },
    async ({ leaveId }) => withToolLogging("leave_cancel", () =>
      withBackendGuard("leave_cancel", "/v1/leaves/cancel", async () => {
        const result = await client.cancelLeave(leaveId);
        return {
          content: [mutateContent(formatRecord("Leave cancelled", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );

  // -- leave_list --

  server.registerTool(
    "leave_list",
    {
      title: "List Leave Requests",
      description:
        "List leave/PTO requests with optional filters. " +
        "Filter by employee, status (pending/approved/rejected/cancelled), or period (date range). " +
        "Useful for HR dashboards, calendar views, balance tracking. " +
        "/ Lista solicitudes de permisos con filtros opcionales (empleado, estado, periodo).",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        employeeId: z.string().optional().describe("Filter by employee ID / Filtrar por empleado"),
        status: z
          .enum(["pending", "approved", "rejected", "cancelled"])
          .optional()
          .describe("Filter by status / Filtrar por estado"),
        from: z.string().optional().describe("Period start ISO 8601 (YYYY-MM-DD) / Inicio periodo"),
        to: z.string().optional().describe("Period end ISO 8601 (YYYY-MM-DD) / Fin periodo"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100) / Resultados maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
        after: z.string().optional().describe("Cursor for cursor-based pagination / Cursor"),
      },
      outputSchema: paginatedOutput(leaveRequestItemOutput),
    },
    async ({ employeeId, status, from, to, limit, offset, after }) =>
      withToolLogging("leave_list", () =>
        withBackendGuard("leave_list", "/v1/leaves", async () => {
          const result = await client.listLeaves({ employeeId, status, from, to, limit, offset, after });
          return {
            content: [listContent(formatPaginatedResponse("leaves", result))],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        }),
      ),
  );

  // -- attendance_clock_in --

  server.registerTool(
    "attendance_clock_in",
    {
      title: "Clock In (Attendance)",
      description:
        "Record an employee clock-in. Optionally captures mood (employee well-being tracking) " +
        "and location (remote/office/site). Returns an attendance entry with status='open'. " +
        "Pair with attendance_clock_out to close the entry. " +
        "/ Registra una entrada de fichaje. Captura opcionalmente estado de animo y ubicacion.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        employeeId: z.string().describe("Employee ID / ID del empleado"),
        mood: z.string().optional().describe("Optional mood slug (e.g. 'great','ok','tired') / Estado de animo"),
        location: z.string().optional().describe("Optional location ('remote','office','site') / Ubicacion"),
        idempotencyKey: z
          .string()
          .max(64)
          .optional()
          .describe(
            "Optional idempotency key, max 64 chars. One is generated per call when omitted or blank; " +
            "pass your own to make a retry replay the stored open entry instead of creating a second clock-in. " +
            "Reusing a key with a different body returns 409 IDEMPOTENCY_KEY_REUSED — reconcile, do not " +
            "retry with a new key. / Clave de idempotencia opcional (max 64). Se genera una por llamada si se omite.",
          ),
      },
      outputSchema: attendanceEntryItemOutput,
    },
    async (input) => withToolLogging("attendance_clock_in", () =>
      withBackendGuard("attendance_clock_in", "/v1/time-entries/clock-in", async () => {
        const { idempotencyKey, ...data } = input as typeof input & { idempotencyKey?: string };
        const result = await client.attendanceClockIn(data, idempotencyKey);
        return {
          content: [mutateContent(formatRecord("Clocked in", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );

  // -- attendance_clock_out --

  server.registerTool(
    "attendance_clock_out",
    {
      title: "Clock Out (Attendance)",
      description:
        "Close an open attendance entry. Stamps clockOutAt and computes durationMinutes. " +
        "Idempotent: clocking out an already-closed entry is a no-op. " +
        "/ Cierra una entrada de fichaje abierta. Calcula la duracion en minutos.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        entryId: z.string().describe("Open attendance entry ID / ID de la entrada abierta"),
        idempotencyKey: z
          .string()
          .max(64)
          .optional()
          .describe(
            "Optional idempotency key, max 64 chars. One is generated per call when omitted or blank; " +
            "pass your own to make a retry replay the stored close instead of erroring on a closed entry. " +
            "/ Clave de idempotencia opcional (max 64). Se genera una por llamada si se omite.",
          ),
      },
      outputSchema: attendanceEntryItemOutput,
    },
    async (input) => withToolLogging("attendance_clock_out", () =>
      withBackendGuard("attendance_clock_out", "/v1/time-entries/clock-out", async () => {
        const { entryId, idempotencyKey } = input as { entryId: string; idempotencyKey?: string };
        const result = await client.attendanceClockOut(entryId, idempotencyKey);
        return {
          content: [mutateContent(formatRecord("Clocked out", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );

  // -- overtime_report --

  server.registerTool(
    "overtime_report",
    {
      title: "Overtime Report",
      description:
        "Read the ERP overtime computation for a calendar month or year: daily and weekly overtime, " +
        "worked/regular/overtime minutes, overtime hours, and compliance alerts computed from records in the selected period. " +
        "Optionally filter the attendance records by employee. Period format: 'YYYY-MM' or 'YYYY'. " +
        "/ Lee desgloses diarios y semanales, y minutos/horas agregados calculados con los registros del periodo seleccionado, con alertas.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        period: z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/).describe("Period (YYYY-MM or YYYY) / Periodo"),
        employeeId: z.string().min(1).optional().describe("Optional filter by employee / Filtrar por empleado opcional"),
      },
      outputSchema: overtimeReportOutput,
    },
    async ({ period, employeeId }) => withToolLogging("overtime_report", () =>
      withBackendGuard("overtime_report", "/v1/time-entries/overtime", async () => {
        const result = await client.getOvertimeReport({ period, employeeId });
        return {
          content: [getContent(formatRecord("Overtime report", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );

  // -- anomaly_list --

  server.registerTool(
    "anomaly_list",
    {
      title: "List Anomalies",
      description:
        "List HR / operational / financial anomalies detected by the system. " +
        "Filter by type (daily_exceeded, weekly_exceeded, annual_approaching, " +
        "annual_exceeded, missing_break), severity (warning/critical), or period. " +
        "Anomalies are COMPUTE-ON-READ over the live attendance records (Art.34/35 ET " +
        "overtime engine) — there is no stored anomalies collection. " +
        "Useful for daily HR review and compliance audits. " +
        "/ Lista anomalias detectadas (RRHH/operativas/financieras) con filtros opcionales.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        type: z
          .enum([
            "daily_exceeded",
            "weekly_exceeded",
            "annual_approaching",
            "annual_exceeded",
            "missing_break",
          ])
          .optional()
          .describe("Filter by anomaly type slug / Tipo"),
        severity: z
          .enum(["warning", "critical"])
          .optional()
          .describe("Filter by severity / Severidad"),
        from: z.string().optional().describe("Period start ISO 8601 (YYYY-MM-DD) / Inicio"),
        to: z.string().optional().describe("Period end ISO 8601 (YYYY-MM-DD) / Fin"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results / Maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
      },
      outputSchema: paginatedOutput(anomalyItemOutput),
    },
    async ({ type, severity, from, to, limit, offset }) =>
      withToolLogging("anomaly_list", () =>
        withBackendGuard("anomaly_list", "/v1/anomalies", async () => {
          const result = await client.listAnomalies({ type, severity, from, to, limit, offset });
          return {
            content: [listContent(formatPaginatedResponse("anomalies", result))],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        }),
      ),
  );
}
