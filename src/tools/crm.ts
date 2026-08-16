/**
 * CRM subcollection tools for the Frihet MCP server.
 *
 * Contacts, activities, and notes — all scoped under a client.
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
  enrichResponse,
  READ_ONLY_ANNOTATIONS,
  CREATE_ANNOTATIONS,
  DELETE_ANNOTATIONS,
  paginatedOutput,
  deleteResultOutput,
  contactItemOutput,
  activityItemOutput,
  noteItemOutput,
} from "./shared.js";

export function registerCrmTools(server: McpServer, client: IFrihetClient): void {
  // ================================================================
  //  Contacts
  // ================================================================

  // -- list_client_contacts --

  server.registerTool(
    "list_client_contacts",
    {
      title: "List Client Contacts",
      description:
        "List all contacts for a client with optional pagination. " +
        "Returns name, email, phone, role, and primary flag. " +
        "/ Lista todos los contactos de un cliente con paginacion opcional.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        clientId: z.string().describe("Client ID / ID del cliente"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100) / Resultados maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
      },
      outputSchema: paginatedOutput(contactItemOutput),
    },
    async ({ clientId, limit, offset }) => withToolLogging("list_client_contacts", async () => {
      const result = await client.listClientContacts(clientId, { limit, offset });
      return {
        content: [listContent(formatPaginatedResponse("contacts", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- create_client_contact --

  server.registerTool(
    "create_client_contact",
    {
      title: "Create Client Contact",
      description:
        "Add a new contact person to a client. Requires a name at minimum. " +
        "Example: clientId='abc123', name='Ana Garcia', email='ana@acme.com', role='CTO', isPrimary=true " +
        "/ Anade un nuevo contacto a un cliente. Requiere al menos un nombre.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        clientId: z.string().describe("Client ID / ID del cliente"),
        name: z.string().describe("Contact name / Nombre del contacto"),
        email: z.string().optional().describe("Email address / Correo electronico"),
        phone: z.string().optional().describe("Phone number / Telefono"),
        role: z.string().optional().describe("Role or title (e.g. CEO, CTO, Billing) / Cargo o rol"),
        isPrimary: z.boolean().optional().describe("Whether this is the primary contact / Si es el contacto principal"),
      },
      outputSchema: contactItemOutput,
    },
    async ({ clientId, ...data }) => withToolLogging("create_client_contact", async () => {
      const result = await client.createClientContact(clientId, data);
      const hints = enrichResponse("contacts", "create", result);
      return {
        content: [mutateContent(formatRecord("Contact created", result))],
        structuredContent: { ...result, ...hints } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- delete_client_contact --

  server.registerTool(
    "delete_client_contact",
    {
      title: "Delete Client Contact",
      description:
        "Permanently delete a contact from a client. This action cannot be undone. " +
        "/ Elimina permanentemente un contacto de un cliente. Esta accion no se puede deshacer.",
      annotations: DELETE_ANNOTATIONS,
      inputSchema: {
        clientId: z.string().describe("Client ID / ID del cliente"),
        contactId: z.string().describe("Contact ID / ID del contacto"),
      },
      outputSchema: deleteResultOutput,
    },
    async ({ clientId, contactId }) => withToolLogging("delete_client_contact", async () => {
      await client.deleteClientContact(clientId, contactId);
      return {
        content: [mutateContent(`Contact ${contactId} deleted from client ${clientId}. / Contacto ${contactId} eliminado del cliente ${clientId}.`)],
        structuredContent: { success: true, id: contactId } as unknown as Record<string, unknown>,
      };
    }),
  );

  // ================================================================
  //  Activities
  // ================================================================

  // -- list_client_activities --

  server.registerTool(
    "list_client_activities",
    {
      title: "List Client Activities",
      description:
        "List all CRM activities for a client with optional pagination. " +
        "Returns calls, emails, meetings, and tasks logged against the client. " +
        "/ Lista todas las actividades CRM de un cliente con paginacion opcional.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        clientId: z.string().describe("Client ID / ID del cliente"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100) / Resultados maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
      },
      outputSchema: paginatedOutput(activityItemOutput),
    },
    async ({ clientId, limit, offset }) => withToolLogging("list_client_activities", async () => {
      const result = await client.listClientActivities(clientId, { limit, offset });
      return {
        content: [listContent(formatPaginatedResponse("activities", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- log_client_activity --

  server.registerTool(
    "log_client_activity",
    {
      title: "Log Client Activity",
      description:
        "Log a CRM activity against a client. Use to track calls, emails, meetings, or tasks. " +
        "Example: clientId='abc123', type='call', title='Discussed Q2 proposal', description='Client interested in upgrade' " +
        "/ Registra una actividad CRM para un cliente. Usa para rastrear llamadas, emails, reuniones o tareas.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: z.object({
        clientId: z.string().describe("Client ID / ID del cliente"),
        type: z
          .enum(["call", "email", "meeting", "task"])
          .describe("Activity type / Tipo de actividad"),
        title: z.string().max(500).describe("Activity title / Titulo de la actividad"),
        description: z.string().max(5000).optional().describe("Detailed description / Descripcion detallada"),
      }).strict(),
      outputSchema: activityItemOutput,
    },
    async ({ clientId, ...data }) => withToolLogging("log_client_activity", async () => {
      const result = await client.logClientActivity(clientId, data);
      return {
        content: [mutateContent(formatRecord("Activity logged", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // ================================================================
  //  Notes
  // ================================================================

  // -- list_client_notes --

  server.registerTool(
    "list_client_notes",
    {
      title: "List Client Notes",
      description:
        "List all notes for a client with optional pagination. " +
        "/ Lista todas las notas de un cliente con paginacion opcional.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        clientId: z.string().describe("Client ID / ID del cliente"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100) / Resultados maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
      },
      outputSchema: paginatedOutput(noteItemOutput),
    },
    async ({ clientId, limit, offset }) => withToolLogging("list_client_notes", async () => {
      const result = await client.listClientNotes(clientId, { limit, offset });
      return {
        content: [listContent(formatPaginatedResponse("notes", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- create_client_note --

  server.registerTool(
    "create_client_note",
    {
      title: "Create Client Note",
      description:
        "Add a note to a client. Notes are free-form text entries useful for keeping context. " +
        "Example: clientId='abc123', content='Prefers invoices in English. Payment NET 30.' " +
        "/ Anade una nota a un cliente. Las notas son texto libre para mantener contexto.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        clientId: z.string().describe("Client ID / ID del cliente"),
        content: z.string().describe("Note content / Contenido de la nota"),
      },
      outputSchema: noteItemOutput,
    },
    async ({ clientId, content }) => withToolLogging("create_client_note", async () => {
      const result = await client.createClientNote(clientId, { content });
      return {
        content: [mutateContent(formatRecord("Note created", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- delete_client_note --

  server.registerTool(
    "delete_client_note",
    {
      title: "Delete Client Note",
      description:
        "Permanently delete a note from a client. This action cannot be undone. " +
        "/ Elimina permanentemente una nota de un cliente. Esta accion no se puede deshacer.",
      annotations: DELETE_ANNOTATIONS,
      inputSchema: {
        clientId: z.string().describe("Client ID / ID del cliente"),
        noteId: z.string().describe("Note ID / ID de la nota"),
      },
      outputSchema: deleteResultOutput,
    },
    async ({ clientId, noteId }) => withToolLogging("delete_client_note", async () => {
      await client.deleteClientNote(clientId, noteId);
      return {
        content: [mutateContent(`Note ${noteId} deleted from client ${clientId}. / Nota ${noteId} eliminada del cliente ${clientId}.`)],
        structuredContent: { success: true, id: noteId } as unknown as Record<string, unknown>,
      };
    }),
  );
}
