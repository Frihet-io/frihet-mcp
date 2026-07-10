/**
 * Client tools for the Frihet MCP server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import { withToolLogging, formatPaginatedResponse, formatRecord, listContent, getContent, mutateContent, enrichResponse, READ_ONLY_ANNOTATIONS, CREATE_ANNOTATIONS, UPDATE_ANNOTATIONS, DELETE_ANNOTATIONS, paginatedOutput, deleteResultOutput, clientItemOutput } from "./shared.js";

const addressSchema = z
  .object({
    street: z.string().optional().describe("Street address / Direccion"),
    city: z.string().optional().describe("City / Ciudad"),
    state: z.string().optional().describe("State or province / Provincia o comunidad autonoma"),
    postalCode: z.string().optional().describe("Postal code / Codigo postal"),
    country: z.string().optional().describe("Country (ISO code) / Pais"),
  })
  .optional()
  .describe("Client address / Direccion del cliente");

export function registerClientTools(server: McpServer, client: IFrihetClient): void {
  // -- list_clients --

  server.registerTool(
    "list_clients",
    {
      title: "List Clients",
      description:
        "List all clients/customers with optional pagination. " +
        "Returns contact info, tax IDs, and addresses. " +
        "/ Lista todos los clientes con paginacion opcional. " +
        "Devuelve informacion de contacto, NIF/CIF y direcciones.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        q: z
          .string()
          .optional()
          .describe("Search by name or email / Buscar por nombre o email"),
        stage: z
          .enum(["lead", "contacted", "proposal", "active", "inactive", "lost"])
          .optional()
          .describe("Filter by CRM stage / Filtrar por etapa del CRM"),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated field names to return (e.g. 'id,name,email') / Campos a devolver"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100) / Resultados maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
        after: z
          .string()
          .optional()
          .describe("Cursor for cursor-based pagination (document ID) / Cursor para paginacion basada en cursor"),
      },
      outputSchema: paginatedOutput(clientItemOutput, { projectable: true }),
    },
    async ({ limit, offset, q, stage, fields, after }) => withToolLogging("list_clients", async () => {
      const result = await client.listClients({ limit, offset, after, fields, q, stage });
      return {
        content: [listContent(formatPaginatedResponse("clients", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_client --

  server.registerTool(
    "get_client",
    {
      title: "Get Client",
      description:
        "Get a single client by their ID. Returns full contact details. " +
        "/ Obtiene un cliente por su ID. Devuelve todos los datos de contacto.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Client ID / ID del cliente"),
      },
      outputSchema: clientItemOutput,
    },
    async ({ id }) => withToolLogging("get_client", async () => {
      const result = await client.getClient(id);
      return {
        content: [getContent(formatRecord("Client", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- create_client --

  server.registerTool(
    "create_client",
    {
      title: "Create Client",
      description:
        "Create a new client/customer. Requires at minimum a name. " +
        "Clients are used when creating invoices and quotes. " +
        "Example: name='Acme Corp', email='billing@acme.com', taxId='B12345678', address={street:'Main St 1', city:'Madrid', country:'ES'} " +
        "/ Crea un nuevo cliente. Requiere como minimo un nombre. " +
        "Los clientes se usan al crear facturas y presupuestos.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        name: z.string().describe("Client/company name / Nombre del cliente o empresa"),
        email: z.string().optional().describe("Email address / Correo electronico"),
        phone: z.string().optional().describe("Phone number / Telefono"),
        taxId: z.string().optional().describe("Tax ID (NIF/CIF/VAT) / NIF o CIF"),
        address: addressSchema,
      },
      outputSchema: clientItemOutput,
    },
    async (input) => withToolLogging("create_client", async () => {
      const result = await client.createClient(input);
      const hints = enrichResponse("clients", "create", result);
      return {
        content: [mutateContent(formatRecord("Client created", result))],
        structuredContent: { ...result, ...hints } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- update_client --

  server.registerTool(
    "update_client",
    {
      title: "Update Client",
      description:
        "Update an existing client using PATCH semantics. Only the provided fields will be changed. " +
        "Example: id='abc123', email='new@acme.com', phone='+34600123456' " +
        "/ Actualiza un cliente existente. Solo se modifican los campos proporcionados.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Client ID / ID del cliente"),
        name: z.string().optional().describe("Name / Nombre"),
        email: z.string().optional().describe("Email / Correo"),
        phone: z.string().optional().describe("Phone / Telefono"),
        taxId: z.string().optional().describe("Tax ID / NIF/CIF"),
        address: addressSchema,
      },
      outputSchema: clientItemOutput,
    },
    async ({ id, ...data }) => withToolLogging("update_client", async () => {
      const result = await client.updateClient(id, data);
      return {
        content: [mutateContent(formatRecord("Client updated", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- delete_client --

  server.registerTool(
    "delete_client",
    {
      title: "Delete Client",
      description:
        "Permanently delete a client by their ID. This action cannot be undone. " +
        "Warning: this may affect existing invoices and quotes referencing this client. " +
        "/ Elimina permanentemente un cliente por su ID. Esta accion no se puede deshacer. " +
        "Advertencia: puede afectar a facturas y presupuestos existentes.",
      annotations: DELETE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Client ID / ID del cliente"),
      },
      outputSchema: deleteResultOutput,
    },
    async ({ id }) => withToolLogging("delete_client", async () => {
      await client.deleteClient(id);
      return {
        content: [mutateContent(`Client ${id} deleted successfully. / Cliente ${id} eliminado correctamente.`)],
        structuredContent: { success: true, id } as unknown as Record<string, unknown>,
      };
    }),
  );
}
