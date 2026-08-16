/**
 * Period close tools for the Frihet MCP server — D4-B megasprint (3 tools).
 *
 * Tools:
 *   1. period_close_status — get the current or selected fiscal-year state
 *   2. period_close        — close a monthly or quarterly period (TRUST AREA)
 *   3. period_reopen       — reopen a closed period with required reason (TRUST AREA)
 *
 * REST surface: /v1/periods/current, /v1/periods/{id}, /v1/periods/close, /v1/periods/{id}/reopen
 *
 * Closing a period freezes invoices/expenses/journal entries. Reopening requires a
 * compliance reason logged for audit. These are TRUST AREA operations.
 *
 * Period reads are live. The ERP close/reopen routes remain deferred and return
 * honest 501 responses without mutating fiscal state.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import {
  withToolLogging,
  formatRecord,
  getContent,
  mutateContent,
  READ_ONLY_ANNOTATIONS,
  currentPeriodOutput,
  periodStatusOutput,
} from "./shared.js";
import { withBackendGuard } from "./backend-availability.js";

export function registerAccountingCloseTools(server: McpServer, client: IFrihetClient): void {
  // -- period_close_status --

  server.registerTool(
    "period_close_status",
    {
      title: "Period Close Status",
      description:
        "Get the open or closed state of the current fiscal year, including its fiscal-year start, " +
        "inclusive date range, and nullable closing details. Pass a four-digit fiscal-year label to read it explicitly. " +
        "/ Devuelve el estado abierto o cerrado del ejercicio fiscal actual o indicado.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        periodId: z
          .string()
          .regex(/^\d{4}$/)
          .optional()
          .describe("Compatibility field: fiscal-year label YYYY, not an arbitrary period ID (default: current) / Ejercicio fiscal YYYY"),
      },
      outputSchema: currentPeriodOutput,
    },
    async ({ periodId }) => withToolLogging("period_close_status", () =>
      withBackendGuard("period_close_status", periodId ? `/v1/periods/${periodId}` : "/v1/periods/current", async () => {
        const result = await client.getCurrentPeriod({ fiscalYear: periodId });
        return {
          content: [getContent(formatRecord("Period status", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );

  // -- period_close --

  server.registerTool(
    "period_close",
    {
      title: "Close Accounting Period",
      description:
        "TRUST AREA — FISCAL CLOSE. Close a monthly or quarterly accounting period. " +
        "Freezes invoices, expenses, journal entries and bank reconciliations for the period. " +
        "Requires confirm=true. Idempotent: re-closing an already closed period is a no-op. " +
        "Closed periods can be reopened with period_reopen + audit reason. " +
        "/ AREA DE CONFIANZA — CIERRE FISCAL. Cierra un periodo contable mensual o trimestral. " +
        "Congela facturas, gastos, asientos. Requiere confirm=true.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        type: z
          .enum(["monthly", "quarterly"])
          .describe("Period type: monthly or quarterly / Tipo: mensual o trimestral"),
        confirm: z
          .boolean()
          .describe("Must be true to perform the close / Debe ser true para ejecutar el cierre"),
      },
      outputSchema: periodStatusOutput,
    },
    async ({ type, confirm }) => withToolLogging("period_close", async () => {
      if (!confirm) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: confirm=true is required to close an accounting period. " +
                "This freezes all invoices, expenses, journal entries and bank reconciliations for the period. " +
                "Set confirm=true when you are certain. / " +
                "Se requiere confirm=true para cerrar un periodo contable.",
            },
          ],
          isError: true,
        };
      }
      return withBackendGuard("period_close", "/v1/periods/close", async () => {
        const result = await client.closePeriod({ type });
        return {
          content: [mutateContent(formatRecord("Period closed", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      });
    }),
  );

  // -- period_reopen --

  server.registerTool(
    "period_reopen",
    {
      title: "Reopen Accounting Period",
      description:
        "TRUST AREA — FISCAL REOPEN. Reopen a closed accounting period. " +
        "Requires a compliance reason (audit log) and confirm=true. " +
        "Reopening allows backdated edits to invoices/expenses — use with extreme caution. " +
        "/ AREA DE CONFIANZA — REAPERTURA FISCAL. Reabre un periodo cerrado. Requiere motivo (auditoria) y confirm=true.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        periodId: z.string().describe("Closed period ID to reopen / ID del periodo cerrado"),
        reason: z
          .string()
          .min(1)
          .describe("Required audit reason (logged) / Motivo obligatorio (auditoria)"),
        confirm: z
          .boolean()
          .describe("Must be true to reopen / Debe ser true para reabrir"),
      },
      outputSchema: periodStatusOutput,
    },
    async ({ periodId, reason, confirm }) => withToolLogging("period_reopen", async () => {
      if (!confirm) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: confirm=true is required to reopen a closed accounting period. " +
                "This allows backdated edits and may affect fiscal reporting. " +
                "Set confirm=true when you are certain. / " +
                "Se requiere confirm=true para reabrir un periodo cerrado.",
            },
          ],
          isError: true,
        };
      }
      return withBackendGuard("period_reopen", "/v1/periods/reopen", async () => {
        const result = await client.reopenPeriod({ periodId, reason });
        return {
          content: [mutateContent(formatRecord("Period reopened", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      });
    }),
  );
}
