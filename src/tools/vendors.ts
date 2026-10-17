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
  const rootStreet = typeof out.street === "string" && out.street.trim() ? out.street.trim() : undefined;
  const rootCity = typeof out.city === "string" && out.city.trim() ? out.city.trim() : undefined;
  const rootState =
    typeof out.state === "string" && out.state.trim()
      ? out.state.trim()
      : typeof out.province === "string" && out.province.trim()
        ? out.province.trim()
        : undefined;
  const rootPostalCode =
    typeof out.postalCode === "string" && out.postalCode.trim()
      ? out.postalCode.trim()
      : typeof out.zip === "string" && out.zip.trim()
        ? out.zip.trim()
        : undefined;
  const rootCountry =
    typeof out.country === "string" && out.country.trim()
      ? out.country.trim()
      : typeof out.countryCode === "string" && out.countryCode.trim()
        ? out.countryCode.trim()
        : undefined;

  const buildFlatAddress = (streetOverride?: string): Record<string, string> | undefined => {
    const built: Record<string, string> = {};
    const st = streetOverride ?? rootStreet;
    if (st !== undefined) built.street = st;
    if (rootCity !== undefined) built.city = rootCity;
    if (rootState !== undefined) built.state = rootState;
    if (rootPostalCode !== undefined) built.postalCode = rootPostalCode;
    if (rootCountry !== undefined) built.country = rootCountry;
    return Object.keys(built).length > 0 ? built : undefined;
  };

  if (rawAddress === undefined || rawAddress === null) {
    if (rawAddress === null) {
      delete out.address;
    }
    const flatAddr = buildFlatAddress();
    if (flatAddr) {
      out.address = flatAddr;
    }
    return out;
  }

  if (typeof rawAddress === "string") {
    const trimmed = rawAddress.trim();
    const flatAddr = buildFlatAddress(trimmed || undefined);
    if (!flatAddr) {
      delete out.address;
      return out;
    }
    out.address = flatAddr;
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

    const street =
      typeof addrObj.street === "string" && addrObj.street.trim()
        ? addrObj.street.trim()
        : rootStreet;
    const city =
      typeof addrObj.city === "string" && addrObj.city.trim()
        ? addrObj.city.trim()
        : rootCity;
    const state =
      typeof addrObj.state === "string" && addrObj.state.trim()
        ? addrObj.state.trim()
        : typeof addrObj.province === "string" && addrObj.province.trim()
          ? addrObj.province.trim()
          : rootState;
    const postalCode =
      typeof addrObj.postalCode === "string" && addrObj.postalCode.trim()
        ? addrObj.postalCode.trim()
        : typeof addrObj.zip === "string" && addrObj.zip.trim()
          ? addrObj.zip.trim()
          : rootPostalCode;
    const country =
      typeof addrObj.country === "string" && addrObj.country.trim()
        ? addrObj.country.trim()
        : typeof addrObj.countryCode === "string" && addrObj.countryCode.trim()
          ? addrObj.countryCode.trim()
          : rootCountry;

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
      const trimmedQ = q?.trim();
      const trimmedAfter = after?.trim();

      // Limitation in Frihet-ERP `listResources` (publicApi.ts L8158-8268):
      // When `search` (`q`) is provided, the backend slices results by `offset`/`limit`
      // and returns before evaluating `cursorParam` (`after`). Protected profiles
      // (Claude `claudeToolResult` and OpenAI `applyOpenAIProfile`) rebuild `content`
      // from `structuredContent` while `paginatedOutput` is frozen, so fail closed
      // (`isError: true` without `structuredContent`).
      if (trimmedQ && trimmedAfter) {
        return {
          content: [{
            type: "text" as const,
            text:
              "Error: text search ('q') cannot be combined with cursor pagination ('after') because the ERP backend slices search results by 'offset'/'limit' and ignores 'after'. Use 'offset' and 'limit' when searching with 'q', or omit 'q' when paginating with 'after'. / " +
              "Error: la busqueda textual ('q') no se puede combinar con el cursor 'after' porque el backend pagina las busquedas mediante 'offset'/'limit' e ignora 'after'. Usa 'offset' y 'limit' con 'q', u omite 'q' al paginar con 'after'.",
          }],
          isError: true,
        };
      }

      let result = await client.listVendors({ q, limit, offset, after, fields });

      let usedFallback = false;
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
          const fallbackTruncated = (fallbackResult as unknown as Record<string, unknown>)?.truncated === true;
          if (
            fallbackTruncated ||
            (fallbackResult?.data && (fallbackResult.data.length > 0 || (fallbackResult.total !== undefined && fallbackResult.total > 0)))
          ) {
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

      // Conservative refusal when the ERP 500-document scan cap was saturated (`truncated: true`).
      // Because `paginatedOutput` is a frozen schema contract and both Claude (`claudeToolResult`)
      // and OpenAI (`applyOpenAIProfile`) overwrite `content` whenever `structuredContent` is
      // present, returning `structuredContent` here would hide the truncation warning and present
      // an incomplete 500-doc scan as exhaustive.
      if (isTruncated) {
        const partialCount = typeof result?.total === "number" ? result.total : normalizedData.length;
        return {
          content: [{
            type: "text" as const,
            text:
              `Error: vendor search hit the ERP 500-document scan cap (truncated=true; ${partialCount} match(es) within the first 500 scanned records) and cannot be returned as an exhaustive result across protected profiles. Narrow 'q' or paginate without 'q' using 'after'. / ` +
              `Error: la busqueda de proveedores alcanzo el limite de escaneo de 500 documentos del ERP (truncated=true; ${partialCount} coincidencia(s) en los primeros 500 registros) y no puede devolverse como resultado exhaustivo. Acota 'q' o pagina sin 'q' usando 'after'.`,
          }],
          isError: true,
        };
      }

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
