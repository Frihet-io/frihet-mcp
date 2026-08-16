/**
 * Webhook management tools for the Frihet MCP server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import { withToolLogging, formatRecord, formatUnpaginatedListResponse, listContent, getContent, mutateContent, READ_ONLY_ANNOTATIONS, CREATE_ANNOTATIONS, UPDATE_ANNOTATIONS, DELETE_ANNOTATIONS, deleteResultOutput, webhookCreateOutput, webhookItemOutput, webhookListOutput, webhookTestResultOutput } from "./shared.js";

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
      inputSchema: z.object({}).strict(),
      outputSchema: webhookListOutput,
    },
    async () => withToolLogging("list_webhooks", async () => {
      const result = await client.listWebhooks();
      return {
        content: [listContent(formatUnpaginatedListResponse("webhooks", result))],
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
      inputSchema: z.object({
        id: z.string().describe("Webhook ID / ID del webhook"),
      }).strict(),
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
        "Register a named webhook endpoint. You must specify the name, URL, and events to receive notifications " +
        "and which events to subscribe to. " +
        "Available events: invoice.created, invoice.updated, invoice.paid, " +
        "expense.created, expense.updated, client.created, client.updated, " +
        "quote.created, quote.updated, quote.accepted. " +
        "Example: name='Invoice events', url='https://example.com/webhook', events=['invoice.created','invoice.paid'], secret='my-secret' " +
        "/ Registra un nuevo endpoint de webhook. Especifica la URL y los eventos a suscribir.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: z.object({
        name: z.string().max(200).describe("Webhook name / Nombre del webhook"),
        url: z.string().url().max(2000).describe("Webhook endpoint URL / URL del endpoint del webhook"),
        events: z
          .array(z.string().max(100))
          .min(1)
          .describe(
            "Events to subscribe to (e.g. ['invoice.created', 'invoice.paid']) " +
            "/ Eventos a suscribir",
          ),
        status: z
          .enum(["active", "inactive"])
          .optional()
          .describe("Webhook status (default: active) / Estado del webhook"),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arbitrary webhook metadata / Metadatos del webhook"),
        secret: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Signing secret for payload verification / Secreto para verificar las notificaciones",
          ),
      }).strict(),
      outputSchema: webhookCreateOutput,
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
        "Example: id='abc123', status='paused' to pause a webhook. " +
        "/ Actualiza la configuracion de un webhook. Solo se modifican los campos proporcionados.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: z.object({
        id: z.string().describe("Webhook ID / ID del webhook"),
        name: z.string().max(200).optional().describe("Webhook name / Nombre del webhook"),
        url: z.string().url().max(2000).optional().describe("Endpoint URL / URL"),
        events: z.array(z.string().max(100)).min(1).optional().describe("Events / Eventos"),
        status: z.enum(["active", "inactive", "paused"]).optional().describe("Status / Estado"),
        metadata: z.record(z.string(), z.unknown()).optional().describe("Metadata / Metadatos"),
        secret: z.string().max(500).optional().describe("Signing secret / Secreto"),
      }).strict(),
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
