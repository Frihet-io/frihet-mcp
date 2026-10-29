/**
 * Candidate 1.0.3 capability expansion for the Frihet ChatGPT (OpenAI) profile.
 *
 * Developed in isolation (branch `feat/openai-1.0.3-candidate`) without mutating
 * the live 1.0.2 production endpoint (`https://openai-mcp.frihet.io/mcp`, 33 tools).
 *
 * Exposes four read-only operational intelligence & commercial-search capabilities
 * (expanding the surface from 33 to 37 tools):
 * 1. `get_daily_operational_brief` — Prioritized daily brief with record provenance
 * 2. `get_business_period_summary` — Period & month-over-month comparison by currency
 * 3. `search_clients` — Multi-page commercial-name client search with ambiguity & coverage truth
 * 4. `search_vendors` — Multi-page commercial-name vendor search with ambiguity & coverage truth
 *
 * Architectural note on `update_draft_invoice` (excluded from 1.0.3):
 * Inspection of `Frihet-ERP/functions/src/publicApi.ts:10175-10350` (`updateResource`)
 * shows that an MCP-only pre-flight (`getInvoice` + `updateInvoice`) is NOT atomic
 * end-to-end:
 * - `PATCH /v1/invoices/:id` runs a Firestore transaction (`db.runTransaction`),
 *   but does not accept an `expectedStatus: "draft"` or `expectedUpdatedAt`
 *   precondition inside that transaction.
 * - `documentNumber` is assigned at draft creation (`POST /v1/invoices`), so
 *   `expectedDocumentNumber` is not a revision token.
 * - If a concurrent session transitions a draft invoice to `'sent'` (prior to
 *   `verifactu.hash` or `documentNumberFinal`) between the MCP's `GET` and `PATCH`,
 *   sending `{ status: "draft", ... }` is permitted by `publicApi.ts:10323-10333`,
 *   which would demote an unhashed `'sent'` invoice back to `'draft'`.
 * Therefore, draft editing is intentionally kept outside 1.0.3 until the ERP
 * backend enforces `ifStatus === "draft"` + `ifUpdatedAt` inside `updateResource`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import {
  withToolLogging,
  getContent,
  formatRecord,
  READ_ONLY_ANNOTATIONS,
} from "./shared.js";
import {
  generateDailyOperationalBrief,
  resolveDocumentAmount,
  type ProvenancedAmount,
} from "../workflows/daily-operational-brief.js";
import { OPENAI_REVIEW_FREE_TEXT_WARNING } from "../openai-profile.js";

const CALENDAR_MONTH_REGEX = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const CLIENT_SEARCH_SERVER_PROJECTION = "id,name,stage,email,phone" as const;
export const VENDOR_SEARCH_SERVER_PROJECTION = "id,name,email,phone" as const;

const LEGAL_SUFFIX_STOPWORDS = new Set([
  "sl",
  "slu",
  "sa",
  "sau",
  "sll",
  "scp",
  "cb",
  "coop",
  "inc",
  "llc",
  "ltd",
  "gmbh",
  "bv",
  "sarl",
  "sas",
  "plc",
  "corp",
]);

function isSingleTokenGovernmentId(token: string): boolean {
  const compact = token.replace(/[\s.\-:/,()]+/g, "").toUpperCase();
  if (compact.length < 7 || compact.length > 15) return false;
  // Bare 7..11 digit sequence (e.g. 8-digit Spanish DNI/NIF stem)
  if (/^[0-9]{7,11}$/.test(compact)) return true;
  // Spanish NIF (8 digits + letter), NIE (X/Y/Z + 7 digits + letter), CIF (letter + 7 digits + control)
  if (/^[0-9]{8}[A-Z]$/.test(compact)) return true;
  if (/^[XYZ][0-9]{7}[A-Z]$/.test(compact)) return true;
  if (/^[ABCDEFGHJNPQRSUVW][0-9]{7}[0-9A-J]$/.test(compact)) return true;
  // Partial CIF/NIE stem (letter + 6..7 digits)
  if (/^[ABCDEFGHJNPQRSUVWXYZ][0-9]{6,7}$/.test(compact)) return true;
  // EU VAT prefix + 7..12 alphanumeric with at least 5 digits
  if (/^[A-Z]{2}[A-Z0-9]{7,12}$/.test(compact) && (compact.match(/[0-9]/g)?.length ?? 0) >= 5) {
    return true;
  }
  return false;
}

/**
 * Rejects queries that look like Spanish NIF/NIE/CIF or EU VAT numbers
 * (including labeled forms like "NIF: B87654321" or numeric stems) so
 * name-only search tools can never be used as government-ID lookup oracles.
 */
export function isLikelyGovernmentIdQuery(raw: string): boolean {
  const withoutLabel = raw.replace(/^\s*(?:nif|nie|cif|vat|tax\s*id|id\s*fiscal)\s*[:#\-/]?\s*/i, "");
  if (isSingleTokenGovernmentId(withoutLabel)) return true;
  const tokens = withoutLabel.split(/[\s,;:/()]+/).filter(Boolean);
  return tokens.some((t) => isSingleTokenGovernmentId(t));
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type NameMatchRank = "exact" | "prefix" | "token" | "substring";

export function matchCommercialName(
  candidateName: unknown,
  rawQuery: string,
): { matched: boolean; rank?: NameMatchRank; score: number } {
  if (typeof candidateName !== "string" || !candidateName.trim()) {
    return { matched: false, score: 0 };
  }
  const normName = normalizeSearchText(candidateName);
  const normQuery = normalizeSearchText(rawQuery);
  if (!normName || !normQuery) {
    return { matched: false, score: 0 };
  }
  if (normName === normQuery) {
    return { matched: true, rank: "exact", score: 100 };
  }
  const queryTokens = normQuery.split(" ").filter(Boolean);
  const nonStopwordQueryTokens = queryTokens.filter((t) => !LEGAL_SUFFIX_STOPWORDS.has(t));
  if (nonStopwordQueryTokens.length === 0 || nonStopwordQueryTokens.every((t) => t.length < 2)) {
    return { matched: false, score: 0 };
  }
  // Whole-word prefix at start of commercial name (e.g. "Acme" in "Acme Iberia SL")
  if (normName.startsWith(`${normQuery} `)) {
    return { matched: true, rank: "prefix", score: 85 };
  }
  const nameTokens = normName.split(" ").filter(Boolean);
  if (
    queryTokens.length > 0 &&
    queryTokens.every((qt) => nameTokens.some((nt) => nt === qt || (qt.length >= 2 && nt.startsWith(qt))))
  ) {
    return { matched: true, rank: "token", score: 70 };
  }
  if (normQuery.length >= 3 && normName.includes(normQuery)) {
    return { matched: true, rank: "substring", score: 50 };
  }
  return { matched: false, score: 0 };
}

function lastCalendarDayOfMonth(period: string): string {
  const m = CALENDAR_MONTH_REGEX.exec(period);
  if (!m) throw new Error(`Invalid period format: ${period}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(lastDay).padStart(2, "0")}`;
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function approxJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? {}), "utf8");
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/*  Closed Zod Output Schemas (JSON-safe primitives only)              */
/* ------------------------------------------------------------------ */

const currencyBucketSchema = z.object({
  currency: z.string().describe("ISO currency code (e.g. EUR, USD)"),
  amount: z.number().describe("Aggregated amount in this currency"),
  documentCount: z.number().int().nonnegative().describe("Documents contributing to this bucket"),
  provenance: z.enum(["stored_field", "derived_from_items"]).describe("How the bucket total was obtained"),
});

const provenancedAmountSchema = z.object({
  amount: z.number().nullable().describe("Scalar amount when single-currency and determinable; null when MIXED or unavailable"),
  currency: z.string().describe("ISO currency code or 'MIXED' when multiple currencies are present"),
  provenance: z.enum([
    "stored_field",
    "derived_from_items",
    "business_context_summary",
    "unavailable",
    "mixed_currency_unconverted",
  ]).describe("Amount provenance classification"),
  fieldOrFormula: z.string().describe("Source field or canonical formula used"),
  totalsByCurrency: z.array(currencyBucketSchema).describe("Per-currency breakdown without cross-currency conversion"),
  unavailableCount: z.number().int().nonnegative().describe("Documents excluded because their amount could not be determined"),
});

function serializeProvenancedAmount(p: ProvenancedAmount): z.infer<typeof provenancedAmountSchema> {
  const buckets = p.totalsByCurrency
    ? Object.values(p.totalsByCurrency).map((b) => ({
        currency: b.currency,
        amount: b.amount,
        documentCount: b.documentCount,
        provenance: b.provenance,
      }))
    : p.amount !== null && (p.provenance === "stored_field" || p.provenance === "derived_from_items")
      ? [{
          currency: p.currency,
          amount: p.amount,
          documentCount: 1,
          provenance: p.provenance,
        }]
      : [];
  return {
    amount: p.amount,
    currency: p.currency,
    provenance: p.provenance,
    fieldOrFormula: p.fieldOrFormula,
    totalsByCurrency: buckets,
    unavailableCount: p.unavailableCount ?? 0,
  };
}

const resourceCoverageSchema = z.object({
  collection: z.enum(["invoices", "quotes", "expenses", "clients", "client_activities"]),
  sourceTool: z.string(),
  inspected: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  complete: z.boolean(),
});

const briefDocumentSummarySchema = z.object({
  id: z.string(),
  documentNumber: z.string().nullable(),
  status: z.string(),
  counterpartyName: z.string(),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  amount: provenancedAmountSchema,
});

const briefPriorityItemSchema = z.object({
  priority: z.enum(["high", "medium", "low"]),
  category: z.enum([
    "overdue_invoice",
    "draft_invoice",
    "draft_or_expiring_quote",
    "expense_review",
    "client_followup",
    "plan_quota",
  ]),
  title: z.string(),
  why: z.string(),
  recordRefs: z.array(
    z.object({
      type: z.enum(["invoice", "quote", "expense", "client", "client_activity", "plan_quota"]),
      id: z.string(),
      label: z.string(),
    }),
  ).max(10),
  amount: provenancedAmountSchema.optional(),
  suggestedNextAction: z.object({
    description: z.string(),
    recommendedTool: z.string().describe("Reviewed ChatGPT tool to inspect or follow up"),
    requiresConfirmation: z.boolean(),
    autoExecuted: z.literal(false),
  }),
});

export const dailyOperationalBriefOutputSchema = z.object({
  question: z.string(),
  coverage: z.object({
    asOfDate: z.string(),
    referenceMonth: z.string(),
    temporalScope: z.literal("unfiltered_operational_sample_as_of_date"),
    temporalScopeNote: z.string(),
    isPartial: z.boolean(),
    resources: z.array(resourceCoverageSchema).max(5),
  }),
  activitySeparation: z.object({
    draftActivity: z.object({
      note: z.string(),
      invoiceDraftsCount: z.number().int().nonnegative(),
      invoiceDraftsTotal: provenancedAmountSchema,
      invoiceDrafts: z.array(briefDocumentSummarySchema).max(25),
      quoteDraftsCount: z.number().int().nonnegative(),
      quoteDraftsTotal: provenancedAmountSchema,
      quoteDrafts: z.array(briefDocumentSummarySchema).max(25),
    }),
    issuedActivity: z.object({
      note: z.string(),
      realOutstandingBalanceDeterminable: z.literal(false),
      unpaidNominalSemantics: z.literal("nominal_unpaid_invoice_totals_without_partial_payments"),
      issuedInvoicesCount: z.number().int().nonnegative(),
      paidInvoicesCount: z.number().int().nonnegative(),
      paidInvoicesTotal: provenancedAmountSchema,
      unpaidNominalInvoicesCount: z.number().int().nonnegative(),
      unpaidNominalTotal: provenancedAmountSchema,
      overdueNominalInvoicesCount: z.number().int().nonnegative(),
      overdueNominalTotal: provenancedAmountSchema,
      onTimeNominalPendingCount: z.number().int().nonnegative(),
      onTimeNominalPendingTotal: provenancedAmountSchema,
      outstandingInvoices: z.array(briefDocumentSummarySchema).max(25),
    }),
    recordedExpenses: z.object({
      note: z.string(),
      expensesCount: z.number().int().nonnegative(),
      expensesTotal: provenancedAmountSchema,
      deductibleCount: z.number().int().nonnegative(),
      deductibleTotal: provenancedAmountSchema,
      nonDeductibleCount: z.number().int().nonnegative(),
      nonDeductibleTotal: provenancedAmountSchema,
      pendingReviewCount: z.number().int().nonnegative(),
    }),
    currentMonthActivity: z.object({
      referenceMonth: z.string(),
      note: z.string(),
      issuedInvoicesInMonthCount: z.number().int().nonnegative(),
      issuedInvoicesInMonthTotal: provenancedAmountSchema,
      invoiceDraftsInMonthCount: z.number().int().nonnegative(),
      invoiceDraftsInMonthTotal: provenancedAmountSchema,
      expensesInMonthCount: z.number().int().nonnegative(),
      expensesInMonthTotal: provenancedAmountSchema,
    }),
  }),
  priorities: z.array(briefPriorityItemSchema).max(25),
  knownUnknowns: z.array(z.string()).max(15),
  mutationsExecuted: z.literal(0),
}).describe("OpenAI-reviewed daily operational brief with strict draft/issued separation, amount provenance, and coverage");

const periodCategoryBucketSchema = z.object({
  category: z.string(),
  currency: z.string(),
  amount: z.number(),
  expenseCount: z.number().int().nonnegative(),
});

const singlePeriodSummarySchema = z.object({
  period: z.string().describe("Calendar month in YYYY-MM format"),
  coverage: z.object({
    invoicesInspected: z.number().int().nonnegative(),
    invoicesTotal: z.number().int().nonnegative(),
    invoicesComplete: z.boolean(),
    expensesInspected: z.number().int().nonnegative(),
    expensesTotal: z.number().int().nonnegative(),
    expensesComplete: z.boolean(),
    isComplete: z.boolean(),
    telemetry: z.object({
      invoicePagesFetched: z.number().int().nonnegative(),
      expensePagesFetched: z.number().int().nonnegative(),
      totalApiRequests: z.number().int().nonnegative(),
      recordsInspected: z.number().int().nonnegative(),
      approximatePayloadBytes: z.number().int().nonnegative(),
    }),
  }),
  draftInvoices: z.object({
    note: z.string(),
    count: z.number().int().nonnegative(),
    total: provenancedAmountSchema,
  }),
  issuedInvoices: z.object({
    selectionBasis: z
      .literal("issue_date_cohort_not_payment_date")
      .describe(
        "Invoices are selected by issueDate within the period; paid figures reflect current status=paid of that issueDate cohort, not cash collected during the month",
      ),
    note: z.string(),
    realOutstandingBalanceDeterminable: z.literal(false),
    count: z.number().int().nonnegative(),
    currentlyMarkedPaidCount: z
      .number()
      .int()
      .nonnegative()
      .describe("Count of invoices issued in this period that are currently marked as paid (not payment-date collections)"),
    unpaidNominalCount: z.number().int().nonnegative(),
    overdueNominalCount: z.number().int().nonnegative(),
    issuedTotal: provenancedAmountSchema,
    currentlyMarkedPaidTotal: provenancedAmountSchema.describe(
      "Total of invoices issued in this period that are currently marked as paid (issueDate cohort, NOT cash collected during the period)",
    ),
    unpaidNominalTotal: provenancedAmountSchema,
    overdueNominalTotal: provenancedAmountSchema,
  }),
  expenses: z.object({
    note: z
      .string()
      .describe("Explains strict separation of taxDeductible === true, false, and undetermined (absent/null)"),
    count: z.number().int().nonnegative(),
    total: provenancedAmountSchema,
    deductibleCount: z
      .number()
      .int()
      .nonnegative()
      .describe("Expenses explicitly classified with taxDeductible === true"),
    deductibleTotal: provenancedAmountSchema,
    nonDeductibleCount: z
      .number()
      .int()
      .nonnegative()
      .describe("Expenses explicitly classified with taxDeductible === false"),
    nonDeductibleTotal: provenancedAmountSchema,
    undeterminedDeductibilityCount: z
      .number()
      .int()
      .nonnegative()
      .describe("Expenses where taxDeductible is absent, null, or non-boolean"),
    undeterminedDeductibilityTotal: provenancedAmountSchema,
    byCategory: z.array(periodCategoryBucketSchema).max(30),
  }),
  netOperatingByCurrency: z.array(
    z.object({
      currency: z.string(),
      issuedRevenueMinusExpenses: z
        .number()
        .nullable()
        .describe("Issued invoice cohort total minus recorded expenses for this period"),
      issuedCohortCurrentlyPaidMinusExpenses: z
        .number()
        .nullable()
        .describe(
          "Invoices issued in this period currently marked as paid minus recorded expenses in this period (issueDate cohort difference, NOT treasury cash flow or accounting profit)",
        ),
      completeAndDeterminable: z.boolean(),
    }),
  ).max(10),
});

const periodComparisonDeltaByCurrencySchema = z.object({
  currency: z.string(),
  primaryIssuedRevenue: z.number().nullable(),
  comparisonIssuedRevenue: z.number().nullable(),
  issuedRevenueDelta: z.number().nullable(),
  primaryIssuedCurrentlyPaid: z
    .number()
    .nullable()
    .describe("Invoices issued in primaryMonth currently marked as paid (issueDate cohort, not cash collected in primaryMonth)"),
  comparisonIssuedCurrentlyPaid: z
    .number()
    .nullable()
    .describe("Invoices issued in compareWithMonth currently marked as paid (issueDate cohort, not cash collected in compareWithMonth)"),
  issuedCurrentlyPaidDelta: z
    .number()
    .nullable()
    .describe("Delta between primaryMonth and compareWithMonth cohorts of issued invoices currently marked as paid (not a cash-flow collection delta)"),
  primaryExpenses: z.number().nullable(),
  comparisonExpenses: z.number().nullable(),
  expensesDelta: z.number().nullable(),
  completeAndDeterminable: z.boolean(),
});

export const businessPeriodSummaryOutputSchema = z.object({
  accountingSemanticsNote: z.string(),
  primaryPeriod: singlePeriodSummarySchema,
  comparisonPeriod: singlePeriodSummarySchema.optional(),
  comparison: z.object({
    primaryMonth: z.string(),
    compareWithMonth: z.string(),
    bothPeriodsComplete: z.boolean(),
    issuedInvoicesCountDelta: z.number().int(),
    draftInvoicesCountDelta: z.number().int(),
    expensesCountDelta: z.number().int(),
    deltasByCurrency: z.array(periodComparisonDeltaByCurrencySchema).max(10),
    notes: z.array(z.string()).max(10),
  }).optional(),
}).describe("Operational period summary and month-over-month comparison without regulated tax filing fields");

const searchTelemetrySchema = z.object({
  directoryPagesFetched: z.number().int().nonnegative().describe("Number of paginated directory requests issued"),
  contextRequestsMade: z.number().int().nonnegative().describe("Follow-up requests issued for matched record context"),
  totalApiRequests: z.number().int().nonnegative().describe("Total upstream API requests issued by this tool call"),
  recordsInspected: z.number().int().nonnegative().describe("Directory records inspected across fetched pages"),
  approximatePayloadBytes: z.number().int().nonnegative().describe("Approximate UTF-8 JSON bytes received across upstream calls"),
  serverProjectionFields: z.string().describe("Server-side fields projection passed to strip taxId/address/searchTokens before serialization"),
});

const searchCoverageSchema = z.object({
  inspected: z.number().int().nonnegative().describe("Records inspected in this call"),
  total: z.number().int().nonnegative().describe("Total records reported by the workspace directory"),
  uninspectedCount: z.number().int().nonnegative().describe("Directory records not inspected in this call"),
  complete: z.boolean().describe("True only when all directory records from offset 0 through total were inspected in this call"),
  nextCursor: z.string().nullable().describe("Continuation token to pass as 'after' to scan the next forward page window, or null when forward scan reached the end"),
  telemetry: searchTelemetrySchema,
});

export const searchMatchStatusSchema = z.enum([
  "exact",
  "unambiguous",
  "ambiguous",
  "none",
  "partial_scan_single_match",
  "partial_scan_no_match",
]).describe(
  "Match certainty status. 'exact', 'unambiguous', and 'none' require coverage.complete===true. " +
  "When coverage.complete===false, a single match is reported as 'partial_scan_single_match' and 0 matches as 'partial_scan_no_match' because uninspected pages may contain additional matches.",
);

const matchedClientInvoicePreviewSchema = z.object({
  id: z.string(),
  invoiceNumber: z.string().nullable(),
  status: z.string(),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  amount: provenancedAmountSchema,
});

const matchedClientActivityPreviewSchema = z.object({
  type: z.string(),
  title: z.string(),
  timestamp: z.string().nullable(),
});

const matchedClientItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  stage: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  matchRank: z.enum(["exact", "prefix", "token", "substring"]),
  context: z.object({
    recentInvoices: z.array(matchedClientInvoicePreviewSchema).max(5),
    recentActivities: z.array(matchedClientActivityPreviewSchema).max(5),
  }).optional(),
});

export const searchClientsOutputSchema = z.object({
  query: z.string(),
  searchedFields: z.array(z.literal("name")).max(1),
  matchStatus: searchMatchStatusSchema,
  disambiguationNote: z.string(),
  coverage: searchCoverageSchema,
  matches: z.array(matchedClientItemSchema).max(20),
}).describe("Commercial-name client search with multi-page coverage truth, ambiguity detection, and meeting-prep context");

const matchedVendorExpensePreviewSchema = z.object({
  id: z.string(),
  description: z.string(),
  date: z.string().nullable(),
  category: z.string().nullable(),
  taxDeductible: z.boolean().nullable(),
  amount: provenancedAmountSchema,
});

const matchedVendorItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  matchRank: z.enum(["exact", "prefix", "token", "substring"]),
  recentExpenses: z.array(matchedVendorExpensePreviewSchema).max(5).optional(),
});

export const searchVendorsOutputSchema = z.object({
  query: z.string(),
  searchedFields: z.array(z.literal("name")).max(1),
  matchStatus: searchMatchStatusSchema,
  disambiguationNote: z.string(),
  coverage: searchCoverageSchema,
  matches: z.array(matchedVendorItemSchema).max(20),
}).describe("Commercial-name vendor search with multi-page coverage truth, ambiguity detection, and recent expense context");

/* ------------------------------------------------------------------ */
/*  Helper: Aggregate a list of documents into ProvenancedAmount       */
/* ------------------------------------------------------------------ */

function aggregateAmounts(
  docs: Array<Record<string, unknown>>,
  defaultCurrency: string,
  formulaLabel: string,
): z.infer<typeof provenancedAmountSchema> {
  if (docs.length === 0) {
    const cur = defaultCurrency.toUpperCase();
    return {
      amount: 0,
      currency: cur,
      provenance: "stored_field",
      fieldOrFormula: `${formulaLabel} (0 documents)`,
      totalsByCurrency: [{ currency: cur, amount: 0, documentCount: 0, provenance: "stored_field" }],
      unavailableCount: 0,
    };
  }

  const buckets = new Map<
    string,
    { amount: number; count: number; provenance: "stored_field" | "derived_from_items" }
  >();
  let unavailableCount = 0;

  for (const doc of docs) {
    const resolved = resolveDocumentAmount(doc, defaultCurrency);
    if (resolved.amount === null || resolved.provenance === "unavailable") {
      unavailableCount++;
      continue;
    }
    const cur = resolved.currency;
    const prev = buckets.get(cur);
    const prov: "stored_field" | "derived_from_items" =
      prev?.provenance === "derived_from_items" || resolved.provenance === "derived_from_items"
        ? "derived_from_items"
        : "stored_field";
    buckets.set(cur, {
      amount: roundCurrency((prev?.amount ?? 0) + resolved.amount),
      count: (prev?.count ?? 0) + 1,
      provenance: prov,
    });
  }

  const totalsByCurrency = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, b]) => ({
      currency,
      amount: b.amount,
      documentCount: b.count,
      provenance: b.provenance,
    }));

  if (unavailableCount > 0) {
    return {
      amount: null,
      currency: totalsByCurrency.length === 1 ? totalsByCurrency[0].currency : totalsByCurrency.length > 1 ? "MIXED" : defaultCurrency.toUpperCase(),
      provenance: "unavailable",
      fieldOrFormula: `${formulaLabel} (${unavailableCount} document(s) missing valid amount)`,
      totalsByCurrency,
      unavailableCount,
    };
  }

  if (totalsByCurrency.length > 1) {
    return {
      amount: null,
      currency: "MIXED",
      provenance: "mixed_currency_unconverted",
      fieldOrFormula: `${formulaLabel} (multi-currency buckets without conversion)`,
      totalsByCurrency,
      unavailableCount: 0,
    };
  }

  const single = totalsByCurrency[0];
  return {
    amount: single.amount,
    currency: single.currency,
    provenance: single.provenance,
    fieldOrFormula: formulaLabel,
    totalsByCurrency,
    unavailableCount: 0,
  };
}

async function computeSinglePeriodSummary(
  client: IFrihetClient,
  period: string,
  defaultCurrency: string,
  maxPages = 5,
): Promise<z.infer<typeof singlePeriodSummarySchema>> {
  const from = `${period}-01`;
  const to = lastCalendarDayOfMonth(period);
  const pageSize = 100;

  let invoicePagesFetched = 0;
  let expensePagesFetched = 0;
  let approximatePayloadBytes = 0;

  const rawInvoices: Array<Record<string, unknown>> = [];
  const seenInvoiceIds = new Set<string>();
  let invoicesTotal = 0;
  let invoicesComplete = true;
  let invAfter: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await client.listInvoices({
      from,
      to,
      limit: pageSize,
      ...(invAfter ? { after: invAfter } : { offset: page * pageSize }),
    });
    invoicePagesFetched++;
    approximatePayloadBytes += approxJsonBytes(res);
    const rows = Array.isArray(res?.data) ? res.data : [];
    if (page === 0) {
      invoicesTotal = typeof res?.total === "number" ? res.total : rows.length;
    }
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id : "";
      if (id && seenInvoiceIds.has(id)) continue;
      if (id) seenInvoiceIds.add(id);
      rawInvoices.push(rec);
    }
    const nextCursor = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
    const hasMore = Boolean(nextCursor) || rawInvoices.length < invoicesTotal;
    if (!hasMore || rows.length === 0 || (rows.length < pageSize && !nextCursor)) break;
    invAfter = nextCursor;
    if (page === maxPages - 1 && (Boolean(nextCursor) || rawInvoices.length < invoicesTotal)) {
      invoicesComplete = false;
    }
  }
  if (rawInvoices.length < invoicesTotal) invoicesComplete = false;

  const rawExpenses: Array<Record<string, unknown>> = [];
  const seenExpenseIds = new Set<string>();
  let expensesTotal = 0;
  let expensesComplete = true;
  let expAfter: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await client.listExpenses({
      from,
      to,
      limit: pageSize,
      ...(expAfter ? { after: expAfter } : { offset: page * pageSize }),
    });
    expensePagesFetched++;
    approximatePayloadBytes += approxJsonBytes(res);
    const rows = Array.isArray(res?.data) ? res.data : [];
    if (page === 0) {
      expensesTotal = typeof res?.total === "number" ? res.total : rows.length;
    }
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id : "";
      if (id && seenExpenseIds.has(id)) continue;
      if (id) seenExpenseIds.add(id);
      rawExpenses.push(rec);
    }
    const nextCursor = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
    const hasMore = Boolean(nextCursor) || rawExpenses.length < expensesTotal;
    if (!hasMore || rows.length === 0 || (rows.length < pageSize && !nextCursor)) break;
    expAfter = nextCursor;
    if (page === maxPages - 1 && (Boolean(nextCursor) || rawExpenses.length < expensesTotal)) {
      expensesComplete = false;
    }
  }
  if (rawExpenses.length < expensesTotal) expensesComplete = false;

  const isDateWithinPeriod = (rawDate: unknown): boolean => {
    if (typeof rawDate !== "string" || !rawDate.trim()) return true;
    const d = rawDate.trim().slice(0, 10);
    return d >= from && d <= to;
  };

  const getNormStatus = (doc: Record<string, unknown>, fallback = "draft"): string =>
    typeof doc.status === "string" && doc.status.trim() ? doc.status.trim().toLowerCase() : fallback;

  const invoices = rawInvoices.filter((inv) => isDateWithinPeriod(inv.issueDate));
  const expenses = rawExpenses.filter((exp) => {
    const st = getNormStatus(exp, "recorded");
    if (st === "cancelled" || st === "canceled" || st === "void") return false;
    return isDateWithinPeriod(exp.date);
  });

  const draftInvoices = invoices.filter((inv) => getNormStatus(inv) === "draft");
  const issuedInvoices = invoices.filter((inv) => {
    const st = getNormStatus(inv);
    return st !== "draft" && st !== "cancelled" && st !== "canceled" && st !== "void";
  });
  const paidInvoices = issuedInvoices.filter((inv) => getNormStatus(inv) === "paid");
  const unpaidInvoices = issuedInvoices.filter((inv) => getNormStatus(inv) !== "paid");
  const overdueInvoices = unpaidInvoices.filter((inv) => getNormStatus(inv) === "overdue");

  const deductibleExpenses = expenses.filter((exp) => exp.taxDeductible === true);
  const nonDeductibleExpenses = expenses.filter((exp) => exp.taxDeductible === false);
  const undeterminedDeductibilityExpenses = expenses.filter(
    (exp) => typeof exp.taxDeductible !== "boolean",
  );

  const categoryBuckets = new Map<string, { category: string; currency: string; amount: number; count: number }>();
  for (const exp of expenses) {
    const resolved = resolveDocumentAmount(exp, defaultCurrency);
    if (resolved.amount === null) continue;
    const category = typeof exp.category === "string" && exp.category.trim() ? exp.category.trim() : "uncategorized";
    const key = `${category}::${resolved.currency}`;
    const prev = categoryBuckets.get(key);
    categoryBuckets.set(key, {
      category,
      currency: resolved.currency,
      amount: roundCurrency((prev?.amount ?? 0) + resolved.amount),
      count: (prev?.count ?? 0) + 1,
    });
  }

  const draftTotal = aggregateAmounts(draftInvoices, defaultCurrency, "sum(draft_invoices)");
  const issuedTotal = aggregateAmounts(issuedInvoices, defaultCurrency, "sum(issued_invoices)");
  const currentlyMarkedPaidTotal = aggregateAmounts(
    paidInvoices,
    defaultCurrency,
    "sum(issued_invoices_currently_marked_paid)",
  );
  const unpaidNominalTotal = aggregateAmounts(unpaidInvoices, defaultCurrency, "sum(unpaid_nominal_invoices)");
  const overdueNominalTotal = aggregateAmounts(overdueInvoices, defaultCurrency, "sum(overdue_nominal_invoices)");
  const expTotal = aggregateAmounts(expenses, defaultCurrency, "sum(expenses)");
  const dedTotal = aggregateAmounts(deductibleExpenses, defaultCurrency, "sum(deductible_expenses)");
  const nonDedTotal = aggregateAmounts(nonDeductibleExpenses, defaultCurrency, "sum(non_deductible_expenses)");
  const undeterminedDedTotal = aggregateAmounts(
    undeterminedDeductibilityExpenses,
    defaultCurrency,
    "sum(undetermined_deductibility_expenses)",
  );

  const allCurrencies = new Set<string>([
    ...issuedTotal.totalsByCurrency.map((b) => b.currency),
    ...currentlyMarkedPaidTotal.totalsByCurrency.map((b) => b.currency),
    ...expTotal.totalsByCurrency.map((b) => b.currency),
  ]);

  const isComplete = invoicesComplete && expensesComplete;
  const determinable =
    isComplete &&
    issuedTotal.unavailableCount === 0 &&
    currentlyMarkedPaidTotal.unavailableCount === 0 &&
    expTotal.unavailableCount === 0;

  const netOperatingByCurrency = [...allCurrencies].sort().map((currency) => {
    const issuedBucket = issuedTotal.totalsByCurrency.find((b) => b.currency === currency)?.amount ?? 0;
    const paidBucket = currentlyMarkedPaidTotal.totalsByCurrency.find((b) => b.currency === currency)?.amount ?? 0;
    const expBucket = expTotal.totalsByCurrency.find((b) => b.currency === currency)?.amount ?? 0;
    return {
      currency,
      issuedRevenueMinusExpenses: determinable ? roundCurrency(issuedBucket - expBucket) : null,
      issuedCohortCurrentlyPaidMinusExpenses: determinable ? roundCurrency(paidBucket - expBucket) : null,
      completeAndDeterminable: determinable,
    };
  });

  return {
    period,
    coverage: {
      invoicesInspected: rawInvoices.length,
      invoicesTotal,
      invoicesComplete,
      expensesInspected: rawExpenses.length,
      expensesTotal,
      expensesComplete,
      isComplete,
      telemetry: {
        invoicePagesFetched,
        expensePagesFetched,
        totalApiRequests: invoicePagesFetched + expensePagesFetched,
        recordsInspected: rawInvoices.length + rawExpenses.length,
        approximatePayloadBytes,
      },
    },
    draftInvoices: {
      note: "Draft invoices are non-issued working documents and are excluded from issued revenue.",
      count: draftInvoices.length,
      total: draftTotal,
    },
    issuedInvoices: {
      selectionBasis: "issue_date_cohort_not_payment_date" as const,
      note:
        "Invoices are selected by issueDate within the period. currentlyMarkedPaidTotal sums invoices issued in this period that are currently marked as paid; it does NOT measure cash collected during this calendar month (e.g. an invoice issued in September and paid in October belongs to the September issueDate cohort). Unpaid totals represent nominal invoice amounts not marked as paid; real outstanding balance cannot be determined without partial-payment or bank-reconciliation records.",
      realOutstandingBalanceDeterminable: false,
      count: issuedInvoices.length,
      currentlyMarkedPaidCount: paidInvoices.length,
      unpaidNominalCount: unpaidInvoices.length,
      overdueNominalCount: overdueInvoices.length,
      issuedTotal,
      currentlyMarkedPaidTotal,
      unpaidNominalTotal,
      overdueNominalTotal,
    },
    expenses: {
      note:
        "Expenses are partitioned into deductible (taxDeductible === true), non-deductible (taxDeductible === false), and undetermined classification (taxDeductible absent, null, or non-boolean) without assuming deductibility by default.",
      count: expenses.length,
      total: expTotal,
      deductibleCount: deductibleExpenses.length,
      deductibleTotal: dedTotal,
      nonDeductibleCount: nonDeductibleExpenses.length,
      nonDeductibleTotal: nonDedTotal,
      undeterminedDeductibilityCount: undeterminedDeductibilityExpenses.length,
      undeterminedDeductibilityTotal: undeterminedDedTotal,
      byCategory: [...categoryBuckets.values()]
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 30)
        .map((b) => ({
          category: b.category,
          currency: b.currency,
          amount: b.amount,
          expenseCount: b.count,
        })),
    },
    netOperatingByCurrency,
  };
}

const OPENAI_ALLOWED_NEXT_TOOLS = new Set([
  "get_business_context",
  "get_daily_operational_brief",
  "get_business_period_summary",
  "search_clients",
  "search_vendors",
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
  "create_invoice",
  "create_expense",
  "create_client",
  "create_client_contact",
  "log_client_activity",
  "create_client_note",
  "create_product",
  "create_quote",
  "create_vendor",
  "update_expense",
  "update_client",
  "update_product",
  "update_vendor",
  "delete_client_contact",
  "delete_client_note",
  "delete_quote",
]);

function mapRecommendedToolToOpenAISurface(toolName: string, category: string): string {
  if (OPENAI_ALLOWED_NEXT_TOOLS.has(toolName)) return toolName;
  if (category === "overdue_invoice" || category === "draft_invoice") return "get_invoice";
  if (category === "draft_or_expiring_quote") return "get_quote";
  if (category === "expense_review") return "get_expense";
  if (category === "client_followup") return "search_clients";
  return "get_business_context";
}

function resolveMatchStatusWithCoverageTruth(
  matchCount: number,
  exactCount: number,
  complete: boolean,
): z.infer<typeof searchMatchStatusSchema> {
  if (matchCount >= 2) {
    return "ambiguous";
  }
  if (matchCount === 1) {
    if (!complete) return "partial_scan_single_match";
    return exactCount === 1 ? "exact" : "unambiguous";
  }
  return complete ? "none" : "partial_scan_no_match";
}

export function registerOpenAI103CandidateTools(
  server: McpServer,
  client: IFrihetClient,
): void {
  /* ---------------------------------------------------------------- */
  /*  1. get_daily_operational_brief                                  */
  /* ---------------------------------------------------------------- */
  server.registerTool(
    "get_daily_operational_brief",
    {
      title: "Get Daily Operational Brief",
      description:
        "Generate a prioritized read-only operational brief answering 'What should I review today in my business and why?'. " +
        "Separates draft documents from issued activity, enforces multi-currency and missing-amount provenance, " +
        "states collection coverage and nominal unpaid balance limits, and links every priority item to its source record IDs. " +
        "/ Genera un brief operativo diario de solo lectura con prioridades respaldadas por IDs de origen, " +
        "separacion entre borradores y actividad emitida, desglose por moneda y cobertura explicita.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        asOfDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format")
          .optional()
          .describe("Reference date in YYYY-MM-DD format (defaults to today UTC) / Fecha de referencia YYYY-MM-DD"),
        pageLimit: z
          .number()
          .int()
          .min(5)
          .max(50)
          .optional()
          .describe("Records inspected per collection (5-50, default 25) / Registros inspeccionados por coleccion"),
      },
      outputSchema: dailyOperationalBriefOutputSchema,
    },
    async ({ asOfDate, pageLimit }) =>
      withToolLogging("get_daily_operational_brief", async () => {
        const brief = await generateDailyOperationalBrief(client, {
          asOfDate,
          pageLimit: pageLimit ?? 25,
          maxActivityClients: 3,
        });

        const mapDoc = (d: {
          id: string;
          documentNumber: string | null;
          status: string;
          counterpartyName: string;
          issueDate: string | null;
          dueDate: string | null;
          amount: ProvenancedAmount;
        }) => ({
          id: d.id,
          documentNumber: d.documentNumber,
          status: d.status,
          counterpartyName: d.counterpartyName,
          issueDate: d.issueDate,
          dueDate: d.dueDate,
          amount: serializeProvenancedAmount(d.amount),
        });

        const structured: z.infer<typeof dailyOperationalBriefOutputSchema> = {
          question: brief.question,
          coverage: {
            asOfDate: brief.coverage.asOfDate,
            referenceMonth: brief.coverage.referenceMonth,
            temporalScope: brief.coverage.temporalScope,
            temporalScopeNote: brief.coverage.temporalScopeNote,
            isPartial: brief.coverage.isPartial,
            resources: Object.values(brief.coverage.resources),
          },
          activitySeparation: {
            draftActivity: {
              note: brief.activitySeparation.draftActivity.note,
              invoiceDraftsCount: brief.activitySeparation.draftActivity.invoiceDraftsCount,
              invoiceDraftsTotal: serializeProvenancedAmount(brief.activitySeparation.draftActivity.invoiceDraftsTotal),
              invoiceDrafts: brief.activitySeparation.draftActivity.invoiceDrafts.slice(0, 25).map(mapDoc),
              quoteDraftsCount: brief.activitySeparation.draftActivity.quoteDraftsCount,
              quoteDraftsTotal: serializeProvenancedAmount(brief.activitySeparation.draftActivity.quoteDraftsTotal),
              quoteDrafts: brief.activitySeparation.draftActivity.quoteDrafts.slice(0, 25).map(mapDoc),
            },
            issuedActivity: {
              note: brief.activitySeparation.issuedActivity.note,
              realOutstandingBalanceDeterminable: false,
              unpaidNominalSemantics: "nominal_unpaid_invoice_totals_without_partial_payments",
              issuedInvoicesCount: brief.activitySeparation.issuedActivity.issuedInvoicesCount,
              paidInvoicesCount: brief.activitySeparation.issuedActivity.paidInvoicesCount,
              paidInvoicesTotal: serializeProvenancedAmount(brief.activitySeparation.issuedActivity.paidInvoicesTotal),
              unpaidNominalInvoicesCount: brief.activitySeparation.issuedActivity.unpaidNominalInvoicesCount,
              unpaidNominalTotal: serializeProvenancedAmount(brief.activitySeparation.issuedActivity.unpaidNominalTotal),
              overdueNominalInvoicesCount: brief.activitySeparation.issuedActivity.overdueNominalInvoicesCount,
              overdueNominalTotal: serializeProvenancedAmount(brief.activitySeparation.issuedActivity.overdueNominalTotal),
              onTimeNominalPendingCount: brief.activitySeparation.issuedActivity.onTimeNominalPendingCount,
              onTimeNominalPendingTotal: serializeProvenancedAmount(brief.activitySeparation.issuedActivity.onTimeNominalPendingTotal),
              outstandingInvoices: brief.activitySeparation.issuedActivity.outstandingInvoices.slice(0, 25).map(mapDoc),
            },
            recordedExpenses: {
              note: brief.activitySeparation.recordedExpenses.note,
              expensesCount: brief.activitySeparation.recordedExpenses.expensesCount,
              expensesTotal: serializeProvenancedAmount(brief.activitySeparation.recordedExpenses.expensesTotal),
              deductibleCount: brief.activitySeparation.recordedExpenses.deductibleCount,
              deductibleTotal: serializeProvenancedAmount(brief.activitySeparation.recordedExpenses.deductibleTotal),
              nonDeductibleCount: brief.activitySeparation.recordedExpenses.nonDeductibleCount,
              nonDeductibleTotal: serializeProvenancedAmount(brief.activitySeparation.recordedExpenses.nonDeductibleTotal),
              pendingReviewCount: brief.activitySeparation.recordedExpenses.pendingReviewCount,
            },
            currentMonthActivity: {
              referenceMonth: brief.activitySeparation.currentMonthActivity.referenceMonth,
              note: brief.activitySeparation.currentMonthActivity.note,
              issuedInvoicesInMonthCount: brief.activitySeparation.currentMonthActivity.issuedInvoicesInMonthCount,
              issuedInvoicesInMonthTotal: serializeProvenancedAmount(
                brief.activitySeparation.currentMonthActivity.issuedInvoicesInMonthTotal,
              ),
              invoiceDraftsInMonthCount: brief.activitySeparation.currentMonthActivity.invoiceDraftsInMonthCount,
              invoiceDraftsInMonthTotal: serializeProvenancedAmount(
                brief.activitySeparation.currentMonthActivity.invoiceDraftsInMonthTotal,
              ),
              expensesInMonthCount: brief.activitySeparation.currentMonthActivity.expensesInMonthCount,
              expensesInMonthTotal: serializeProvenancedAmount(
                brief.activitySeparation.currentMonthActivity.expensesInMonthTotal,
              ),
            },
          },
          priorities: brief.priorities.slice(0, 25).map((p) => ({
            priority: p.priority,
            category: p.category,
            title: p.title,
            why: p.why,
            recordRefs: p.recordRefs.slice(0, 10),
            ...(p.amount ? { amount: serializeProvenancedAmount(p.amount) } : {}),
            suggestedNextAction: {
              description: p.suggestedNextAction.description,
              recommendedTool: mapRecommendedToolToOpenAISurface(
                p.suggestedNextAction.recommendedTool,
                p.category,
              ),
              requiresConfirmation: p.suggestedNextAction.requiresConfirmation,
              autoExecuted: false as const,
            },
          })),
          knownUnknowns: brief.knownUnknowns.slice(0, 15),
          mutationsExecuted: 0,
        };

        return {
          content: [getContent(brief.markdown)],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      }),
  );

  /* ---------------------------------------------------------------- */
  /*  2. get_business_period_summary                                  */
  /* ---------------------------------------------------------------- */
  server.registerTool(
    "get_business_period_summary",
    {
      title: "Get Business Period Summary",
      description:
        "Get an operational summary of issued invoices, draft invoices, and recorded expenses for a calendar month (YYYY-MM), " +
        "with optional side-by-side comparison against another month. Selects invoices by issueDate and expenses by date, " +
        "aggregates strictly by currency without cross-currency conversion, separates drafts from issued invoices (reporting how much " +
        "of that period's issued invoice cohort is currently marked as paid vs unpaid nominal, without claiming payment-date cash collections " +
        "or treasury cash flow), partitions expenses into deductible (true), non-deductible (false), and undetermined classification, " +
        "reports coverage telemetry, and excludes regulated tax-return calculations. " +
        "/ Obtiene el resumen operativo de un mes (YYYY-MM) y permite compararlo con otro mes por moneda, seleccionando facturas por " +
        "fecha de emision (issueDate) y gastos por fecha (date), separando borradores de facturas emitidas (indicando cuantas de las emitidas " +
        "en ese mes estan actualmente marcadas como pagadas frente a pendientes nominales, sin atribuirlo a cobros por fecha de pago ni tesoreria), " +
        "y separando gastos deducibles, no deducibles y de clasificacion no determinada.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        period: z
          .string()
          .regex(CALENDAR_MONTH_REGEX, "Use YYYY-MM format (01-12)")
          .describe("Primary calendar month in YYYY-MM format (e.g. '2026-10') / Mes principal YYYY-MM"),
        compareWithPeriod: z
          .string()
          .regex(CALENDAR_MONTH_REGEX, "Use YYYY-MM format (01-12)")
          .optional()
          .describe("Optional comparison month in YYYY-MM format (e.g. '2026-09') / Mes a comparar YYYY-MM"),
      },
      outputSchema: businessPeriodSummaryOutputSchema,
    },
    async ({ period, compareWithPeriod }) =>
      withToolLogging("get_business_period_summary", async () => {
        let defaultCurrency = "EUR";
        try {
          const ctx = await client.getBusinessContext();
          const cur = (ctx?.defaults as Record<string, unknown> | undefined)?.currency;
          if (typeof cur === "string" && cur.trim()) defaultCurrency = cur.trim().toUpperCase();
        } catch {
          // Default to EUR if context call fails
        }

        const primaryPeriod = await computeSinglePeriodSummary(client, period, defaultCurrency);
        let comparisonPeriod: z.infer<typeof singlePeriodSummarySchema> | undefined;
        let comparison: z.infer<typeof businessPeriodSummaryOutputSchema>["comparison"];

        if (compareWithPeriod) {
          comparisonPeriod =
            compareWithPeriod === period
              ? primaryPeriod
              : await computeSinglePeriodSummary(client, compareWithPeriod, defaultCurrency);

          const pIssuedUnavail = primaryPeriod.issuedInvoices.issuedTotal.unavailableCount > 0;
          const cIssuedUnavail = comparisonPeriod.issuedInvoices.issuedTotal.unavailableCount > 0;
          const pPaidUnavail = primaryPeriod.issuedInvoices.currentlyMarkedPaidTotal.unavailableCount > 0;
          const cPaidUnavail = comparisonPeriod.issuedInvoices.currentlyMarkedPaidTotal.unavailableCount > 0;
          const pExpUnavail = primaryPeriod.expenses.total.unavailableCount > 0;
          const cExpUnavail = comparisonPeriod.expenses.total.unavailableCount > 0;

          const currencies = new Set<string>([
            ...primaryPeriod.issuedInvoices.issuedTotal.totalsByCurrency.map((b) => b.currency),
            ...comparisonPeriod.issuedInvoices.issuedTotal.totalsByCurrency.map((b) => b.currency),
            ...primaryPeriod.issuedInvoices.currentlyMarkedPaidTotal.totalsByCurrency.map((b) => b.currency),
            ...comparisonPeriod.issuedInvoices.currentlyMarkedPaidTotal.totalsByCurrency.map((b) => b.currency),
            ...primaryPeriod.expenses.total.totalsByCurrency.map((b) => b.currency),
            ...comparisonPeriod.expenses.total.totalsByCurrency.map((b) => b.currency),
          ]);
          if (currencies.size === 0) {
            currencies.add(defaultCurrency);
          }

          const bothComplete = primaryPeriod.coverage.isComplete && comparisonPeriod.coverage.isComplete;
          const anyUnavailable =
            pIssuedUnavail || cIssuedUnavail || pPaidUnavail || cPaidUnavail || pExpUnavail || cExpUnavail;

          const deltasByCurrency = [...currencies].sort().map((currency) => {
            const pIssuedRaw =
              primaryPeriod.issuedInvoices.issuedTotal.totalsByCurrency.find((b) => b.currency === currency)?.amount ?? 0;
            const cIssuedRaw =
              comparisonPeriod!.issuedInvoices.issuedTotal.totalsByCurrency.find((b) => b.currency === currency)?.amount ?? 0;
            const pPaidRaw =
              primaryPeriod.issuedInvoices.currentlyMarkedPaidTotal.totalsByCurrency.find((b) => b.currency === currency)
                ?.amount ?? 0;
            const cPaidRaw =
              comparisonPeriod!.issuedInvoices.currentlyMarkedPaidTotal.totalsByCurrency.find((b) => b.currency === currency)
                ?.amount ?? 0;
            const pExpRaw =
              primaryPeriod.expenses.total.totalsByCurrency.find((b) => b.currency === currency)?.amount ?? 0;
            const cExpRaw =
              comparisonPeriod!.expenses.total.totalsByCurrency.find((b) => b.currency === currency)?.amount ?? 0;

            const pIssued = pIssuedUnavail ? null : pIssuedRaw;
            const cIssued = cIssuedUnavail ? null : cIssuedRaw;
            const pPaid = pPaidUnavail ? null : pPaidRaw;
            const cPaid = cPaidUnavail ? null : cPaidRaw;
            const pExp = pExpUnavail ? null : pExpRaw;
            const cExp = cExpUnavail ? null : cExpRaw;

            return {
              currency,
              primaryIssuedRevenue: pIssued,
              comparisonIssuedRevenue: cIssued,
              issuedRevenueDelta: pIssued !== null && cIssued !== null ? roundCurrency(pIssued - cIssued) : null,
              primaryIssuedCurrentlyPaid: pPaid,
              comparisonIssuedCurrentlyPaid: cPaid,
              issuedCurrentlyPaidDelta: pPaid !== null && cPaid !== null ? roundCurrency(pPaid - cPaid) : null,
              primaryExpenses: pExp,
              comparisonExpenses: cExp,
              expensesDelta: pExp !== null && cExp !== null ? roundCurrency(pExp - cExp) : null,
              completeAndDeterminable: bothComplete && !anyUnavailable,
            };
          });

          const notes: string[] = [
            "Invoice figures compare issueDate cohorts for each period; issuedCurrentlyPaidDelta compares invoices issued in each period that are currently marked as paid, not cash collections by payment date.",
          ];
          if (compareWithPeriod === period) {
            notes.push("Primary and comparison periods are identical; all deltas are zero.");
          }
          if (!bothComplete) {
            notes.push(
              "One or both periods exceeded the bounded inspection cap; deltas reflect only the inspected sample.",
            );
          }
          if (anyUnavailable) {
            notes.push(
              "One or more documents have missing or corrupt amounts; affected revenue or expense deltas are null instead of coercing missing amounts to 0.",
            );
          }
          if (currencies.size > 1) {
            notes.push(
              "Multiple currencies detected; deltas are reported per currency without exchange-rate conversion.",
            );
          }

          comparison = {
            primaryMonth: period,
            compareWithMonth: compareWithPeriod,
            bothPeriodsComplete: bothComplete,
            issuedInvoicesCountDelta:
              primaryPeriod.issuedInvoices.count - comparisonPeriod.issuedInvoices.count,
            draftInvoicesCountDelta:
              primaryPeriod.draftInvoices.count - comparisonPeriod.draftInvoices.count,
            expensesCountDelta:
              primaryPeriod.expenses.count - comparisonPeriod.expenses.count,
            deltasByCurrency,
            notes,
          };
        }

        const output: z.infer<typeof businessPeriodSummaryOutputSchema> = {
          accountingSemanticsNote:
            "Operational period summary based on invoice issueDate and expense date. Draft and cancelled invoices are excluded from issued revenue. currentlyMarkedPaidTotal sums invoices issued in the period whose current status is 'paid'; it does NOT measure cash collected during that calendar month (e.g. an invoice issued in September and paid in October belongs to the September issueDate cohort). issuedCohortCurrentlyPaidMinusExpenses is an issueDate-cohort difference, not treasury cash flow or accounting profit. Expenses are partitioned into deductible (taxDeductible === true), non-deductible (taxDeductible === false), and undetermined classification (taxDeductible absent/null) without assuming deductibility by default. Multi-currency totals are kept in separate currency buckets without conversion. Regulated tax-filing figures are omitted.",
          primaryPeriod,
          ...(comparisonPeriod ? { comparisonPeriod } : {}),
          ...(comparison ? { comparison } : {}),
        };

        return {
          content: [getContent(formatRecord(`Business Period Summary (${period})`, output as unknown as Record<string, unknown>))],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      }),
  );

  /* ---------------------------------------------------------------- */
  /*  3. search_clients                                               */
  /* ---------------------------------------------------------------- */
  server.registerTool(
    "search_clients",
    {
      title: "Search Clients by Name",
      description:
        "Search clients by commercial name only across paginated directory windows, report exact coverage and uninspected " +
        "record counts, distinguish complete single matches from partial-scan single matches or ambiguous matches, and optionally " +
        "retrieve meeting-prep context (recent invoices and CRM activities). Uses server-side field projection so government tax " +
        "identifiers and street addresses are never queried or serialized. " +
        "/ Busca clientes exclusivamente por nombre comercial en paginas sucesivas del directorio, informa la cobertura exacta " +
        "y registros no inspeccionados, distingue coincidencias unicas completas de muestras parciales o ambiguas, y recupera " +
        "contexto para reuniones sin consultar ni exponer identificadores fiscales ni direcciones.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .describe(
            `Commercial client name to search for (1-100 chars) / Nombre comercial del cliente — ${OPENAI_REVIEW_FREE_TEXT_WARNING}`,
          ),
        stage: z
          .enum(["lead", "contacted", "proposal", "active", "inactive", "lost"])
          .optional()
          .describe("Optional CRM stage filter / Filtro opcional por etapa CRM"),
        includeContext: z
          .boolean()
          .optional()
          .describe("When true (default) and 1-3 clients match, includes recent invoices and CRM activities / Incluir contexto reciente"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum matches to return (1-20, default 10) / Maximo de coincidencias"),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Maximum directory pages (100 records/page) to scan in this call (1-5, default 3 = 300 records) / Paginas maximas a escanear (1-5, por defecto 3)"),
        after: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .optional()
          .describe("Optional continuation token from a previous coverage.nextCursor to scan subsequent directory pages / Cursor de continuacion coverage.nextCursor"),
      },
      outputSchema: searchClientsOutputSchema,
    },
    async ({ query, stage, includeContext, limit, maxPages, after: initialAfter }) =>
      withToolLogging("search_clients", async () => {
        const cleanQuery = query.trim();
        if (isLikelyGovernmentIdQuery(cleanQuery)) {
          return {
            content: [{
              type: "text" as const,
              text:
                "Error: search_clients searches by commercial name only. Government tax identifiers (NIF/NIE/CIF/VAT) are not accepted on the reviewed ChatGPT surface.",
            }],
            isError: true,
          };
        }

        const maxMatches = Math.min(limit ?? 10, 20);
        const pageSize = 100;
        const pagesToScan = Math.min(Math.max(maxPages ?? 3, 1), 5);

        let currentCursor: string | undefined;
        let startOffset = 0;
        if (typeof initialAfter === "string" && initialAfter.trim()) {
          const trimmedAfter = initialAfter.trim();
          const offsetMatch = /^offset:(\d+)$/.exec(trimmedAfter);
          if (offsetMatch) {
            startOffset = Number(offsetMatch[1]);
          } else {
            currentCursor = trimmedAfter;
            const trailingDigits = /(?:^|[_:])(\d+)$/.exec(trimmedAfter);
            if (trailingDigits) {
              startOffset = Number(trailingDigits[1]);
            }
          }
        }

        let currentOffset = startOffset;
        let inspected = 0;
        let total = 0;
        let reachedEndOfDirectory = false;
        let lastNextCursor: string | null = null;
        let directoryPagesFetched = 0;
        let contextRequestsMade = 0;
        let approximatePayloadBytes = 0;

        const scored: Array<{
          record: Record<string, unknown>;
          rank: NameMatchRank;
          score: number;
        }> = [];
        const seenIds = new Set<string>();

        // Do NOT pass `q` to `client.listClients` because backend `q` searches `taxId` / `searchTokens`.
        // Pass `fields: CLIENT_SEARCH_SERVER_PROJECTION` so the backend projects only id,name,stage,email,phone
        // before serializing the response over HTTP.
        for (let page = 0; page < pagesToScan; page++) {
          const reqParams: {
            limit: number;
            fields: string;
            stage?: string;
            after?: string;
            offset?: number;
          } = {
            limit: pageSize,
            fields: CLIENT_SEARCH_SERVER_PROJECTION,
            ...(stage ? { stage } : {}),
          };
          if (currentCursor !== undefined) {
            reqParams.after = currentCursor;
          } else if (currentOffset > 0) {
            reqParams.offset = currentOffset;
          }

          const res = await client.listClients(reqParams);
          directoryPagesFetched++;
          approximatePayloadBytes += approxJsonBytes(res);

          const rows = Array.isArray(res?.data) ? res.data : [];
          if (page === 0) {
            if (typeof res?.offset === "number") {
              startOffset = res.offset;
            }
            total = typeof res?.total === "number" ? res.total : startOffset + rows.length;
          }
          inspected += rows.length;

          for (const row of rows) {
            if (!row || typeof row !== "object") continue;
            const rec = row as Record<string, unknown>;
            const recId = typeof rec.id === "string" ? rec.id : "";
            if (recId && seenIds.has(recId)) continue;
            if (recId) seenIds.add(recId);
            const m = matchCommercialName(rec.name, cleanQuery);
            if (m.matched && m.rank) {
              scored.push({ record: rec, rank: m.rank, score: m.score });
            }
          }

          const nextCursorFromRes = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
          const cumulativePosition = startOffset + inspected;
          const moreByTotal = total > cumulativePosition;
          const hasMore = Boolean(nextCursorFromRes) || (rows.length >= pageSize && moreByTotal);

          if (!hasMore || rows.length === 0) {
            reachedEndOfDirectory = !nextCursorFromRes && cumulativePosition >= total;
            lastNextCursor = nextCursorFromRes ?? (reachedEndOfDirectory ? null : `offset:${cumulativePosition}`);
            break;
          }

          if (nextCursorFromRes) {
            currentCursor = nextCursorFromRes;
            lastNextCursor = nextCursorFromRes;
          } else {
            currentCursor = undefined;
            currentOffset = cumulativePosition;
            lastNextCursor = `offset:${cumulativePosition}`;
          }
        }

        // Epistemic truth: `complete` is true ONLY when this call inspected the entire directory
        // (startOffset === 0, inspected >= total, and no forward cursor remains).
        // When continuing from `after` (startOffset > 0), reaching the end of the directory means
        // `nextCursor` is null (no forward pages remain), while `uninspectedCount` reflects the
        // `total - inspected` records not inspected in this stateless call.
        const complete = startOffset === 0 && reachedEndOfDirectory && inspected >= total && lastNextCursor === null;
        const uninspectedCount = complete ? 0 : Math.max(1, total - inspected);
        const nextCursor = reachedEndOfDirectory ? null : lastNextCursor;

        scored.sort((a, b) => b.score - a.score || String(a.record.name ?? "").localeCompare(String(b.record.name ?? "")));
        // F-02: When ambiguous (scored.length >= 2), always surface at least 2 candidates so
        // callers never receive matchStatus="ambiguous" with only 1 candidate in `matches`.
        const effectiveLimit = scored.length >= 2 ? Math.min(20, Math.max(maxMatches, 2)) : maxMatches;
        const top = scored.slice(0, effectiveLimit);
        const exactCount = scored.filter((x) => x.rank === "exact").length;
        const matchStatus = resolveMatchStatusWithCoverageTruth(scored.length, exactCount, complete);

        const shouldFetchContext = (includeContext ?? true) && top.length >= 1 && top.length <= 3;

        let defaultCurrency: string | undefined;
        const getWorkspaceDefaultCurrency = async (): Promise<string> => {
          if (defaultCurrency) return defaultCurrency;
          defaultCurrency = "EUR";
          try {
            const ctx = await client.getBusinessContext();
            contextRequestsMade++;
            approximatePayloadBytes += approxJsonBytes(ctx);
            const cur = (ctx?.defaults as Record<string, unknown> | undefined)?.currency;
            if (typeof cur === "string" && cur.trim()) {
              defaultCurrency = cur.trim().toUpperCase();
            }
          } catch {
            // Keep EUR fallback if context call fails
          }
          return defaultCurrency;
        };

        const matches: Array<z.infer<typeof matchedClientItemSchema>> = [];
        for (const item of top) {
          const id = String(item.record.id ?? "");
          const name = String(item.record.name ?? "");
          const normTargetName = normalizeSearchText(name);
          const entry: z.infer<typeof matchedClientItemSchema> = {
            id,
            name,
            ...(typeof item.record.stage === "string" ? { stage: item.record.stage } : {}),
            ...(typeof item.record.email === "string" ? { email: item.record.email } : {}),
            ...(typeof item.record.phone === "string" ? { phone: item.record.phone } : {}),
            matchRank: item.rank,
          };

          if (shouldFetchContext && id) {
            const [invRes, actRes] = await Promise.all([
              client.searchInvoices(name, { limit: 5 }).catch(() => ({ data: [] })),
              client.listClientActivities(id, { limit: 5 }).catch(() => ({ data: [] })),
            ]);
            contextRequestsMade += 2;
            approximatePayloadBytes += approxJsonBytes(invRes) + approxJsonBytes(actRes);

            const rawInvRows = Array.isArray(invRes?.data) ? invRes.data : [];
            // F-05: Strict entity isolation: if inv.clientId is present, require exact ID equality
            // (never fall through to prefix matching!). If absent, require exact normalized name equality.
            const invRows = rawInvRows.filter((inv) => {
              if (typeof inv.clientId === "string" && inv.clientId.trim()) {
                return inv.clientId.trim() === id;
              }
              return typeof inv.clientName === "string" && normalizeSearchText(inv.clientName) === normTargetName;
            });
            const actRows = Array.isArray(actRes?.data) ? actRes.data : [];

            const needsFallbackCurrency = invRows.slice(0, 5).some(
              (inv) => typeof inv.currency !== "string" || !inv.currency.trim(),
            );
            const fallbackCur = needsFallbackCurrency ? await getWorkspaceDefaultCurrency() : "EUR";

            entry.context = {
              recentInvoices: invRows.slice(0, 5).map((inv) => ({
                id: String(inv.id ?? ""),
                invoiceNumber:
                  typeof inv.documentNumber === "string"
                    ? inv.documentNumber
                    : typeof inv.invoiceNumber === "string"
                      ? inv.invoiceNumber
                      : null,
                status: typeof inv.status === "string" ? inv.status : "draft",
                issueDate: typeof inv.issueDate === "string" ? inv.issueDate : null,
                dueDate: typeof inv.dueDate === "string" ? inv.dueDate : null,
                amount: serializeProvenancedAmount(resolveDocumentAmount(inv, fallbackCur)),
              })),
              recentActivities: actRows.slice(0, 5).map((act) => ({
                type: typeof act.type === "string" ? act.type : "note",
                title: typeof act.title === "string" ? act.title : "",
                timestamp: typeof act.timestamp === "string" ? act.timestamp : null,
              })),
            };
          }

          matches.push(entry);
        }

        const disambiguationNote =
          matchStatus === "none"
            ? `No clients matched '${cleanQuery}' across the complete workspace directory (${inspected}/${total} records inspected).`
            : matchStatus === "partial_scan_no_match"
              ? `No clients matched '${cleanQuery}' in the inspected directory window (${inspected} of ${total} records inspected; ${uninspectedCount} records remain uninspected). ${nextCursor ? `Continue scanning with after='${nextCursor}' or increase maxPages` : "Scan from offset 0 with higher maxPages"} before concluding the client does not exist.`
              : matchStatus === "partial_scan_single_match"
                ? `Found 1 matching client ('${matches[0].name}', id=${matches[0].id}) in the inspected window (${inspected} of ${total} records), but ${uninspectedCount} directory records were not inspected in this call. Do not assume this is the only match in the workspace; confirm with the user${nextCursor ? ` or continue scanning with after='${nextCursor}'` : ""} before mutating records.`
                : matchStatus === "ambiguous"
                  ? `Found ${scored.length} clients matching '${cleanQuery}'${complete ? "" : ` across ${inspected}/${total} inspected records (${uninspectedCount} uninspected)`} (showing ${matches.length} of ${scored.length} matches). Present all candidate IDs/names and ask the user which client they mean before mutating records.`
                  : `Resolved a unique client match ('${matches[0].name}', id=${matches[0].id}) across the complete directory (${inspected}/${total} records inspected).`;

        const output: z.infer<typeof searchClientsOutputSchema> = {
          query: cleanQuery,
          searchedFields: ["name"],
          matchStatus,
          disambiguationNote,
          coverage: {
            inspected,
            total,
            uninspectedCount,
            complete,
            nextCursor,
            telemetry: {
              directoryPagesFetched,
              contextRequestsMade,
              totalApiRequests: directoryPagesFetched + contextRequestsMade,
              recordsInspected: inspected,
              approximatePayloadBytes,
              serverProjectionFields: CLIENT_SEARCH_SERVER_PROJECTION,
            },
          },
          matches,
        };

        return {
          content: [getContent(formatRecord("Client Search", output as unknown as Record<string, unknown>))],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      }),
  );

  /* ---------------------------------------------------------------- */
  /*  4. search_vendors                                               */
  /* ---------------------------------------------------------------- */
  server.registerTool(
    "search_vendors",
    {
      title: "Search Vendors by Name",
      description:
        "Search vendors/suppliers by commercial name only across paginated directory windows, report exact coverage and " +
        "uninspected record counts, distinguish complete single matches from partial-scan single matches or ambiguous matches, " +
        "and optionally include recent expenses recorded for matched suppliers. Uses server-side field projection so government " +
        "tax identifiers and street addresses are never queried or serialized. " +
        "/ Busca proveedores exclusivamente por nombre comercial en paginas sucesivas del directorio, informa la cobertura exacta " +
        "y registros no inspeccionados, distingue coincidencias unicas completas de muestras parciales o ambiguas, y muestra gastos " +
        "recientes sin consultar ni exponer identificadores fiscales ni direcciones.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .describe(
            `Commercial vendor name to search for (1-100 chars) / Nombre comercial del proveedor — ${OPENAI_REVIEW_FREE_TEXT_WARNING}`,
          ),
        includeRecentExpenses: z
          .boolean()
          .optional()
          .describe("When true (default) and 1-3 vendors match, includes recent matching expenses / Incluir gastos recientes"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum matches to return (1-20, default 10) / Maximo de coincidencias"),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Maximum directory pages (100 records/page) to scan in this call (1-5, default 3 = 300 records) / Paginas maximas a escanear (1-5, por defecto 3)"),
        after: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .optional()
          .describe("Optional continuation token from a previous coverage.nextCursor to scan subsequent directory pages / Cursor de continuacion coverage.nextCursor"),
      },
      outputSchema: searchVendorsOutputSchema,
    },
    async ({ query, includeRecentExpenses, limit, maxPages, after: initialAfter }) =>
      withToolLogging("search_vendors", async () => {
        const cleanQuery = query.trim();
        if (isLikelyGovernmentIdQuery(cleanQuery)) {
          return {
            content: [{
              type: "text" as const,
              text:
                "Error: search_vendors searches by commercial name only. Government tax identifiers (NIF/NIE/CIF/VAT) are not accepted on the reviewed ChatGPT surface.",
            }],
            isError: true,
          };
        }

        const maxMatches = Math.min(limit ?? 10, 20);
        const pageSize = 100;
        const pagesToScan = Math.min(Math.max(maxPages ?? 3, 1), 5);

        let currentCursor: string | undefined;
        let startOffset = 0;
        if (typeof initialAfter === "string" && initialAfter.trim()) {
          const trimmedAfter = initialAfter.trim();
          const offsetMatch = /^offset:(\d+)$/.exec(trimmedAfter);
          if (offsetMatch) {
            startOffset = Number(offsetMatch[1]);
          } else {
            currentCursor = trimmedAfter;
            const trailingDigits = /(?:^|[_:])(\d+)$/.exec(trimmedAfter);
            if (trailingDigits) {
              startOffset = Number(trailingDigits[1]);
            }
          }
        }

        let currentOffset = startOffset;
        let inspected = 0;
        let total = 0;
        let reachedEndOfDirectory = false;
        let lastNextCursor: string | null = null;
        let directoryPagesFetched = 0;
        let contextRequestsMade = 0;
        let approximatePayloadBytes = 0;

        const scored: Array<{
          record: Record<string, unknown>;
          rank: NameMatchRank;
          score: number;
        }> = [];
        const seenIds = new Set<string>();

        // Do NOT pass `q` to `client.listVendors` because backend `q` searches `taxId` / `searchTokens`.
        // Pass `fields: VENDOR_SEARCH_SERVER_PROJECTION` so the backend strips taxId/address/iban before serialization.
        for (let page = 0; page < pagesToScan; page++) {
          const reqParams: {
            limit: number;
            fields: string;
            after?: string;
            offset?: number;
          } = {
            limit: pageSize,
            fields: VENDOR_SEARCH_SERVER_PROJECTION,
          };
          if (currentCursor !== undefined) {
            reqParams.after = currentCursor;
          } else if (currentOffset > 0) {
            reqParams.offset = currentOffset;
          }

          const res = await client.listVendors(reqParams);
          directoryPagesFetched++;
          approximatePayloadBytes += approxJsonBytes(res);

          const rows = Array.isArray(res?.data) ? res.data : [];
          if (page === 0) {
            if (typeof res?.offset === "number") {
              startOffset = res.offset;
            }
            total = typeof res?.total === "number" ? res.total : startOffset + rows.length;
          }
          inspected += rows.length;

          for (const row of rows) {
            if (!row || typeof row !== "object") continue;
            const rec = row as Record<string, unknown>;
            const recId = typeof rec.id === "string" ? rec.id : "";
            if (recId && seenIds.has(recId)) continue;
            if (recId) seenIds.add(recId);
            const m = matchCommercialName(rec.name, cleanQuery);
            if (m.matched && m.rank) {
              scored.push({ record: rec, rank: m.rank, score: m.score });
            }
          }

          const nextCursorFromRes = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
          const cumulativePosition = startOffset + inspected;
          const moreByTotal = total > cumulativePosition;
          const hasMore = Boolean(nextCursorFromRes) || (rows.length >= pageSize && moreByTotal);

          if (!hasMore || rows.length === 0) {
            reachedEndOfDirectory = !nextCursorFromRes && cumulativePosition >= total;
            lastNextCursor = nextCursorFromRes ?? (reachedEndOfDirectory ? null : `offset:${cumulativePosition}`);
            break;
          }

          if (nextCursorFromRes) {
            currentCursor = nextCursorFromRes;
            lastNextCursor = nextCursorFromRes;
          } else {
            currentCursor = undefined;
            currentOffset = cumulativePosition;
            lastNextCursor = `offset:${cumulativePosition}`;
          }
        }

        const complete = startOffset === 0 && reachedEndOfDirectory && inspected >= total && lastNextCursor === null;
        const uninspectedCount = complete ? 0 : Math.max(1, total - inspected);
        const nextCursor = reachedEndOfDirectory ? null : lastNextCursor;

        scored.sort((a, b) => b.score - a.score || String(a.record.name ?? "").localeCompare(String(b.record.name ?? "")));
        const effectiveLimit = scored.length >= 2 ? Math.min(20, Math.max(maxMatches, 2)) : maxMatches;
        const top = scored.slice(0, effectiveLimit);
        const exactCount = scored.filter((x) => x.rank === "exact").length;
        const matchStatus = resolveMatchStatusWithCoverageTruth(scored.length, exactCount, complete);

        const shouldFetchExpenses = (includeRecentExpenses ?? true) && top.length >= 1 && top.length <= 3;
        let recentExpensePool: Array<Record<string, unknown>> = [];
        let fallbackExpenseCurrency = "EUR";
        if (shouldFetchExpenses) {
          const expRes = await client.listExpenses({ limit: 50, offset: 0 }).catch(() => ({ data: [] }));
          contextRequestsMade++;
          approximatePayloadBytes += approxJsonBytes(expRes);
          recentExpensePool = Array.isArray(expRes?.data) ? expRes.data : [];

          const anyMissingCur = recentExpensePool.some((exp) => typeof exp.currency !== "string" || !exp.currency.trim());
          if (anyMissingCur) {
            try {
              const ctx = await client.getBusinessContext();
              contextRequestsMade++;
              approximatePayloadBytes += approxJsonBytes(ctx);
              const cur = (ctx?.defaults as Record<string, unknown> | undefined)?.currency;
              if (typeof cur === "string" && cur.trim()) {
                fallbackExpenseCurrency = cur.trim().toUpperCase();
              }
            } catch {
              // Keep EUR fallback
            }
          }
        }

        const matches: Array<z.infer<typeof matchedVendorItemSchema>> = top.map((item) => {
          const id = String(item.record.id ?? "");
          const name = String(item.record.name ?? "");
          const normTargetVendorName = normalizeSearchText(name);
          const vendorExpenses = shouldFetchExpenses
            ? recentExpensePool
                .filter((exp) => {
                  // F-05: Strict entity isolation on vendorId vs exact normalized vendor name
                  if (typeof exp.vendorId === "string" && exp.vendorId.trim()) {
                    return exp.vendorId.trim() === id;
                  }
                  return typeof exp.vendor === "string" && normalizeSearchText(exp.vendor) === normTargetVendorName;
                })
                .slice(0, 5)
                .map((exp) => ({
                  id: String(exp.id ?? ""),
                  description: typeof exp.description === "string" ? exp.description : "",
                  date: typeof exp.date === "string" ? exp.date : null,
                  category: typeof exp.category === "string" ? exp.category : null,
                  taxDeductible: typeof exp.taxDeductible === "boolean" ? exp.taxDeductible : null,
                  amount: serializeProvenancedAmount(resolveDocumentAmount(exp, fallbackExpenseCurrency)),
                }))
            : undefined;

          return {
            id,
            name,
            ...(typeof item.record.email === "string" ? { email: item.record.email } : {}),
            ...(typeof item.record.phone === "string" ? { phone: item.record.phone } : {}),
            matchRank: item.rank,
            ...(vendorExpenses ? { recentExpenses: vendorExpenses } : {}),
          };
        });

        const disambiguationNote =
          matchStatus === "none"
            ? `No vendors matched '${cleanQuery}' across the complete workspace directory (${inspected}/${total} records inspected).`
            : matchStatus === "partial_scan_no_match"
              ? `No vendors matched '${cleanQuery}' in the inspected directory window (${inspected} of ${total} records inspected; ${uninspectedCount} records remain uninspected). ${nextCursor ? `Continue scanning with after='${nextCursor}' or increase maxPages` : "Scan from offset 0 with higher maxPages"} before concluding the vendor does not exist.`
              : matchStatus === "partial_scan_single_match"
                ? `Found 1 matching vendor ('${matches[0].name}', id=${matches[0].id}) in the inspected window (${inspected} of ${total} records), but ${uninspectedCount} directory records were not inspected in this call. Do not assume this is the only match in the workspace; confirm with the user${nextCursor ? ` or continue scanning with after='${nextCursor}'` : ""} before mutating records.`
                : matchStatus === "ambiguous"
                  ? `Found ${scored.length} vendors matching '${cleanQuery}'${complete ? "" : ` across ${inspected}/${total} inspected records (${uninspectedCount} uninspected)`} (showing ${matches.length} of ${scored.length} matches). Present all candidate IDs/names and ask the user which vendor they mean before mutating records.`
                  : `Resolved a unique vendor match ('${matches[0].name}', id=${matches[0].id}) across the complete directory (${inspected}/${total} records inspected).`;

        const output: z.infer<typeof searchVendorsOutputSchema> = {
          query: cleanQuery,
          searchedFields: ["name"],
          matchStatus,
          disambiguationNote,
          coverage: {
            inspected,
            total,
            uninspectedCount,
            complete,
            nextCursor,
            telemetry: {
              directoryPagesFetched,
              contextRequestsMade,
              totalApiRequests: directoryPagesFetched + contextRequestsMade,
              recordsInspected: inspected,
              approximatePayloadBytes,
              serverProjectionFields: VENDOR_SEARCH_SERVER_PROJECTION,
            },
          },
          matches,
        };

        return {
          content: [getContent(formatRecord("Vendor Search", output as unknown as Record<string, unknown>))],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      }),
  );
}
