/**
 * Gestoria (accountant) tools for the Frihet MCP server — Wave Fase 1 (5 tools).
 *
 * Tools:
 *   1. gestoria_message_send          — send a message in a contextual thread
 *   2. gestoria_messages_list         — list messages in a thread (paged backwards)
 *   3. gestoria_template_create       — create a document request template
 *   4. gestoria_template_bulk_send    — bulk send template to N client workspaces
 *   5. gestoria_aging_consolidated    — cross-client AR aging report
 *
 * REST surface: /v1/gestoria/*
 *
 * Backend status (post-Wave Fase 1, May 2026):
 *   - Frihet-ERP PR #383 — `gestoriaBulkSendRequests` callable (eu-west1) MERGED.
 *   - Frihet-ERP PR #384 — consolidated AR aging tab (branch live, await merge).
 *   - Frihet-ERP PR #385 — contextual messaging (branch live, await merge).
 *
 * The MCP layer talks REST (`api.frihet.io/v1/gestoria/*`). The REST shell
 * proxies to Firebase callables + Firestore reads. Until the REST shell ships,
 * tools will surface 404 errors with clear messages — clients can retry post-deploy.
 *
 * App Check: mcp.frihet.io worker is App Check enforced. Region: callables
 * auto-resolve eu-west1 via existing client routing.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import {
  withToolLogging,
  formatRecord,
  listContent,
  getContent,
  mutateContent,
  READ_ONLY_ANNOTATIONS,
  CREATE_ANNOTATIONS,
  gestoriaMessageItemOutput,
  gestoriaMessageSendResultOutput,
  gestoriaTemplateCreateResultOutput,
  gestoriaBulkSendResultOutput,
  gestoriaAgingConsolidatedOutput,
} from "./shared.js";

const PARENT_TYPE = z
  .enum(["documentRequest", "filingItem", "obligation"])
  .describe(
    "Thread parent kind / Tipo de hilo: documentRequest (solicitud de documento), filingItem (presentacion fiscal), obligation (obligacion fiscal)",
  );

const TEMPLATE_VARIABLE = z.object({
  key: z.string().describe("Variable placeholder key, e.g. 'quarter' / Clave variable, p.ej. 'trimestre'"),
  label: z.string().optional().describe("Human label shown in template editor / Etiqueta legible"),
  defaultValue: z.string().optional().describe("Fallback value if no override supplied / Valor por defecto"),
});

const PERIOD_OVERRIDES = z
  .object({
    quarter: z.union([z.string(), z.number()]).optional(),
    year: z.union([z.string(), z.number()]).optional(),
    month: z.union([z.string(), z.number()]).optional(),
  })
  .optional()
  .describe(
    "Override template period variables in the bulk send / Sobrescribir variables de periodo (trimestre, ano, mes)",
  );

export function registerGestoriaTools(server: McpServer, client: IFrihetClient): void {
  // -- gestoria_message_send ------------------------------------------------

  server.registerTool(
    "gestoria_message_send",
    {
      title: "Send Gestoria Message",
      description:
        "Send a message in a contextual thread between a gestor (accountant) and a client. " +
        "Threads attach to a document request, a filing item, or a fiscal obligation — " +
        "context is preserved so both sides see what the message is about. " +
        "Useful for chasing a missing document, replying to a client's question, or " +
        "annotating a presentation. " +
        "Example: workspaceId='ws_abc', parentType='documentRequest', parentId='dr_q3_iva', body='Falta el extracto bancario de septiembre'. " +
        "/ Envia un mensaje en un hilo contextual entre gestor y cliente. " +
        "Los hilos se anclan a una solicitud de documento, presentacion o obligacion fiscal — " +
        "ambas partes ven a que se refiere. Util para pedir documentos, responder dudas o anotar presentaciones.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        workspaceId: z
          .string()
          .min(1)
          .describe("Client workspace ID the thread belongs to / ID del espacio de trabajo del cliente"),
        parentType: PARENT_TYPE,
        parentId: z.string().min(1).describe("ID of the parent entity (document request / filing item / obligation) / ID de la entidad padre"),
        body: z
          .string()
          .min(1)
          .max(4000)
          .describe("Message body (plain text, 1-4000 chars) / Cuerpo del mensaje (texto plano)"),
      },
      outputSchema: gestoriaMessageSendResultOutput,
    },
    async ({ workspaceId, parentType, parentId, body }) =>
      withToolLogging("gestoria_message_send", async () => {
        const result = await client.sendGestoriaMessage({ workspaceId, parentType, parentId, body });
        return {
          content: [mutateContent(formatRecord("Message sent", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- gestoria_messages_list -----------------------------------------------

  server.registerTool(
    "gestoria_messages_list",
    {
      title: "List Gestoria Messages",
      description:
        "List messages in a contextual gestor/cliente thread, newest first. " +
        "Use `before` (message ID or ISO timestamp) to paginate backwards through history. " +
        "Returns up to `limit` messages plus a `hasMore` flag so the agent knows when to stop. " +
        "/ Lista los mensajes de un hilo gestor/cliente, mas recientes primero. " +
        "Usa `before` (ID o fecha) para paginar hacia atras. Devuelve hasta `limit` mensajes con flag `hasMore`.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        workspaceId: z.string().min(1).describe("Client workspace ID / ID del espacio de trabajo"),
        parentType: PARENT_TYPE,
        parentId: z.string().min(1).describe("ID of the parent entity / ID de la entidad padre"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max messages to return (1-100, default 50) / Mensajes maximos"),
        before: z
          .string()
          .optional()
          .describe("Cursor: messages older than this (message ID or ISO date) / Cursor: mensajes anteriores a este"),
      },
      outputSchema: z.object({
        messages: z.array(gestoriaMessageItemOutput),
        hasMore: z.boolean(),
      }),
    },
    async ({ workspaceId, parentType, parentId, limit, before }) =>
      withToolLogging("gestoria_messages_list", async () => {
        const result = await client.listGestoriaMessages({
          workspaceId,
          parentType,
          parentId,
          limit,
          before,
        });
        const count = Array.isArray(result.messages) ? result.messages.length : 0;
        return {
          content: [
            listContent(
              `Loaded ${count} message${count === 1 ? "" : "s"} for ${parentType}:${parentId}` +
                (result.hasMore ? " (more available — paginate with `before`)" : ""),
            ),
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- gestoria_template_create ---------------------------------------------

  server.registerTool(
    "gestoria_template_create",
    {
      title: "Create Gestoria Template",
      description:
        "Create a reusable document request template that the gestor can bulk-send to many " +
        "client workspaces. Template body supports plain-text variable interpolation " +
        "(e.g. `{{quarter}}`, `{{year}}`). `dueDateOffsetDays` sets when the request is due " +
        "relative to the bulk-send date. `attachmentRequired=true` enforces clients to upload " +
        "a file before marking complete. " +
        "Example: name='IVA trimestral', title='Documentacion IVA {{quarter}}/{{year}}', " +
        "description='Adjunta extractos bancarios y facturas emitidas del {{quarter}}', " +
        "dueDateOffsetDays=14, attachmentRequired=true. " +
        "/ Crea una plantilla de solicitud de documento reutilizable que el gestor puede enviar en masa a varios espacios cliente.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(120)
          .describe("Internal template name (shown to gestor only) / Nombre interno"),
        title: z
          .string()
          .min(1)
          .max(200)
          .describe("Title rendered to the client (supports {{variables}}) / Titulo visible al cliente"),
        description: z
          .string()
          .min(1)
          .max(4000)
          .describe("Description / instructions for the client (supports {{variables}}) / Descripcion e instrucciones"),
        dueDateOffsetDays: z
          .number()
          .int()
          .min(0)
          .max(365)
          .describe("Days from send until due (0-365) / Dias desde envio hasta vencimiento"),
        attachmentRequired: z
          .boolean()
          .optional()
          .describe("Require an uploaded file before completion (default: false) / Requiere archivo"),
        variables: z
          .array(TEMPLATE_VARIABLE)
          .optional()
          .describe("Variable definitions for interpolation / Definiciones de variables"),
      },
      outputSchema: gestoriaTemplateCreateResultOutput,
    },
    async ({ name, title, description, dueDateOffsetDays, attachmentRequired, variables }) =>
      withToolLogging("gestoria_template_create", async () => {
        const result = await client.createGestoriaTemplate({
          name,
          title,
          description,
          dueDateOffsetDays,
          attachmentRequired,
          variables,
        });
        return {
          content: [mutateContent(formatRecord("Template created", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- gestoria_template_bulk_send ------------------------------------------

  server.registerTool(
    "gestoria_template_bulk_send",
    {
      title: "Bulk Send Gestoria Template",
      description:
        "Send the same document request template to up to 500 client workspaces in one call. " +
        "Each spawned request triggers the per-client notification handler (email + in-app). " +
        "Honours `allowGestoriaCommunications=false` on the client user doc (opt-out). " +
        "Uses `periodOverrides` to plug runtime values (quarter/year/month) into template variables. " +
        "Returns a per-client outcome with success count, failures, and total wall-clock duration. " +
        "Trust Area: RGPD — recipients must already have granted accountant access. " +
        "Example: templateId='tpl_iva_q', clientWorkspaceIds=['ws_a','ws_b','ws_c'], periodOverrides={quarter:3, year:2026}. " +
        "/ Envia la misma plantilla a hasta 500 espacios cliente en una sola operacion. " +
        "Respeta opt-out `allowGestoriaCommunications=false`.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        templateId: z.string().min(1).describe("Template ID (from `gestoria_template_create`) / ID de la plantilla"),
        clientWorkspaceIds: z
          .array(z.string().min(1))
          .min(1)
          .max(500)
          .describe("Target client workspace IDs (1-500) / IDs de espacios cliente destino"),
        periodOverrides: PERIOD_OVERRIDES,
      },
      outputSchema: gestoriaBulkSendResultOutput,
    },
    async ({ templateId, clientWorkspaceIds, periodOverrides }) =>
      withToolLogging("gestoria_template_bulk_send", async () => {
        const result = await client.bulkSendGestoriaTemplate({
          templateId,
          clientWorkspaceIds,
          periodOverrides,
        });
        const success = typeof result.success === "number" ? result.success : 0;
        const failed = Array.isArray(result.failed) ? result.failed.length : 0;
        return {
          content: [
            mutateContent(
              `Bulk send complete: ${success} succeeded, ${failed} failed of ${clientWorkspaceIds.length} targets.`,
            ),
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- gestoria_aging_consolidated ------------------------------------------

  server.registerTool(
    "gestoria_aging_consolidated",
    {
      title: "Consolidated AR Aging (Gestoria)",
      description:
        "Get a cross-client AR aging report for a gestor — totals bucketed by current / 30-60 / " +
        "60-90 / 90+ days overdue, a per-workspace breakdown, and the top overdue invoices. " +
        "Defaults to the authenticated gestor; pass `ownerUid` to query a specific gestor " +
        "(requires elevated scope). " +
        "Useful for dunning prioritisation and end-of-month chase lists. " +
        "/ Obtiene un informe de antiguedad de saldos cruzando todos los clientes del gestor — " +
        "totales por tramo (al dia / 30-60 / 60-90 / 90+ dias), desglose por espacio y top vencidas. " +
        "Util para priorizar reclamaciones y listas de cobro de fin de mes.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        ownerUid: z
          .string()
          .optional()
          .describe(
            "Gestor UID to query (defaults to authenticated caller; elevated scope required for other UIDs) / UID del gestor (por defecto el llamante)",
          ),
      },
      outputSchema: gestoriaAgingConsolidatedOutput,
    },
    async ({ ownerUid }) =>
      withToolLogging("gestoria_aging_consolidated", async () => {
        const result = await client.getGestoriaAgingConsolidated({ ownerUid });
        return {
          content: [getContent(formatRecord("Aging consolidated", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );
}
