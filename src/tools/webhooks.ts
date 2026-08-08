/**
 * Webhook management tools for the Frihet MCP server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import { withToolLogging, formatPaginatedResponse, formatRecord, listContent, getContent, mutateContent, READ_ONLY_ANNOTATIONS, CREATE_ANNOTATIONS, UPDATE_ANNOTATIONS, DELETE_ANNOTATIONS, unpaginatedListOutput, deleteResultOutput, webhookItemOutput, webhookTestResultOutput } from "./shared.js";

/**
 * The subscribable webhook event catalogue — SINGLE SOURCE for this repo.
 *
 * Verbatim mirror of `VALID_WEBHOOK_EVENTS` in
 * erp-main/functions/src/webhooks.ts:27-45 ("single source of truth for
 * validation"), transcribed 2026-08-08. Both the tool schemas AND the
 * user-facing description are generated from this array — the previous prose
 * list had drifted, advertising `invoice.deleted` / `expense.deleted`, which
 * exist nowhere in the backend and are emitted by nothing.
 *
 * WHY AN ENUM AND NOT FREE STRINGS: the public REST route does NOT validate the
 * events array (publicApi.ts:5147 accepts `z.array(z.string().max(100))`; the
 * catalogue is enforced only on the callable path). A subscription to a
 * non-existent event is therefore stored with 201 and then silently never fires.
 * This enum is the only place that mistake can be caught.
 *
 * DRIFT RULE: if the ERP adds an event, add it here in the same wave —
 * `src/__tests__/webhook-input-contract.test.ts` pins this array against a
 * checked-in transcription of the backend's list and fails when they diverge.
 */
export const WEBHOOK_EVENTS = [
  "invoice.created", "invoice.updated", "invoice.generated", "invoice.one_off_created",
  "invoice.paid", "invoice.overdue", "invoice.voided", "invoice.payment_status_updated",
  "invoice.payment_failure",
  "payment.succeeded", "payment.requires_action", "payment_receipt.created",
  "credit_note.created", "credit_note.generated",
  "quote.created", "quote.updated", "quote.accepted", "quote.rejected", "quote.expired",
  "expense.created", "expense.updated",
  "client.created", "client.updated", "client.vies_check",
  "product.created", "product.updated",
  "dunning.finished",
  // Stay
  "reservation.created", "reservation.updated", "reservation.cancelled",
  "reservation.checked_in", "reservation.checked_out",
  "property.created", "property.updated",
  "guest.compliance_completed",
  "cleaning_task.created", "cleaning_task.completed",
  "settlement.generated",
  "channel.sync_completed",
] as const;

export function registerWebhookTools(server: McpServer, client: IFrihetClient): void {
  // -- list_webhooks --

  server.registerTool(
    "list_webhooks",
    {
      title: "List Webhooks",
      description:
        "List all configured webhooks. Webhooks send HTTP POST notifications when events occur in Frihet. " +
        "/ Lista todos los webhooks configurados. Los webhooks envian notificaciones HTTP POST cuando ocurren eventos en Frihet.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        // HONEST COPY: the backend handler (erp-main publicApi.ts:5100-5116)
        // fetches the whole webhooks subcollection and never reads these query
        // params, so the full list always comes back. They are forwarded so the
        // tool starts paginating the day the backend slices — they are NOT a
        // capability to rely on today.
        limit: z
          .number().int().min(1).max(100).optional()
          .describe("Max results (1-100) — NOT yet applied server-side; all webhooks are returned / Resultados maximos (aun no aplicado por el backend)"),
        offset: z
          .number().int().min(0).optional()
          .describe("Offset — NOT yet applied server-side / Desplazamiento (aun no aplicado por el backend)"),
      },
      // `{ data, total }` only: this endpoint sends no limit/offset. See
      // unpaginatedListOutput in shared.ts for why it is not paginatedOutput.
      outputSchema: unpaginatedListOutput(webhookItemOutput),
    },
    async ({ limit, offset }) => withToolLogging("list_webhooks", async () => {
      const result = await client.listWebhooks({ limit, offset });
      return {
        content: [listContent(formatPaginatedResponse("webhooks", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_webhook --

  server.registerTool(
    "get_webhook",
    {
      title: "Get Webhook",
      description:
        "Get a single webhook configuration by its ID. " +
        "/ Obtiene la configuracion de un webhook por su ID.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Webhook ID / ID del webhook"),
      },
      outputSchema: webhookItemOutput,
    },
    async ({ id }) => withToolLogging("get_webhook", async () => {
      const result = await client.getWebhook(id);
      return {
        content: [getContent(formatRecord("Webhook", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- create_webhook --

  server.registerTool(
    "create_webhook",
    {
      title: "Create Webhook",
      description:
        "Register a new webhook endpoint. Requires a name, the URL to receive notifications, " +
        "and at least one event to subscribe to. " +
        `Available events: ${WEBHOOK_EVENTS.join(", ")}. ` +
        "Example: name='Billing', url='https://example.com/webhook', " +
        "events=['invoice.created','invoice.paid'], secret='my-secret' " +
        "/ Registra un nuevo endpoint de webhook. Requiere nombre, URL y al menos un evento.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        // Field set + required-ness mirror the DEPLOYED body schema
        // (erp-main publicApi.ts:5143-5151), which is `.strict()`: `name` is
        // required and any key it does not declare 400s. The tool previously
        // omitted `name` and sent `active`, so every call failed twice over.
        name: z.string().max(200).describe("Webhook name / Nombre del webhook"),
        url: z.string().url().max(2000).describe("Webhook endpoint URL / URL del endpoint del webhook"),
        events: z
          .array(z.enum(WEBHOOK_EVENTS))
          .min(1)
          .describe(
            "Events to subscribe to (e.g. ['invoice.created', 'invoice.paid']) " +
            "/ Eventos a suscribir",
          ),
        status: z
          .enum(["active", "inactive"])
          .optional()
          .describe("Webhook status (default: 'active') / Estado del webhook"),
        secret: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Signing secret for payload verification / Secreto para verificar las notificaciones",
          ),
      },
      outputSchema: webhookItemOutput,
    },
    async (input) => withToolLogging("create_webhook", async () => {
      const result = await client.createWebhook(input);
      return {
        content: [mutateContent(formatRecord("Webhook created", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- update_webhook --

  server.registerTool(
    "update_webhook",
    {
      title: "Update Webhook",
      description:
        "Update an existing webhook configuration using PATCH semantics. Only provided fields change. " +
        "Example: id='abc123', status='inactive' to disable a webhook. " +
        "/ Actualiza la configuracion de un webhook. Solo se modifican los campos proporcionados.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        // Mirrors the DEPLOYED `.strict()` update schema (erp-main
        // publicApi.ts:5199-5206), whose key is `status` — with 'paused'
        // available on update but not on create.
        id: z.string().describe("Webhook ID / ID del webhook"),
        name: z.string().max(200).optional().describe("Webhook name / Nombre"),
        url: z.string().url().max(2000).optional().describe("Endpoint URL / URL"),
        events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional().describe("Events / Eventos"),
        status: z
          .enum(["active", "inactive", "paused"])
          .optional()
          .describe("Webhook status / Estado del webhook"),
        secret: z.string().max(500).optional().describe("Signing secret / Secreto"),
      },
      outputSchema: webhookItemOutput,
    },
    async ({ id, ...data }) => withToolLogging("update_webhook", async () => {
      const result = await client.updateWebhook(id, data);
      return {
        content: [mutateContent(formatRecord("Webhook updated", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- delete_webhook --

  server.registerTool(
    "delete_webhook",
    {
      title: "Delete Webhook",
      description:
        "Permanently delete a webhook by its ID. Notifications will stop immediately. " +
        "/ Elimina permanentemente un webhook por su ID. Las notificaciones se detendran inmediatamente.",
      annotations: DELETE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Webhook ID / ID del webhook"),
      },
      outputSchema: deleteResultOutput,
    },
    async ({ id }) => withToolLogging("delete_webhook", async () => {
      await client.deleteWebhook(id);
      return {
        content: [mutateContent(`Webhook ${id} deleted successfully. / Webhook ${id} eliminado correctamente.`)],
        structuredContent: { success: true, id } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- test_webhook --
  // D4-B megasprint: fire a synthetic event to verify endpoint reachability + signature validation.

  server.registerTool(
    "test_webhook",
    {
      title: "Test Webhook",
      description:
        "Fire a synthetic test event to the webhook endpoint and return the delivery result. " +
        "Useful to verify endpoint reachability, signature validation, and TLS configuration. " +
        "Optionally specify the eventType to simulate (default: 'webhook.test'). " +
        "Example: id='wh_abc', eventType='invoice.paid' " +
        "/ Envia un evento de prueba sintetico al endpoint del webhook. " +
        "Util para verificar accesibilidad, validacion de firma y configuracion TLS.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        id: z.string().describe("Webhook ID / ID del webhook"),
        eventType: z
          .string()
          .optional()
          .describe("Event type to simulate (default: 'webhook.test') / Tipo de evento a simular"),
      },
      outputSchema: webhookTestResultOutput,
    },
    async ({ id, eventType }) => withToolLogging("test_webhook", async () => {
      const result = await client.testWebhook(id, { eventType });
      return {
        content: [mutateContent(formatRecord("Webhook test", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );
}
