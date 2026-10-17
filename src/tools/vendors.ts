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

/**
 * Splits a concatenated / camelCase / snake_case / kebab-case search query into
 * space-separated tokens (e.g. "CanariasBlue" -> "Canarias Blue",
 * "SLCanarias" -> "SL Canarias", "Canarias_Blue" -> "Canarias Blue").
 */
function splitCompoundQuery(q: string): string {
  return q
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const OPTIONAL_VENDOR_STRING_FIELDS = [
  "email",
  "phone",
  "taxId",
  "createdAt",
  "updatedAt",
] as const;

/**
 * Normalizes a vendor record returned by the Frihet API so it always satisfies
 * `vendorItemOutput` without losing ERP-canonical data:
 *  - Strips `null` on optional string fields (`email`, `phone`, `taxId`,
 *    `createdAt`, `updatedAt`) so `z.string().optional()` never rejects legacy docs.
 *  - Backfills `taxId` from legacy `nif` / `cif` / `vatNumber` / `tax_id` when
 *    `taxId` is absent or null, preserving all original fields.
 *  - Converts legacy string `address` into `{ street }`.
 *  - Omits `null` or empty `address`.
 *  - Maps ERP canonical address keys (`province` -> `state`, `zip` -> `postalCode`,
 *    `countryCode` -> `country`).
 */
function normalizeVendorRecord(vendorRecord: Record<string, unknown>): Record<string, unknown> {
  if (!vendorRecord || typeof vendorRecord !== "object" || Array.isArray(vendorRecord)) {
    return vendorRecord;
  }

  const out: Record<string, unknown> = { ...vendorRecord };

  for (const field of OPTIONAL_VENDOR_STRING_FIELDS) {
    if (out[field] === null) {
      delete out[field];
    }
  }

  if (typeof out.taxId !== "string" || !out.taxId.trim()) {
    for (const alias of ["nif", "cif", "vatNumber", "tax_id"] as const) {
      const candidate = out[alias];
      if (typeof candidate === "string" && candidate.trim()) {
        out.taxId = candidate.trim();
        break;
      }
    }
  }

  const rawAddress = out.address;

  if (rawAddress === undefined) {
    return out;
  }

  if (rawAddress === null) {
    delete out.address;
    return out;
  }

  if (typeof rawAddress === "string") {
    const trimmed = rawAddress.trim();
    if (!trimmed) {
      delete out.address;
      return out;
    }
    out.address = { street: trimmed };
    return out;
  }

  if (typeof rawAddress === "object" && !Array.isArray(rawAddress)) {
    const addrObj = rawAddress as Record<string, unknown>;
    const normalizedAddress: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(addrObj)) {
      if (v !== null && v !== undefined) {
        normalizedAddress[k] = v;
      }
    }

    const street = typeof addrObj.street === "string" ? addrObj.street.trim() : undefined;
    const city = typeof addrObj.city === "string" ? addrObj.city.trim() : undefined;
    const state =
      typeof addrObj.state === "string" && addrObj.state.trim()
        ? addrObj.state.trim()
        : typeof addrObj.province === "string" && addrObj.province.trim()
          ? addrObj.province.trim()
          : undefined;
    const postalCode =
      typeof addrObj.postalCode === "string" && addrObj.postalCode.trim()
        ? addrObj.postalCode.trim()
        : typeof addrObj.zip === "string" && addrObj.zip.trim()
          ? addrObj.zip.trim()
          : undefined;
    const country =
      typeof addrObj.country === "string" && addrObj.country.trim()
        ? addrObj.country.trim()
        : typeof addrObj.countryCode === "string" && addrObj.countryCode.trim()
          ? addrObj.countryCode.trim()
          : undefined;

    if (street !== undefined) normalizedAddress.street = street;
    else delete normalizedAddress.street;

    if (city !== undefined) normalizedAddress.city = city;
    else delete normalizedAddress.city;

    if (state !== undefined) normalizedAddress.state = state;
    else delete normalizedAddress.state;

    if (postalCode !== undefined) normalizedAddress.postalCode = postalCode;
    else delete normalizedAddress.postalCode;

    if (country !== undefined) normalizedAddress.country = country;
    else delete normalizedAddress.country;

    if (Object.keys(normalizedAddress).length === 0) {
      delete out.address;
      return out;
    }

    out.address = normalizedAddress;
    return out;
  }

  return out;
}

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
      let result = await client.listVendors({ q, limit, offset, after, fields });

      let usedFallback = false;
      const trimmedQ = q?.trim();
      const splitQ = trimmedQ ? splitCompoundQuery(trimmedQ) : undefined;
      const isSubsequentPage = (offset !== undefined && offset > 0) || Boolean(after);
      const initialTruncated = (result as unknown as Record<string, unknown>)?.truncated === true;
      const canFallback = splitQ !== undefined && splitQ !== trimmedQ && !after && !initialTruncated;
      const hasZeroTotalMatches =
        Array.isArray(result?.data) &&
        result.data.length === 0 &&
        (isSubsequentPage ? result.total === 0 : result.total === 0 || result.total === undefined);

      if (canFallback && hasZeroTotalMatches) {
        try {
          const fallbackResult = await client.listVendors({ q: splitQ, limit, offset, after, fields });
          if (fallbackResult?.data && (fallbackResult.data.length > 0 || (fallbackResult.total !== undefined && fallbackResult.total > 0))) {
            result = fallbackResult;
            usedFallback = true;
          }
        } catch {
          // Preserve original response if fallback fails
        }
      }

      const rawEnvelope = (result ?? {}) as unknown as Record<string, unknown>;
      const isTruncated = rawEnvelope.truncated === true;
      const normalizedData = Array.isArray(result?.data)
        ? result.data.map((v) => (v && typeof v === "object" ? normalizeVendorRecord(v as Record<string, unknown>) : v))
        : [];
      const cleanEnvelope: typeof result = {
        data: normalizedData,
        total: typeof result?.total === "number" ? result.total : normalizedData.length,
        limit: typeof result?.limit === "number" ? result.limit : (limit ?? 20),
        offset: typeof result?.offset === "number" ? result.offset : (offset ?? 0),
        ...(typeof result?.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
      };

      const notes: string[] = [];
      if (usedFallback) {
        notes.push(` (criterio aplicado: "${splitQ}")`);
      }
      if (isTruncated) {
        notes.push(
          "\nNote: Search scan reached the 500-document backend cap (truncated=true); results and total reflect only the first 500 records scanned. / " +
          "Nota: La busqueda alcanzo el limite de escaneo de 500 documentos (truncated=true); total y resultados reflejan solo los primeros 500 registros.",
        );
      }
      if (trimmedQ && after) {
        notes.push(
          "\nNote: Backend text search (q) slices by offset/limit and ignores the 'after' cursor parameter. Use offset for search pagination. / " +
          "Nota: La busqueda textual (q) pagina mediante offset/limit e ignora el cursor 'after'.",
        );
      }

      return {
        content: [listContent(formatPaginatedResponse("vendors", cleanEnvelope) + notes.join(""))],
        structuredContent: cleanEnvelope as unknown as Record<string, unknown>,
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
      const result = normalizeVendorRecord(await client.getVendor(id));
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
        name: z.string().trim().min(1).max(200).describe("Vendor/company name / Nombre del proveedor o empresa"),
        email: z.string().trim().email().max(255).optional().describe("Email address / Correo electronico"),
        phone: z.string().trim().min(1).max(50).optional().describe("Phone number / Telefono"),
        taxId: z.string().optional().describe("Tax ID (NIF/CIF/VAT) / NIF o CIF"),
        address: addressSchema,
      },
      outputSchema: vendorItemOutput,
    },
    async (input) => withToolLogging("create_vendor", async () => {
      const result = normalizeVendorRecord(await client.createVendor(input));
      const hints = enrichResponse("vendors", "create", result);
      return {
        content: [mutateContent(formatRecord("Vendor created", result) + hints)],
        structuredContent: { ...result } as unknown as Record<string, unknown>,
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
        id: z.string().trim().min(1).max(128).describe("Vendor ID / ID del proveedor"),
        name: z.string().trim().min(1).max(200).optional().describe("Name / Nombre"),
        email: z.string().trim().email().max(255).optional().describe("Email / Correo"),
        phone: z.string().trim().min(1).max(50).optional().describe("Phone / Telefono"),
        taxId: z.string().optional().describe("Tax ID / NIF/CIF"),
        address: addressSchema,
      },
      outputSchema: vendorItemOutput,
    },
    async ({ id, ...data }) => withToolLogging("update_vendor", async () => {
      const result = normalizeVendorRecord(await client.updateVendor(id, data));
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
