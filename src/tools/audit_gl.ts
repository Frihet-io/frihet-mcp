/**
 * Audit GL tools for the Frihet MCP server — Day 1 Megasprint (3 tools).
 *
 * Tools:
 *   1. frihet_gl_entry_approve    — approve a GL journal entry (TRUST AREA)
 *   2. frihet_gl_entry_reject     — reject a GL journal entry with reason (TRUST AREA)
 *   3. frihet_gl_entry_audit_log  — retrieve the audit trail for a GL entry
 *
 * REST surface: /v1/gl/* proxies Firebase callables:
 *   approveGLEntry, rejectGLEntry, getGLEntryAuditLog (eu-west1)
 *
 * Backend status (post-Day 1 Megasprint, May 2026):
 *   Frihet-ERP PR #395 — Audit GL approval workflow MERGED.
 *   Tools will surface 404 errors until backend REST shell ships.
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
  UPDATE_ANNOTATIONS,
} from "./shared.js";

export function registerAuditGLTools(server: McpServer, client: IFrihetClient): void {
  // -- frihet_gl_entry_approve -----------------------------------------------

  server.registerTool(
    "frihet_gl_entry_approve",
    {
      title: "Approve GL Entry",
      description:
        "Approve a General Ledger journal entry pending review. " +
        "Sets entry status to 'approved' and records the approver + timestamp in the audit trail. " +
        "Requires gestor/admin role. This is a TRUST AREA action — double-check entry ID before calling. " +
        "Example: entryId='gl_2026_q1_042'. " +
        "/ Aprueba un asiento contable pendiente de revision. " +
        "Requiere rol gestor/admin. Accion de area de confianza.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        entryId: z.string().describe("GL entry ID to approve / ID del asiento contable a aprobar"),
        notes: z.string().optional().describe("Optional approval notes / Notas de aprobacion opcionales"),
      },
    },
    async ({ entryId, notes }) => withToolLogging("frihet_gl_entry_approve", async () => {
      const result = await client.approveGLEntry(entryId, notes);
      return {
        content: [
          mutateContent(
            formatRecord(`GL Entry ${entryId} approved`, result),
          ),
        ],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- frihet_gl_entry_reject ------------------------------------------------

  server.registerTool(
    "frihet_gl_entry_reject",
    {
      title: "Reject GL Entry",
      description:
        "Reject a General Ledger journal entry pending review with a required reason. " +
        "Sets entry status to 'rejected' and records the rejector + reason in the audit trail. " +
        "Requires gestor/admin role. This is a TRUST AREA action. " +
        "Example: entryId='gl_2026_q1_042', reason='Importe incorrecto, revisar factura F-2026-042'. " +
        "/ Rechaza un asiento contable pendiente con una razon obligatoria. " +
        "Requiere rol gestor/admin.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        entryId: z.string().describe("GL entry ID to reject / ID del asiento contable a rechazar"),
        reason: z.string().describe("Mandatory rejection reason (visible to submitter) / Razon del rechazo (obligatoria, visible al emisor)"),
      },
    },
    async ({ entryId, reason }) => withToolLogging("frihet_gl_entry_reject", async () => {
      const result = await client.rejectGLEntry(entryId, reason);
      return {
        content: [
          mutateContent(
            formatRecord(`GL Entry ${entryId} rejected`, result),
          ),
        ],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- frihet_gl_entry_audit_log ---------------------------------------------

  server.registerTool(
    "frihet_gl_entry_audit_log",
    {
      title: "Get GL Entry Audit Log",
      description:
        "Retrieve the full audit trail for a General Ledger entry — all state transitions " +
        "(created, submitted, approved, rejected), who acted, and when. " +
        "Use this to investigate approval history or compliance audits. " +
        "Example: entryId='gl_2026_q1_042'. " +
        "/ Obtiene el historial de auditoría completo de un asiento contable. " +
        "Muestra todas las transiciones de estado, quien actuo y cuando.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        entryId: z.string().describe("GL entry ID / ID del asiento contable"),
      },
    },
    async ({ entryId }) => withToolLogging("frihet_gl_entry_audit_log", async () => {
      const result = await client.getGLEntryAuditLog(entryId);
      return {
        content: [getContent(formatRecord(`Audit Log for GL Entry ${entryId}`, result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );
}
