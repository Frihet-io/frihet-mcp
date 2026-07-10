/**
 * Vendor tools for the Frihet MCP server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import { withToolLogging, formatPaginatedResponse, formatRecord, listContent, getContent, mutateContent, enrichResponse, READ_ONLY_ANNOTATIONS, CREATE_ANNOTATIONS, UPDATE_ANNOTATIONS, DELETE_ANNOTATIONS, paginatedOutput, deleteResultOutput, vendorItemOutput } from "./shared.js";

const addressSchema = z
  .object({
    street: z.string().optional().describe("Street address / Direccion"),
    city: z.string().optional().describe("City / Ciudad"),
    state: z.string().optional().describe("State or province / Provincia o comunidad autonoma"),
    postalCode: z.string().optional().describe("Postal code / Codigo postal"),
    country: z.string().optional().describe("Country (ISO code) / Pais"),
  })
  .optional()
  .describe("Vendor address / Direccion del proveedor");

export function registerVendorTools(server: McpServer, client: IFrihetClient): void {
  // -- list_vendors --

  server.registerTool(
    "list_vendors",
    {
      title: "List Vendors",
      description:
        "List all vendors/suppliers with optional pagination and search. " +
        "Returns contact info, tax IDs, and addresses. " +
        "/ Lista todos los proveedores con paginacion y busqueda opcional. " +
        "Devuelve informacion de contacto, NIF/CIF y direcciones.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        q: z.string().optional().describe("Search query (name, email, etc.) / Busqueda por texto"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100) / Resultados maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
        after: z.string().optional().describe("Cursor for pagination / Cursor de paginacion"),
        fields: z.string().optional().describe("Comma-separated fields to return / Campos a devolver separados por coma"),
      },
      outputSchema: paginatedOutput(vendorItemOutput, { projectable: true }),
    },
    async ({ q, limit, offset, after, fields }) => withToolLogging("list_vendors", async () => {
      const result = await client.listVendors({ q, limit, offset, after, fields });
      return {
        content: [listContent(formatPaginatedResponse("vendors", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_vendor --

  server.registerTool(
    "get_vendor",
    {
      title: "Get Vendor",
      description:
        "Get a single vendor/supplier by their ID. Returns full contact details. " +
        "/ Obtiene un proveedor por su ID. Devuelve todos los datos de contacto.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Vendor ID / ID del proveedor"),
      },
      outputSchema: vendorItemOutput,
    },
    async ({ id }) => withToolLogging("get_vendor", async () => {
      const result = await client.getVendor(id);
      return {
        content: [getContent(formatRecord("Vendor", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- create_vendor --

  server.registerTool(
    "create_vendor",
    {
      title: "Create Vendor",
      description:
        "Create a new vendor/supplier. Requires at minimum a name. " +
        "Vendors are used when tracking expenses and purchase orders. " +
        "Example: name='Office Supplies Ltd', email='billing@office.com', taxId='B87654321', address={street:'Gran Via 1', city:'Madrid', country:'ES'} " +
        "/ Crea un nuevo proveedor. Requiere como minimo un nombre. " +
        "Los proveedores se usan al registrar gastos y pedidos de compra.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        name: z.string().describe("Vendor/company name / Nombre del proveedor o empresa"),
        email: z.string().optional().describe("Email address / Correo electronico"),
        phone: z.string().optional().describe("Phone number / Telefono"),
        taxId: z.string().optional().describe("Tax ID (NIF/CIF/VAT) / NIF o CIF"),
        address: addressSchema,
      },
      outputSchema: vendorItemOutput,
    },
    async (input) => withToolLogging("create_vendor", async () => {
      const result = await client.createVendor(input);
      const hints = enrichResponse("vendors", "create", result);
      return {
        content: [mutateContent(formatRecord("Vendor created", result))],
        structuredContent: { ...result, ...hints } as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- update_vendor --

  server.registerTool(
    "update_vendor",
    {
      title: "Update Vendor",
      description:
        "Update an existing vendor using PATCH semantics. Only the provided fields will be changed. " +
        "Example: id='abc123', email='new@supplier.com', phone='+34600123456' " +
        "/ Actualiza un proveedor existente. Solo se modifican los campos proporcionados.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Vendor ID / ID del proveedor"),
        name: z.string().optional().describe("Name / Nombre"),
        email: z.string().optional().describe("Email / Correo"),
        phone: z.string().optional().describe("Phone / Telefono"),
        taxId: z.string().optional().describe("Tax ID / NIF/CIF"),
        address: addressSchema,
      },
      outputSchema: vendorItemOutput,
    },
    async ({ id, ...data }) => withToolLogging("update_vendor", async () => {
      const result = await client.updateVendor(id, data);
      return {
        content: [mutateContent(formatRecord("Vendor updated", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- delete_vendor --

  server.registerTool(
    "delete_vendor",
    {
      title: "Delete Vendor",
      description:
        "Permanently delete a vendor by their ID. This action cannot be undone. " +
        "Warning: this may affect existing expenses referencing this vendor. " +
        "/ Elimina permanentemente un proveedor por su ID. Esta accion no se puede deshacer. " +
        "Advertencia: puede afectar a gastos existentes que referencien este proveedor.",
      annotations: DELETE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Vendor ID / ID del proveedor"),
      },
      outputSchema: deleteResultOutput,
    },
    async ({ id }) => withToolLogging("delete_vendor", async () => {
      await client.deleteVendor(id);
      return {
        content: [mutateContent(`Vendor ${id} deleted successfully. / Proveedor ${id} eliminado correctamente.`)],
        structuredContent: { success: true, id } as unknown as Record<string, unknown>,
      };
    }),
  );
}
