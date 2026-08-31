/**
 * OpenAI-safe profile for the Frihet MCP server.
 *
 * Activated by FRIHET_OPENAI_MODE=true (env var or Worker binding).
 *
 * Applies transformations to every tool registration to comply with
 * OpenAI's ChatGPT Apps submission requirements:
 *
 * 1. Excludes tools that return highly sensitive fiscal data
 * 2. Corrects openWorldHint for tools that trigger external communication
 * 3. Removes government IDs and credentials from input schemas
 * 4. Redacts sensitive fields from all tool outputs
 * 5. Updates descriptions to reflect modified behavior + openWorldHint justifications
 *
 * The full MCP server (158 business tools + MCP extras) remains available for Claude, Cursor,
 * Windsurf, Cline, Codex, and all other MCP clients.
 *
 * OpenAI-safe mode: 33 reviewed business tools, 0 prompts, 0 resources, and no
 * dedicated government-ID fields in I/O.
 * The full MCP surface remains available outside FRIHET_OPENAI_MODE.
 *
 * @see https://developers.openai.com/apps-sdk/app-submission-guidelines
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  getLiteralValue,
  getObjectShape,
  type AnyObjectSchema,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod/v4";
import { correctToolAnnotations } from "./capability-truth.js";
import { MCP_RESOURCE_COUNT } from "./resources/register-all.js";
import { SENSITIVE_FIELD_NAMES, deepRedact, redactText } from "./redaction.js";
import { FRIHET_CONNECTOR_SCOPE } from "./openai-review-oauth.js";

/* ------------------------------------------------------------------ */
/*  Profile definition                                                 */
/* ------------------------------------------------------------------ */

interface OpenAIProfile {
  /** Tools allowed for OpenAI app submission; all others are hidden */
  includeTools: Set<string>;
  /** Tools excluded entirely from registration */
  excludeTools: Set<string>;
  /** Hide MCP prompt templates in OpenAI mode */
  excludePrompts: boolean;
  /** Hide MCP resources in OpenAI mode */
  excludeResources: boolean;
  /** Per-tool annotation overrides (merged with existing) */
  annotationOverrides: Record<string, Partial<ToolAnnotations>>;
  /** Per-tool description replacements */
  descriptionOverrides: Record<string, string>;
  /** Per-tool input fields to remove from schema */
  stripInputFields: Record<string, string[]>;
  /** Legacy-optional fields that must be explicit on the reviewed surface */
  requireInputFields: Record<string, string[]>;
  /** Field names to redact from ALL tool outputs */
  redactOutputFields: readonly string[];
}

const PROFILE: OpenAIProfile = {
  // -- OpenAI-reviewed core surface ----------------------------------------
  //
  // Keep the ChatGPT app submission narrow and stable. The full MCP server
  // has many more tools, including payroll, HR, e-invoicing, VIES, stay/PMS,
  // POS, and other regulated workflows. Those are useful for direct MCP
  // clients, but they broaden data collection and review risk for ChatGPT.
  includeTools: new Set([
    // Read-only tools
    "get_business_context",
    "list_invoices",
    "get_invoice",
    "search_invoices",
    "list_expenses",
    "get_expense",
    "list_clients",
    "get_client",
    "list_client_contacts",
    "list_client_activities",
    "list_client_notes",
    "list_products",
    "get_product",
    "list_quotes",
    "get_quote",
    "list_vendors",
    "get_vendor",

    // Create tools
    "create_invoice",
    "create_expense",
    "create_client",
    "create_client_contact",
    "log_client_activity",
    "create_client_note",
    "create_product",
    "create_quote",
    "create_vendor",

    // Update tools
    "update_expense",
    "update_client",
    "update_product",
    "update_vendor",

    // Delete tools
    "delete_client_contact",
    "delete_client_note",
    "delete_quote",

  ]),

  // ── Tools excluded entirely ─────────────────────────────────────────
  // Return restricted data categories that cannot be adequately redacted.
  excludeTools: new Set([
    "get_quarterly_taxes",  // Modelo 303/130 tax filing data — sensitive fiscal PII
    "get_invoice_einvoice", // EN16931 XML mandatorily contains seller+buyer NIF/CIF
    "get_invoice_pdf",      // Opaque PDF bytes can contain tax IDs and cannot be redacted safely
    "list_webhooks",        // URLs/metadata can embed credentials or external routing data
    "get_webhook",
    "create_webhook",
    "update_webhook",
    "delete_webhook",
    // A draft invoice can cross into a regulated issuance/filing lifecycle
    // through these endpoints when workspace automation is enabled. ChatGPT's
    // reviewed profile is deliberately draft-only for invoices.
    "update_invoice",
    "mark_invoice_paid",
    "delete_invoice",
    "send_invoice",
    "duplicate_invoice",
    "create_credit_note",
    // The backend deletes the accounting record without proving cleanup of
    // linked attachment metadata/objects. Do not imply complete expense-data
    // erasure through the reviewed connector.
    "delete_expense",
    // The backend deletes only the client parent document and leaves its
    // contacts, notes and activities stored but unreachable. Do not imply that
    // this connector performs complete client-data erasure.
    "delete_client",
    // Email delivery is excluded until the backend can bind the previewed
    // recipient atomically and make delivery retry-safe.
    "send_quote",
  ]),

  // MCP prompts/resources can reference tools/fields/modules that are
  // intentionally hidden from OpenAI mode (for example tax IDs, fiscal filing
  // tools, and broad Spanish compliance reference material). ChatGPT Apps do
  // not need them for the public app surface, so remove them from this profile.
  excludePrompts: true,
  excludeResources: true,

  // ── Annotation corrections ──────────────────────────────────────────
  // openWorldHint MUST be true for tools that cause external side effects.
  annotationOverrides: {
    send_invoice: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },

  // ── Description overrides ───────────────────────────────────────────
  // Remove references to stripped fields (taxId, secret, to) and include
  // openWorldHint justifications as required by OpenAI review guidelines.
  descriptionOverrides: {
    get_business_context:
      "Get a concise workspace context with business defaults, plan usage, recent activity, " +
      "top clients, and current-month totals. Government identifiers, precise address fields, " +
      "and regulated filing data are omitted. " +
      "/ Obtiene un contexto conciso del espacio de trabajo sin identificadores oficiales, " +
      "direcciones precisas ni datos de declaraciones reguladas.",

    get_invoice:
      "Get one invoice by ID with its stored line items, linked-client context, dates, and status. " +
      "The response contains only stored document fields; a calculated total may be absent. " +
      "/ Obtiene una factura por ID con sus campos almacenados; el total calculado puede no estar presente.",

    get_quote:
      "Get one quote by ID with its stored line items, linked-client context, dates, and status. " +
      "The response contains only stored document fields; a calculated total may be absent. " +
      "/ Obtiene un presupuesto por ID con sus campos almacenados; el total calculado puede no estar presente.",

    create_invoice:
      "Prepare a draft invoice that reserves a document number, advances the numbering counter, and may create/link a client; it cannot issue, email, or file it. " +
      "It requires a client name and at least one line item and always forces draft status. It cannot mark paid, cancel, hash, or submit the invoice to an external filing service. " +
      "This invoice counts toward the workspace's monthly invoice usage and may emit invoice-creation analytics to PostHog's EU-hosted analytics service. Active owner-configured webhooks may receive the resulting full business events. Frihet may create in-app and Novu notifications for eligible workspace admins or accountants whose preferences allow them. For a referred workspace's first invoice, Frihet may award activation credits to the referring Frihet account. " +
      "/ Prepara una nueva factura en borrador. Este conector siempre fuerza el estado borrador " +
      "y reserva un numero interno; puede crear y vincular el cliente si no existe una coincidencia exacta, pero no emite, envia, marca como pagada, cancela, firma ni presenta la factura.",

    create_expense:
      "Record an expense on an explicit date; its tax-deductible choice affects Frihet's accounting, files nothing, and a new vendor may persist if the expense fails. " +
      "A supplied vendor name may create and link a vendor record when no exact match exists. Vendor creation is a separate backend step, so a newly created vendor may remain if the later expense write fails. " +
      "Active owner-configured webhooks may receive the resulting full business events. Frihet may create in-app and Novu notifications for eligible workspace admins or accountants whose preferences allow them. For a referred workspace's first expense, Frihet may award activation credits to the referring Frihet account. " +
      "/ Registra un gasto tras confirmacion explicita. La creacion del proveedor es un paso separado y el proveedor nuevo puede permanecer si despues falla la creacion del gasto; la clasificacion deducible afecta los calculos internos pero no presenta declaraciones.",

    update_expense:
      "Update an expense description, category, date, or tax-deductible classification, which affects Frihet's internal accounting; this tool files nothing. " +
      "A date change moves the future tax-report period. Only supplied reviewed fields change; amount and supplier identity cannot be changed here. " +
      "Active owner-configured webhooks may receive the resulting full business event. " +
      "/ Actualiza solo los campos indicados de un gasto. La clasificacion deducible afecta los calculos internos, pero no presenta declaraciones.",

    create_quote:
      "Prepare a draft quote that reserves a document number, advances the numbering counter, and may create/link a client; it cannot send or accept it. " +
      "It always forces draft status. Active owner-configured webhooks may receive the resulting full business events. " +
      "/ Prepara un presupuesto en borrador, reserva un numero y avanza el contador. Puede crear y vincular el cliente si no existe una coincidencia exacta; no envia ni acepta el presupuesto.",

    list_clients:
      "List all clients/customers with optional pagination and CRM stage filtering. Free-text search is excluded because the backend search also matches government tax identifiers. " +
      "Returns only summary record identifiers, names, and stages; contact details, government identifiers, and precise addresses are omitted. " +
      "/ Lista todos los clientes con paginacion opcional y filtro por etapa CRM; se excluye la busqueda de texto libre porque tambien coincide con identificadores fiscales oficiales. " +
      "Devuelve solo identificadores, nombres y etapas de resumen; se omiten los datos de contacto, identificadores fiscales y direcciones precisas.",

    get_client:
      "Get one client/customer by ID through the reviewed contact projection; government identifiers and precise addresses are omitted. " +
      "/ Obtiene un cliente por ID mediante la proyeccion revisada; se omiten los identificadores fiscales y las direcciones precisas.",

    create_client:
      "Create a new client/customer. Requires at minimum a name. " +
      "Clients are used when creating invoices and quotes. " +
      "Example: name='Acme Corp', email='billing@acme.com'. " +
      "/ Crea un nuevo cliente. Requiere como minimo un nombre.",

    update_client:
      "Update an existing client using PATCH semantics. Only the provided fields will be changed. " +
      "Example: id='abc123', email='new@acme.com', phone='+34600123456' " +
      "/ Actualiza un cliente existente. Solo se modifican los campos proporcionados.",

    log_client_activity:
      "Log a call, meeting, email, or task entry on one client timeline. For call, meeting, or email entries, Frihet also updates the parent client's latest-activity fields, so active owner-configured webhooks may receive the resulting full client.updated event; task entries do not update the parent client. " +
      "/ Registra una llamada, reunion, correo o tarea en el historial de un cliente. Las llamadas, reuniones y correos tambien actualizan la actividad reciente del cliente y pueden generar un evento client.updated completo para webhooks configurados por el propietario; las tareas no actualizan el cliente padre.",

    list_vendors:
      "List all vendors/suppliers with optional pagination. Free-text search is excluded because the backend search also matches government tax identifiers. " +
      "Returns only summary record identifiers and names; contact details, government identifiers, and precise addresses are omitted. " +
      "/ Lista todos los proveedores con paginacion opcional; se excluye la busqueda de texto libre porque tambien coincide con identificadores fiscales oficiales. " +
      "Devuelve solo identificadores y nombres de resumen; se omiten los datos de contacto, identificadores fiscales y direcciones precisas.",

    get_vendor:
      "Get one vendor/supplier by ID through the reviewed contact projection; government identifiers and precise addresses are omitted. " +
      "/ Obtiene un proveedor por ID mediante la proyeccion revisada; se omiten los identificadores fiscales y las direcciones precisas.",

    create_vendor:
      "Create a new vendor/supplier. Requires at minimum a name. " +
      "Vendors are used when tracking expenses and purchase orders. " +
      "Example: name='Office Supplies Ltd', email='billing@office.com'. " +
      "/ Crea un nuevo proveedor. Requiere como minimo un nombre.",

    update_vendor:
      "Update an existing vendor using PATCH semantics. Only the provided fields will be changed. " +
      "Example: id='abc123', email='new@supplier.com', phone='+34600123456' " +
      "/ Actualiza un proveedor existente. Solo se modifican los campos proporcionados.",

    delete_quote:
      "Delete a clean draft quote or cancel a non-draft quote by its ID. Requires confirm=true. " +
      "A draft is removed permanently only when it has no delivery, response, attachment, or conversion evidence; a protected draft is refused and left unchanged. A quote that has already been " +
      "sent/accepted/rejected/expired is NOT destroyed: the backend cancels it " +
      "(status=cancelled) and it remains readable via get_quote. The response states which " +
      "of the two happened — report that to the user rather than assuming the record is gone. " +
      "/ Elimina un borrador limpio o cancela uno no borrador. Requiere confirm=true. " +
      "Un borrador con evidencia de entrega, respuesta, adjuntos o conversion se rechaza y queda sin cambios; uno no borrador se cancela y sigue consultable con get_quote.",

  },

  // ── Input fields stripped ──────────────────────────────────────────
  // Government IDs (NIF/CIF/VAT), auth credentials, and unsolicited
  // email address collection removed from input schemas.
  stripInputFields: {
    // Projection is useful to direct MCP clients, but unnecessary in the
    // reviewed ChatGPT surface. OpenAI's scanner treats a comma-delimited
    // free-form string as ambiguous (array vs JSON vs CSV), so omit it and
    // return the full, redacted record shape instead.
    list_invoices:  ["fields"],
    search_invoices: ["fields"],
    list_expenses:  ["fields"],
    // The public API's `q` search includes taxId/searchTokens. Omit it entirely
    // so a generic free-text field cannot become a government-identifier input
    // path or leak such a value through a GET URL.
    list_clients:   ["fields", "q"],
    list_products:  ["fields"],
    list_quotes:    ["fields"],
    list_vendors:   ["fields", "q"],
    create_invoice: [
      "clientId",
      "clientTaxId",
      "clientAddress",
      "clientLocation",
      "status",
      "irpfRate",
      "equivalenceSurchargeRate",
      "prepayment",
      "seriesId",
      "documentNumber",
      "poNumber",
      "operationType",
    ],
    create_quote: [
      "clientId",
      "clientTaxId",
      "clientAddress",
      "clientLocation",
      "status",
      "irpfRate",
      "equivalenceSurchargeRate",
    ],
    // paidDate drives cash-basis tax-period allocation in Frihet. The reviewed
    // ChatGPT surface may record an expense, but must not mark it paid or choose
    // the fiscal period in which that payment is recognised.
    create_expense: ["paidDate"],
    // The generic ERP PATCH route does not re-resolve vendorId when a vendor
    // display name changes. Hiding and deleting this field prevents a later
    // fiscal export from pairing a new name with the old vendor identity.
    update_expense: ["vendor", "amount"],
    create_client:  ["taxId", "address"],   // government ID + raw location
    update_client:  ["taxId", "address"],
    create_vendor:  ["taxId", "address"],
    update_vendor:  ["taxId", "address"],
  },

  requireInputFields: {
    // The base API has legacy defaults for these accounting choices. ChatGPT
    // must receive an explicit user choice instead of silently accepting them.
    create_expense: ["date", "taxDeductible"],
  },

  // ── Output fields redacted ─────────────────────────────────────────
  // Stripped from structuredContent and text in ALL tool responses.
  // Single source of truth lives in redaction.ts (shared with observability.ts
  // so Langfuse traces redact the EXACT same field set).
  redactOutputFields: [
    ...SENSITIVE_FIELD_NAMES,
    // The reviewed connector neither requests nor echoes precise locations.
    "address",
    "clientAddress",
    "clientLocation",
    // Monthly summaries remain useful without becoming a filing surface.
    "taxLiability",
    "estimatedModel303",
    "vatPayable",
    "irpfRetained",
    "fiscalZone",
    "irpfRate",
    "series",
    // CRM activity metadata is an open-ended backend map. It is useful to the
    // full MCP server, but it cannot be proven free of restricted data for the
    // reviewed connector, so omit it from both descriptor and runtime output.
    "metadata",
    // Demo-mode markers are internal implementation metadata. The dedicated
    // OAuth host never uses DemoFrihetClient, so advertising them would expose
    // impossible fields and make the reviewed app look like a trial/demo app.
    "_demo",
    "_demoNotice",
    // Generic persistence timestamps are reviewer-noise and are not needed to
    // address, relate, or reconcile any reviewed operation. Business dates
    // such as issueDate, dueDate, date, validUntil, and activity timestamp stay.
    "createdAt",
    "updatedAt",
    // Internal backend-path marker; the reviewed result already exposes the
    // user-relevant deleted/cancelled outcome.
    "cancelledVia",
  ],
};

/** OAuth requirement advertised on every reviewed business tool. */
export const OPENAI_OAUTH_SECURITY_SCHEMES = [
  { type: "oauth2" as const, scopes: [FRIHET_CONNECTOR_SCOPE] },
] as const;

/**
 * @modelcontextprotocol/sdk 1.30 accepts unknown registration config fields,
 * but its McpServer currently drops top-level `securitySchemes` when it builds
 * the actual tools/list response. OpenAI requires that standard field and only
 * treats `_meta.securitySchemes` as a backwards-compatibility mirror.
 *
 * Install a narrow response projection before the SDK registers its first
 * tools/list handler. It copies the already-reviewed mirror to the standard
 * top-level field and fails closed if any visible tool lacks the exact OAuth
 * requirement. The normal (non-OpenAI) MCP surface is never patched.
 */
const OPENAI_TOOLS_LIST_PATCHED_SERVERS = new WeakSet<object>();
type ReviewedSchemaDescriptionSources = {
  inputSchema?: unknown;
  outputSchema?: unknown;
};

function requestSchemaMethod(requestSchema: unknown): unknown {
  const shape = getObjectShape(requestSchema as AnyObjectSchema);
  return shape?.method ? getLiteralValue(shape.method) : undefined;
}

function reviewedSchemaDescriptionSource(
  schema: unknown,
  location: string,
): unknown {
  if (schema === undefined) return undefined;
  if (!(schema instanceof z.ZodType)) {
    throw new Error(`${location} must be a finalized Zod schema`);
  }
  return z.toJSONSchema(schema);
}

function restoreReviewedSchemaDescriptions(
  wireValue: unknown,
  sourceValue: unknown,
): unknown {
  if (Array.isArray(wireValue) && Array.isArray(sourceValue)) {
    return wireValue.map((item, index) =>
      restoreReviewedSchemaDescriptions(item, sourceValue[index])
    );
  }
  if (!isRecord(wireValue) || !isRecord(sourceValue)) return wireValue;

  const restored: Record<string, unknown> = { ...wireValue };
  const hasMetadataDescription = typeof sourceValue.description === "string";
  if (hasMetadataDescription) {
    restored.description = sourceValue.description;
  }
  for (const [key, child] of Object.entries(wireValue)) {
    if ((key === "description" && hasMetadataDescription) || !(key in sourceValue)) {
      continue;
    }
    restored[key] = restoreReviewedSchemaDescriptions(child, sourceValue[key]);
  }
  return restored;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installOpenAIToolsListSecurityProjection(server: any): void {
  const protocol = server?.server;
  if (
    protocol === null
    || typeof protocol !== "object"
    || typeof protocol.setRequestHandler !== "function"
    || typeof server?.registerTool !== "function"
    || OPENAI_TOOLS_LIST_PATCHED_SERVERS.has(protocol)
  ) {
    return;
  }

  OPENAI_TOOLS_LIST_PATCHED_SERVERS.add(protocol);
  const schemaDescriptions = new Map<string, ReviewedSchemaDescriptionSources>();

  const originalRegisterTool = server.registerTool.bind(server);
  // Capture finalized reviewed schemas before the Worker SDK serializes them.
  // Zod stores `.describe()` metadata in a module-local registry; without this
  // projection, the Worker's separate Zod copy drops every field description.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerTool = (name: string, config: any, handler: any) => {
    if (typeof name !== "string" || !isRecord(config)) {
      throw new Error("OpenAI tool registration is invalid");
    }
    schemaDescriptions.set(name, {
      inputSchema: reviewedSchemaDescriptionSource(
        config.inputSchema,
        `${name}.inputSchema`,
      ),
      outputSchema: reviewedSchemaDescriptionSource(
        config.outputSchema,
        `${name}.outputSchema`,
      ),
    });
    return originalRegisterTool(name, config, handler);
  };

  const originalSetRequestHandler = protocol.setRequestHandler.bind(protocol);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protocol.setRequestHandler = (requestSchema: any, handler: any) => {
    // Match the protocol method structurally. The deployed Worker has its own
    // @modelcontextprotocol/sdk installation, so schema object identity differs
    // from the root package even when both resolve the same locked version.
    if (requestSchemaMethod(requestSchema) !== "tools/list") {
      return originalSetRequestHandler(requestSchema, handler);
    }

    return originalSetRequestHandler(
      requestSchema,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (request: any, extra: any) => {
        const result = await handler(request, extra);
        if (!isRecord(result) || !Array.isArray(result.tools)) {
          throw new Error("OpenAI tools/list returned an invalid tool collection");
        }

        const tools = result.tools.map((tool: unknown) => {
          if (!isRecord(tool) || !isRecord(tool._meta)) {
            throw new Error("OpenAI tools/list tool is missing OAuth metadata");
          }
          if (typeof tool.name !== "string") {
            throw new Error("OpenAI tools/list tool is missing its name");
          }
          const schemes = tool._meta.securitySchemes;
          if (
            !Array.isArray(schemes)
            || schemes.length !== 1
            || !isRecord(schemes[0])
            || schemes[0].type !== "oauth2"
            || !Array.isArray(schemes[0].scopes)
            || schemes[0].scopes.length !== 1
            || schemes[0].scopes[0] !== FRIHET_CONNECTOR_SCOPE
          ) {
            throw new Error(
              `OpenAI tool ${String(tool.name)} is missing the reviewed OAuth scope`,
            );
          }

          const securitySchemes = [{
            type: "oauth2",
            scopes: [FRIHET_CONNECTOR_SCOPE],
          }];
          const descriptionSources = schemaDescriptions.get(tool.name);
          if (!descriptionSources) {
            throw new Error(
              `OpenAI tool ${tool.name} is missing its reviewed schema projection`,
            );
          }
          return {
            ...tool,
            inputSchema: restoreReviewedSchemaDescriptions(
              tool.inputSchema,
              descriptionSources.inputSchema,
            ),
            ...(tool.outputSchema === undefined
              ? {}
              : {
                  outputSchema: restoreReviewedSchemaDescriptions(
                    tool.outputSchema,
                    descriptionSources.outputSchema,
                  ),
                }),
            securitySchemes,
          };
        });

        return { ...result, tools };
      },
    );
  };
}

export const OPENAI_WORKSPACE_WEBHOOK_EVENT_TOOLS: ReadonlySet<string> = new Set([
  "create_invoice",
  "create_expense",
  "update_expense",
  "create_quote",
  "delete_quote",
  "create_client",
  "update_client",
  "log_client_activity",
  "create_product",
  "update_product",
]);

const REVIEWED_PERMANENT_DELETE_TOOLS = new Set([
  "delete_client_contact",
  "delete_client_note",
]);

const REVIEWED_CLOSED_WORLD_WRITE_TOOLS = new Set([
  "create_client_contact",
  "create_client_note",
  "create_vendor",
  "update_vendor",
]);

const BASE_CONFIRM_TOOLS = new Set(["delete_quote"]);

export const OPENAI_REVIEW_CONFIRM_REQUIRED_TOOLS: ReadonlySet<string> = new Set([
  ...OPENAI_WORKSPACE_WEBHOOK_EVENT_TOOLS,
  ...REVIEWED_PERMANENT_DELETE_TOOLS,
  ...REVIEWED_CLOSED_WORLD_WRITE_TOOLS,
]);

const PROFILE_INJECTED_CONFIRM_TOOLS = new Set(
  [...OPENAI_REVIEW_CONFIRM_REQUIRED_TOOLS].filter(
    (name) => !BASE_CONFIRM_TOOLS.has(name),
  ),
);

const REVIEWED_NON_EMPTY_PATCH_TOOLS = new Set([
  "update_client",
  "update_expense",
  "update_product",
  "update_vendor",
]);

const PROFILE_FORCED_INPUT_VALUES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  create_invoice: { status: "draft" },
  create_quote: { status: "draft" },
};

/* ------------------------------------------------------------------ */
/*  Deep field redaction — shared policy in redaction.ts               */
/* ------------------------------------------------------------------ */
//
// deepRedact (in-place DELETE) + redactText (regex) now live in ./redaction.ts
// so observability.ts redacts the SAME field set before tracing to Langfuse.

/* ------------------------------------------------------------------ */
/*  Output SCHEMA stripping (descriptor-level)                          */
/* ------------------------------------------------------------------ */

/**
 * Returns a closed Zod output schema with sensitive fields removed at EVERY
 * depth.
 *
 * Runtime output redaction (deepRedact in the handler wrapper) hides the
 * VALUES, but the advertised `outputSchema` descriptor still DECLARES taxId /
 * secret etc. at tools/list — which OpenAI's submission review auto-detects as
 * exposed government IDs / credentials. This strips them from the descriptor too.
 *
 * Every object is deliberately rebuilt in strip mode, including objects whose
 * base schema is `.passthrough()`. The Frihet API returns raw Firestore records,
 * so a blacklist alone is insufficient: a newly added backend field could
 * otherwise escape the reviewed contract without appearing in this file. The
 * rebuilt schema is therefore also the runtime output projection allowlist.
 */
function buildReviewedOutputSchema(
  schema: unknown,
  fields: readonly string[],
): unknown {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const newShape: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(shape)) {
      const unwrapped = value instanceof z.ZodOptional || value instanceof z.ZodNullable
        ? value.unwrap()
        : value;
      if (fields.includes(key) || unwrapped instanceof z.ZodNever) continue;
      newShape[key] = buildReviewedOutputSchema(value, fields);
    }

    // Default Zod object behavior strips unknown keys. Do not preserve a base
    // `.passthrough()` or `.catchall()`: this is the reviewed output boundary.
    let rebuilt: z.ZodTypeAny = z.object(newShape as z.ZodRawShape);
    if (typeof schema.description === "string") rebuilt = rebuilt.describe(schema.description);
    return rebuilt;
  }

  if (schema instanceof z.ZodArray) {
    const inner = schema.element;
    const stripped = buildReviewedOutputSchema(inner, fields);
    let rebuilt: z.ZodTypeAny = z.array(stripped as z.ZodTypeAny);
    if (typeof schema.description === "string") rebuilt = rebuilt.describe(schema.description);
    return rebuilt;
  }

  if (schema instanceof z.ZodOptional) {
    const inner = schema.unwrap();
    let rebuilt: z.ZodTypeAny = z.optional(
      buildReviewedOutputSchema(inner, fields) as z.ZodTypeAny,
    );
    if (typeof schema.description === "string") rebuilt = rebuilt.describe(schema.description);
    return rebuilt;
  }

  if (schema instanceof z.ZodNullable) {
    const inner = schema.unwrap();
    let rebuilt: z.ZodTypeAny = z.nullable(
      buildReviewedOutputSchema(inner, fields) as z.ZodTypeAny,
    );
    if (typeof schema.description === "string") rebuilt = rebuilt.describe(schema.description);
    return rebuilt;
  }

  if (schema instanceof z.ZodUnion) {
    const options = schema.options.map(
      (option) => buildReviewedOutputSchema(option, fields) as z.ZodTypeAny,
    ) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]];
    let rebuilt: z.ZodTypeAny = z.union(options);
    if (typeof schema.description === "string") rebuilt = rebuilt.describe(schema.description);
    return rebuilt;
  }

  if (schema instanceof z.ZodRecord) {
    let rebuilt: z.ZodTypeAny = z.record(
      schema.keyType,
      buildReviewedOutputSchema(schema.valueType, fields) as z.ZodTypeAny,
    );
    if (typeof schema.description === "string") rebuilt = rebuilt.describe(schema.description);
    return rebuilt;
  }

  // Only JSON-safe primitive leaves are accepted. Unknown/open schema kinds
  // must fail registration instead of silently bypassing this security
  // boundary when a future tool introduces a tuple, intersection, lazy,
  // transform, any, or unknown output.
  if (
    schema instanceof z.ZodString
    || schema instanceof z.ZodNumber
    || schema instanceof z.ZodBoolean
    || schema instanceof z.ZodLiteral
    || schema instanceof z.ZodEnum
    || schema instanceof z.ZodNull
  ) {
    return schema;
  }

  const typeName = schema instanceof z.ZodType
    ? String((schema._def as { type?: unknown }).type ?? schema.constructor.name)
    : typeof schema;
  throw new Error(`Unsupported reviewed output schema node: ${typeName}`);
}

const REVIEWED_PAGINATED_REQUIRED_ITEM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  list_invoices: ["id"],
  search_invoices: ["id"],
  list_expenses: ["id", "description", "amount"],
  list_clients: ["id", "name"],
  list_products: ["id", "name", "unitPrice"],
  list_quotes: ["id"],
  list_vendors: ["id", "name"],
};

/** Strictly necessary row fields for reviewed collection/search responses. */
export const OPENAI_REVIEW_LIST_OUTPUT_FIELDS: Readonly<
  Record<string, readonly string[]>
> = {
  list_invoices: [
    "id",
    "invoiceNumber",
    "clientName",
    "issueDate",
    "dueDate",
    "status",
    "total",
  ],
  search_invoices: [
    "id",
    "invoiceNumber",
    "clientName",
    "issueDate",
    "dueDate",
    "status",
    "total",
  ],
  list_expenses: [
    "id",
    "description",
    "amount",
    "category",
    "date",
    "vendor",
    "taxDeductible",
    "paidDate",
  ],
  list_clients: ["id", "name", "stage"],
  list_products: ["id", "name", "unitPrice", "taxRate", "isActive"],
  list_quotes: [
    "id",
    "quoteNumber",
    "clientName",
    "issueDate",
    "dueDate",
    "validUntil",
    "status",
    "total",
  ],
  list_vendors: ["id", "name"],
};

export const OPENAI_REVIEW_LIST_LIMIT_MAX = 50;
export const OPENAI_REVIEW_OFFSET_MAX = 10_000;
export const OPENAI_REVIEW_PAGINATION_DEFAULT = 20;
export const OPENAI_REVIEW_DOCUMENT_LINE_ITEM_MAX = 100;
export const OPENAI_REVIEW_BUSINESS_CONTEXT_TOP_CLIENTS_MAX = 5;

export const OPENAI_REVIEW_FREE_TEXT_WARNING =
  "Do not include passwords, credentials, payment-card data, health data, or official/government identifiers in this free-text field / No incluyas contrasenas, credenciales, datos de tarjetas, datos de salud ni identificadores oficiales en este campo de texto libre";

/** Dot paths whose persisted or query text needs an explicit model-facing warning. */
export const OPENAI_REVIEW_FREE_TEXT_WARNING_PATHS: Readonly<
  Record<string, readonly string[]>
> = {
  search_invoices: ["query"],
  list_expenses: ["category"],
  list_products: ["q"],
  create_invoice: ["clientName", "items[].description", "notes"],
  create_quote: ["clientName", "items[].description", "notes"],
  create_expense: ["description", "category", "vendor"],
  update_expense: ["description", "category"],
  create_client: ["name"],
  update_client: ["name"],
  create_client_contact: ["name", "role"],
  create_client_note: ["content"],
  create_product: ["name", "description"],
  update_product: ["name", "description"],
  create_vendor: ["name"],
  update_vendor: ["name"],
  log_client_activity: ["title", "description"],
};

export const OPENAI_REVIEW_PAGINATION_LIMITS: Readonly<Record<string, number>> = {
  list_invoices: OPENAI_REVIEW_LIST_LIMIT_MAX,
  search_invoices: OPENAI_REVIEW_LIST_LIMIT_MAX,
  list_expenses: OPENAI_REVIEW_LIST_LIMIT_MAX,
  list_clients: OPENAI_REVIEW_LIST_LIMIT_MAX,
  list_products: OPENAI_REVIEW_LIST_LIMIT_MAX,
  list_quotes: OPENAI_REVIEW_LIST_LIMIT_MAX,
  list_vendors: OPENAI_REVIEW_LIST_LIMIT_MAX,
  list_client_contacts: OPENAI_REVIEW_LIST_LIMIT_MAX,
  list_client_activities: 20,
  list_client_notes: 20,
};

export const OPENAI_REVIEW_TEXT_INPUT_LIMITS: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = {
  create_expense: { category: 100 },
  update_expense: { description: 1_000, category: 100 },
};

const REVIEWED_INVOICE_OUTPUT_TOOLS = new Set([
  "list_invoices",
  "search_invoices",
  "get_invoice",
  "create_invoice",
]);

const REVIEWED_QUOTE_OUTPUT_TOOLS = new Set([
  "list_quotes",
  "get_quote",
  "create_quote",
]);

const REVIEWED_DOCUMENT_DETAIL_OUTPUT_TOOLS = new Set([
  "get_invoice",
  "create_invoice",
  "get_quote",
  "create_quote",
]);

function requireObjectFields(
  schema: z.ZodObject,
  fields: readonly string[],
): z.ZodObject {
  const shape = { ...schema.shape } as Record<string, z.ZodTypeAny>;
  for (const field of fields) {
    const value = shape[field];
    if (!value) throw new Error(`Reviewed output is missing required field ${field}`);
    if (value instanceof z.ZodOptional) {
      shape[field] = value.unwrap() as z.ZodTypeAny;
    }
  }
  return z.object(shape as z.ZodRawShape);
}

function addDocumentAlias(
  schema: z.ZodObject,
  alias: "invoiceNumber" | "quoteNumber",
  required = false,
): z.ZodObject {
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const data = shape.data;
  if (data instanceof z.ZodArray && data.element instanceof z.ZodObject) {
    return schema.extend({
      data: z.array(data.element.extend({ [alias]: z.string().optional() })),
    });
  }
  return schema.extend({ [alias]: required ? z.string() : z.string().optional() });
}

function selectReviewedObjectFields(
  schema: z.ZodObject,
  fields: readonly string[],
): z.ZodObject {
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const selected: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    const value = shape[field];
    if (!value) throw new Error(`Reviewed summary output is missing field ${field}`);
    selected[field] = value;
  }
  return z.object(selected as z.ZodRawShape);
}

function omitReviewedLineItemIds(schema: z.ZodObject): z.ZodObject {
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const items = shape.items;
  const array = items instanceof z.ZodOptional ? items.unwrap() : items;
  if (!(array instanceof z.ZodArray) || !(array.element instanceof z.ZodObject)) {
    throw new Error("Reviewed document detail output must expose an item-object array");
  }
  let projectedItems = z
    .array(array.element.omit({ id: true }))
    .max(OPENAI_REVIEW_DOCUMENT_LINE_ITEM_MAX);
  if (typeof array.description === "string") {
    projectedItems = projectedItems.describe(array.description);
  }
  return schema.extend({
    items: items instanceof z.ZodOptional ? projectedItems.optional() : projectedItems,
  });
}

function omitReviewedActivityMetadata(name: string, schema: z.ZodObject): z.ZodObject {
  if (name === "log_client_activity") return schema.omit({ id: true, createdBy: true });
  if (name !== "list_client_activities") return schema;
  const data = (schema.shape as Record<string, z.ZodTypeAny>).data;
  if (!(data instanceof z.ZodArray) || !(data.element instanceof z.ZodObject)) {
    throw new Error("Reviewed activity list output must expose an object array");
  }
  return schema.extend({ data: z.array(data.element.omit({ id: true, createdBy: true })) });
}

function capReviewedBusinessContext(name: string, schema: z.ZodObject): z.ZodObject {
  if (name !== "get_business_context") return schema;
  const topClients = (schema.shape as Record<string, z.ZodTypeAny>).topClients;
  if (!(topClients instanceof z.ZodArray)) {
    throw new Error("Reviewed business context must expose a topClients array");
  }
  let capped = z.array(topClients.element).max(
    OPENAI_REVIEW_BUSINESS_CONTEXT_TOP_CLIENTS_MAX,
  );
  if (typeof topClients.description === "string") {
    capped = capped.describe(topClients.description);
  }
  return schema.extend({ topClients: capped });
}

/** Contextual reviewed DTO refinements after the generic closed projection. */
function customizeReviewedOutputSchema(name: string, schema: unknown): unknown {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(`${name} must expose a top-level object output schema`);
  }

  let reviewed = schema;
  const required = REVIEWED_PAGINATED_REQUIRED_ITEM_FIELDS[name];
  if (required) {
    const data = (reviewed.shape as Record<string, z.ZodTypeAny>).data;
    if (!(data instanceof z.ZodArray) || !(data.element instanceof z.ZodObject)) {
      throw new Error(`${name} must expose a paginated object array`);
    }
    reviewed = reviewed.extend({
      data: z.array(requireObjectFields(data.element, required)),
    });
  }

  if (REVIEWED_INVOICE_OUTPUT_TOOLS.has(name)) {
    reviewed = addDocumentAlias(reviewed, "invoiceNumber", name === "create_invoice");
  } else if (REVIEWED_QUOTE_OUTPUT_TOOLS.has(name)) {
    reviewed = addDocumentAlias(reviewed, "quoteNumber", name === "create_quote");
  }

  if (REVIEWED_DOCUMENT_DETAIL_OUTPUT_TOOLS.has(name)) {
    reviewed = omitReviewedLineItemIds(reviewed);
  }

  // Create handlers have stronger invariants than the shared read/update
  // schemas. Publish only fields that can occur on their successful wire
  // result and require the values the backend always materializes.
  if (name === "create_client") {
    reviewed = reviewed.omit({ stage: true });
  } else if (name === "create_expense") {
    reviewed = requireObjectFields(
      reviewed.omit({ paidDate: true }),
      ["date", "taxDeductible"],
    );
  } else if (name === "create_invoice") {
    reviewed = requireObjectFields(
      reviewed.omit({ total: true }),
      ["clientId", "clientName", "items", "issueDate", "dueDate"],
    );
  } else if (name === "create_quote") {
    reviewed = requireObjectFields(
      reviewed.omit({ total: true }),
      ["clientId", "clientName", "items", "issueDate"],
    );
  } else if (name === "create_product") {
    reviewed = reviewed.omit({ isActive: true });
  }
  reviewed = omitReviewedActivityMetadata(name, reviewed);
  reviewed = capReviewedBusinessContext(name, reviewed);

  const summaryFields = OPENAI_REVIEW_LIST_OUTPUT_FIELDS[name];
  if (summaryFields) {
    const data = (reviewed.shape as Record<string, z.ZodTypeAny>).data;
    if (!(data instanceof z.ZodArray) || !(data.element instanceof z.ZodObject)) {
      throw new Error(`${name} must expose a paginated object array`);
    }
    reviewed = reviewed.extend({
      data: z.array(selectReviewedObjectFields(data.element, summaryFields)),
    });
  }

  const paginationLimit = OPENAI_REVIEW_PAGINATION_LIMITS[name];
  if (paginationLimit !== undefined) {
    const data = (reviewed.shape as Record<string, z.ZodTypeAny>).data;
    if (!(data instanceof z.ZodArray)) {
      throw new Error(`${name} must expose a paginated array for reviewed output capping`);
    }
    reviewed = reviewed.extend({ data: z.array(data.element).max(paginationLimit) });
  }

  // These two reviewed operations force status=draft before they call the
  // backend. The create transaction always reserves and returns a document
  // number, so advertise those successful-result invariants as required rather
  // than a loose optional string contract.
  if (name === "create_invoice" || name === "create_quote") {
    reviewed = reviewed.extend({ status: z.literal("draft") });
  }

  if (OPENAI_WORKSPACE_WEBHOOK_EVENT_TOOLS.has(name) && name !== "delete_quote") {
    reviewed = reviewed.extend({ externalEffects: z.array(z.string()) });
  }

  // delete_quote has two mutually exclusive wire results. Keep this a strict
  // discriminated union so a deleted row can never claim a cancellation status
  // and a retained/cancelled row can never omit status=cancelled.
  if (name === "delete_quote") {
    const {
      outcome: _outcome,
      status: _status,
      previousStatus: _previousStatus,
      cancelledVia: _cancelledVia,
      externalEffects: _externalEffects,
      ...shared
    } = reviewed.shape as Record<string, z.ZodTypeAny>;
    const deleted = z.object({
      outcome: z.literal("deleted"),
    }).strict();
    const cancelled = z.object({
      outcome: z.literal("cancelled"),
      status: z.literal("cancelled"),
      previousStatus: z.string().nullable().optional(),
      externalEffects: z.array(z.string()),
    }).strict();
    return z.object({
      ...shared,
      success: z.literal(true),
      result: z.discriminatedUnion("outcome", [deleted, cancelled]),
    }).strict();
  }
  return reviewed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Convert internal names/maps into explicit reviewed DTO fields before redaction. */
function customizeReviewedOutputValue(name: string, value: unknown): unknown {
  if (!isRecord(value)) return value;

  if (name === "delete_quote") {
    const details = value.outcome === "cancelled"
      ? {
          outcome: "cancelled",
          status: "cancelled",
          ...(typeof value.previousStatus === "string"
            ? { previousStatus: value.previousStatus }
            : value.previousStatus === null
              ? { previousStatus: null }
              : {}),
          externalEffects: [
            "One or more active webhook endpoints previously configured by the workspace owner may receive the full resulting quote.updated event.",
          ],
        }
      : { outcome: "deleted" };
    delete value.outcome;
    delete value.status;
    delete value.previousStatus;
    delete value.cancelledVia;
    delete value.externalEffects;
    value.result = details;
    return value;
  }

  const alias = REVIEWED_INVOICE_OUTPUT_TOOLS.has(name)
    ? "invoiceNumber"
    : REVIEWED_QUOTE_OUTPUT_TOOLS.has(name)
      ? "quoteNumber"
      : undefined;
  if (alias) {
    const records = Array.isArray(value.data)
      ? value.data.filter(isRecord)
      : [value];
    for (const record of records) {
      if (typeof record.documentNumber === "string") {
        record[alias] = record.documentNumber;
      }
    }
  }

  if (
    OPENAI_WORKSPACE_WEBHOOK_EVENT_TOOLS.has(name)
    && name !== "delete_quote"
  ) {
    const effects = [name === "log_client_activity"
      ? "For call, meeting, or email entries, active webhook endpoints previously configured by the workspace owner may receive the full resulting client.updated event; task entries do not update the parent client."
      : "One or more active webhook endpoints previously configured by the workspace owner may receive the full resulting business event."];
    if (name === "create_invoice" || name === "create_quote") {
      effects.unshift("Frihet reserved a document number and advanced the workspace numbering counter.");
      effects.push("If no exact client match existed, Frihet may have created and linked a client record from the supplied name.");
    }
    if (name === "create_expense") {
      if (typeof value.vendorId === "string" || typeof value.vendor === "string") {
        effects.push("If no exact vendor match existed, Frihet may have created and linked a vendor record from the supplied name.");
      }
    }
    if (name === "update_expense") {
      effects.push("A changed date moves the expense's accounting and future tax-report period; a changed tax-deductible choice affects Frihet's internal accounting. This tool files nothing and cannot change the amount or linked supplier identity.");
    }
    if (name === "create_invoice") {
      effects.push("The draft counts toward the workspace's monthly invoice usage.");
      effects.push("Frihet may have sent invoice-creation usage and activation analytics to PostHog's EU-hosted analytics service.");
      effects.push("Frihet may create in-app and Novu notifications for eligible workspace admins or accountants whose preferences allow them.");
      effects.push("If this was a referred workspace's first invoice, Frihet may have awarded activation credits to the referring Frihet account.");
    }
    if (name === "create_expense") {
      effects.push("Frihet may create in-app and Novu notifications for eligible workspace admins or accountants whose preferences allow them.");
      effects.push("If this was a referred workspace's first expense, Frihet may have awarded activation credits to the referring Frihet account.");
    }
    value.externalEffects = effects;
  }
  return value;
}

function reviewedStructuredContentSummary(name: string, value: unknown): string {
  if (isRecord(value) && Array.isArray(value.data)) {
    return `Frihet returned ${value.data.length} reviewed summary record(s) for ${name}. The declared fields are available in structuredContent.`;
  }
  if (OPENAI_REVIEW_CONFIRM_REQUIRED_TOOLS.has(name)) {
    return `Frihet completed ${name}. The reviewed result and any disclosed external effects are available in structuredContent.`;
  }
  return `Frihet returned the reviewed ${name} result in structuredContent.`;
}

/** Remove reviewed input fields while preserving a Zod object's strictness. */
function stripReviewedInputFields(
  schema: unknown,
  fields: readonly string[],
): unknown {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const filtered = Object.fromEntries(
      Object.entries(shape).filter(([key]) => !fields.includes(key)),
    ) as z.ZodRawShape;
    const base = z.object(filtered);
    const catchall = schema._def.catchall;
    if (catchall instanceof z.ZodUnknown) return base.passthrough();
    if (catchall instanceof z.ZodNever) return base.strict();
    if (catchall) return base.catchall(catchall);
    return base;
  }

  if (schema !== null && typeof schema === "object" && !Array.isArray(schema)) {
    const filtered = { ...(schema as Record<string, unknown>) };
    for (const field of fields) delete filtered[field];
    return filtered;
  }

  return schema;
}

/** Make legacy-optional accounting choices explicit on the reviewed surface. */
function requireReviewedInputFields(
  schema: unknown,
  fields: readonly string[],
): z.ZodObject {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error("Reviewed required input fields need a Zod object schema");
  }
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const required: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    const value = shape[field];
    if (!value) throw new Error(`Reviewed required input field is missing: ${field}`);
    required[field] = value.nonoptional();
  }
  return schema.extend(required);
}

/** Advertise and enforce a closed input object for every reviewed operation. */
function closeReviewedInputSchema(schema: unknown): z.ZodObject {
  if (schema instanceof z.ZodObject) return schema.strict();
  if (schema !== null && typeof schema === "object" && !Array.isArray(schema)) {
    return z.object(schema as z.ZodRawShape).strict();
  }
  throw new Error("Reviewed tool input schema must be an object");
}

function constrainReviewedPagination(schema: unknown, maximum: number): unknown {
  const limit = z
    .number()
    .int()
    .min(1)
    .max(maximum)
    .optional()
    .describe(
      `Maximum ${maximum} rows per reviewed response`,
    );
  const offset = z
    .number()
    .int()
    .min(0)
    .max(OPENAI_REVIEW_OFFSET_MAX)
    .optional()
    .describe(`Reviewed pagination offset, maximum ${OPENAI_REVIEW_OFFSET_MAX}`);
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    if (!shape.limit || !shape.offset) {
      throw new Error("Reviewed paginated input must expose limit and offset");
    }
    return schema.extend({ limit, offset });
  }
  if (schema !== null && typeof schema === "object" && !Array.isArray(schema)) {
    const shape = schema as Record<string, unknown>;
    if (!shape.limit || !shape.offset) {
      throw new Error("Reviewed paginated input must expose limit and offset");
    }
    return { ...shape, limit, offset };
  }
  throw new Error("Reviewed list input schema must be an object");
}

function constrainReviewedTextInputs(
  schema: unknown,
  limits: Readonly<Record<string, number>>,
): unknown {
  const replacements = Object.fromEntries(
    Object.entries(limits).map(([field, maximum]) => [
      field,
      z
        .string()
        .trim()
        .min(1)
        .max(maximum)
        .optional()
        .describe(`Reviewed ${field} text, maximum ${maximum} characters`),
    ]),
  );
  if (schema instanceof z.ZodObject) return schema.extend(replacements);
  if (schema !== null && typeof schema === "object" && !Array.isArray(schema)) {
    return { ...(schema as Record<string, unknown>), ...replacements };
  }
  throw new Error("Reviewed text input schema must be an object");
}

function appendReviewedFreeTextWarning(schema: z.ZodTypeAny): z.ZodTypeAny {
  const prefix = typeof schema.description === "string" && schema.description.length > 0
    ? `${schema.description} — `
    : "";
  return schema.describe(`${prefix}${OPENAI_REVIEW_FREE_TEXT_WARNING}`);
}

function warnReviewedRootTextFields(
  schema: unknown,
  name: string,
  fields: readonly string[],
): unknown {
  const shape = schema instanceof z.ZodObject
    ? schema.shape as Record<string, z.ZodTypeAny>
    : schema !== null && typeof schema === "object" && !Array.isArray(schema)
      ? schema as Record<string, z.ZodTypeAny>
      : undefined;
  if (!shape) {
    throw new Error(`${name} reviewed free-text warnings require a Zod object`);
  }
  const warned: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    const value = shape[field];
    if (!value) throw new Error(`${name} reviewed free-text field is missing: ${field}`);
    warned[field] = appendReviewedFreeTextWarning(value);
  }
  return schema instanceof z.ZodObject
    ? schema.extend(warned)
    : { ...shape, ...warned };
}

function constrainReviewedDocumentLineItems(
  schema: unknown,
  name: string,
): unknown {
  const shape = schema instanceof z.ZodObject
    ? schema.shape as Record<string, z.ZodTypeAny>
    : schema !== null && typeof schema === "object" && !Array.isArray(schema)
      ? schema as Record<string, z.ZodTypeAny>
      : undefined;
  if (!shape) {
    throw new Error(`${name} reviewed line items require a Zod object`);
  }
  const items = shape.items;
  if (!(items instanceof z.ZodArray) || !(items.element instanceof z.ZodObject)) {
    throw new Error(`${name} reviewed line items must be an object array`);
  }
  const itemShape = items.element.shape as Record<string, z.ZodTypeAny>;
  const description = itemShape.description;
  if (!description) {
    throw new Error(`${name} reviewed line-item description is missing`);
  }
  const warnedItem = items.element.extend({
    description: appendReviewedFreeTextWarning(description),
  });
  let constrained = z
    .array(warnedItem)
    .min(1)
    .max(OPENAI_REVIEW_DOCUMENT_LINE_ITEM_MAX);
  if (typeof items.description === "string") {
    constrained = constrained.describe(items.description);
  }
  return schema instanceof z.ZodObject
    ? schema.extend({ items: constrained })
    : { ...shape, items: constrained };
}

function reviewedConfirmationDescription(name: string): string {
  if (name === "create_invoice") {
    return "Set true only after the user authorizes creating a numbered draft, advancing the numbering counter, consuming monthly invoice usage, sending invoice-creation analytics to PostHog's EU-hosted analytics service, possibly creating/linking the client, delivering owner-configured webhooks, notifying eligible workspace admins/accountants, and possibly awarding first-use referral credits.";
  }
  if (name === "create_quote") {
    return "Set true only after the user authorizes creating a numbered draft, advancing the numbering counter, possibly creating/linking the client, and delivering owner-configured webhooks.";
  }
  if (name === "create_expense") {
    return "Set true only after the user authorizes recording the expense on the supplied date and using the explicit deductible classification, possibly creating/linking the vendor in a separate step that may persist if the later expense write fails, delivering owner-configured webhooks, notifying eligible workspace admins/accountants, and possibly awarding first-use referral credits.";
  }
  if (name === "update_expense") {
    return "Set true only after the user authorizes changing the supplied description, category, date, or deductible classification and any accounting or future tax-report effect; amount and supplier identity cannot be changed here, and owner-configured webhooks may receive the resulting business event.";
  }
  if (name === "log_client_activity") {
    return "Set true only after the user authorizes adding this client activity; call, meeting, or email entries update the parent client's latest-activity fields and may deliver a full client.updated event to active owner-configured webhooks, while task entries do not update the parent client.";
  }
  if (name === "delete_quote") {
    return "Set true only after the user authorizes Frihet to permanently delete the quote if it is a clean draft with no delivery, response, attachment, or conversion evidence, or to retain and cancel it when non-draft; a protected draft is refused, and cancellation may deliver a quote-updated event to active owner-configured webhooks.";
  }
  if (REVIEWED_PERMANENT_DELETE_TOOLS.has(name)) {
    return "Set true only after the user authorizes this permanent deletion; it cannot be undone.";
  }
  if (OPENAI_WORKSPACE_WEBHOOK_EVENT_TOOLS.has(name)) {
    return "Set true only after the user authorizes this write; one or more active workspace webhooks may receive the resulting business event.";
  }
  return "Set true only after the user authorizes this change to a Frihet record.";
}

/** Add a required literal confirmation to OpenAI-only mutating schemas. */
function addReviewedConfirmation(schema: unknown, name: string): unknown {
  const confirm = z
    .literal(true)
    .describe(reviewedConfirmationDescription(name));
  if (schema instanceof z.ZodObject) return schema.extend({ confirm });
  if (schema !== null && typeof schema === "object" && !Array.isArray(schema)) {
    return { ...(schema as Record<string, unknown>), confirm };
  }
  return schema;
}

/* ------------------------------------------------------------------ */
/*  Resources excluded / redacted in OpenAI mode                       */
/* ------------------------------------------------------------------ */

/** Dynamic resources excluded — return too much raw PII to safely redact. */
const EXCLUDE_RESOURCES = new Set([
  "overdue-invoices", // Returns up to 100 raw invoice objects with client NIF/CIF
]);

/* ------------------------------------------------------------------ */
/*  CSP for the OpenAI Worker                                          */
/* ------------------------------------------------------------------ */

/**
 * Content-Security-Policy for the OpenAI-safe MCP endpoint.
 * OpenAI requires CSP specifying the exact domains the app fetches from.
 */
export const OPENAI_CSP =
  "default-src 'self'; " +
  "base-uri 'none'; " +
  "object-src 'none'; " +
  "frame-ancestors 'none'; " +
  "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://apis.google.com; " +
  "style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' https://auth.frihet.io https://identitytoolkit.googleapis.com " +
    "https://securetoken.googleapis.com https://www.googleapis.com; " +
  "frame-src https://auth.frihet.io https://accounts.google.com https://github.com https://login.microsoftonline.com; " +
  "img-src 'self' data:; " +
  "font-src 'self'";

/* ------------------------------------------------------------------ */
/*  Profile applicator                                                 */
/* ------------------------------------------------------------------ */

/**
 * Applies the OpenAI-safe profile to an MCP server.
 *
 * Must be called BEFORE registerAllTools() and registerAllResources().
 * Intercepts both registerTool() and registerResource() to apply
 * the profile transformations.
 *
 * @example
 * ```ts
 * const server = new McpServer({ name: "Frihet", version: "1.5.4" });
 * if (process.env.FRIHET_OPENAI_MODE === "true") {
 *   applyOpenAIProfile(server);
 * }
 * registerAllTools(server, client);
 * registerAllResources(server, client);
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyOpenAIProfile(server: any): void {
  installOpenAIToolsListSecurityProjection(server);
  const fieldsToRedact = PROFILE.redactOutputFields;

  /* ── Intercept registerTool ─────────────────────────────────────── */

  const originalRegisterTool = server.registerTool.bind(server);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerTool = (name: string, config: any, handler: any) => {
    // 0. Keep the public ChatGPT app to the reviewed core tool surface
    if (!PROFILE.includeTools.has(name)) return;

    // 1. Skip excluded tools entirely
    if (PROFILE.excludeTools.has(name)) return;

    // 2. Apply the repository-wide capability truth, then merge any
    // OpenAI-specific override. This keeps destructive/idempotent/open-world
    // hints identical across public MCP surfaces.
    config.annotations = correctToolAnnotations(name, config.annotations);
    const annOverrides = PROFILE.annotationOverrides[name];
    if (annOverrides) {
      config.annotations = { ...config.annotations, ...annOverrides };
    }
    config.securitySchemes = OPENAI_OAUTH_SECURITY_SCHEMES.map((scheme) => ({
      type: scheme.type,
      scopes: [...scheme.scopes],
    }));
    config._meta = {
      ...(config._meta ?? {}),
      securitySchemes: config.securitySchemes,
    };

    // 3. Replace descriptions
    const descOverride = PROFILE.descriptionOverrides[name];
    if (descOverride) {
      config.description = descOverride;
    }

    // 3b. Ensure EVERY reviewed tool states an explicit openWorldHint rationale.
    // OpenAI review requires openWorldHint to be explicitly true/false (never null)
    // with a clear justification per tool. The open-world tools already embed a
    // bespoke "[openWorldHint: true — …]" rationale via descriptionOverrides; this
    // appends the closed-world rationale to the remaining reviewed tools so the
    // justification is present for all of them at tools/list. Only mutates the
    // OpenAI-mode description string — annotation booleans (already correct) and the
    // base tool files (used by every other MCP client) are left untouched.
    if (
      typeof config.description === "string" &&
      !config.description.includes("openWorldHint")
    ) {
      const ow = config.annotations?.openWorldHint;
      const openWorldRationale = name === "create_invoice"
        ? "may send invoice analytics to PostHog's EU-hosted analytics service, notify eligible admins/accountants through Novu, award referral credits, and deliver full business events to owner-configured webhook endpoints"
        : name === "create_expense"
          ? "may notify eligible admins/accountants through Novu, may award referral credits, and may deliver full business events to owner-configured webhook endpoints"
          : name === "delete_quote"
            ? "cancelling a non-draft quote may deliver a quote-updated event to owner-configured webhook endpoints"
            : "may deliver one or more resulting business events to owner-configured webhook endpoints";
      const closedWorldRationale = config.annotations?.readOnlyHint === true
        ? " [openWorldHint: false — it only reads the authenticated Frihet workspace.]"
        : " [openWorldHint: false — it only changes data inside the authenticated Frihet workspace.]";
      config.description +=
        ow === true
          ? OPENAI_WORKSPACE_WEBHOOK_EVENT_TOOLS.has(name)
            ? ` Requires confirm=true. [openWorldHint: true — ${openWorldRationale}.]`
            : " [openWorldHint: true — sends email to a recipient outside Frihet.]"
          : closedWorldRationale;
    }

    if (
      PROFILE_INJECTED_CONFIRM_TOOLS.has(name) &&
      typeof config.description === "string" &&
      !/confirm=true/i.test(config.description)
    ) {
      config.description += REVIEWED_PERMANENT_DELETE_TOOLS.has(name)
        ? " Requires confirm=true because the deletion is permanent and cannot be undone."
        : OPENAI_WORKSPACE_WEBHOOK_EVENT_TOOLS.has(name)
          ? " Requires confirm=true before the requested write can run."
          : " Requires confirm=true before this Frihet record change can run.";
    }

    // 4. Strip sensitive input fields
    const inputStrip = PROFILE.stripInputFields[name];
    if (inputStrip && config.inputSchema) {
      config.inputSchema = stripReviewedInputFields(config.inputSchema, inputStrip);
    }
    const requiredInput = PROFILE.requireInputFields[name];
    if (requiredInput && config.inputSchema) {
      config.inputSchema = requireReviewedInputFields(config.inputSchema, requiredInput);
    }
    if (OPENAI_REVIEW_CONFIRM_REQUIRED_TOOLS.has(name) && config.inputSchema) {
      config.inputSchema = addReviewedConfirmation(
        config.inputSchema,
        name,
      );
    }
    const paginationLimit = OPENAI_REVIEW_PAGINATION_LIMITS[name];
    if (paginationLimit !== undefined && config.inputSchema) {
      config.inputSchema = constrainReviewedPagination(config.inputSchema, paginationLimit);
    }
    const textInputLimits = OPENAI_REVIEW_TEXT_INPUT_LIMITS[name];
    if (textInputLimits && config.inputSchema) {
      config.inputSchema = constrainReviewedTextInputs(
        config.inputSchema,
        textInputLimits,
      );
    }
    const warningPaths = OPENAI_REVIEW_FREE_TEXT_WARNING_PATHS[name] ?? [];
    const rootWarningFields = warningPaths.filter((path) => !path.includes("[]"));
    if (rootWarningFields.length > 0) {
      config.inputSchema = warnReviewedRootTextFields(
        config.inputSchema,
        name,
        rootWarningFields,
      );
    }
    if (name === "create_invoice" || name === "create_quote") {
      config.inputSchema = constrainReviewedDocumentLineItems(config.inputSchema, name);
    }
    config.inputSchema = closeReviewedInputSchema(config.inputSchema ?? {});

    // 4a. Strip sensitive fields from the OUTPUT schema descriptor too.
    // The handler wrapper (step 5) redacts VALUES at runtime; this removes the
    // field DECLARATIONS (taxId/secret/iban/…) from the outputSchema advertised
    // at tools/list, so OpenAI review never sees a gov-ID/credential field.
    const reviewedOutputSchema = config.outputSchema
      ? customizeReviewedOutputSchema(
          name,
          buildReviewedOutputSchema(config.outputSchema, fieldsToRedact),
        )
      : undefined;
    if (reviewedOutputSchema) config.outputSchema = reviewedOutputSchema;

    // 5. Wrap the handler to enforce reviewed confirmation, force safe input
    // values, and redact sensitive output fields. Schema validation is not the
    // authorization boundary: the wrapper itself refuses missing/false consent
    // before the underlying handler or API client can run.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrappedHandler = async (input: any) => {
      if (
        OPENAI_REVIEW_CONFIRM_REQUIRED_TOOLS.has(name) &&
        input?.confirm !== true
      ) {
        const consequence = name === "delete_quote"
          ? "A clean draft with no delivery, response, attachment, or conversion evidence is permanently deleted; a protected draft is refused; a non-draft quote is retained and cancelled, and cancellation may deliver a quote-updated event to active endpoints configured by the workspace owner."
          : REVIEWED_PERMANENT_DELETE_TOOLS.has(name)
            ? "This permanently deletes a Frihet record and cannot be undone."
            : OPENAI_WORKSPACE_WEBHOOK_EVENT_TOOLS.has(name)
              ? "This write may deliver one or more business events to active endpoints configured by the workspace owner."
              : "This changes a record in the Frihet workspace.";
        return {
          content: [{
            type: "text" as const,
            text: `Error: confirm=true is required. ${consequence}`,
          }],
          isError: true,
        };
      }

      const missingRequiredInput = (requiredInput ?? []).find(
        (field) => !Object.hasOwn(input ?? {}, field) || input?.[field] === undefined,
      );
      if (missingRequiredInput) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${missingRequiredInput} is required on the reviewed connector so its accounting consequence is explicit.`,
          }],
          isError: true,
        };
      }

      // The real MCP SDK validates against config.inputSchema before calling a
      // handler. Enforce the same contract again here so direct/internal calls
      // cannot bypass min/max/format constraints or smuggle undeclared fields.
      // Known stripped fields are removed first as defense-in-depth; they are
      // never forwarded to the ERP client.
      const validationInput = { ...(input ?? {}) };
      for (const field of inputStrip ?? []) delete validationInput[field];
      const validatedInput = config.inputSchema instanceof z.ZodObject
        ? await config.inputSchema.safeParseAsync(validationInput)
        : { success: true as const, data: validationInput };
      if (!validatedInput.success) {
        const issue = validatedInput.error.issues[0];
        const path = issue?.path.length ? issue.path.join(".") : "input";
        return {
          content: [{
            type: "text" as const,
            text: `Error: invalid reviewed input at ${path}: ${issue?.message ?? "validation failed"}.`,
          }],
          isError: true,
        };
      }

      const handlerInput = { ...validatedInput.data };
      if (paginationLimit !== undefined && handlerInput.limit === undefined) {
        handlerInput.limit = Math.min(
          OPENAI_REVIEW_PAGINATION_DEFAULT,
          paginationLimit,
        );
      }
      if (PROFILE_INJECTED_CONFIRM_TOOLS.has(name)) delete handlerInput.confirm;
      Object.assign(handlerInput, PROFILE_FORCED_INPUT_VALUES[name] ?? {});
      if (
        REVIEWED_NON_EMPTY_PATCH_TOOLS.has(name) &&
        Object.keys(handlerInput).every((field) => field === "id")
      ) {
        return {
          content: [{
            type: "text" as const,
            text: "Error: provide at least one reviewed field to update.",
          }],
          isError: true,
        };
      }
      const result = await handler(handlerInput);

      // A transport/body failure, a 5xx, or an idempotency-in-progress response
      // after a write was sent is ambiguous: the backend may have committed it
      // even though the caller did not receive a usable success response.
      // Convert that internal marker into explicit, fail-closed model guidance.
      // Retrying with a fresh invocation-level idempotency key could otherwise
      // duplicate a record, advance numbering twice, or emit a webhook twice.
      if (
        result.isError === true &&
        config.annotations?.readOnlyHint === false &&
        (
          result._meta?.["io.frihet/operationOutcomeUnknown"] === true
          || result._meta?.["io.frihet/transportOutcomeUnknown"] === true
        )
      ) {
        const vendorResidual = name === "create_expense"
          ? " A vendor created while handling this request may remain even if the expense itself was not created."
          : "";
        return {
          content: [{
            type: "text" as const,
            text: `Frihet could not confirm the result of this write. It may already have completed.${vendorResidual} Do not retry automatically; first verify the record with the corresponding read or list tool.`,
          }],
          isError: true,
          _meta: {
            ...result._meta,
            "io.frihet/retryable": false,
            "io.frihet/operationMayHaveCompleted": true,
          },
        };
      }

      if (result.isError === true && name === "create_expense") {
        for (const block of result.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            block.text += " A vendor created while handling this request may remain even if the expense itself was not created.";
          }
        }
      }

      // Redact structuredContent, then project it through the closed reviewed
      // schema. This allowlist drops every undeclared backend field (including
      // future fields) rather than trying to maintain an exhaustive blacklist.
      if (result.structuredContent) {
        customizeReviewedOutputValue(name, result.structuredContent);
        deepRedact(result.structuredContent, fieldsToRedact);
        if (reviewedOutputSchema instanceof z.ZodType) {
          const projected = await reviewedOutputSchema.safeParseAsync(
            result.structuredContent,
          );
          if (!projected.success) {
            if (config.annotations?.readOnlyHint === false) {
              const operationId = isRecord(result.structuredContent)
                && typeof result.structuredContent.id === "string"
                ? ` Result identifier: ${redactText(result.structuredContent.id, fieldsToRedact)}.`
                : "";
              return {
                content: [{
                  type: "text" as const,
                  text: `Frihet may already have completed this write, but its response did not match the reviewed output contract.${operationId}${name === "create_expense" ? " A vendor created while handling this request may remain even if the expense itself was not created." : ""} Do not retry automatically; verify the record with the corresponding read or list tool.`,
                }],
                isError: true,
                _meta: {
                  "io.frihet/retryable": false,
                  "io.frihet/operationMayHaveCompleted": true,
                },
              };
            }
            return {
              content: [{
                type: "text" as const,
                text: "Frihet could not return this result because it did not match the reviewed output contract.",
              }],
              isError: true,
            };
          }
          result.structuredContent = projected.data;
        }
      }

      // Do not duplicate the full structured payload into the display block.
      // That doubled PII/free text and response size without adding model value.
      // Text-only errors still use the conservative redaction fallback.
      if (Array.isArray(result.content)) {
        const safeStructuredText = result.structuredContent
          ? reviewedStructuredContentSummary(name, result.structuredContent)
          : undefined;
        for (const block of result.content) {
          if (block.type === "text" && typeof block.text === "string") {
            block.text = safeStructuredText ?? redactText(block.text, fieldsToRedact);
          }
        }
      }

      return result;
    };

    return originalRegisterTool(name, config, wrappedHandler);
  };

  /* ── Intercept registerResource ─────────────────────────────────── */

  const originalRegisterResource = server.registerResource.bind(server);

  // registerResource(name, uri, config, handler) — 4 args
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerResource = (name: string, ...rest: any[]) => {
    // Public ChatGPT Apps do not need MCP resources. Several full-server
    // resources contain broad fiscal/compliance reference material or raw
    // workspace lists that are outside the reviewed 33-tool MCP surface.
    if (PROFILE.excludeResources) return;

    // Skip resources that expose too much raw PII
    if (EXCLUDE_RESOURCES.has(name)) return;

    // Find the handler (last argument) and wrap it
    const handler = rest[rest.length - 1];
    if (typeof handler === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rest[rest.length - 1] = async (...args: any[]) => {
        const result = await handler(...args);

        // Resources return { contents: [{ uri, text?, blob? }] }
        if (result?.contents && Array.isArray(result.contents)) {
          for (const content of result.contents) {
            if (typeof content.text === "string") {
              // Parse JSON, redact, re-serialize for clean removal
              try {
                const parsed = JSON.parse(content.text);
                deepRedact(parsed, fieldsToRedact);
                content.text = JSON.stringify(parsed, null, 2);
              } catch {
                // Not JSON — fall back to regex redaction
                content.text = redactText(content.text, fieldsToRedact);
              }
            }
          }
        }

        return result;
      };
    }

    return originalRegisterResource(name, ...rest);
  };

  /* ── Intercept registerPrompt ───────────────────────────────────── */

  if (PROFILE.excludePrompts && typeof server.registerPrompt === "function") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.registerPrompt = (_name: string, ..._rest: any[]) => undefined;
  }
}

/** Number of tools excluded in OpenAI mode (for logging). */
export const OPENAI_EXCLUDED_COUNT = PROFILE.excludeTools.size;

/** Number of tools explicitly allowed in OpenAI mode. */
export const OPENAI_ALLOWED_TOOL_COUNT = PROFILE.includeTools.size;

/** The exact 33-tool allow-list reviewed for the OpenAI connector. */
export const OPENAI_REVIEWED_TOOL_ALLOWLIST: ReadonlySet<string> =
  PROFILE.includeTools;

/**
 * Backwards-compatible helper for tests and gates that capture the exact
 * ChatGPT review profile. The reviewed host deliberately uses full tool
 * descriptions and exposes no grouped discovery meta-tools.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyOpenAIReviewProfiles(server: any): void {
  applyOpenAIProfile(server);
}

/** Number of resources excluded in OpenAI mode (for logging). */
export const OPENAI_EXCLUDED_RESOURCE_COUNT = PROFILE.excludeResources
  ? MCP_RESOURCE_COUNT
  : EXCLUDE_RESOURCES.size;
