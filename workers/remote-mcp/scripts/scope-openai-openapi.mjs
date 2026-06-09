#!/usr/bin/env node
/**
 * Generate the OpenAI-mode scoped OpenAPI spec + asset bundle.
 *
 * Cloudflare Workers Assets serves files in the asset directory DIRECTLY,
 * before the Worker runs — so the openai-mcp host must ship an already-scoped
 * openapi.json rather than filtering at request time. This produces
 * public-openai/ from public/, keeping only the paths/schemas backing the 53
 * reviewed tools and stripping government-ID / banking / credential properties.
 *
 * Mirrors scopeOpenApiForOpenAI() in src/index.ts. Run before `wrangler deploy --env openai`.
 *   node scripts/scope-openai-openapi.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
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
const DROP_SCHEMAS = new Set([
  "Channel", "ChannelCreate", "ChannelStatus", "Deposit", "DepositCreate", "DepositStatus",
  "Guest", "Property", "PropertyCreate", "PropertyStatus", "Reservation", "ReservationCreate",
  "ReservationStatus", "QuarterlySummary", "BatchResponse", "ReceiptQueueItem", "ResendInboundPayload",
]);
const STRIP_PROPS = [
  "taxId", "tax_id", "nif", "cif", "vatNumber", "vat_number", "vatId", "vat_id",
  "documentType", "documentNumber", "signatureCaptured", "passport", "passportNumber",
  "dni", "nationalId", "national_id", "iban", "bankAccount", "bank_account", "accountNumber",
  "secret", "apiKey", "api_key", "ssn", "socialSecurityNumber", "social_security_number",
];

function stripDeep(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) stripDeep(x); return; }
  if (node.properties && typeof node.properties === "object") {
    for (const p of STRIP_PROPS) delete node.properties[p];
  }
  if (Array.isArray(node.required)) {
    node.required = node.required.filter((r) => !STRIP_PROPS.includes(r));
  }
  for (const v of Object.values(node)) stripDeep(v);
}

const spec = JSON.parse(readFileSync(join(SRC, "openapi.json"), "utf8"));
for (const p of Object.keys(spec.paths ?? {})) {
  const drop = DROP_PATHS_EXACT.has(p) ||
    DROP_PATH_PREFIXES.some((pre) => p === pre || p.startsWith(pre + "/"));
  if (drop) delete spec.paths[p];
}
if (spec.components?.schemas) {
  for (const s of DROP_SCHEMAS) delete spec.components.schemas[s];
}
stripDeep(spec.paths);
stripDeep(spec.components);
if (spec.info) {
  spec.info.description =
    "Frihet ERP API — ChatGPT connector reviewed surface (invoicing, expenses, clients/CRM, " +
    "products, quotes, vendors, webhooks). Government tax identifiers, banking identifiers, " +
    "and credentials are excluded.";
}
spec.servers = [{ url: "https://api.frihet.io", description: "Frihet API" }];

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "openapi.json"), JSON.stringify(spec, null, 2));
if (existsSync(join(SRC, "releases.json"))) copyFileSync(join(SRC, "releases.json"), join(OUT, "releases.json"));

const blob = JSON.stringify(spec);
const sensitive = ["\"taxId\"", "documentType", "signatureCaptured", "/guests", "/reservations", "/quarterly", "/properties"]
  .filter((t) => blob.includes(t));
console.log(`scoped openapi.json: ${Object.keys(spec.paths).length} paths (from full spec)`);
console.log(`sensitive/regulated leftovers: ${sensitive.length ? sensitive.join(", ") : "NONE"}`);
if (sensitive.length) { console.error("FAIL: sensitive content remains"); process.exit(1); }
