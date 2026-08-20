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
 * The full MCP server (157 business tools + MCP extras) remains available for Claude, Cursor,
 * Windsurf, Cline, Codex, and all other MCP clients.
 *
 * OpenAI-safe mode: 53 reviewed business tools, 0 prompts, 0 resources, 0 government IDs in I/O.
 * The full MCP surface remains available outside FRIHET_OPENAI_MODE.
 *
 * @see https://developers.openai.com/apps-sdk/app-submission-guidelines
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { MCP_RESOURCE_COUNT } from "./resources/register-all.js";
import { SENSITIVE_FIELD_NAMES, deepRedact, redactText } from "./redaction.js";
import { applyToolExposureProfile } from "./tool-exposure.js";
import { deleteResultOutput } from "./tools/shared.js";

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
  /**
   * Values supplied to the handler on the client's behalf for inputs that were
   * removed by {@link stripInputFields}. Without this, stripping a REQUIRED
   * field turns the tool into a permanent error on the reviewed surface.
   * An explicitly-sent value always wins (defence in depth — the field is not
   * in the advertised schema, so one should never arrive).
   */
  impliedInputValues: Record<string, Record<string, unknown>>;
  /**
   * Per-tool outputSchema replacements. Used to hold the reviewed descriptor at
   * the exact shape OpenAI approved while the base tool widens its output for
   * direct MCP clients. See docs/openai-review-descriptor-freeze.md.
   */
  outputSchemaOverrides: Record<string, unknown>;
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
    "get_monthly_summary",
    "list_invoices",
    "get_invoice",
    "search_invoices",
    "get_invoice_pdf",
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
    "list_webhooks",
    "get_webhook",

    // Create tools
    "create_invoice",
    "duplicate_invoice",
    "create_credit_note",
    "apply_late_fee",
    "create_expense",
    "create_client",
    "create_client_contact",
    "log_client_activity",
    "create_client_note",
    "create_product",
    "create_quote",
    "create_vendor",

    // Update tools
    "update_invoice",
    "mark_invoice_paid",
    "update_expense",
    "update_client",
    "update_product",
    "update_quote",
    "update_vendor",

    // Delete tools
    "delete_invoice",
    "delete_expense",
    "delete_client",
    "delete_client_contact",
    "delete_client_note",
    "delete_product",
    "delete_quote",
    "delete_vendor",
    "delete_webhook",

    // Open-world tools with explicit justifications
    "send_invoice",
    "send_quote",
    "create_webhook",
    "update_webhook",
  ]),

  // ── Tools excluded entirely ─────────────────────────────────────────
  // Return restricted data categories that cannot be adequately redacted.
  excludeTools: new Set([
    "get_quarterly_taxes",  // Modelo 303/130 tax filing data — sensitive fiscal PII
    "get_invoice_einvoice", // EN16931 XML mandatorily contains seller+buyer NIF/CIF
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
    send_invoice:   { openWorldHint: true },
    send_quote:     { openWorldHint: true },
    create_webhook: { openWorldHint: true },
    update_webhook: { openWorldHint: true },
  },

  // ── Description overrides ───────────────────────────────────────────
  // Remove references to stripped fields (taxId, secret, to) and include
  // openWorldHint justifications as required by OpenAI review guidelines.
  descriptionOverrides: {
    list_clients:
      "List all clients/customers with optional pagination. " +
      "Returns contact info and addresses. " +
      "/ Lista todos los clientes con paginacion opcional. " +
      "Devuelve informacion de contacto y direcciones.",

    create_client:
      "Create a new client/customer. Requires at minimum a name. " +
      "Clients are used when creating invoices and quotes. " +
      "Example: name='Acme Corp', email='billing@acme.com', " +
      "address={street:'Main St 1', city:'Madrid', country:'ES'} " +
      "/ Crea un nuevo cliente. Requiere como minimo un nombre.",

    update_client:
      "Update an existing client using PATCH semantics. Only the provided fields will be changed. " +
      "Example: id='abc123', email='new@acme.com', phone='+34600123456' " +
      "/ Actualiza un cliente existente. Solo se modifican los campos proporcionados.",

    list_vendors:
      "List all vendors/suppliers with optional pagination and search. " +
      "Returns contact info and addresses. " +
      "/ Lista todos los proveedores con paginacion y busqueda opcional. " +
      "Devuelve informacion de contacto y direcciones.",

    create_vendor:
      "Create a new vendor/supplier. Requires at minimum a name. " +
      "Vendors are used when tracking expenses and purchase orders. " +
      "Example: name='Office Supplies Ltd', email='billing@office.com', " +
      "address={street:'Gran Via 1', city:'Madrid', country:'ES'} " +
      "/ Crea un nuevo proveedor. Requiere como minimo un nombre.",

    update_vendor:
      "Update an existing vendor using PATCH semantics. Only the provided fields will be changed. " +
      "Example: id='abc123', email='new@supplier.com', phone='+34600123456' " +
      "/ Actualiza un proveedor existente. Solo se modifican los campos proporcionados.",

    // ── FROZEN-DESCRIPTOR DIVERGENCE (delete_invoice / delete_quote / send_invoice) ──
    //
    // These three overrides exist to hold the reviewed ChatGPT descriptor
    // BYTE-IDENTICAL to the frozen snapshot while the base tool files tell the
    // truth to every direct MCP client. An OpenAI app review has been in flight
    // since July and the owner's standing order is not to mutate the reviewed
    // surface mid-review.
    //
    // The freeze only covers what tools/list emits, and in grouped mode that is
    // `[group] firstSentence(description) — full schema via describe_tool(…)`.
    // So the FIRST SENTENCE of each override is pinned byte-identical to the
    // frozen text, and the correction goes in the sentences AFTER it — which
    // flow into describe_tool(), the call ChatGPT makes before invoking, and
    // which is NOT part of the frozen descriptor.
    //
    // Do not "tidy" the first sentence of any of these three. It is a byte
    // contract with src/__tests__/fixtures/openai-review-descriptor.snapshot.json.
    // Full rationale + closing conditions: docs/openai-review-descriptor-freeze.md
    // § "Deliberate divergence — truth-in-descriptions (2026-08-08)".
    delete_invoice:
      "Permanently delete an invoice by its ID. " +
      "IMPORTANT — that is accurate ONLY for a DRAFT invoice. An invoice that has already " +
      "been issued (sent/paid/overdue) is NOT destroyed: the backend CANCELS it " +
      "(status=cancelled) so the VeriFactu hash chain stays intact, and it remains readable " +
      "via get_invoice. The response states which of the two happened — report that to the " +
      "user rather than assuming the record is gone. " +
      "/ IMPORTANTE: solo se elimina una factura en BORRADOR. Una factura emitida/pagada NO " +
      "se destruye: se CANCELA (status=cancelled) para preservar la cadena de hash VeriFactu " +
      "y sigue consultable con get_invoice.",

    delete_quote:
      "Permanently delete a quote by its ID. " +
      "IMPORTANT — that is accurate ONLY for a DRAFT quote. A quote that has already been " +
      "sent/accepted/rejected/expired is NOT destroyed: the backend CANCELS it " +
      "(status=cancelled) and it remains readable via get_quote. The response states which " +
      "of the two happened — report that to the user rather than assuming the record is gone. " +
      "/ IMPORTANTE: solo se elimina un presupuesto en BORRADOR. Uno ya enviado/aceptado NO " +
      "se destruye: se CANCELA (status=cancelled) y sigue consultable con get_quote.",

    send_invoice:
      "Send an invoice to the client via email using the client's stored email address. " +
      "The invoice must exist and should not already be cancelled. " +
      "This delivers mail to a third party outside the workspace and CANNOT be recalled — " +
      "confirm with the user before calling it. " +
      "[openWorldHint: true — triggers email delivery to the client's external email address " +
      "via Frihet's transactional email service] " +
      "/ Envia una factura al cliente por email usando el email almacenado del cliente. " +
      "Llega a un tercero y no se puede anular: confirma con el usuario antes de llamarla.",

    send_quote:
      "Send a quote to the client via email using the client's stored email address. " +
      "The quote must exist and should not already be expired or rejected. " +
      "[openWorldHint: true — triggers email delivery to the client's external email address " +
      "via Frihet's transactional email service] " +
      "/ Envia un presupuesto al cliente por email usando el email almacenado del cliente.",

    create_webhook:
      "Register a new named webhook endpoint. Specify the name, URL, and events to subscribe to. " +
      "Available events: invoice.created, invoice.updated, invoice.paid, " +
      "expense.created, expense.updated, client.created, client.updated, " +
      "quote.created, quote.updated, quote.accepted. " +
      "Example: name='Invoice events', url='https://example.com/webhook', events=['invoice.created','invoice.paid'], status='active' " +
      "[openWorldHint: true — configures Frihet to POST event data to the specified external URL] " +
      "/ Registra un nuevo endpoint de webhook.",

    update_webhook:
      "Update an existing webhook configuration using PATCH semantics. " +
      "Example: id='abc123', status='paused' to pause a webhook. " +
      "[openWorldHint: true — can modify the external URL that receives webhook notifications] " +
      "/ Actualiza la configuracion de un webhook.",
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
    list_clients:   ["fields"],
    list_products:  ["fields"],
    list_quotes:    ["fields"],
    list_vendors:   ["fields"],
    create_invoice: ["clientTaxId"],
    update_invoice: ["clientTaxId"],
    create_quote:   ["clientTaxId"],
    update_quote:   ["clientTaxId"],
    create_client:  ["taxId"],   // NIF/CIF/VAT — government-issued identifier
    update_client:  ["taxId"],
    create_vendor:  ["taxId"],
    update_vendor:  ["taxId"],
    send_invoice:   ["to", "confirm"],
    send_quote:     ["to"],
    create_webhook: ["secret"],  // Signing credential — manage via Frihet web app
    update_webhook: ["secret"],

    // ── FROZEN-DESCRIPTOR DIVERGENCE ────────────────────────────────
    // `confirm` is a NEW required input on the base tools. Adding it to the
    // reviewed inputSchema would break the frozen descriptor mid-review, so it
    // is removed here and supplied by impliedInputValues below.
    //
    // What actually protects the user on each surface:
    //   • direct MCP clients (Claude, Cursor, Cline…) — no destructive-action
    //     UI exists, so `confirm` IS the protection. It stays required there.
    //   • ChatGPT — delete_invoice/delete_quote carry destructiveHint: true, so
    //     the client prompts the user before invoking.
    //   • send_invoice carries destructiveHint: false / openWorldHint: true, so
    //     ChatGPT does NOT prompt. That gap is NOT closed by this divergence and
    //     is recorded as open in docs/openai-review-descriptor-freeze.md.
    delete_invoice: ["confirm"],
    delete_quote:   ["confirm"],
  },

  // ── Implied inputs for stripped-but-required fields ────────────────
  // Stripping a REQUIRED field without supplying it makes the tool a permanent
  // error on the reviewed surface. Pinned by the divergence tests.
  impliedInputValues: {
    delete_invoice: { confirm: true },
    delete_quote:   { confirm: true },
    send_invoice:   { confirm: true },
  },

  // ── Output schemas held at the reviewed shape ──────────────────────
  // delete_invoice/delete_quote widened their base output to `documentDelete-
  // ResultOutput` (it carries `outcome: deleted | cancelled`). That widening is
  // the point of the fix for direct clients, but it drifts the frozen
  // descriptor, so the reviewed surface keeps the exact object that produced
  // the approved bytes. Importing the real `deleteResultOutput` (rather than
  // re-declaring its shape) is deliberate: if it ever changes, the freeze gate
  // fires instead of silently re-approving.
  outputSchemaOverrides: {
    delete_invoice: deleteResultOutput,
    delete_quote:   deleteResultOutput,
  },

  // ── Output fields redacted ─────────────────────────────────────────
  // Stripped from structuredContent and text in ALL tool responses.
  // Single source of truth lives in redaction.ts (shared with observability.ts
  // so Langfuse traces redact the EXACT same field set).
  redactOutputFields: SENSITIVE_FIELD_NAMES,
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
 * Returns a Zod output schema with sensitive fields removed at EVERY depth.
 *
 * Runtime output redaction (deepRedact in the handler wrapper) hides the
 * VALUES, but the advertised `outputSchema` descriptor still DECLARES taxId /
 * secret etc. at tools/list — which OpenAI's submission review auto-detects as
 * exposed government IDs / credentials. This strips them from the descriptor too.
 *
 * Surgical: only the object/array nodes on the path to a sensitive field are
 * rebuilt; untouched branches are returned BY REFERENCE so their `.describe()`
 * metadata and `.passthrough()` behavior are preserved. A schema with no
 * sensitive field anywhere is returned unchanged (identity).
 */
function stripSensitiveOutputSchema(
  schema: unknown,
  fields: readonly string[],
): unknown {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const newShape: Record<string, unknown> = {};
    let changed = false;
    for (const [key, value] of Object.entries(shape)) {
      if (fields.includes(key)) {
        changed = true;
        continue; // drop the sensitive field entirely from the descriptor
      }
      const stripped = stripSensitiveOutputSchema(value, fields);
      if (stripped !== value) changed = true;
      newShape[key] = stripped;
    }
    if (!changed) return schema;

    const base = z.object(newShape as z.ZodRawShape);
    // Zod v4 stores passthrough/strict behavior in `catchall`. Preserve it so
    // redacting one declared field never changes validation of unrelated API
    // fields. The previous implementation inspected Zod v3's `_def.typeName`,
    // which is absent in v4 and silently returned the original schema.
    const catchall = schema._def.catchall;
    let rebuilt: z.ZodTypeAny;
    if (catchall instanceof z.ZodUnknown) rebuilt = base.passthrough();
    else if (catchall instanceof z.ZodNever) rebuilt = base.strict();
    else if (catchall) rebuilt = base.catchall(catchall);
    else rebuilt = base;

    if (typeof schema.description === "string") rebuilt = rebuilt.describe(schema.description);
    return rebuilt;
  }

  if (schema instanceof z.ZodArray) {
    const inner = schema.element;
    const stripped = stripSensitiveOutputSchema(inner, fields);
    if (stripped === inner) return schema;
    let rebuilt: z.ZodTypeAny = z.array(stripped as z.ZodTypeAny);
    if (typeof schema.description === "string") rebuilt = rebuilt.describe(schema.description);
    return rebuilt;
  }

  if (schema instanceof z.ZodOptional) {
    const inner = schema.unwrap();
    const stripped = stripSensitiveOutputSchema(inner, fields);
    return stripped === inner ? schema : z.optional(stripped as z.ZodTypeAny);
  }

  if (schema instanceof z.ZodNullable) {
    const inner = schema.unwrap();
    const stripped = stripSensitiveOutputSchema(inner, fields);
    return stripped === inner ? schema : z.nullable(stripped as z.ZodTypeAny);
  }

  // Primitives, unions, records, and anything else: leave untouched.
  return schema;
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
  "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://apis.google.com; " +
  "style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' https://api.frihet.io https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net " +
    "https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://www.gstatic.com; " +
  "frame-src https://accounts.google.com https://github.com https://login.microsoftonline.com; " +
  "img-src 'self' data: https:; " +
  "font-src 'self' https://www.frihet.io";

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
  const fieldsToRedact = PROFILE.redactOutputFields;

  /* ── Intercept registerTool ─────────────────────────────────────── */

  const originalRegisterTool = server.registerTool.bind(server);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerTool = (name: string, config: any, handler: any) => {
    // 0. Keep the public ChatGPT app to the reviewed core tool surface
    if (!PROFILE.includeTools.has(name)) return;

    // 1. Skip excluded tools entirely
    if (PROFILE.excludeTools.has(name)) return;

    // 2. Merge annotation overrides
    const annOverrides = PROFILE.annotationOverrides[name];
    if (annOverrides) {
      config.annotations = { ...config.annotations, ...annOverrides };
    }

    // 3. Replace descriptions
    const descOverride = PROFILE.descriptionOverrides[name];
    if (descOverride) {
      config.description = descOverride;
    }

    // 3b. Ensure EVERY reviewed tool states an explicit openWorldHint rationale.
    // OpenAI review requires openWorldHint to be explicitly true/false (never null)
    // with a clear justification per tool. The 4 open-world tools already embed a
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
      config.description +=
        ow === true
          ? " [openWorldHint: true — contacts an entity outside Frihet (an email recipient or an external webhook URL).]"
          : " [openWorldHint: false — operates only against the Frihet API (api.frihet.io); no third-party/external calls.]";
    }

    // 4. Strip sensitive input fields
    const inputStrip = PROFILE.stripInputFields[name];
    if (inputStrip && config.inputSchema) {
      config.inputSchema = stripReviewedInputFields(config.inputSchema, inputStrip);
    }

    // 4a. Hold the reviewed outputSchema at the approved shape where the base
    // tool has widened it. Runs BEFORE 4b so the override is still subject to
    // sensitive-field stripping (a future override can never smuggle a
    // gov-ID/credential declaration past the contract gate).
    const outputOverride = PROFILE.outputSchemaOverrides[name];
    if (outputOverride) {
      config.outputSchema = outputOverride;
    }

    // 4b. Strip sensitive fields from the OUTPUT schema descriptor too.
    // The handler wrapper (step 5) redacts VALUES at runtime; this removes the
    // field DECLARATIONS (taxId/secret/iban/…) from the outputSchema advertised
    // at tools/list, so OpenAI review never sees a gov-ID/credential field.
    if (config.outputSchema) {
      config.outputSchema = stripSensitiveOutputSchema(config.outputSchema, fieldsToRedact);
    }

    // 5. Wrap handler to redact sensitive output fields, and to re-supply any
    // REQUIRED input that step 4 removed from the advertised schema.
    const implied = PROFILE.impliedInputValues[name];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrappedHandler = async (input: any) => {
      const result = await handler(implied ? { ...implied, ...input } : input);

      // Redact structuredContent (programmatic output)
      if (result.structuredContent) {
        deepRedact(result.structuredContent, fieldsToRedact);
      }

      // Best-effort redact text content (display output)
      if (Array.isArray(result.content)) {
        for (const block of result.content) {
          if (block.type === "text" && typeof block.text === "string") {
            block.text = redactText(block.text, fieldsToRedact);
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
    // workspace lists that are outside the reviewed 53-tool business surface.
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

/**
 * The reviewed OpenAI tool allow-list (the 53 business tools), exposed read-only
 * so the grouped tool-exposure profile can pin its catalog to EXACTLY this set
 * when the two profiles are composed on openai-mcp.frihet.io. The progressive-
 * disclosure meta-tools (search_tools / describe_tool / list_tool_groups) must
 * never surface a tool outside this allow-list; passing it as the grouped
 * `allowlist` enforces that statically. This is the SAME object used to gate
 * registerTool, so the two can never drift apart.
 *
 * NOTE: this is the 53 BUSINESS tools only. It deliberately does NOT contain the
 * 3 grouped meta-tools — those are registered directly on the real server
 * (bypassing the OpenAI gate) by applyToolExposureProfile when it runs first, so
 * OPENAI_ALLOWED_TOOL_COUNT (and every advertised "53 reviewed tools" doc) stays
 * correct while the live tools/list still materialises 53 + 3 = 56 tools.
 */
export const OPENAI_REVIEWED_TOOL_ALLOWLIST: ReadonlySet<string> =
  PROFILE.includeTools;

/**
 * Apply the exact profile composition used by the ChatGPT review Worker.
 *
 * Keep this helper as the single source for the security-sensitive ordering:
 * grouped exposure first (with the frozen allow-list), OpenAI profile second.
 * Tool registration happens afterwards through registerAllTools().
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyOpenAIReviewProfiles(server: any): void {
  applyToolExposureProfile(server, {
    allowlist: OPENAI_REVIEWED_TOOL_ALLOWLIST,
  });
  applyOpenAIProfile(server);
}

/** Number of resources excluded in OpenAI mode (for logging). */
export const OPENAI_EXCLUDED_RESOURCE_COUNT = PROFILE.excludeResources
  ? MCP_RESOURCE_COUNT
  : EXCLUDE_RESOURCES.size;
