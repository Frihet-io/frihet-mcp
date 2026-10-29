/**
 * Candidate 1.0.3 capability expansion for the Frihet ChatGPT (OpenAI) profile.
 *
 * Developed in isolation (branch `feat/openai-1.0.3-candidate`) without mutating
 * the live 1.0.2 production endpoint (`https://openai-mcp.frihet.io/mcp`, 33 tools).
 *
 * Includes:
 * - Four read-only candidate tools (`get_daily_operational_brief`,
 *   `get_business_period_summary`, `search_clients`, `search_vendors`)
 * - One optional phase-2 draft-only mutation candidate (`update_draft_invoice`),
 *   gated separately so it never blocks the four read-only capabilities.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import {
  withToolLogging,
  getContent,
  mutateContent,
  formatRecord,
  READ_ONLY_ANNOTATIONS,
  UPDATE_ANNOTATIONS,
} from "./shared.js";
import {
  generateDailyOperationalBrief,
  resolveDocumentAmount,
  type ProvenancedAmount,
} from "../workflows/daily-operational-brief.js";
import { OPENAI_REVIEW_FREE_TEXT_WARNING } from "../openai-profile.js";

const CALENDAR_MONTH_REGEX = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * Rejects queries that look like Spanish NIF/NIE/CIF or EU VAT numbers so
 * name-only search tools can never be used as government-ID lookup oracles.
 */
export function isLikelyGovernmentIdQuery(raw: string): boolean {
  const compact = raw.replace(/[\s.-]+/g, "").toUpperCase();
  if (compact.length < 7 || compact.length > 15) return false;
  // Spanish NIF (8 digits + letter), NIE (X/Y/Z + 7 digits + letter), CIF (letter + 7 digits + control)
  if (/^[0-9]{8}[A-Z]$/.test(compact)) return true;
  if (/^[XYZ][0-9]{7}[A-Z]$/.test(compact)) return true;
  if (/^[ABCDEFGHJNPQRSUVW][0-9]{7}[0-9A-J]$/.test(compact)) return true;
  // EU VAT prefix + 7..12 alphanumeric with at least 5 digits
  if (/^[A-Z]{2}[A-Z0-9]{7,12}$/.test(compact) && (compact.match(/[0-9]/g)?.length ?? 0) >= 5) {
    return true;
  }
  return false;
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
  if (normName.startsWith(`${normQuery} `) || normName.startsWith(normQuery)) {
    return { matched: true, rank: "prefix", score: 85 };
  }
  const queryTokens = normQuery.split(" ").filter(Boolean);
  const nameTokens = normName.split(" ").filter(Boolean);
  if (
    queryTokens.length > 0 &&
    queryTokens.every((qt) => nameTokens.some((nt) => nt === qt || nt.startsWith(qt)))
  ) {
    return { matched: true, rank: "token", score: 70 };
  }
  if (normName.includes(normQuery)) {
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
  }),
  draftInvoices: z.object({
    note: z.string(),
    count: z.number().int().nonnegative(),
    total: provenancedAmountSchema,
  }),
  issuedInvoices: z.object({
    note: z.string(),
    realOutstandingBalanceDeterminable: z.literal(false),
    count: z.number().int().nonnegative(),
    paidCount: z.number().int().nonnegative(),
    unpaidNominalCount: z.number().int().nonnegative(),
    overdueNominalCount: z.number().int().nonnegative(),
    issuedTotal: provenancedAmountSchema,
    paidTotal: provenancedAmountSchema,
    unpaidNominalTotal: provenancedAmountSchema,
    overdueNominalTotal: provenancedAmountSchema,
  }),
  expenses: z.object({
    count: z.number().int().nonnegative(),
    total: provenancedAmountSchema,
    deductibleCount: z.number().int().nonnegative(),
    deductibleTotal: provenancedAmountSchema,
    nonDeductibleCount: z.number().int().nonnegative(),
    nonDeductibleTotal: provenancedAmountSchema,
    byCategory: z.array(periodCategoryBucketSchema).max(30),
  }),
  netOperatingByCurrency: z.array(
    z.object({
      currency: z.string(),
      issuedRevenueMinusExpenses: z.number().nullable(),
      paidRevenueMinusExpenses: z.number().nullable(),
      completeAndDeterminable: z.boolean(),
    }),
  ).max(10),
});

const periodComparisonDeltaByCurrencySchema = z.object({
  currency: z.string(),
  primaryIssuedRevenue: z.number(),
  comparisonIssuedRevenue: z.number(),
  issuedRevenueDelta: z.number(),
  primaryPaidRevenue: z.number(),
  comparisonPaidRevenue: z.number(),
  paidRevenueDelta: z.number(),
  primaryExpenses: z.number(),
  comparisonExpenses: z.number(),
  expensesDelta: z.number(),
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
  matchStatus: z.enum(["exact", "unambiguous", "ambiguous", "none"]),
  disambiguationNote: z.string(),
  coverage: z.object({
    inspected: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    complete: z.boolean(),
  }),
  matches: z.array(matchedClientItemSchema).max(20),
}).describe("Commercial-name client search with ambiguity detection and optional meeting-prep context");

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
  matchStatus: z.enum(["exact", "unambiguous", "ambiguous", "none"]),
  disambiguationNote: z.string(),
  coverage: z.object({
    inspected: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    complete: z.boolean(),
  }),
  matches: z.array(matchedVendorItemSchema).max(20),
}).describe("Commercial-name vendor search with ambiguity detection and recent expense context");

export const updateDraftInvoiceOutputSchema = z.object({
  id: z.string(),
  invoiceNumber: z.string(),
  status: z.literal("draft"),
  clientName: z.string(),
  issueDate: z.string(),
  dueDate: z.string().optional(),
  currency: z.string().optional(),
  taxRate: z.number().optional(),
  discountRate: z.number().optional(),
  notes: z.string().optional(),
  items: z.array(
    z.object({
      description: z.string(),
      quantity: z.number(),
      unitPrice: z.number(),
      taxRate: z.number().optional(),
      discount: z.number().optional(),
    }),
  ).max(100),
  externalEffects: z.array(z.string()),
}).describe("Updated draft invoice after atomic draft-state verification");

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

  const invoices: Array<Record<string, unknown>> = [];
  let invoicesTotal = 0;
  let invoicesComplete = true;
  for (let page = 0; page < maxPages; page++) {
    const res = await client.listInvoices({ from, to, limit: pageSize, offset: page * pageSize });
    const rows = Array.isArray(res?.data) ? res.data : [];
    if (page === 0) {
      invoicesTotal = typeof res?.total === "number" ? res.total : rows.length;
    }
    invoices.push(...rows);
    const hasMore = Boolean(res?.nextCursor) || invoices.length < invoicesTotal;
    if (!hasMore || rows.length < pageSize) break;
    if (page === maxPages - 1 && invoices.length < invoicesTotal) {
      invoicesComplete = false;
    }
  }
  if (invoices.length < invoicesTotal) invoicesComplete = false;

  const expenses: Array<Record<string, unknown>> = [];
  let expensesTotal = 0;
  let expensesComplete = true;
  for (let page = 0; page < maxPages; page++) {
    const res = await client.listExpenses({ from, to, limit: pageSize, offset: page * pageSize });
    const rows = Array.isArray(res?.data) ? res.data : [];
    if (page === 0) {
      expensesTotal = typeof res?.total === "number" ? res.total : rows.length;
    }
    expenses.push(...rows);
    const hasMore = Boolean(res?.nextCursor) || expenses.length < expensesTotal;
    if (!hasMore || rows.length < pageSize) break;
    if (page === maxPages - 1 && expenses.length < expensesTotal) {
      expensesComplete = false;
    }
  }
  if (expenses.length < expensesTotal) expensesComplete = false;

  const draftInvoices = invoices.filter((inv) => (inv.status ?? "draft") === "draft");
  const issuedInvoices = invoices.filter((inv) => {
    const st = String(inv.status ?? "draft");
    return st !== "draft" && st !== "cancelled" && st !== "void";
  });
  const paidInvoices = issuedInvoices.filter((inv) => inv.status === "paid");
  const unpaidInvoices = issuedInvoices.filter((inv) => inv.status !== "paid");
  const overdueInvoices = unpaidInvoices.filter((inv) => inv.status === "overdue");

  const deductibleExpenses = expenses.filter((exp) => exp.taxDeductible !== false);
  const nonDeductibleExpenses = expenses.filter((exp) => exp.taxDeductible === false);

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
  const paidTotal = aggregateAmounts(paidInvoices, defaultCurrency, "sum(paid_invoices)");
  const unpaidNominalTotal = aggregateAmounts(unpaidInvoices, defaultCurrency, "sum(unpaid_nominal_invoices)");
  const overdueNominalTotal = aggregateAmounts(overdueInvoices, defaultCurrency, "sum(overdue_nominal_invoices)");
  const expTotal = aggregateAmounts(expenses, defaultCurrency, "sum(expenses)");
  const dedTotal = aggregateAmounts(deductibleExpenses, defaultCurrency, "sum(deductible_expenses)");
  const nonDedTotal = aggregateAmounts(nonDeductibleExpenses, defaultCurrency, "sum(non_deductible_expenses)");

  const allCurrencies = new Set<string>([
    ...issuedTotal.totalsByCurrency.map((b) => b.currency),
    ...paidTotal.totalsByCurrency.map((b) => b.currency),
    ...expTotal.totalsByCurrency.map((b) => b.currency),
  ]);

  const isComplete = invoicesComplete && expensesComplete;
  const determinable =
    isComplete &&
    issuedTotal.unavailableCount === 0 &&
    paidTotal.unavailableCount === 0 &&
    expTotal.unavailableCount === 0;

  const netOperatingByCurrency = [...allCurrencies].sort().map((currency) => {
    const issuedBucket = issuedTotal.totalsByCurrency.find((b) => b.currency === currency)?.amount ?? 0;
    const paidBucket = paidTotal.totalsByCurrency.find((b) => b.currency === currency)?.amount ?? 0;
    const expBucket = expTotal.totalsByCurrency.find((b) => b.currency === currency)?.amount ?? 0;
    return {
      currency,
      issuedRevenueMinusExpenses: determinable ? roundCurrency(issuedBucket - expBucket) : null,
      paidRevenueMinusExpenses: determinable ? roundCurrency(paidBucket - expBucket) : null,
      completeAndDeterminable: determinable,
    };
  });

  return {
    period,
    coverage: {
      invoicesInspected: invoices.length,
      invoicesTotal,
      invoicesComplete,
      expensesInspected: expenses.length,
      expensesTotal,
      expensesComplete,
      isComplete,
    },
    draftInvoices: {
      note: "Draft invoices are non-issued working documents and are excluded from issued revenue.",
      count: draftInvoices.length,
      total: draftTotal,
    },
    issuedInvoices: {
      note: "Unpaid totals represent nominal invoice amounts not marked as paid; real outstanding balance cannot be determined without partial-payment or bank-reconciliation records.",
      realOutstandingBalanceDeterminable: false,
      count: issuedInvoices.length,
      paidCount: paidInvoices.length,
      unpaidNominalCount: unpaidInvoices.length,
      overdueNominalCount: overdueInvoices.length,
      issuedTotal,
      paidTotal,
      unpaidNominalTotal,
      overdueNominalTotal,
    },
    expenses: {
      count: expenses.length,
      total: expTotal,
      deductibleCount: deductibleExpenses.length,
      deductibleTotal: dedTotal,
      nonDeductibleCount: nonDeductibleExpenses.length,
      nonDeductibleTotal: nonDedTotal,
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
  if (category === "client_followup") return "get_client";
  return "get_business_context";
}

export interface RegisterOpenAI103Options {
  includeDraftInvoiceEdit?: boolean;
}

export function registerOpenAI103CandidateTools(
  server: McpServer,
  client: IFrihetClient,
  options: RegisterOpenAI103Options = {},
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
        "with optional side-by-side comparison against another month. Aggregates strictly by currency without cross-currency " +
        "conversion, separates drafts from issued revenue, and excludes regulated tax-return calculations. " +
        "/ Obtiene el resumen operativo de un mes (YYYY-MM) y permite compararlo con otro mes por moneda, " +
        "separando borradores de facturacion emitida y sin incluir calculos de declaraciones fiscales.",
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
          comparisonPeriod = await computeSinglePeriodSummary(client, compareWithPeriod, defaultCurrency);
          const currencies = new Set<string>([
            ...primaryPeriod.issuedInvoices.issuedTotal.totalsByCurrency.map((b) => b.currency),
            ...comparisonPeriod.issuedInvoices.issuedTotal.totalsByCurrency.map((b) => b.currency),
            ...primaryPeriod.expenses.total.totalsByCurrency.map((b) => b.currency),
            ...comparisonPeriod.expenses.total.totalsByCurrency.map((b) => b.currency),
          ]);

          const deltasByCurrency = [...currencies].sort().map((currency) => {
            const pIssued =
              primaryPeriod.issuedInvoices.issuedTotal.totalsByCurrency.find((b) => b.currency === currency)?.amount ?? 0;
            const cIssued =
              comparisonPeriod!.issuedInvoices.issuedTotal.totalsByCurrency.find((b) => b.currency === currency)?.amount ?? 0;
            const pPaid =
              primaryPeriod.issuedInvoices.paidTotal.totalsByCurrency.find((b) => b.currency === currency)?.amount ?? 0;
            const cPaid =
              comparisonPeriod!.issuedInvoices.paidTotal.totalsByCurrency.find((b) => b.currency === currency)?.amount ?? 0;
            const pExp =
              primaryPeriod.expenses.total.totalsByCurrency.find((b) => b.currency === currency)?.amount ?? 0;
            const cExp =
              comparisonPeriod!.expenses.total.totalsByCurrency.find((b) => b.currency === currency)?.amount ?? 0;

            return {
              currency,
              primaryIssuedRevenue: pIssued,
              comparisonIssuedRevenue: cIssued,
              issuedRevenueDelta: roundCurrency(pIssued - cIssued),
              primaryPaidRevenue: pPaid,
              comparisonPaidRevenue: cPaid,
              paidRevenueDelta: roundCurrency(pPaid - cPaid),
              primaryExpenses: pExp,
              comparisonExpenses: cExp,
              expensesDelta: roundCurrency(pExp - cExp),
            };
          });

          const bothComplete = primaryPeriod.coverage.isComplete && comparisonPeriod.coverage.isComplete;
          const notes: string[] = [];
          if (!bothComplete) {
            notes.push(
              "One or both periods exceeded the bounded inspection cap; deltas reflect only the inspected sample.",
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
            "Operational period summary based on invoice issueDate and expense date. Draft and cancelled invoices are excluded from issued revenue. Multi-currency totals are kept in separate currency buckets without conversion. Regulated tax-filing figures are omitted.",
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
        "Search clients by commercial name only, detect ambiguous matches, and optionally retrieve meeting-prep context " +
        "(recent invoices and recent CRM activities). Does not query or expose government tax identifiers or street addresses. " +
        "/ Busca clientes exclusivamente por nombre comercial, detecta coincidencias ambiguas y recupera contexto " +
        "de facturas y actividades recientes sin consultar ni exponer identificadores fiscales ni direcciones.",
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
      },
      outputSchema: searchClientsOutputSchema,
    },
    async ({ query, stage, includeContext, limit }) =>
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
        const maxPages = 5;
        let after: string | undefined;
        let inspected = 0;
        let total = 0;
        let complete = true;
        const scored: Array<{
          record: Record<string, unknown>;
          rank: NameMatchRank;
          score: number;
        }> = [];

        // Do NOT pass `q` to `client.listClients` because backend `q` searches `taxId`.
        // Instead, scan pages and match exclusively on `record.name`.
        for (let page = 0; page < maxPages; page++) {
          const res = await client.listClients({ limit: pageSize, after, stage });
          const rows = Array.isArray(res?.data) ? res.data : [];
          if (page === 0) {
            total = typeof res?.total === "number" ? res.total : rows.length;
          }
          inspected += rows.length;
          for (const row of rows) {
            if (!row || typeof row !== "object") continue;
            const m = matchCommercialName((row as Record<string, unknown>).name, cleanQuery);
            if (m.matched && m.rank) {
              scored.push({ record: row as Record<string, unknown>, rank: m.rank, score: m.score });
            }
          }
          const nextCursor = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
          const hasMore = Boolean(nextCursor);
          if (!hasMore || rows.length < pageSize) break;
          after = nextCursor;
          if (page === maxPages - 1 && inspected < total) {
            complete = false;
          }
        }
        if (inspected < total) complete = false;

        scored.sort((a, b) => b.score - a.score || String(a.record.name ?? "").localeCompare(String(b.record.name ?? "")));
        const top = scored.slice(0, maxMatches);
        const exactCount = top.filter((x) => x.rank === "exact").length;
        const matchStatus: "exact" | "unambiguous" | "ambiguous" | "none" =
          top.length === 0
            ? "none"
            : exactCount === 1 && top.length === 1
              ? "exact"
              : top.length === 1
                ? "unambiguous"
                : "ambiguous";

        const shouldFetchContext = (includeContext ?? true) && top.length >= 1 && top.length <= 3;

        const matches: Array<z.infer<typeof matchedClientItemSchema>> = [];
        for (const item of top) {
          const id = String(item.record.id ?? "");
          const name = String(item.record.name ?? "");
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
            const invRows = Array.isArray(invRes?.data) ? invRes.data : [];
            const actRows = Array.isArray(actRes?.data) ? actRes.data : [];

            entry.context = {
              recentInvoices: invRows.slice(0, 5).map((inv) => ({
                id: String(inv.id ?? ""),
                invoiceNumber: typeof inv.documentNumber === "string" ? inv.documentNumber : null,
                status: typeof inv.status === "string" ? inv.status : "draft",
                issueDate: typeof inv.issueDate === "string" ? inv.issueDate : null,
                dueDate: typeof inv.dueDate === "string" ? inv.dueDate : null,
                amount: serializeProvenancedAmount(resolveDocumentAmount(inv, "EUR")),
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
            ? "No clients matched the commercial name query in the inspected directory window."
            : matchStatus === "ambiguous"
              ? `Found ${scored.length} clients matching '${cleanQuery}'. Ask the user to confirm which client ID/name they mean before mutating records.`
              : `Resolved a single client match ('${matches[0].name}', id=${matches[0].id}).`;

        const output: z.infer<typeof searchClientsOutputSchema> = {
          query: cleanQuery,
          searchedFields: ["name"],
          matchStatus,
          disambiguationNote,
          coverage: {
            inspected,
            total,
            complete,
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
        "Search vendors/suppliers by commercial name only, detect ambiguous matches, and optionally include recent expenses " +
        "recorded for matched suppliers. Does not query or expose government tax identifiers or street addresses. " +
        "/ Busca proveedores exclusivamente por nombre comercial, detecta coincidencias ambiguas y muestra gastos recientes " +
        "asociados sin consultar ni exponer identificadores fiscales ni direcciones.",
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
      },
      outputSchema: searchVendorsOutputSchema,
    },
    async ({ query, includeRecentExpenses, limit }) =>
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
        const maxPages = 5;
        let after: string | undefined;
        let inspected = 0;
        let total = 0;
        let complete = true;
        const scored: Array<{
          record: Record<string, unknown>;
          rank: NameMatchRank;
          score: number;
        }> = [];

        // Do NOT pass `q` to `client.listVendors` because backend `q` searches `taxId`.
        // Scan pages and match exclusively on `record.name`.
        for (let page = 0; page < maxPages; page++) {
          const res = await client.listVendors({ limit: pageSize, after });
          const rows = Array.isArray(res?.data) ? res.data : [];
          if (page === 0) {
            total = typeof res?.total === "number" ? res.total : rows.length;
          }
          inspected += rows.length;
          for (const row of rows) {
            if (!row || typeof row !== "object") continue;
            const m = matchCommercialName((row as Record<string, unknown>).name, cleanQuery);
            if (m.matched && m.rank) {
              scored.push({ record: row as Record<string, unknown>, rank: m.rank, score: m.score });
            }
          }
          const nextCursor = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
          const hasMore = Boolean(nextCursor);
          if (!hasMore || rows.length < pageSize) break;
          after = nextCursor;
          if (page === maxPages - 1 && inspected < total) {
            complete = false;
          }
        }
        if (inspected < total) complete = false;

        scored.sort((a, b) => b.score - a.score || String(a.record.name ?? "").localeCompare(String(b.record.name ?? "")));
        const top = scored.slice(0, maxMatches);
        const exactCount = top.filter((x) => x.rank === "exact").length;
        const matchStatus: "exact" | "unambiguous" | "ambiguous" | "none" =
          top.length === 0
            ? "none"
            : exactCount === 1 && top.length === 1
              ? "exact"
              : top.length === 1
                ? "unambiguous"
                : "ambiguous";

        const shouldFetchExpenses = (includeRecentExpenses ?? true) && top.length >= 1 && top.length <= 3;
        let recentExpensePool: Array<Record<string, unknown>> = [];
        if (shouldFetchExpenses) {
          const expRes = await client.listExpenses({ limit: 50, offset: 0 }).catch(() => ({ data: [] }));
          recentExpensePool = Array.isArray(expRes?.data) ? expRes.data : [];
        }

        const matches: Array<z.infer<typeof matchedVendorItemSchema>> = top.map((item) => {
          const id = String(item.record.id ?? "");
          const name = String(item.record.name ?? "");
          const vendorExpenses = shouldFetchExpenses
            ? recentExpensePool
                .filter((exp) => {
                  if (typeof exp.vendorId === "string" && exp.vendorId === id) return true;
                  return matchCommercialName(exp.vendor, name).matched;
                })
                .slice(0, 5)
                .map((exp) => ({
                  id: String(exp.id ?? ""),
                  description: typeof exp.description === "string" ? exp.description : "",
                  date: typeof exp.date === "string" ? exp.date : null,
                  category: typeof exp.category === "string" ? exp.category : null,
                  taxDeductible: typeof exp.taxDeductible === "boolean" ? exp.taxDeductible : null,
                  amount: serializeProvenancedAmount(resolveDocumentAmount(exp, "EUR")),
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
            ? "No vendors matched the commercial name query in the inspected directory window."
            : matchStatus === "ambiguous"
              ? `Found ${scored.length} vendors matching '${cleanQuery}'. Ask the user to confirm which vendor ID/name they mean before mutating records.`
              : `Resolved a single vendor match ('${matches[0].name}', id=${matches[0].id}).`;

        const output: z.infer<typeof searchVendorsOutputSchema> = {
          query: cleanQuery,
          searchedFields: ["name"],
          matchStatus,
          disambiguationNote,
          coverage: {
            inspected,
            total,
            complete,
          },
          matches,
        };

        return {
          content: [getContent(formatRecord("Vendor Search", output as unknown as Record<string, unknown>))],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      }),
  );

  /* ---------------------------------------------------------------- */
  /*  5. Optional Phase-2 Study: update_draft_invoice                 */
  /* ---------------------------------------------------------------- */
  if (options.includeDraftInvoiceEdit) {
    server.registerTool(
      "update_draft_invoice",
      {
        title: "Update Draft Invoice",
        description:
          "Update an existing invoice ONLY if it is currently in 'draft' status and has no fiscal hash or e-invoice submission. " +
          "Verifies expectedDocumentNumber and draft state before applying changes, forces status='draft', and cannot issue, send, " +
          "mark paid, or alter fiscal series. Active owner-configured webhooks may receive the resulting invoice.updated event. " +
          "Requires confirm=true. [openWorldHint: true — may deliver a business event to owner-configured webhook endpoints.] " +
          "/ Actualiza una factura UNICAMENTE si esta en estado borrador ('draft') y sin huella fiscal. Verifica expectedDocumentNumber " +
          "y mantiene status='draft'; no puede emitir, enviar ni marcar como pagada la factura.",
        annotations: {
          ...UPDATE_ANNOTATIONS,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          id: z.string().min(1).describe("Invoice ID to update / ID de la factura en borrador"),
          expectedDocumentNumber: z
            .string()
            .min(1)
            .describe("Current documentNumber read via get_invoice to prevent concurrent overwrite / Numero de borrador esperado"),
          clientName: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .optional()
            .describe(`Updated client commercial name / Nombre del cliente — ${OPENAI_REVIEW_FREE_TEXT_WARNING}`),
          issueDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format")
            .optional()
            .describe("Updated issue date (YYYY-MM-DD) / Fecha de emision"),
          dueDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format")
            .optional()
            .describe("Updated due date (YYYY-MM-DD) / Fecha de vencimiento"),
          currency: z
            .string()
            .regex(/^[A-Z]{3}$/, "Use 3-letter ISO currency code")
            .optional()
            .describe("3-letter ISO currency code (e.g. EUR) / Moneda ISO"),
          taxRate: z.number().min(0).max(100).optional().describe("Default tax rate % / Tipo de IVA %"),
          discountRate: z.number().min(0).max(100).optional().describe("Document discount % / Descuento %"),
          notes: z
            .string()
            .max(1000)
            .optional()
            .describe(`Updated draft notes / Notas — ${OPENAI_REVIEW_FREE_TEXT_WARNING}`),
          items: z
            .array(
              z.object({
                description: z
                  .string()
                  .min(1)
                  .max(500)
                  .describe(`Line item description / Concepto — ${OPENAI_REVIEW_FREE_TEXT_WARNING}`),
                quantity: z.number().positive().describe("Quantity / Cantidad"),
                unitPrice: z.number().nonnegative().describe("Unit price / Precio unitario"),
                taxRate: z.number().min(0).max(100).optional().describe("Line tax rate % / IVA %"),
                discount: z.number().min(0).max(100).optional().describe("Line discount % / Descuento %"),
              }),
            )
            .min(1)
            .max(100)
            .optional()
            .describe("Replacement line items array (1-100 items) / Conceptos del borrador"),
          idempotencyKey: z
            .string()
            .min(8)
            .max(128)
            .optional()
            .describe("Optional idempotency key / Clave de idempotencia"),
        },
        outputSchema: updateDraftInvoiceOutputSchema,
      },
      async (input) =>
        withToolLogging("update_draft_invoice", async () => {
          const {
            id,
            expectedDocumentNumber,
            clientName,
            issueDate,
            dueDate,
            currency,
            taxRate,
            discountRate,
            notes,
            items,
            idempotencyKey,
          } = input;

          const hasEditableField =
            clientName !== undefined ||
            issueDate !== undefined ||
            dueDate !== undefined ||
            currency !== undefined ||
            taxRate !== undefined ||
            discountRate !== undefined ||
            notes !== undefined ||
            items !== undefined;

          if (!hasEditableField) {
            return {
              content: [{
                type: "text" as const,
                text: "Error: provide at least one editable draft field (clientName, issueDate, dueDate, currency, taxRate, discountRate, notes, or items).",
              }],
              isError: true,
            };
          }

          // Pre-flight state check: verify the invoice is a clean draft and matches expectedDocumentNumber.
          const current = await client.getInvoice(id);
          if (!current || typeof current !== "object") {
            return {
              content: [{ type: "text" as const, text: `Error: invoice '${id}' was not found.` }],
              isError: true,
            };
          }

          const currentStatus = String(current.status ?? "");
          if (currentStatus !== "draft") {
            return {
              content: [{
                type: "text" as const,
                text: `Error: update_draft_invoice only edits invoices in 'draft' status (current status is '${currentStatus}'). Issued, sent, paid, overdue, or cancelled invoices cannot be modified through this tool.`,
              }],
              isError: true,
            };
          }

          if (
            current.fiscalStage === "shopify_order_staged" ||
            current.fiscalIssuanceAuthorized === false ||
            Boolean(current.verifactu) ||
            Boolean(current.einvoiceStatus)
          ) {
            return {
              content: [{
                type: "text" as const,
                text: "Error: this invoice has fiscal containment or e-invoicing metadata and cannot be edited via update_draft_invoice.",
              }],
              isError: true,
            };
          }

          const currentDocNumber = typeof current.documentNumber === "string" ? current.documentNumber : "";
          if (currentDocNumber !== expectedDocumentNumber.trim()) {
            return {
              content: [{
                type: "text" as const,
                text: `Error: expectedDocumentNumber mismatch (expected '${expectedDocumentNumber.trim()}', found '${currentDocNumber || "none"}'). Re-read the invoice with get_invoice before editing.`,
              }],
              isError: true,
            };
          }

          const patchPayload: Record<string, unknown> = {
            status: "draft",
            ...(clientName !== undefined ? { clientName } : {}),
            ...(issueDate !== undefined ? { issueDate } : {}),
            ...(dueDate !== undefined ? { dueDate } : {}),
            ...(currency !== undefined ? { currency } : {}),
            ...(taxRate !== undefined ? { taxRate } : {}),
            ...(discountRate !== undefined ? { discountRate } : {}),
            ...(notes !== undefined ? { notes } : {}),
            ...(items !== undefined ? { items } : {}),
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
          };

          const updated = await client.updateInvoice(id, patchPayload);
          const resultObj: z.infer<typeof updateDraftInvoiceOutputSchema> = {
            id: String(updated.id ?? id),
            invoiceNumber: String(updated.documentNumber ?? currentDocNumber),
            status: "draft",
            clientName: String(updated.clientName ?? clientName ?? current.clientName ?? ""),
            issueDate: String(updated.issueDate ?? issueDate ?? current.issueDate ?? ""),
            ...(typeof (updated.dueDate ?? dueDate ?? current.dueDate) === "string"
              ? { dueDate: String(updated.dueDate ?? dueDate ?? current.dueDate) }
              : {}),
            ...(typeof (updated.currency ?? currency ?? current.currency) === "string"
              ? { currency: String(updated.currency ?? currency ?? current.currency) }
              : {}),
            ...(typeof (updated.taxRate ?? taxRate ?? current.taxRate) === "number"
              ? { taxRate: Number(updated.taxRate ?? taxRate ?? current.taxRate) }
              : {}),
            ...(typeof (updated.discountRate ?? discountRate ?? current.discountRate) === "number"
              ? { discountRate: Number(updated.discountRate ?? discountRate ?? current.discountRate) }
              : {}),
            ...(typeof (updated.notes ?? notes ?? current.notes) === "string"
              ? { notes: String(updated.notes ?? notes ?? current.notes) }
              : {}),
            items: (Array.isArray(updated.items)
              ? updated.items
              : Array.isArray(items)
                ? items
                : Array.isArray(current.items)
                  ? current.items
                  : []
            ).slice(0, 100).map((it: Record<string, unknown>) => ({
              description: String(it.description ?? ""),
              quantity: Number(it.quantity ?? 1),
              unitPrice: Number(it.unitPrice ?? 0),
              ...(typeof it.taxRate === "number" ? { taxRate: it.taxRate } : {}),
              ...(typeof it.discount === "number" ? { discount: it.discount } : {}),
            })),
            externalEffects: [
              "One or more active webhook endpoints previously configured by the workspace owner may receive the full resulting invoice.updated event.",
            ],
          };

          return {
            content: [mutateContent(formatRecord("Updated Draft Invoice", resultObj as unknown as Record<string, unknown>))],
            structuredContent: resultObj as unknown as Record<string, unknown>,
          };
        }),
    );
  }
}
