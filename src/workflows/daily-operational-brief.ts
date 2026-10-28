/**
 * Daily Operational Brief workflow ("¿Qué debería revisar hoy en mi negocio y por qué?").
 *
 * Grounded strictly in read-only Frihet workspace tools:
 * - get_business_context
 * - list_invoices
 * - list_quotes
 * - list_expenses
 * - list_clients
 * - list_client_activities
 *
 * Enforces:
 * 1. Explicit temporal scope (`unfiltered_operational_sample_as_of_date` vs `currentMonthActivity`)
 *    and per-resource coverage (inspected vs total records).
 * 2. Strict separation between draft documents (non-issued) and real/issued activity.
 * 3. Explicit amount provenance (`stored_field`, `derived_from_items`, `business_context_summary`,
 *    `unavailable`, or `mixed_currency_unconverted`).
 *    - Absent/corrupt amounts NEVER coerce to 0 (`amount: null`, `provenance: "unavailable"`).
 *    - Multi-currency totals NEVER sum across currencies without conversion (`totalsByCurrency`, `currency: "MIXED"`).
 *    - Derived line-item totals apply canonical per-line `discount`, document `discountRate`,
 *      `taxRate`, `equivalenceSurchargeRate`, and `irpfRate` over the discounted tax-exclusive base.
 * 4. Honest unpaid invoice semantics: full nominal totals of unpaid invoices are labeled
 *    "importe nominal de facturas no marcadas como pagadas; saldo pendiente real no determinable
 *    sin desglose de cobros parciales ni conciliación bancaria" (`realOutstandingBalanceDeterminable: false`).
 * 5. Record-backed prioritized review items and suggested next actions without auto-executing writes.
 * 6. Explicit declaration of what cannot be determined ("knownUnknowns").
 */

import type { IFrihetClient } from "../client-interface.js";

export type AmountProvenanceKind =
  | "stored_field"
  | "derived_from_items"
  | "business_context_summary"
  | "unavailable"
  | "mixed_currency_unconverted";

export interface CurrencyBucketAmount {
  amount: number;
  currency: string;
  provenance: "stored_field" | "derived_from_items";
  documentCount: number;
}

export interface ProvenancedAmount {
  amount: number | null;
  currency: string;
  provenance: AmountProvenanceKind;
  fieldOrFormula: string;
  totalsByCurrency?: Record<string, CurrencyBucketAmount>;
  unavailableCount?: number;
}

export interface ResourceCoverage {
  collection: "invoices" | "quotes" | "expenses" | "clients" | "client_activities";
  sourceTool: string;
  inspected: number;
  total: number;
  complete: boolean;
}

export interface BriefCoverageSummary {
  asOfDate: string;
  periodMonth: string;
  referenceMonth: string;
  temporalScope: "unfiltered_operational_sample_as_of_date";
  temporalScopeNote: string;
  isPartial: boolean;
  resources: Record<
    "invoices" | "quotes" | "expenses" | "clients" | "client_activities",
    ResourceCoverage
  >;
}

export interface BriefDocumentSummary {
  id: string;
  documentNumber: string | null;
  status: string;
  counterpartyName: string;
  issueDate: string | null;
  dueDate: string | null;
  amount: ProvenancedAmount;
}

export interface BriefPriorityItem {
  priority: "high" | "medium" | "low";
  category:
    | "overdue_invoice"
    | "draft_invoice"
    | "draft_or_expiring_quote"
    | "expense_review"
    | "client_followup"
    | "plan_quota";
  title: string;
  why: string;
  recordRefs: Array<{
    type: "invoice" | "quote" | "expense" | "client" | "client_activity" | "plan_quota";
    id: string;
    label: string;
  }>;
  amount?: ProvenancedAmount;
  suggestedNextAction: {
    description: string;
    recommendedTool: string;
    requiresConfirmation: boolean;
    autoExecuted: false;
  };
}

export interface DailyOperationalBrief {
  question: string;
  coverage: BriefCoverageSummary;
  activitySeparation: {
    draftActivity: {
      note: string;
      invoiceDraftsCount: number;
      invoiceDraftsTotal: ProvenancedAmount;
      invoiceDrafts: BriefDocumentSummary[];
      quoteDraftsCount: number;
      quoteDraftsTotal: ProvenancedAmount;
      quoteDrafts: BriefDocumentSummary[];
    };
    issuedActivity: {
      note: string;
      realOutstandingBalanceDeterminable: false;
      unpaidNominalSemantics: "nominal_unpaid_invoice_totals_without_partial_payments";
      issuedInvoicesCount: number;
      issuedInvoicesByStatus: Record<string, number>;
      issuedInvoicesTotal: ProvenancedAmount;
      issuedInvoices: BriefDocumentSummary[];
      paidInvoicesCount: number;
      paidInvoicesTotal: ProvenancedAmount;
      paidInvoices: BriefDocumentSummary[];
      unpaidNominalInvoicesCount: number;
      unpaidNominalTotal: ProvenancedAmount;
      unpaidNominalTotalsByCurrency: Record<string, CurrencyBucketAmount>;
      overdueNominalInvoicesCount: number;
      overdueNominalTotal: ProvenancedAmount;
      onTimeNominalPendingCount: number;
      onTimeNominalPendingTotal: ProvenancedAmount;
      outstandingInvoicesCount: number;
      outstandingInvoicesTotal: ProvenancedAmount;
      overdueInvoicesCount: number;
      overdueInvoicesTotal: ProvenancedAmount;
      onTimePendingCount: number;
      onTimePendingTotal: ProvenancedAmount;
      outstandingInvoices: BriefDocumentSummary[];
    };
    recordedExpenses: {
      note: string;
      expensesCount: number;
      expensesTotal: ProvenancedAmount;
      deductibleCount: number;
      deductibleTotal: ProvenancedAmount;
      nonDeductibleCount: number;
      nonDeductibleTotal: ProvenancedAmount;
      pendingReviewCount: number;
    };
    currentMonthActivity: {
      referenceMonth: string;
      note: string;
      issuedInvoicesInMonthCount: number;
      issuedInvoicesInMonthTotal: ProvenancedAmount;
      invoiceDraftsInMonthCount: number;
      invoiceDraftsInMonthTotal: ProvenancedAmount;
      expensesInMonthCount: number;
      expensesInMonthTotal: ProvenancedAmount;
    };
  };
  priorities: BriefPriorityItem[];
  knownUnknowns: string[];
  mutationsExecuted: 0;
  markdown: string;
}

export interface GenerateDailyBriefOptions {
  asOfDate?: string;
  pageLimit?: number;
  maxActivityClients?: number;
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function isFiniteRateInRange(value: unknown, min = 0, max = 100): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function formatProvenancedAmount(p: ProvenancedAmount): string {
  if (p.provenance === "mixed_currency_unconverted" && p.totalsByCurrency) {
    const parts = Object.values(p.totalsByCurrency).map(
      (bucket) => `${bucket.amount.toFixed(2)} ${bucket.currency}`,
    );
    return `MIXED (${parts.join(" + ")})`;
  }
  if (p.amount === null || p.provenance === "unavailable") {
    const unavailableCount = p.unavailableCount ?? 1;
    const knownParts = p.totalsByCurrency
      ? Object.values(p.totalsByCurrency).map((b) => `${b.amount.toFixed(2)} ${b.currency}`)
      : [];
    if (knownParts.length > 0) {
      return `NO DETERMINADO (${unavailableCount} doc(s) sin importe válido; parcial conocido: ${knownParts.join(" + ")})`;
    }
    return `NO DETERMINADO (${unavailableCount} doc(s) sin importe válido)`;
  }
  return `${p.amount.toFixed(2)} ${p.currency}`;
}

export function resolveDocumentAmount(
  doc: Record<string, unknown>,
  defaultCurrency = "EUR",
): ProvenancedAmount {
  const currency =
    typeof doc.currency === "string" && doc.currency.trim()
      ? doc.currency.trim().toUpperCase()
      : defaultCurrency.trim().toUpperCase();

  if (typeof doc.total === "number" && Number.isFinite(doc.total)) {
    return {
      amount: roundCurrency(doc.total),
      currency,
      provenance: "stored_field",
      fieldOrFormula: "doc.total",
    };
  }

  if (typeof doc.amount === "number" && Number.isFinite(doc.amount)) {
    return {
      amount: roundCurrency(doc.amount),
      currency,
      provenance: "stored_field",
      fieldOrFormula: "doc.amount",
    };
  }

  // Absent != 0: if neither stored total nor stored amount exists, we require a non-empty
  // items array where every line item has finite non-negative quantity and unitPrice, and no
  // unsupported calculation modifiers are present.
  if (!Array.isArray(doc.items) || doc.items.length === 0) {
    return {
      amount: null,
      currency,
      provenance: "unavailable",
      fieldOrFormula: "unavailable (missing total, amount, and valid line items)",
      unavailableCount: 1,
    };
  }

  // Reject unsupported or invalid document-level calculation modifiers when stored total is missing
  if (
    doc.pricesIncludeTax === true ||
    doc.deductLineDiscountAmounts === true ||
    (Array.isArray(doc.compoundTaxes) && doc.compoundTaxes.length > 0) ||
    (doc.prepayment !== undefined && doc.prepayment !== null && doc.prepayment !== 0) ||
    !isFiniteRateInRange(doc.discountRate, 0, 100) ||
    !isFiniteRateInRange(doc.taxRate, 0, 100) ||
    !isFiniteRateInRange(doc.irpfRate, 0, 100) ||
    !isFiniteRateInRange(doc.equivalenceSurchargeRate, 0, 100)
  ) {
    return {
      amount: null,
      currency,
      provenance: "unavailable",
      fieldOrFormula: "unavailable (unsupported or invalid calculation modifiers without stored total)",
      unavailableCount: 1,
    };
  }

  const items = doc.items as Array<Record<string, unknown>>;
  const docTaxRate = typeof doc.taxRate === "number" ? doc.taxRate : 0;
  const docDiscountPct = typeof doc.discountRate === "number" ? doc.discountRate : 0;
  const docIrpfRate = typeof doc.irpfRate === "number" ? doc.irpfRate : 0;
  const docSurchargeRate =
    typeof doc.equivalenceSurchargeRate === "number" ? doc.equivalenceSurchargeRate : 0;

  const baseByRate = new Map<number, number>();
  let subtotalBeforeDiscount = 0;

  for (const item of items) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.quantity !== "number" ||
      !Number.isFinite(item.quantity) ||
      item.quantity < 0 ||
      typeof item.unitPrice !== "number" ||
      !Number.isFinite(item.unitPrice) ||
      item.unitPrice < 0 ||
      (item.discountAmount !== undefined && item.discountAmount !== null && item.discountAmount !== 0) ||
      !isFiniteRateInRange(item.discount, 0, 100) ||
      !isFiniteRateInRange(item.taxRate, 0, 100)
    ) {
      return {
        amount: null,
        currency,
        provenance: "unavailable",
        fieldOrFormula: "unavailable (corrupt or incomplete line item without stored total)",
        unavailableCount: 1,
      };
    }

    const effectiveRate = typeof item.taxRate === "number" ? item.taxRate : docTaxRate;
    const lineDiscountPct = typeof item.discount === "number" ? item.discount : 0;
    const effectiveUnitPrice = roundCurrency(item.unitPrice * (1 - lineDiscountPct / 100));
    const lineBase = roundCurrency(item.quantity * effectiveUnitPrice);

    subtotalBeforeDiscount = roundCurrency(subtotalBeforeDiscount + lineBase);
    baseByRate.set(effectiveRate, roundCurrency((baseByRate.get(effectiveRate) ?? 0) + lineBase));
  }

  const documentDiscount = roundCurrency(subtotalBeforeDiscount * (docDiscountPct / 100));
  const subtotal = roundCurrency(subtotalBeforeDiscount - documentDiscount);

  if (docDiscountPct > 0 && subtotalBeforeDiscount > 0) {
    const rates = [...baseByRate.keys()].sort((a, b) => b - a);
    for (let i = 0; i < rates.length; i++) {
      const rate = rates[i];
      const originalBase = baseByRate.get(rate)!;
      if (i === rates.length - 1) {
        let otherGroupsTotal = 0;
        for (let j = 0; j < i; j++) {
          otherGroupsTotal = roundCurrency(otherGroupsTotal + baseByRate.get(rates[j])!);
        }
        baseByRate.set(rate, roundCurrency(subtotal - otherGroupsTotal));
      } else {
        const groupDiscount = roundCurrency(originalBase * (docDiscountPct / 100));
        baseByRate.set(rate, roundCurrency(originalBase - groupDiscount));
      }
    }
  }

  let totalTax = 0;
  for (const [rate, base] of [...baseByRate.entries()].sort((a, b) => b[0] - a[0])) {
    const tax = roundCurrency(base * (rate / 100));
    totalTax = roundCurrency(totalTax + tax);
  }

  const irpf = roundCurrency(subtotal * (docIrpfRate / 100));
  const surcharge = roundCurrency(subtotal * (docSurchargeRate / 100));
  const total = roundCurrency(subtotal + totalTax + surcharge - irpf);

  return {
    amount: total,
    currency,
    provenance: "derived_from_items",
    fieldOrFormula:
      "canonical_invoice_calculation(items[qty*round(unitPrice*(1-lineDiscount))], docDiscountRate, taxRate, equivalenceSurchargeRate, irpfRate)",
  };
}

export function sumProvenancedAmounts(
  amounts: ProvenancedAmount[],
  defaultCurrency = "EUR",
): ProvenancedAmount {
  const normalizedDefault = defaultCurrency.trim().toUpperCase();
  if (amounts.length === 0) {
    return {
      amount: 0,
      currency: normalizedDefault,
      provenance: "stored_field",
      fieldOrFormula: "sum(0 documents)",
      totalsByCurrency: {},
      unavailableCount: 0,
    };
  }

  const totalsByCurrency: Record<string, CurrencyBucketAmount> = {};
  let unavailableCount = 0;

  for (const item of amounts) {
    if (
      item.amount === null ||
      !Number.isFinite(item.amount) ||
      item.provenance === "unavailable"
    ) {
      unavailableCount += item.unavailableCount ?? 1;
      continue;
    }

    const curr = (item.currency || normalizedDefault).trim().toUpperCase();
    const existing = totalsByCurrency[curr];
    const itemProv: "stored_field" | "derived_from_items" =
      item.provenance === "derived_from_items" ? "derived_from_items" : "stored_field";

    if (!existing) {
      totalsByCurrency[curr] = {
        amount: roundCurrency(item.amount),
        currency: curr,
        provenance: itemProv,
        documentCount: 1,
      };
    } else {
      existing.amount = roundCurrency(existing.amount + item.amount);
      existing.documentCount += 1;
      if (itemProv === "derived_from_items") {
        existing.provenance = "derived_from_items";
      }
    }
  }

  const currencies = Object.keys(totalsByCurrency);

  if (unavailableCount > 0) {
    return {
      amount: null,
      currency: currencies.length === 1 ? currencies[0] : currencies.length > 1 ? "MIXED" : normalizedDefault,
      provenance: "unavailable",
      fieldOrFormula: `unavailable (${unavailableCount} document(s) missing valid amount; never coerced to 0)`,
      totalsByCurrency,
      unavailableCount,
    };
  }

  if (currencies.length > 1) {
    const breakdownText = currencies
      .sort()
      .map((c) => `${c}: ${totalsByCurrency[c].amount.toFixed(2)}`)
      .join(", ");
    return {
      amount: null,
      currency: "MIXED",
      provenance: "mixed_currency_unconverted",
      fieldOrFormula: `unconverted multi-currency totals (${breakdownText})`,
      totalsByCurrency,
      unavailableCount: 0,
    };
  }

  const singleCurr = currencies[0] ?? normalizedDefault;
  const bucket = totalsByCurrency[singleCurr];
  const anyDerived = bucket?.provenance === "derived_from_items";

  return {
    amount: bucket ? bucket.amount : 0,
    currency: singleCurr,
    provenance: anyDerived ? "derived_from_items" : "stored_field",
    fieldOrFormula: anyDerived
      ? "sum(stored doc.total/amount + canonical derived item totals)"
      : "sum(stored doc.total/amount)",
    totalsByCurrency,
    unavailableCount: 0,
  };
}

export async function generateDailyOperationalBrief(
  client: Pick<
    IFrihetClient,
    | "getBusinessContext"
    | "listInvoices"
    | "listQuotes"
    | "listExpenses"
    | "listClients"
    | "listClientActivities"
  >,
  options?: GenerateDailyBriefOptions,
): Promise<DailyOperationalBrief> {
  const asOfDate = options?.asOfDate ?? new Date().toISOString().slice(0, 10);
  const periodMonth = asOfDate.slice(0, 7);
  const pageLimit = options?.pageLimit ?? 20;
  const maxActivityClients = options?.maxActivityClients ?? 5;

  const [businessContext, invoicesPage, quotesPage, expensesPage, clientsPage] = await Promise.all([
    client.getBusinessContext(),
    client.listInvoices({ limit: pageLimit }),
    client.listQuotes({ limit: pageLimit }),
    client.listExpenses({ limit: pageLimit }),
    client.listClients({ limit: pageLimit }),
  ]);

  const defaultCurrency =
    typeof (businessContext?.company as Record<string, unknown> | undefined)?.currency === "string"
      ? String((businessContext.company as Record<string, unknown>).currency)
      : "EUR";

  const clientsToInspect = clientsPage.data.slice(0, maxActivityClients);
  const activitiesByClient = await Promise.all(
    clientsToInspect.map(async (c) => {
      const clientId = String(c.id ?? "");
      const res = await client.listClientActivities(clientId, { limit: 10 });
      return {
        client: c,
        activities: res.data,
        total: res.total,
      };
    }),
  );

  const invoicesCoverage: ResourceCoverage = {
    collection: "invoices",
    sourceTool: "list_invoices",
    inspected: invoicesPage.data.length,
    total: invoicesPage.total,
    complete: invoicesPage.data.length >= invoicesPage.total,
  };
  const quotesCoverage: ResourceCoverage = {
    collection: "quotes",
    sourceTool: "list_quotes",
    inspected: quotesPage.data.length,
    total: quotesPage.total,
    complete: quotesPage.data.length >= quotesPage.total,
  };
  const expensesCoverage: ResourceCoverage = {
    collection: "expenses",
    sourceTool: "list_expenses",
    inspected: expensesPage.data.length,
    total: expensesPage.total,
    complete: expensesPage.data.length >= expensesPage.total,
  };
  const clientsCoverage: ResourceCoverage = {
    collection: "clients",
    sourceTool: "list_clients",
    inspected: clientsPage.data.length,
    total: clientsPage.total,
    complete: clientsPage.data.length >= clientsPage.total,
  };
  const clientActivitiesCoverage: ResourceCoverage = {
    collection: "client_activities",
    sourceTool: "list_client_activities",
    inspected: clientsToInspect.length,
    total: clientsPage.total,
    complete:
      clientsToInspect.length >= clientsPage.total &&
      activitiesByClient.every((entry) => entry.activities.length >= entry.total),
  };

  const isPartial =
    !invoicesCoverage.complete ||
    !quotesCoverage.complete ||
    !expensesCoverage.complete ||
    !clientsCoverage.complete ||
    !clientActivitiesCoverage.complete;

  const coverage: BriefCoverageSummary = {
    asOfDate,
    periodMonth,
    referenceMonth: periodMonth,
    temporalScope: "unfiltered_operational_sample_as_of_date",
    temporalScopeNote:
      `Las consultas list_invoices, list_quotes y list_expenses leen los registros recientes/abiertos a fecha de corte (${asOfDate}) sin filtro mensual para no ocultar impagos vencidos ni borradores de meses anteriores. La actividad específica del mes de referencia (${periodMonth}) se desglosa por separado en currentMonthActivity.`,
    isPartial,
    resources: {
      invoices: invoicesCoverage,
      quotes: quotesCoverage,
      expenses: expensesCoverage,
      clients: clientsCoverage,
      client_activities: clientActivitiesCoverage,
    },
  };

  // Separate draft invoices vs issued invoices (and inside issued: paid vs unpaid nominal [overdue vs on-time])
  const invoiceDrafts: BriefDocumentSummary[] = [];
  const issuedInvoices: BriefDocumentSummary[] = [];
  const paidInvoices: BriefDocumentSummary[] = [];
  const outstandingInvoices: BriefDocumentSummary[] = [];
  const issuedInvoicesByStatus: Record<string, number> = {};

  for (const rawInv of invoicesPage.data) {
    const status = typeof rawInv.status === "string" ? rawInv.status : "draft";
    const summary: BriefDocumentSummary = {
      id: String(rawInv.id ?? ""),
      documentNumber:
        typeof rawInv.documentNumber === "string" && rawInv.documentNumber ? rawInv.documentNumber : null,
      status,
      counterpartyName:
        typeof rawInv.clientName === "string" && rawInv.clientName ? rawInv.clientName : "Cliente sin nombre",
      issueDate: typeof rawInv.issueDate === "string" ? rawInv.issueDate : null,
      dueDate: typeof rawInv.dueDate === "string" ? rawInv.dueDate : null,
      amount: resolveDocumentAmount(rawInv, defaultCurrency),
    };
    if (status === "draft") {
      invoiceDrafts.push(summary);
    } else if (status !== "cancelled") {
      issuedInvoices.push(summary);
      issuedInvoicesByStatus[status] = (issuedInvoicesByStatus[status] ?? 0) + 1;
      if (status === "paid") {
        paidInvoices.push(summary);
      } else {
        outstandingInvoices.push(summary);
      }
    }
  }

  const quoteDrafts: BriefDocumentSummary[] = [];
  for (const rawQuote of quotesPage.data) {
    const status = typeof rawQuote.status === "string" ? rawQuote.status : "draft";
    if (status === "draft" || status === "sent") {
      quoteDrafts.push({
        id: String(rawQuote.id ?? ""),
        documentNumber:
          typeof rawQuote.documentNumber === "string" && rawQuote.documentNumber ? rawQuote.documentNumber : null,
        status,
        counterpartyName:
          typeof rawQuote.clientName === "string" && rawQuote.clientName ? rawQuote.clientName : "Cliente sin nombre",
        issueDate: typeof rawQuote.issueDate === "string" ? rawQuote.issueDate : null,
        dueDate:
          typeof rawQuote.validUntil === "string"
            ? rawQuote.validUntil
            : typeof rawQuote.dueDate === "string"
              ? rawQuote.dueDate
              : null,
        amount: resolveDocumentAmount(rawQuote, defaultCurrency),
      });
    }
  }

  const expenseAmounts = expensesPage.data.map((exp) => resolveDocumentAmount(exp, defaultCurrency));
  const deductibleExpenses = expensesPage.data.filter((exp) => exp.taxDeductible === true);
  const nonDeductibleExpenses = expensesPage.data.filter((exp) => exp.taxDeductible === false);
  const expensesNeedingReview = expensesPage.data.filter((exp) => {
    const missingVendor = typeof exp.vendor !== "string" || !exp.vendor.trim();
    const missingCategory = typeof exp.category !== "string" || !exp.category.trim();
    const unsetDeductibility = typeof exp.taxDeductible !== "boolean";
    return missingVendor || missingCategory || unsetDeductibility;
  });

  // Current month (`periodMonth`) subset explicitly filtered by document date prefix
  const issuedInvoicesInMonth = issuedInvoices.filter(
    (inv) => typeof inv.issueDate === "string" && inv.issueDate.startsWith(periodMonth),
  );
  const invoiceDraftsInMonth = invoiceDrafts.filter(
    (inv) => typeof inv.issueDate === "string" && inv.issueDate.startsWith(periodMonth),
  );
  const expensesInMonth = expensesPage.data.filter(
    (exp) => typeof exp.date === "string" && String(exp.date).startsWith(periodMonth),
  );

  const priorities: BriefPriorityItem[] = [];

  // 1. Overdue or past-due unpaid invoices (high priority)
  const overdueInvoices = outstandingInvoices.filter(
    (inv) => inv.status === "overdue" || (inv.dueDate !== null && inv.dueDate < asOfDate),
  );
  const onTimePendingInvoices = outstandingInvoices.filter(
    (inv) => inv.status !== "overdue" && (inv.dueDate === null || inv.dueDate >= asOfDate),
  );
  if (overdueInvoices.length > 0) {
    const overdueTotal = sumProvenancedAmounts(
      overdueInvoices.map((i) => i.amount),
      defaultCurrency,
    );
    priorities.push({
      priority: "high",
      category: "overdue_invoice",
      title: `${overdueInvoices.length} factura(s) emitida(s) vencida(s) o fuera de plazo`,
      why: `Las facturas emitidas (${overdueInvoices.map((i) => `${i.documentNumber ?? i.id} · ${i.counterpartyName}`).join(", ")}) tienen vencimiento anterior a ${asOfDate} o estado 'overdue' (importe nominal total de documentos no marcados como pagados; saldo pendiente real no determinado sin cobros parciales).`,
      recordRefs: overdueInvoices.map((i) => ({
        type: "invoice",
        id: i.id,
        label: `${i.documentNumber ?? i.id} (${i.counterpartyName})`,
      })),
      amount: overdueTotal,
      suggestedNextAction: {
        description:
          "Inspeccionar el detalle con get_invoice y registrar seguimiento comercial con log_client_activity (previa confirmación).",
        recommendedTool: "get_invoice",
        requiresConfirmation: false,
        autoExecuted: false,
      },
    });
  }

  // 2. Draft invoices pending review (high/medium priority)
  if (invoiceDrafts.length > 0) {
    const draftsTotal = sumProvenancedAmounts(
      invoiceDrafts.map((i) => i.amount),
      defaultCurrency,
    );
    priorities.push({
      priority: "high",
      category: "draft_invoice",
      title: `${invoiceDrafts.length} borrador(es) de factura pendientes de revisión`,
      why: `Existen ${invoiceDrafts.length} borradores (${invoiceDrafts.map((i) => `${i.documentNumber ?? i.id} · ${i.counterpartyName}`).join(", ")}) que ya reservaron numeración pero siguen en estado 'draft' (no constituyen facturación emitida ni enviada).`,
      recordRefs: invoiceDrafts.map((i) => ({
        type: "invoice",
        id: i.id,
        label: `${i.documentNumber ?? i.id} (${i.counterpartyName})`,
      })),
      amount: draftsTotal,
      suggestedNextAction: {
        description:
          "Revisar líneas e importes de cada borrador con get_invoice antes de decidir su emisión en la aplicación web de Frihet.",
        recommendedTool: "get_invoice",
        requiresConfirmation: false,
        autoExecuted: false,
      },
    });
  }

  // 3. Expenses with incomplete metadata (missing vendor, category, or boolean taxDeductible)
  if (expensesNeedingReview.length > 0) {
    const reviewAmounts = expensesNeedingReview.map((e) => resolveDocumentAmount(e, defaultCurrency));
    const reviewTotal = sumProvenancedAmounts(reviewAmounts, defaultCurrency);
    priorities.push({
      priority: "medium",
      category: "expense_review",
      title: `${expensesNeedingReview.length} gasto(s) con datos incompletos (proveedor, categoría o deducibilidad sin definir)`,
      why: `Los gastos (${expensesNeedingReview.map((e) => `${String(e.id)} · ${String(e.description ?? "Sin descripción")}`).join(", ")}) carecen de proveedor, categoría o valor booleano en taxDeductible. (Nota: los gastos con taxDeductible=false y metadatos completos se contabilizan normalmente como no deducibles sin marcarse como error).`,
      recordRefs: expensesNeedingReview.map((e) => ({
        type: "expense",
        id: String(e.id ?? ""),
        label: `${String(e.description ?? e.id)} (${String(e.vendor ?? "sin proveedor")})`,
      })),
      amount: reviewTotal,
      suggestedNextAction: {
        description:
          "Comprobar cada gasto incompleto con get_expense y, si procede completar categoría, proveedor o taxDeductible, solicitar confirmación antes de llamar a update_expense.",
        recommendedTool: "get_expense",
        requiresConfirmation: true,
        autoExecuted: false,
      },
    });
  }

  // 4. Client CRM follow-ups
  for (const entry of activitiesByClient) {
    const clientId = String(entry.client.id ?? "");
    const clientName = String(entry.client.name ?? clientId);
    if (entry.activities.length > 0) {
      const latest = entry.activities[0];
      priorities.push({
        priority: "medium",
        category: "client_followup",
        title: `Seguimiento comercial registrado en ${clientName}`,
        why: `Última actividad registrada (${String(latest.type ?? "actividad")}): "${String(latest.title ?? "")}" (${String(latest.id ?? "")}). Conviene verificar si requiere respuesta, presupuesto o nota de seguimiento.`,
        recordRefs: [
          { type: "client", id: clientId, label: clientName },
          {
            type: "client_activity",
            id: String(latest.id ?? ""),
            label: `${String(latest.type ?? "activity")}: ${String(latest.title ?? "")}`,
          },
        ],
        suggestedNextAction: {
          description:
            "Revisar fichas y notas del cliente con list_client_notes / list_client_contacts antes de registrar una nueva actividad confirmada.",
          recommendedTool: "list_client_notes",
          requiresConfirmation: false,
          autoExecuted: false,
        },
      });
    }
  }

  // 5. Plan quota alerts from get_business_context
  const planObj = businessContext?.plan as Record<string, unknown> | undefined;
  const usageObj = planObj?.usage as Record<string, Record<string, number>> | undefined;
  if (usageObj) {
    for (const [quotaKey, quotaVal] of Object.entries(usageObj)) {
      const used = typeof quotaVal?.used === "number" ? quotaVal.used : 0;
      const limit = typeof quotaVal?.limit === "number" ? quotaVal.limit : 0;
      if (limit > 0 && used / limit >= 0.8) {
        priorities.push({
          priority: "low",
          category: "plan_quota",
          title: `Cuota mensual de ${quotaKey} al ${Math.round((used / limit) * 100)}% (${used}/${limit})`,
          why: `El uso mensual reportado en get_business_context para '${quotaKey}' es ${used} de ${limit}.`,
          recordRefs: [{ type: "plan_quota", id: quotaKey, label: `${quotaKey}: ${used}/${limit}` }],
          suggestedNextAction: {
            description:
              "Evitar creaciones de prueba innecesarias que consuman cuota mensual antes de cerrar el periodo.",
            recommendedTool: "get_business_context",
            requiresConfirmation: false,
            autoExecuted: false,
          },
        });
      }
    }
  }

  // Known unknowns ("esto es lo que no puedo determinar")
  const knownUnknowns: string[] = [
    "Saldo bancario real y posición de tesorería: las herramientas de banca y conciliación bancaria no forman parte de esta consulta y la existencia de facturas no implica cobro efectivo en banco.",
    "Saldos pendientes reales o cobros parciales: solo se observan los importes nominales íntegros y los estados de cada documento (p. ej. 'draft', 'sent', 'overdue', 'paid'), por lo que el importe de facturas no pagadas es un nominal bruto y no un saldo vivo conciliado.",
  ];
  if (isPartial) {
    const partialLabels = Object.values(coverage.resources)
      .filter((r) => !r.complete)
      .map((r) => `${r.collection} (${r.inspected}/${r.total} vía ${r.sourceTool})`);
    knownUnknowns.unshift(
      `Cobertura parcial del espacio de trabajo: solo se ha inspeccionado una página en ${partialLabels.join(", ")}. Los importes agregados reflejan únicamente los registros leídos en esta muestra y no el total histórico del negocio.`,
    );
  }

  const draftInvoicesTotal = sumProvenancedAmounts(
    invoiceDrafts.map((d) => d.amount),
    defaultCurrency,
  );
  const draftQuotesTotal = sumProvenancedAmounts(
    quoteDrafts.map((d) => d.amount),
    defaultCurrency,
  );
  const issuedInvoicesTotal = sumProvenancedAmounts(
    issuedInvoices.map((d) => d.amount),
    defaultCurrency,
  );
  const paidInvoicesTotal = sumProvenancedAmounts(
    paidInvoices.map((d) => d.amount),
    defaultCurrency,
  );
  const outstandingInvoicesTotal = sumProvenancedAmounts(
    outstandingInvoices.map((d) => d.amount),
    defaultCurrency,
  );
  const overdueInvoicesTotal = sumProvenancedAmounts(
    overdueInvoices.map((d) => d.amount),
    defaultCurrency,
  );
  const onTimePendingTotal = sumProvenancedAmounts(
    onTimePendingInvoices.map((d) => d.amount),
    defaultCurrency,
  );
  const expensesTotal = sumProvenancedAmounts(expenseAmounts, defaultCurrency);
  const deductibleTotal = sumProvenancedAmounts(
    deductibleExpenses.map((e) => resolveDocumentAmount(e, defaultCurrency)),
    defaultCurrency,
  );
  const nonDeductibleTotal = sumProvenancedAmounts(
    nonDeductibleExpenses.map((e) => resolveDocumentAmount(e, defaultCurrency)),
    defaultCurrency,
  );

  const issuedInvoicesInMonthTotal = sumProvenancedAmounts(
    issuedInvoicesInMonth.map((d) => d.amount),
    defaultCurrency,
  );
  const invoiceDraftsInMonthTotal = sumProvenancedAmounts(
    invoiceDraftsInMonth.map((d) => d.amount),
    defaultCurrency,
  );
  const expensesInMonthTotal = sumProvenancedAmounts(
    expensesInMonth.map((e) => resolveDocumentAmount(e, defaultCurrency)),
    defaultCurrency,
  );

  const markdownLines: string[] = [
    `# Brief Operativo Diario (Corte operativo a ${asOfDate} · Muestra abierta/reciente sin filtro mensual)`,
    "",
    `## 1. Cobertura y Alcance Temporal (${isPartial ? "COBERTURA PARCIAL" : "COBERTURA COMPLETA"})`,
    `- **Alcance temporal de la consulta**: muestra operativa a fecha \`${asOfDate}\` sobre los registros abiertos/recientes devueltos por \`list_invoices\`, \`list_quotes\` y \`list_expenses\` (incluye documentos de meses previos, como vencimientos pendientes, para no ocultar riesgos operativos). El subconjunto emitido/registrado en el mes \`${periodMonth}\` se desglosa aparte.`,
    `- **Contexto del negocio**: \`get_business_context\``,
    `- **Facturas** (\`list_invoices\`): ${invoicesCoverage.inspected}/${invoicesCoverage.total} (${invoicesCoverage.complete ? "completo" : "parcial"})`,
    `- **Presupuestos** (\`list_quotes\`): ${quotesCoverage.inspected}/${quotesCoverage.total} (${quotesCoverage.complete ? "completo" : "parcial"})`,
    `- **Gastos** (\`list_expenses\`): ${expensesCoverage.inspected}/${expensesCoverage.total} (${expensesCoverage.complete ? "completo" : "parcial"})`,
    `- **Clientes** (\`list_clients\`): ${clientsCoverage.inspected}/${clientsCoverage.total} (${clientsCoverage.complete ? "completo" : "parcial"})`,
    `- **Actividades CRM** (\`list_client_activities\`): ${clientActivitiesCoverage.inspected}/${clientActivitiesCoverage.total} clientes inspeccionados (${clientActivitiesCoverage.complete ? "completo" : "parcial"})`,
    "",
    "## 2. Separación entre Borrador, Facturación Emitida, Cobro Registrado e Importe Nominal No Pagado",
    `- **Borradores de factura (NO emitidos / NO computan como ingreso ni saldo por cobrar)**: ${invoiceDrafts.length} documento(s) por **${formatProvenancedAmount(draftInvoicesTotal)}** (procedencia: \`${draftInvoicesTotal.provenance}\` — ${draftInvoicesTotal.fieldOrFormula}).`,
    `- **Presupuestos en borrador/enviados**: ${quoteDrafts.length} documento(s) por **${formatProvenancedAmount(draftQuotesTotal)}** (procedencia: \`${draftQuotesTotal.provenance}\`).`,
    `- **Facturación emitida en la muestra operativa (no borrador, incluye meses previos si siguen en la muestra)**: ${issuedInvoices.length} documento(s) por **${formatProvenancedAmount(issuedInvoicesTotal)}** (procedencia: \`${issuedInvoicesTotal.provenance}\` — ${issuedInvoicesTotal.fieldOrFormula}):`,
    `  - **Cobro registrado en ERP (\`paid\`)**: ${paidInvoices.length} documento(s) por **${formatProvenancedAmount(paidInvoicesTotal)}**.`,
    `  - **Importe nominal de facturas no marcadas como pagadas (saldo pendiente real no determinable sin cobros parciales)**: ${outstandingInvoices.length} documento(s) por **${formatProvenancedAmount(outstandingInvoicesTotal)}** (${overdueInvoices.length} vencida(s) por **${formatProvenancedAmount(overdueInvoicesTotal)}**; ${onTimePendingInvoices.length} en plazo por **${formatProvenancedAmount(onTimePendingTotal)}**).`,
    `- **Gastos registrados en la muestra operativa**: ${expensesPage.data.length} registro(s) por **${formatProvenancedAmount(expensesTotal)}** (${deductibleExpenses.length} deducible(s) por ${formatProvenancedAmount(deductibleTotal)}; ${nonDeductibleExpenses.length} no deducible(s) por ${formatProvenancedAmount(nonDeductibleTotal)}; ${expensesNeedingReview.length} con datos incompletos pendientes de revisión).`,
    `- **Subconjunto acotado al mes ${periodMonth} (filtrado por fecha del documento)**: ${issuedInvoicesInMonth.length} factura(s) emitida(s) por **${formatProvenancedAmount(issuedInvoicesInMonthTotal)}**, ${invoiceDraftsInMonth.length} borrador(es) de factura por **${formatProvenancedAmount(invoiceDraftsInMonthTotal)}** y ${expensesInMonth.length} gasto(s) por **${formatProvenancedAmount(expensesInMonthTotal)}**.`,
    "",
    "## 3. Qué Deberías Revisar Hoy y Por Qué (Priorizado)",
    ...(priorities.length > 0
      ? priorities.map(
          (p, idx) =>
            `${idx + 1}. **[${p.priority.toUpperCase()}] ${p.title}**\n` +
            `   - **Por qué**: ${p.why}\n` +
            `   - **Registros**: ${p.recordRefs.map((r) => `\`${r.id}\` (${r.label})`).join(", ")}\n` +
            (p.amount
              ? `   - **Importe y procedencia**: ${formatProvenancedAmount(p.amount)} (\`${p.amount.provenance}\`: ${p.amount.fieldOrFormula})\n`
              : "") +
            `   - **Siguiente acción sugerida (no ejecutada automáticamente)**: ${p.suggestedNextAction.description} (herramienta: \`${p.suggestedNextAction.recommendedTool}\`)`,
        )
      : ["- No se han detectado incidencias prioritarias en los registros inspeccionados."]),
    "",
    "## 4. Lo Que No Puedo Determinar con Estos Datos",
    ...knownUnknowns.map((u) => `- ${u}`),
  ];

  return {
    question: "¿Qué debería revisar hoy en mi negocio y por qué?",
    coverage,
    activitySeparation: {
      draftActivity: {
        note: "Los borradores reservan numeración pero no han sido emitidos ni enviados al cliente; no representan ingresos devengados ni cobrados.",
        invoiceDraftsCount: invoiceDrafts.length,
        invoiceDraftsTotal: draftInvoicesTotal,
        invoiceDrafts,
        quoteDraftsCount: quoteDrafts.length,
        quoteDraftsTotal: draftQuotesTotal,
        quoteDrafts,
      },
      issuedActivity: {
        note: "Incluye únicamente facturas emitidas (estado distinto de 'draft' y 'cancelled'), separando cobro registrado ('paid') del importe nominal de facturas no marcadas como pagadas ('overdue' vs en plazo). El saldo pendiente real no es determinable sin desglose de cobros parciales ni conciliación bancaria.",
        realOutstandingBalanceDeterminable: false,
        unpaidNominalSemantics: "nominal_unpaid_invoice_totals_without_partial_payments",
        issuedInvoicesCount: issuedInvoices.length,
        issuedInvoicesByStatus,
        issuedInvoicesTotal,
        issuedInvoices,
        paidInvoicesCount: paidInvoices.length,
        paidInvoicesTotal,
        paidInvoices,
        unpaidNominalInvoicesCount: outstandingInvoices.length,
        unpaidNominalTotal: outstandingInvoicesTotal,
        unpaidNominalTotalsByCurrency: outstandingInvoicesTotal.totalsByCurrency ?? {},
        overdueNominalInvoicesCount: overdueInvoices.length,
        overdueNominalTotal: overdueInvoicesTotal,
        onTimeNominalPendingCount: onTimePendingInvoices.length,
        onTimeNominalPendingTotal: onTimePendingTotal,
        outstandingInvoicesCount: outstandingInvoices.length,
        outstandingInvoicesTotal,
        overdueInvoicesCount: overdueInvoices.length,
        overdueInvoicesTotal,
        onTimePendingCount: onTimePendingInvoices.length,
        onTimePendingTotal,
        outstandingInvoices,
      },
      recordedExpenses: {
        note: "Los gastos con taxDeductible=false y proveedor/categoría completos se desglosan como no deducibles sin tratarse como error; solo se marcan para revisión los registros con proveedor, categoría o deducibilidad sin especificar.",
        expensesCount: expensesPage.data.length,
        expensesTotal,
        deductibleCount: deductibleExpenses.length,
        deductibleTotal,
        nonDeductibleCount: nonDeductibleExpenses.length,
        nonDeductibleTotal,
        pendingReviewCount: expensesNeedingReview.length,
      },
      currentMonthActivity: {
        referenceMonth: periodMonth,
        note: `Subconjunto de documentos cuya fecha de emisión (issueDate) o fecha de gasto (date) pertenece explícitamente al mes ${periodMonth}, separado de los registros de meses previos presentes en la muestra operativa.`,
        issuedInvoicesInMonthCount: issuedInvoicesInMonth.length,
        issuedInvoicesInMonthTotal,
        invoiceDraftsInMonthCount: invoiceDraftsInMonth.length,
        invoiceDraftsInMonthTotal,
        expensesInMonthCount: expensesInMonth.length,
        expensesInMonthTotal,
      },
    },
    priorities,
    knownUnknowns,
    mutationsExecuted: 0,
    markdown: markdownLines.join("\n"),
  };
}

export function buildScenario1CompleteWorkspaceClient(callLog: string[]): Pick<
  IFrihetClient,
  | "getBusinessContext"
  | "listInvoices"
  | "listQuotes"
  | "listExpenses"
  | "listClients"
  | "listClientActivities"
> {
  return {
    getBusinessContext: async () => {
      callLog.push("get_business_context");
      return {
        company: { name: "Estudio Atlántico SL", currency: "EUR", taxRegime: "iva" },
        monthlySummary: { invoiced: 1347, expenses: 153.5 },
        plan: {
          tier: "free",
          usage: {
            invoices: { used: 3, limit: 10 },
            expenses: { used: 4, limit: 5 },
          },
        },
      };
    },
    listInvoices: async () => {
      callLog.push("list_invoices");
      return {
        data: [
          {
            id: "inv_draft_1",
            documentNumber: "F20260001",
            status: "draft",
            clientName: "Acme SL",
            issueDate: "2026-10-08",
            dueDate: "2026-11-08",
            total: 968,
            currency: "EUR",
          },
          {
            id: "inv_draft_4",
            documentNumber: "F20260004",
            status: "draft",
            clientName: "Acme SL",
            issueDate: "2026-10-27",
            dueDate: "2026-11-27",
            total: 193.6,
            currency: "EUR",
          },
          {
            id: "inv_overdue_0",
            documentNumber: "F20260000",
            status: "overdue",
            clientName: "OpenAI Demo Sample Client",
            issueDate: "2026-09-10",
            dueDate: "2026-10-10",
            total: 605,
            currency: "EUR",
          },
          {
            id: "inv_sent_2",
            documentNumber: "F20260002",
            status: "sent",
            clientName: "Acme SL",
            issueDate: "2026-10-20",
            dueDate: "2026-11-20",
            total: 847,
            currency: "EUR",
          },
          {
            id: "inv_paid_3",
            documentNumber: "F20260003",
            status: "paid",
            clientName: "Acme SL",
            issueDate: "2026-10-05",
            dueDate: "2026-10-20",
            total: 500,
            currency: "EUR",
          },
        ],
        total: 5,
        limit: 20,
        offset: 0,
      };
    },
    listQuotes: async () => {
      callLog.push("list_quotes");
      return {
        data: [
          {
            id: "quo_draft_1",
            documentNumber: "P20260001",
            status: "draft",
            clientName: "Acme SL",
            issueDate: "2026-10-25",
            validUntil: "2026-11-10",
            total: 1210,
            currency: "EUR",
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      };
    },
    listExpenses: async () => {
      callLog.push("list_expenses");
      return {
        data: [
          {
            id: "jyaSd4KNgig9B5pGcsWP",
            description: "Office supplies",
            amount: 45.99,
            category: "office",
            vendor: "Office Depot Canarias",
            taxDeductible: false,
            date: "2026-08-28",
          },
          {
            id: "J5ICnB9lZMokSapUPByP",
            description: "Servidores QA octubre",
            amount: 121.0,
            category: "software",
            vendor: "Cloud Hosting QA",
            taxDeductible: true,
            date: "2026-10-27",
          },
          {
            id: "exp_incomplete_1",
            description: "Recibo taxi sin categorizar",
            amount: 32.5,
            category: "",
            vendor: "",
            date: "2026-10-27",
          },
        ],
        total: 3,
        limit: 20,
        offset: 0,
      };
    },
    listClients: async () => {
      callLog.push("list_clients");
      return {
        data: [
          { id: "444IZvNpVrtJhj5nRySW", name: "Acme SL", email: "contact@acme.example" },
          { id: "RCjuHqsCchF5ZCB7gU0s", name: "OpenAI Demo Sample Client", email: "demo@example.com" },
        ],
        total: 2,
        limit: 20,
        offset: 0,
      };
    },
    listClientActivities: async (clientId: string) => {
      callLog.push(`list_client_activities:${clientId}`);
      if (clientId === "444IZvNpVrtJhj5nRySW") {
        return {
          data: [
            {
              id: "act_call_1",
              type: "call",
              title: "Llamada de seguimiento sobre propuesta de octubre",
              createdAt: "2026-10-28T01:18:39.677Z",
            },
          ],
          total: 1,
          limit: 10,
          offset: 0,
        };
      }
      return { data: [], total: 0, limit: 10, offset: 0 };
    },
  };
}

export function buildScenario2PartialCoverageClient(callLog: string[]): Pick<
  IFrihetClient,
  | "getBusinessContext"
  | "listInvoices"
  | "listQuotes"
  | "listExpenses"
  | "listClients"
  | "listClientActivities"
> {
  return {
    getBusinessContext: async () => {
      callLog.push("get_business_context");
      return {
        company: { name: "Distribuciones Insulares SL", currency: "EUR" },
        plan: { tier: "pro", usage: { invoices: { used: 47, limit: 500 } } },
      };
    },
    listInvoices: async () => {
      callLog.push("list_invoices");
      return {
        data: [
          {
            id: "inv_legacy_draft",
            documentNumber: "F20260047",
            status: "draft",
            clientName: "Logística Norte SL",
            issueDate: "2026-10-27",
            items: [{ description: "Consultoría logística", quantity: 3, unitPrice: 100 }],
            taxRate: 21,
          },
          {
            id: "inv_sent_46",
            documentNumber: "F20260046",
            status: "sent",
            clientName: "Marítima Sur SL",
            issueDate: "2026-09-15",
            dueDate: "2026-10-15",
            total: 2420,
          },
        ],
        total: 47,
        limit: 2,
        offset: 0,
      };
    },
    listQuotes: async () => {
      callLog.push("list_quotes");
      return { data: [], total: 0, limit: 2, offset: 0 };
    },
    listExpenses: async () => {
      callLog.push("list_expenses");
      return {
        data: [
          {
            id: "exp_missing_vendor",
            description: "Combustible flota",
            amount: 88.5,
            category: "",
            vendor: "",
            taxDeductible: true,
            date: "2026-10-26",
          },
        ],
        total: 35,
        limit: 1,
        offset: 0,
      };
    },
    listClients: async () => {
      callLog.push("list_clients");
      return {
        data: [{ id: "cli_1", name: "Logística Norte SL" }],
        total: 12,
        limit: 1,
        offset: 0,
      };
    },
    listClientActivities: async (clientId: string) => {
      callLog.push(`list_client_activities:${clientId}`);
      return { data: [], total: 0, limit: 10, offset: 0 };
    },
  };
}
