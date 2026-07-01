#!/usr/bin/env node
/**
 * Generate the OpenAI-mode scoped OpenAPI spec + asset bundle.
 *
 * Cloudflare Workers Assets serves files in the asset directory DIRECTLY,
 * before the Worker runs — so the openai-mcp host must ship an already-scoped
 * openapi.json rather than filtering at request time. This produces
 * public-openai/ from public/, keeping only the paths/schemas backing the 55
 * reviewed tools and stripping government-ID / banking / credential properties.
 *
 * Mirrors scopeOpenApiForOpenAI() in src/index.ts. Run before `wrangler deploy --env openai`.
 *   node scripts/scope-openai-openapi.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "public");
const OUT = join(root, "public-openai");

const DROP_PATH_PREFIXES = [
  "/v1/channels", "/v1/deposits", "/v1/guests", "/v1/properties",
  "/v1/reservations", "/v1/quarterly", "/webhooks/resend-inbound",
];
const DROP_PATHS_EXACT = new Set([
  "/v1/invoices/{invoiceId}/xml",
  "/v1/expenses/{expenseId}/billable",
  "/v1/quotes/{quoteId}/pdf",
  "/v1/{resource}/batch",
]);
const KEEP_PATHS_EXACT = new Set([
  "/v1/invoices",
  "/v1/invoices/{invoiceId}",
  "/v1/invoices/{invoiceId}/pdf",
  "/v1/invoices/{invoiceId}/send",
  "/v1/invoices/{invoiceId}/paid",
  "/v1/expenses",
  "/v1/expenses/{expenseId}",
  "/v1/clients",
  "/v1/clients/{clientId}",
  "/v1/clients/{clientId}/contacts",
  "/v1/clients/{clientId}/contacts/{contactId}",
  "/v1/clients/{clientId}/activities",
  "/v1/clients/{clientId}/activities/{activityId}",
  "/v1/clients/{clientId}/notes",
  "/v1/clients/{clientId}/notes/{noteId}",
  "/v1/products",
  "/v1/products/{productId}",
  "/v1/quotes",
  "/v1/quotes/{quoteId}",
  "/v1/quotes/{quoteId}/send",
  "/v1/summary",
  "/v1/vendors",
  "/v1/vendors/{vendorId}",
  "/v1/context",
  "/v1/monthly",
  "/v1/search/global",
  "/v1/banking/transactions/{transactionId}/suggestions",
  "/v1/webhooks",
  "/v1/webhooks/{webhookId}",
  "/v1/invoices/{invoiceId}/credit-note",
  "/v1/invoices/{invoiceId}/late-fee",
]);
const DROP_SCHEMAS = new Set([
  "Channel", "ChannelCreate", "ChannelStatus", "Deposit", "DepositCreate", "DepositStatus",
  "Guest", "Property", "PropertyCreate", "PropertyStatus", "Reservation", "ReservationCreate",
  "ReservationStatus", "QuarterlySummary", "BatchResponse", "ReceiptQueueItem", "ResendInboundPayload",
  "FileAttachment", "FileAttachmentInput", "FileAttachmentUpload", "FileAttachmentUploadCreate",
]);
const ALLOWED_TAGS = new Set([
  "Invoices", "Expenses", "Clients", "Products", "Quotes", "Vendors",
  "Summary", "Intelligence", "Search", "Banking", "Webhooks", "Contacts", "Activities", "Notes",
]);
const TAG_DESCRIPTIONS = {
  Invoices: "Create, read, update, send, and manage invoice records.",
  Expenses: "Record and manage business expenses.",
  Clients: "Manage client records with contact details and addresses.",
  Products: "Manage product and service catalogue records with pricing.",
  Quotes: "Create, read, update, send, and manage quotes.",
  Vendors: "Manage vendor records with contact details and addresses.",
  Summary: "Financial dashboard data including revenue, expenses, and profit aggregations.",
  Intelligence: "Business context, global search, and monthly financial summaries.",
  Search: "Read-only search across Frihet records.",
  Banking: "Read-only reconciliation suggestions without creating bank matches.",
  Webhooks: "Manage webhook subscriptions for Frihet business events.",
  Contacts: "Manage contact persons associated with a client.",
  Activities: "Manage client activity timeline entries.",
  Notes: "Manage notes attached to a client.",
};
const STRIP_PROPS = [
  "taxId", "tax_id", "clientTaxId", "client_tax_id", "nif", "cif", "vatNumber", "vat_number", "vatId", "vat_id",
  "documentType", "documentNumber", "signatureCaptured", "passport", "passportNumber",
  "dni", "nationalId", "national_id", "iban", "bankAccount", "bank_account", "accountNumber",
  "secret", "hasSecret", "has_secret", "apiKey", "api_key", "ssn", "socialSecurityNumber", "social_security_number",
  "requestId", "request_id", "traceId", "trace_id", "sessionId", "session_id",
  "userId", "user_id", "verifactuHash", "verifactu_hash", "meta", "security", "attachments",
];

function stripDeep(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) stripDeep(x); return; }
  for (const p of STRIP_PROPS) {
    if (p in node) delete node[p];
  }
  if (node.properties && typeof node.properties === "object") {
    for (const p of STRIP_PROPS) delete node.properties[p];
  }
  if (Array.isArray(node.required)) {
    node.required = node.required.filter((r) => !STRIP_PROPS.includes(r));
  }
  for (const v of Object.values(node)) stripDeep(v);
}

function sanitizeReviewText(text) {
  return text
    .replace(/clientTaxId/gi, "client identifier")
    .replace(/NIF\/CIF\/VAT/gi, "regulated identifiers")
    .replace(/\bNIF\b|\bCIF\b/gi, "regulated identifier")
    .replace(/\bVAT\b/gi, "tax")
    .replace(/\bIBAN\b/gi, "banking identifier")
    .replace(/VeriFactu[^.\n]*/gi, "internal compliance metadata")
    .replace(/Facturae[^.\n]*/gi, "credit-note metadata")
    .replace(/TicketBAI[^.\n]*/gi, "regional e-invoicing metadata")
    .replace(/KSeF[^.\n]*/gi, "e-invoicing metadata")
    .replace(/VIES[^.\n]*/gi, "external tax validation")
    .replace(/Modelo 303/gi, "estimated tax total")
    .replace(/taxId/gi, "regulated identifier")
    .replace(/quarterly tax figures?/gi, "business figures")
    .replace(/tax IDs?/gi, "regulated identifiers")
    .replace(/SHA-256 hash chain integrity[^,.\n]*/gi, "audit history")
    .replace(/Spanish tax compliance/gi, "internal compliance");
}

function addComponentRef(refs, queue, ref) {
  const match = ref.match(/^#\/components\/([^/]+)\/([^/]+)$/);
  if (!match) return;
  const [, section, encodedName] = match;
  const name = decodeURIComponent(encodedName);
  const key = `${section}/${name}`;
  if (!refs.has(key)) {
    refs.set(key, { section, name });
    queue.push({ section, name });
  }
}

function collectComponentRefs(node, refs, queue) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) collectComponentRefs(x, refs, queue); return; }
  if (typeof node.$ref === "string") addComponentRef(refs, queue, node.$ref);
  for (const v of Object.values(node)) collectComponentRefs(v, refs, queue);
}

function pruneUnusedComponents(spec) {
  const refs = new Map();
  const queue = [];
  collectComponentRefs(spec.paths, refs, queue);
  for (let i = 0; i < queue.length; i += 1) {
    const { section, name } = queue[i];
    const component = spec.components?.[section]?.[name];
    collectComponentRefs(component, refs, queue);
  }
  for (const [section, entries] of Object.entries(spec.components ?? {})) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const name of Object.keys(entries)) {
      if (!refs.has(`${section}/${name}`)) delete entries[name];
    }
  }
}

function sanitizeDescriptionsDeep(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) sanitizeDescriptionsDeep(x); return; }
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string") {
      node[key] = sanitizeReviewText(value);
      continue;
    }
    sanitizeDescriptionsDeep(value);
  }
}

const spec = JSON.parse(readFileSync(join(SRC, "openapi.json"), "utf8"));
for (const p of Object.keys(spec.paths ?? {})) {
  const drop = !KEEP_PATHS_EXACT.has(p) ||
    DROP_PATHS_EXACT.has(p) ||
    DROP_PATH_PREFIXES.some((pre) => p === pre || p.startsWith(pre + "/"));
  if (drop) delete spec.paths[p];
}
if (spec.components?.schemas) {
  for (const s of DROP_SCHEMAS) delete spec.components.schemas[s];
}
if (Array.isArray(spec.tags)) {
  spec.tags = spec.tags
    .filter((tag) => ALLOWED_TAGS.has(tag.name))
    .map((tag) => ({
      ...tag,
      description: TAG_DESCRIPTIONS[tag.name] ?? sanitizeReviewText(tag.description ?? ""),
    }));
}
delete spec.security;
if (spec.components?.securitySchemes) delete spec.components.securitySchemes;
stripDeep(spec.paths);
stripDeep(spec.components);
pruneUnusedComponents(spec);
if (spec.info) {
  spec.info.description =
    "Frihet ERP API — ChatGPT connector reviewed surface (invoicing, expenses, clients/CRM, " +
    "products, quotes, vendors, webhooks, global search, reconciliation suggestions, and monthly summaries). Regulated identifiers, " +
    "banking identifiers, credentials, diagnostic metadata, and hidden product modules are excluded.";
  spec.info["x-frihet-openai-profile"] = "chatgpt-reviewed-v2";
}
spec.servers = [{ url: "https://api.frihet.io", description: "Frihet API" }];
sanitizeDescriptionsDeep(spec);

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "openapi.json"), JSON.stringify(spec, null, 2));
let extraAssetText = "";
if (existsSync(join(SRC, "releases.json"))) {
  const sourceReleases = JSON.parse(readFileSync(join(SRC, "releases.json"), "utf8"));
  const openaiReleases = {
    version: sourceReleases.version,
    releasedAt: sourceReleases.releasedAt,
    surface: "openai-chatgpt",
    mcpToolCount: 58,
    reviewedBusinessToolCount: 55,
    discoveryMetaToolCount: 3,
    promptsCount: 0,
    resourcesCount: 0,
    notes:
      "ChatGPT connector metadata is scoped to reviewed invoices, expenses, clients/CRM, products, quotes, vendors, webhooks, global search, read-only reconciliation suggestions, and monthly summaries. Hidden product modules, attachment writes, regulated identifiers, credentials, and diagnostic metadata are excluded.",
    products: {
      mcp_server: {
        status: "live",
        version: sourceReleases.products?.mcp_server?.version ?? sourceReleases.version,
      },
    },
    releases: [
      {
        version: sourceReleases.version,
        releasedAt: sourceReleases.releasedAt,
        mcpToolCount: 58,
        resourcesCount: 0,
        promptsCount: 0,
        delta: "OpenAI ChatGPT scoped connector surface",
        notes:
          "OpenAI mode exposes 55 reviewed business tools plus 3 read-only discovery meta-tools. Prompts, attachment writes, and hidden full-server modules are not part of this surface.",
      },
    ],
  };
  extraAssetText = JSON.stringify(openaiReleases);
  writeFileSync(join(OUT, "releases.json"), `${JSON.stringify(openaiReleases, null, 2)}\n`);
}

const blob = JSON.stringify(spec) + extraAssetText;
const sensitive = [
  "\"taxId\"", "\"clientTaxId\"", "\"hasSecret\"", "HMAC secret", "requestId", "traceId", "sessionId", "\"userId\"", "ApiKeyAuth", "\"apiKey\"",
  "verifactuHash", "documentType", "signatureCaptured", "passport", "\"dni\"", "\"iban\"",
  "\"secret\"", "/guests", "/reservations", "/quarterly", "/properties", "Reservations",
  "Guests", "Channels", "VeriFactu", "Facturae", "TicketBAI", "KSeF",
  "VIES", "Modelo 303", "quarterly tax", "police reports",
]
  .filter((t) => blob.includes(t));
console.log(`scoped openapi.json: ${Object.keys(spec.paths).length} paths (from full spec)`);
console.log(`sensitive/regulated leftovers: ${sensitive.length ? sensitive.join(", ") : "NONE"}`);
if (sensitive.length) { console.error("FAIL: sensitive content remains"); process.exit(1); }
