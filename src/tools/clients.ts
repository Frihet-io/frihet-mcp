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

const OPTIONAL_CLIENT_STRING_FIELDS = [
  "email",
  "phone",
  "stage",
  "taxId",
  "createdAt",
  "updatedAt",
] as const;

/**
 * Normalizes a client record returned by the Frihet API so it always satisfies
 * `clientItemOutput` without losing ERP-canonical data:
 *  - Strips `null` on optional string fields (`email`, `phone`, `stage`, `taxId`,
 *    `createdAt`, `updatedAt`) so `z.string().optional()` never rejects legacy docs.
 *  - Backfills `taxId` from legacy `nif` / `cif` / `vatNumber` / `tax_id` when
 *    `taxId` is absent or null, preserving all original fields.
 *  - Converts legacy string `address` into `{ street }`.
 *  - Omits `null` or empty `address` (which otherwise fails `addressOutputSchema`).
 *  - Maps ERP canonical address keys (`province` -> `state`, `zip` -> `postalCode`,
 *    `countryCode` -> `country`) because `publicApi.ts` (`normalizeAddress`) stores
 *    `zip` and `province`, whereas `addressOutputSchema` only declares `postalCode`
 *    and `state` (and strips unknown keys in `structuredContent`).
 */
function normalizeClientRecord(clientRecord: Record<string, unknown>): Record<string, unknown> {
  if (!clientRecord || typeof clientRecord !== "object" || Array.isArray(clientRecord)) {
    return clientRecord;
  }

  const out: Record<string, unknown> = { ...clientRecord };

  for (const field of OPTIONAL_CLIENT_STRING_FIELDS) {
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
      let result = await client.listClients({ limit, offset, after, fields, q, stage });

      // When a concatenated / camelCase query (e.g. "CanariasBlue") yields zero total matches,
      // retry with split tokens ("Canarias Blue") using the same offset/limit/fields/stage.
      // Guardrails matching publicApi.ts `listResources`:
      //  1. Never fallback when `after` cursor is supplied with `q` (backend search slices by
      //     offset/limit and returns before cursor logic).
      //  2. Never fallback when the first scan hit the 500-document cap (`truncated === true`),
      //     since total===0 only reflects the first 500 scanned records.
      //  3. On page 2+ (`offset > 0`), only fallback when `result.total === 0` explicitly (not
      //     when `total === undefined`, which indicates an exhausted offset).
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
          const fallbackResult = await client.listClients({ limit, offset, after, fields, q: splitQ, stage });
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
        ? result.data.map((c) => (c && typeof c === "object" ? normalizeClientRecord(c as Record<string, unknown>) : c))
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
        content: [listContent(formatPaginatedResponse("clients", cleanEnvelope) + notes.join(""))],
        structuredContent: cleanEnvelope as unknown as Record<string, unknown>,
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
      const result = normalizeClientRecord(await client.getClient(id));
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
        name: z.string().trim().min(1).max(200).describe("Client/company name / Nombre del cliente o empresa"),
        email: z.string().trim().email().max(255).optional().describe("Email address / Correo electronico"),
        phone: z.string().trim().min(1).max(50).optional().describe("Phone number / Telefono"),
        taxId: z.string().optional().describe("Tax ID (NIF/CIF/VAT) / NIF o CIF"),
        address: addressSchema,
      },
      outputSchema: clientItemOutput,
    },
    async (input) => withToolLogging("create_client", async () => {
      const result = normalizeClientRecord(await client.createClient(input));
      const hints = enrichResponse("clients", "create", result);
      return {
        content: [mutateContent(formatRecord("Client created", result) + hints)],
        structuredContent: { ...result } as unknown as Record<string, unknown>,
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
        id: z.string().trim().min(1).max(128).describe("Client ID / ID del cliente"),
        name: z.string().trim().min(1).max(200).optional().describe("Name / Nombre"),
        email: z.string().trim().email().max(255).optional().describe("Email / Correo"),
        phone: z.string().trim().min(1).max(50).optional().describe("Phone / Telefono"),
        taxId: z.string().optional().describe("Tax ID / NIF/CIF"),
        address: addressSchema,
      },
      outputSchema: clientItemOutput,
    },
    async ({ id, ...data }) => withToolLogging("update_client", async () => {
      const result = normalizeClientRecord(await client.updateClient(id, data));
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
