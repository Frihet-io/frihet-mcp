type OpenApiDocument = Record<string, unknown> & {
  openapi: string;
  paths: Record<string, unknown>;
};

const OPENAPI_ROOT_KEYS = new Set([
  "openapi", "info", "servers", "security", "tags", "paths", "components",
]);
const PATH_ITEM_KEYS = new Set([
  "$ref", "summary", "description", "get", "put", "post", "delete", "options",
  "head", "patch", "trace", "servers", "parameters",
]);
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

const OPENAI_DROP_PATH_PREFIXES = [
  "/v1/channels", "/v1/deposits", "/v1/guests", "/v1/properties",
  "/v1/reservations", "/v1/quarterly", "/webhooks/resend-inbound",
];
const OPENAI_DROP_PATHS_EXACT = new Set([
  "/v1/invoices/{invoiceId}/xml",
  "/v1/expenses/{expenseId}/billable",
  "/v1/quotes/{quoteId}/pdf",
  "/v1/{resource}/batch",
]);
const OPENAI_KEEP_PATHS_EXACT = new Set([
  "/v1/invoices", "/v1/invoices/{invoiceId}", "/v1/invoices/{invoiceId}/pdf",
  "/v1/invoices/{invoiceId}/send", "/v1/invoices/{invoiceId}/paid", "/v1/expenses",
  "/v1/expenses/{expenseId}", "/v1/clients", "/v1/clients/{clientId}",
  "/v1/clients/{clientId}/contacts", "/v1/clients/{clientId}/contacts/{contactId}",
  "/v1/clients/{clientId}/activities", "/v1/clients/{clientId}/activities/{activityId}",
  "/v1/clients/{clientId}/notes", "/v1/clients/{clientId}/notes/{noteId}",
  "/v1/products", "/v1/products/{productId}", "/v1/quotes", "/v1/quotes/{quoteId}",
  "/v1/quotes/{quoteId}/send", "/v1/summary", "/v1/vendors", "/v1/vendors/{vendorId}",
  "/v1/context", "/v1/monthly", "/v1/webhooks", "/v1/webhooks/{webhookId}",
  "/v1/invoices/{invoiceId}/credit-note", "/v1/invoices/{invoiceId}/late-fee",
]);
const OPENAI_DROP_SCHEMAS = new Set([
  "Channel", "ChannelCreate", "ChannelStatus", "Deposit", "DepositCreate", "DepositStatus",
  "Guest", "Property", "PropertyCreate", "PropertyStatus", "Reservation", "ReservationCreate",
  "ReservationStatus", "QuarterlySummary", "BatchResponse", "ReceiptQueueItem", "ResendInboundPayload",
]);
const OPENAI_ALLOWED_TAGS = new Set([
  "Invoices", "Expenses", "Clients", "Products", "Quotes", "Vendors",
  "Summary", "Intelligence", "Webhooks", "Contacts", "Activities", "Notes",
]);
const OPENAI_TAG_DESCRIPTIONS: Record<string, string> = {
  Invoices: "Create, read, update, send, and manage invoice records.",
  Expenses: "Record and manage business expenses.",
  Clients: "Manage client records with contact details and addresses.",
  Products: "Manage product and service catalogue records with pricing.",
  Quotes: "Create, read, update, send, and manage quotes.",
  Vendors: "Manage vendor records with contact details and addresses.",
  Summary: "Financial dashboard data including revenue, expenses, and profit aggregations.",
  Intelligence: "Business context and monthly financial summaries.",
  Webhooks: "Manage webhook subscriptions for Frihet business events.",
  Contacts: "Manage contact persons associated with a client.",
  Activities: "Manage client activity timeline entries.",
  Notes: "Manage notes attached to a client.",
};
const OPENAI_STRIP_PROPS = [
  "taxId", "tax_id", "clientTaxId", "client_tax_id", "nif", "cif", "vatNumber", "vat_number", "vatId", "vat_id",
  "documentType", "documentNumber", "signatureCaptured", "passport", "passportNumber",
  "dni", "nationalId", "national_id", "iban", "bankAccount", "bank_account", "accountNumber",
  "secret", "hasSecret", "has_secret", "apiKey", "api_key", "ssn", "socialSecurityNumber", "social_security_number",
  "requestId", "request_id", "traceId", "trace_id", "sessionId", "session_id",
  "userId", "user_id", "verifactuHash", "verifactu_hash", "meta", "security",
];

export function assertValidOpenApiDocument(
  spec: unknown,
  stage: "source" | "scoped",
): asserts spec is OpenApiDocument {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(`Invalid ${stage} OpenAPI document`);
  }
  const record = spec as Record<string, unknown>;
  if (typeof record.openapi !== "string" || !/^3\.\d+\.\d+$/u.test(record.openapi)) {
    throw new Error(`Invalid ${stage} OpenAPI version`);
  }
  if (!record.paths || typeof record.paths !== "object" || Array.isArray(record.paths)) {
    throw new Error(`Invalid ${stage} OpenAPI paths`);
  }
  if (Object.keys(record.paths).length === 0) {
    throw new Error(`Empty ${stage} OpenAPI paths`);
  }
  for (const key of Object.keys(record)) {
    if (!OPENAPI_ROOT_KEYS.has(key)) throw new Error(`Unexpected ${stage} OpenAPI root field`);
  }
  if (!record.info || typeof record.info !== "object" || Array.isArray(record.info)) {
    throw new Error(`Invalid ${stage} OpenAPI info`);
  }
  if (record.components !== undefined
    && (!record.components || typeof record.components !== "object" || Array.isArray(record.components))) {
    throw new Error(`Invalid ${stage} OpenAPI components`);
  }
  for (const field of ["tags", "servers", "security"] as const) {
    if (record[field] !== undefined && !Array.isArray(record[field])) {
      throw new Error(`Invalid ${stage} OpenAPI ${field}`);
    }
  }
  for (const [path, item] of Object.entries(record.paths as Record<string, unknown>)) {
    if (!path.startsWith("/") || !item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Invalid ${stage} OpenAPI path item`);
    }
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (!PATH_ITEM_KEYS.has(key)) throw new Error(`Invalid ${stage} OpenAPI path field`);
      if (HTTP_METHODS.has(key) && (!value || typeof value !== "object" || Array.isArray(value))) {
        throw new Error(`Invalid ${stage} OpenAPI operation`);
      }
      if ((key === "parameters" || key === "servers") && !Array.isArray(value)) {
        throw new Error(`Invalid ${stage} OpenAPI path collection`);
      }
      if ((key === "$ref" || key === "summary" || key === "description") && typeof value !== "string") {
        throw new Error(`Invalid ${stage} OpenAPI path text`);
      }
    }
  }
}

export function parseOpenApiDocument(specText: string): OpenApiDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(specText);
  } catch {
    throw new Error("Invalid source OpenAPI JSON");
  }
  assertValidOpenApiDocument(parsed, "source");
  return parsed;
}

export function openApiUnavailableResponse(
  securityHeaders: Readonly<Record<string, string>> = {},
): Response {
  return new Response(
    JSON.stringify({ error: "OpenAPI spec temporarily unavailable" }),
    {
      status: 502,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...securityHeaders,
      },
    },
  );
}

function stripSensitivePropsDeep(node: unknown): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) stripSensitivePropsDeep(item);
    return;
  }
  const record = node as Record<string, unknown>;
  for (const property of OPENAI_STRIP_PROPS) delete record[property];
  if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
    for (const property of OPENAI_STRIP_PROPS) {
      delete (record.properties as Record<string, unknown>)[property];
    }
  }
  if (Array.isArray(record.required)) {
    record.required = record.required.filter(
      (property): property is string => typeof property === "string" && !OPENAI_STRIP_PROPS.includes(property),
    );
  }
  for (const value of Object.values(record)) stripSensitivePropsDeep(value);
}

function sanitizeOpenAIReviewText(text: string): string {
  return text
    .replace(/clientTaxId/giu, "client identifier")
    .replace(/NIF\/CIF\/VAT/giu, "regulated identifiers")
    .replace(/\bNIF\b|\bCIF\b/giu, "regulated identifier")
    .replace(/\bVAT\b/giu, "tax")
    .replace(/\bIBAN\b/giu, "banking identifier")
    .replace(/VeriFactu[^.\n]*/giu, "internal compliance metadata")
    .replace(/Facturae[^.\n]*/giu, "credit-note metadata")
    .replace(/TicketBAI[^.\n]*/giu, "regional e-invoicing metadata")
    .replace(/KSeF[^.\n]*/giu, "e-invoicing metadata")
    .replace(/VIES[^.\n]*/giu, "external tax validation")
    .replace(/Modelo 303/giu, "estimated tax total")
    .replace(/taxId/giu, "regulated identifier")
    .replace(/quarterly tax figures?/giu, "business figures")
    .replace(/tax IDs?/giu, "regulated identifiers")
    .replace(/SHA-256 hash chain integrity[^,.\n]*/giu, "audit history")
    .replace(/Spanish tax compliance/giu, "internal compliance");
}

function addOpenAIComponentRef(
  refs: Map<string, { section: string; name: string }>,
  queue: Array<{ section: string; name: string }>,
  ref: string,
): void {
  const match = ref.match(/^#\/components\/([^/]+)\/([^/]+)$/u);
  if (!match) return;
  const section = match[1]!;
  const name = decodeURIComponent(match[2]!);
  const key = `${section}/${name}`;
  if (!refs.has(key)) {
    refs.set(key, { section, name });
    queue.push({ section, name });
  }
}

function collectOpenAIComponentRefs(
  node: unknown,
  refs: Map<string, { section: string; name: string }>,
  queue: Array<{ section: string; name: string }>,
): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectOpenAIComponentRefs(item, refs, queue);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.$ref === "string") addOpenAIComponentRef(refs, queue, record.$ref);
  for (const value of Object.values(record)) collectOpenAIComponentRefs(value, refs, queue);
}

function pruneUnusedOpenAIComponents(spec: Record<string, unknown>): void {
  const refs = new Map<string, { section: string; name: string }>();
  const queue: Array<{ section: string; name: string }> = [];
  collectOpenAIComponentRefs(spec.paths, refs, queue);
  const components = spec.components && typeof spec.components === "object" && !Array.isArray(spec.components)
    ? spec.components as Record<string, unknown>
    : {};
  for (let index = 0; index < queue.length; index += 1) {
    const { section, name } = queue[index]!;
    const entries = components[section];
    const component = entries && typeof entries === "object" && !Array.isArray(entries)
      ? (entries as Record<string, unknown>)[name]
      : undefined;
    collectOpenAIComponentRefs(component, refs, queue);
  }
  for (const [section, entries] of Object.entries(components)) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const name of Object.keys(entries)) {
      if (!refs.has(`${section}/${name}`)) delete (entries as Record<string, unknown>)[name];
    }
  }
}

function sanitizeOpenAIDescriptionsDeep(node: unknown): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) sanitizeOpenAIDescriptionsDeep(item);
    return;
  }
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") record[key] = sanitizeOpenAIReviewText(value);
    else sanitizeOpenAIDescriptionsDeep(value);
  }
}

export function scopeOpenApiForOpenAI(specText: string): string {
  const spec = parseOpenApiDocument(specText);
  for (const path of Object.keys(spec.paths)) {
    const drop = !OPENAI_KEEP_PATHS_EXACT.has(path)
      || OPENAI_DROP_PATHS_EXACT.has(path)
      || OPENAI_DROP_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    if (drop) delete spec.paths[path];
  }
  const components = spec.components && typeof spec.components === "object" && !Array.isArray(spec.components)
    ? spec.components as Record<string, unknown>
    : undefined;
  const schemas = components?.schemas && typeof components.schemas === "object" && !Array.isArray(components.schemas)
    ? components.schemas as Record<string, unknown>
    : undefined;
  if (schemas) for (const schema of OPENAI_DROP_SCHEMAS) delete schemas[schema];
  if (Array.isArray(spec.tags)) {
    spec.tags = spec.tags
      .filter((tag): tag is Record<string, unknown> => !!tag && typeof tag === "object" && !Array.isArray(tag)
        && typeof (tag as Record<string, unknown>).name === "string"
        && OPENAI_ALLOWED_TAGS.has((tag as Record<string, unknown>).name as string))
      .map((tag) => {
        const name = tag.name as string;
        return {
          ...tag,
          description: OPENAI_TAG_DESCRIPTIONS[name]
            ?? sanitizeOpenAIReviewText(typeof tag.description === "string" ? tag.description : ""),
        };
      });
  }
  delete spec.security;
  if (components) delete components.securitySchemes;
  stripSensitivePropsDeep(spec.paths);
  stripSensitivePropsDeep(components);
  pruneUnusedOpenAIComponents(spec);
  if (spec.info && typeof spec.info === "object" && !Array.isArray(spec.info)) {
    const info = spec.info as Record<string, unknown>;
    info.description =
      "Frihet ERP API — ChatGPT connector reviewed surface (invoicing, expenses, clients/CRM, products, quotes, vendors, webhooks, and monthly summaries). " +
      "Regulated identifiers, banking identifiers, credentials, diagnostic metadata, and hidden product modules are excluded.";
    info["x-frihet-openai-profile"] = "chatgpt-reviewed-v2";
  }
  spec.servers = [{ url: "https://api.frihet.io", description: "Frihet API" }];
  sanitizeOpenAIDescriptionsDeep(spec);
  assertValidOpenApiDocument(spec, "scoped");
  return JSON.stringify(spec);
}

export async function serveOpenApiAsset(
  assetResponse: Response,
  openai: boolean,
  securityHeaders: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const headers = new Headers(securityHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  if (!openai) return new Response(assetResponse.body, { status: 200, headers });
  try {
    return new Response(scopeOpenApiForOpenAI(await assetResponse.text()), { status: 200, headers });
  } catch {
    return openApiUnavailableResponse(securityHeaders);
  }
}
