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
 * STATE OF THE WORLD (verified against erp-main functions/src/publicApi/families/
 * periods.ts): only the READ route is implemented. Both WRITE routes answer
 * HTTP 501 NOT_IMPLEMENTED — "deferred to the upcoming fiscal-write wave (Trust,
 * serialized). Use year-end closing in the app for now." Nothing is frozen, and
 * there is no idempotent no-op to rely on, because there is no handler at all.
 *
 * The descriptions below therefore state the 501 in the present tense. Do not
 * restore aspirational prose about freezing or idempotency until a handler exists
 * — GAP-13 was exactly that: an agent planning a year-end close read a mechanism
 * the backend never had.
 *
 * `withBackendGuard` converts 404 only (backend-availability.ts isBackendNotFound),
 * so a 501 surfaces through the generic error path as isError with the backend's
 * own NOT_IMPLEMENTED message — an honest failure, not a fake success.
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
        "TRUST AREA — FISCAL CLOSE. NOT IMPLEMENTED SERVER-SIDE TODAY: the backend answers " +
        "HTTP 501 NOT_IMPLEMENTED to POST /v1/periods/close, so calling this tool closes nothing. " +
        "No invoices, expenses, journal entries or bank reconciliations are frozen, and there is no " +
        "idempotent no-op to rely on. Close the period in the Frihet app instead. " +
        "The call is still gated behind confirm=true and will surface the 501 as an error. " +
        "Use period_close_status (implemented) to read the current period state. " +
        "/ AREA DE CONFIANZA — CIERRE FISCAL. HOY NO IMPLEMENTADO EN EL SERVIDOR: el backend responde " +
        "HTTP 501 a POST /v1/periods/close, asi que esta herramienta no cierra nada ni congela nada. " +
        "El cierre debe hacerse en la app de Frihet.",
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
        "TRUST AREA — FISCAL REOPEN. NOT IMPLEMENTED SERVER-SIDE TODAY: the backend answers " +
        "HTTP 501 NOT_IMPLEMENTED to POST /v1/periods/{id}/reopen, so calling this tool reopens nothing " +
        "and writes no audit entry. Reopen the period in the Frihet app instead. " +
        "The call is still gated behind confirm=true plus a reason, and will surface the 501 as an error. " +
        "/ AREA DE CONFIANZA — REAPERTURA FISCAL. HOY NO IMPLEMENTADO EN EL SERVIDOR: el backend responde " +
        "HTTP 501, asi que no se reabre nada ni se registra auditoria. Hazlo en la app de Frihet.",
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
