/**
 * Product tools for the Frihet MCP server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import { withToolLogging, formatPaginatedResponse, formatRecord, listContent, getContent, mutateContent, READ_ONLY_ANNOTATIONS, CREATE_ANNOTATIONS, UPDATE_ANNOTATIONS, DELETE_ANNOTATIONS, paginatedOutput, deleteResultOutput, productItemOutput } from "./shared.js";

export function registerProductTools(server: McpServer, client: IFrihetClient): void {
  // -- list_products --

  server.registerTool(
    "list_products",
    {
      title: "List Products",
      description:
        "List all products/services with optional pagination. " +
        "Products are reusable items that can be added to invoices and quotes. " +
        "/ Lista todos los productos/servicios con paginacion opcional. " +
        "Los productos son conceptos reutilizables para facturas y presupuestos.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        q: z
          .string()
          .optional()
          .describe("Search by product name / Buscar por nombre de producto"),
        isActive: z
          .boolean()
          .optional()
          .describe("Filter by active status / Filtrar por estado activo"),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated field names to return (e.g. 'id,name,unitPrice') / Campos a devolver"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100) / Resultados maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
        after: z
          .string()
          .optional()
          .describe("Cursor for cursor-based pagination (document ID) / Cursor para paginacion basada en cursor"),
      },
      outputSchema: paginatedOutput(productItemOutput, { projectable: true }),
    },
    async ({ limit, offset, q, isActive, fields, after }) => withToolLogging("list_products", async () => {
      const result = await client.listProducts({ limit, offset, after, fields, q, isActive });
      return {
        content: [listContent(formatPaginatedResponse("products", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- get_product --

  server.registerTool(
    "get_product",
    {
      title: "Get Product",
      description:
        "Get a single product/service by its ID. " +
        "/ Obtiene un producto/servicio por su ID.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Product ID / ID del producto"),
      },
      outputSchema: productItemOutput,
    },
    async ({ id }) => withToolLogging("get_product", async () => {
      const result = await client.getProduct(id);
      return {
        content: [getContent(formatRecord("Product", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- create_product --

  server.registerTool(
    "create_product",
    {
      title: "Create Product",
      description:
        "Create a new product or service in the catalog. Requires a name and unit price. " +
        "Products can be referenced when creating invoices and quotes for faster data entry. " +
        "Example: name='Web Design', unitPrice=1500, taxRate=21, description='Full website redesign' " +
        "/ Crea un nuevo producto o servicio en el catalogo. Requiere nombre y precio unitario. " +
        "Los productos se pueden usar al crear facturas y presupuestos para entrada rapida de datos.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        name: z.string().describe("Product/service name / Nombre del producto o servicio"),
        unitPrice: z.number().describe("Unit price in EUR / Precio unitario en EUR"),
        description: z.string().optional().describe("Product description / Descripcion"),
        taxRate: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Default tax rate % (e.g. 21 for 21% IVA) / IVA por defecto"),
      },
      outputSchema: productItemOutput,
    },
    async (input) => withToolLogging("create_product", async () => {
      const result = await client.createProduct(input);
      return {
        content: [mutateContent(formatRecord("Product created", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- update_product --

  server.registerTool(
    "update_product",
    {
      title: "Update Product",
      description:
        "Update an existing product using PATCH semantics. Only the provided fields will be changed. " +
        "Example: id='abc123', unitPrice=2000, taxRate=21 " +
        "/ Actualiza un producto existente. Solo se modifican los campos proporcionados.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Product ID / ID del producto"),
        name: z.string().optional().describe("Name / Nombre"),
        unitPrice: z.number().optional().describe("Unit price / Precio unitario"),
        description: z.string().optional().describe("Description / Descripcion"),
        taxRate: z.number().min(0).max(100).optional().describe("Tax rate % / IVA %"),
      },
      outputSchema: productItemOutput,
    },
    async ({ id, ...data }) => withToolLogging("update_product", async () => {
      const result = await client.updateProduct(id, data);
      return {
        content: [mutateContent(formatRecord("Product updated", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- delete_product --

  server.registerTool(
    "delete_product",
    {
      title: "Delete Product",
      description:
        "Permanently delete a product by its ID. This action cannot be undone. " +
        "/ Elimina permanentemente un producto por su ID. Esta accion no se puede deshacer.",
      annotations: DELETE_ANNOTATIONS,
      inputSchema: {
        id: z.string().describe("Product ID / ID del producto"),
      },
      outputSchema: deleteResultOutput,
    },
    async ({ id }) => withToolLogging("delete_product", async () => {
      await client.deleteProduct(id);
      return {
        content: [mutateContent(`Product ${id} deleted successfully. / Producto ${id} eliminado correctamente.`)],
        structuredContent: { success: true, id } as unknown as Record<string, unknown>,
      };
    }),
  );
}
