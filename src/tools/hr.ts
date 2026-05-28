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
 * NOTE: ERP backend endpoints land in parallel D4-A wave. Tools wired —
 * 404s propagate as isError until backend ships. TODO: wire to CF
 * logLeaveDecision callable when REST shell lands.
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

export function registerHrTools(server: McpServer, client: IFrihetClient): void {
  // -- leave_request_create --

  server.registerTool(
    "leave_request_create",
    {
      title: "Create Leave Request",
      description:
        "Create a new leave/PTO request for an employee. " +
        "Types: 'vacation', 'sick', 'personal', 'parental', 'unpaid', 'training'. " +
        "Dates must be ISO 8601 (YYYY-MM-DD). Status starts as 'pending' awaiting manager approval. " +
        "/ Crea una nueva solicitud de vacaciones/permiso. Estado inicial 'pending' pendiente aprobacion.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        employeeId: z.string().describe("Employee ID / ID del empleado"),
        type: z.string().describe("Leave type slug (vacation, sick, personal, parental, unpaid, training) / Tipo de permiso"),
        startDate: z.string().describe("Start date ISO 8601 (YYYY-MM-DD) / Fecha inicio"),
        endDate: z.string().describe("End date ISO 8601 (YYYY-MM-DD) / Fecha fin"),
        reason: z.string().optional().describe("Optional reason / Motivo opcional"),
      },
      outputSchema: leaveRequestItemOutput,
    },
    async (input) => withToolLogging("leave_request_create", async () => {
      const result = await client.createLeaveRequest(input);
      return {
        content: [mutateContent(formatRecord("Leave request created", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
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
    async ({ leaveId, reason }) => withToolLogging("leave_approve", async () => {
      const result = await client.approveLeave(leaveId, { reason });
      return {
        content: [mutateContent(formatRecord("Leave approved", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
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
    async ({ leaveId, reason }) => withToolLogging("leave_reject", async () => {
      const result = await client.rejectLeave(leaveId, { reason });
      return {
        content: [mutateContent(formatRecord("Leave rejected", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
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
    async ({ leaveId }) => withToolLogging("leave_cancel", async () => {
      const result = await client.cancelLeave(leaveId);
      return {
        content: [mutateContent(formatRecord("Leave cancelled", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
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
      withToolLogging("leave_list", async () => {
        const result = await client.listLeaves({ employeeId, status, from, to, limit, offset, after });
        return {
          content: [listContent(formatPaginatedResponse("leaves", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
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
      },
      outputSchema: attendanceEntryItemOutput,
    },
    async (input) => withToolLogging("attendance_clock_in", async () => {
      const result = await client.attendanceClockIn(input);
      return {
        content: [mutateContent(formatRecord("Clocked in", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
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
      },
      outputSchema: attendanceEntryItemOutput,
    },
    async ({ entryId }) => withToolLogging("attendance_clock_out", async () => {
      const result = await client.attendanceClockOut(entryId);
      return {
        content: [mutateContent(formatRecord("Clocked out", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- overtime_report --

  server.registerTool(
    "overtime_report",
    {
      title: "Overtime Report",
      description:
        "Generate an overtime report for a period. Aggregates regular vs overtime hours " +
        "per employee + total estimated cost in EUR. Useful for payroll prep and labor-law audits. " +
        "Period format: 'YYYY-MM' (monthly) or 'YYYY-QN' (quarterly) or 'YYYY' (annual). " +
        "/ Informe de horas extra por periodo. Agrega horas regulares vs extra por empleado + coste estimado.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        period: z.string().describe("Period (YYYY-MM, YYYY-QN, or YYYY) / Periodo"),
        employeeId: z.string().optional().describe("Optional filter by employee / Filtrar por empleado opcional"),
      },
      outputSchema: overtimeReportOutput,
    },
    async ({ period, employeeId }) => withToolLogging("overtime_report", async () => {
      const result = await client.getOvertimeReport({ period, employeeId });
      return {
        content: [getContent(formatRecord("Overtime report", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- anomaly_list --

  server.registerTool(
    "anomaly_list",
    {
      title: "List Anomalies",
      description:
        "List HR / operational / financial anomalies detected by the system. " +
        "Filter by type (duplicate_clock_in, overtime_spike, missing_clock_out, expense_outlier, etc.), " +
        "severity (low/medium/high/critical), or period. " +
        "Useful for daily HR review and compliance audits. " +
        "/ Lista anomalias detectadas (RRHH/operativas/financieras) con filtros opcionales.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        type: z.string().optional().describe("Filter by anomaly type slug / Tipo"),
        severity: z
          .enum(["low", "medium", "high", "critical"])
          .optional()
          .describe("Filter by severity / Severidad"),
        from: z.string().optional().describe("Period start ISO 8601 / Inicio"),
        to: z.string().optional().describe("Period end ISO 8601 / Fin"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results / Maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
      },
      outputSchema: paginatedOutput(anomalyItemOutput),
    },
    async ({ type, severity, from, to, limit, offset }) =>
      withToolLogging("anomaly_list", async () => {
        const result = await client.listAnomalies({ type, severity, from, to, limit, offset });
        return {
          content: [listContent(formatPaginatedResponse("anomalies", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );
}
