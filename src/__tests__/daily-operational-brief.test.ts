/**
 * Tests and golden reference scenarios for the Daily Operational Brief workflow
 * ("¿Qué debería revisar hoy en mi negocio y por qué?").
 *
 * Scenarios & Golden Cases:
 *   1. Complete workspace coverage (`isPartial: false`):
 *      - Separates 2 draft invoices (non-issued) from 3 issued invoices (1 overdue from prior month, 1 sent, 1 paid).
 *      - Distinguishes operational sample as of `asOfDate` (`1952 EUR` across 3 issued invoices) from `currentMonthActivity` (`1347 EUR` across 2 October issued invoices).
 *      - Labels unpaid totals as nominal (`realOutstandingBalanceDeterminable: false`, `unpaidNominalTotal: 1452 EUR`).
 *      - Flags 1 expense with incomplete metadata vs 1 deductible and 1 valid non-deductible expense.
 *      - Surfaces client follow-up activity on Acme SL and plan quota at 80% (4/5).
 *      - Zero mutating calls executed (`mutationsExecuted === 0`).
 *   2. Partial workspace coverage (`isPartial: true`, multi-page workspace):
 *      - `list_invoices` returns 2 of 47 (`complete: false`) and `list_expenses` returns 1 of 35 (`complete: false`).
 *      - Computes derived total (`derived_from_items`) when a legacy draft lacks `doc.total`.
 *      - Prepends explicit partial-coverage warning in `knownUnknowns` and markdown header.
 *   3. Golden Counterexample 1 (Absent != 0):
 *      - `resolveDocumentAmount({})` returns `amount: null`, `provenance: "unavailable"` (never `0 EUR`).
 *   4. Golden Counterexample 2 (Multi-currency separation):
 *      - `sumProvenancedAmounts([100 EUR, 100 USD])` returns `amount: null`, `currency: "MIXED"`, `provenance: "mixed_currency_unconverted"`, `totalsByCurrency: { EUR: 100, USD: 100 }` (never `200 EUR`).
 *   5. Golden Counterexample 3 (Canonical discounts & taxes):
 *      - `resolveDocumentAmount({ items: [{ quantity: 1, unitPrice: 100 }], discountRate: 10, taxRate: 0, irpfRate: 0 })` returns `90 EUR`.
 *      - Line-level `discount`, document-level `discountRate`, `taxRate`, `equivalenceSurchargeRate`, and `irpfRate` match Frihet's canonical calculation engine.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildScenario1CompleteWorkspaceClient,
  buildScenario2PartialCoverageClient,
  generateDailyOperationalBrief,
  resolveDocumentAmount,
  sumProvenancedAmounts,
  type DailyOperationalBrief,
} from "../workflows/daily-operational-brief.js";

export { buildScenario1CompleteWorkspaceClient, buildScenario2PartialCoverageClient };

describe("Daily Operational Brief — '¿Qué debería revisar hoy en mi negocio y por qué?'", () => {
  test("Scenario 1 (complete workspace): separates drafts from issued invoices, distinguishes operational sample from current month, labels unpaid nominal honestly, and executes zero writes", async () => {
    const callLog: string[] = [];
    const brief: DailyOperationalBrief = await generateDailyOperationalBrief(
      buildScenario1CompleteWorkspaceClient(callLog),
      { asOfDate: "2026-10-28", pageLimit: 20 },
    );

    assert.equal(brief.coverage.isPartial, false);
    assert.equal(brief.coverage.temporalScope, "unfiltered_operational_sample_as_of_date");
    assert.equal(brief.coverage.referenceMonth, "2026-10");
    assert.equal(brief.coverage.resources.invoices.complete, true);
    assert.equal(brief.coverage.resources.invoices.inspected, 5);
    assert.equal(brief.coverage.resources.invoices.total, 5);

    // Strict separation between drafts, issued invoices, paid, and unpaid nominal (overdue vs on-time)
    assert.equal(brief.activitySeparation.draftActivity.invoiceDraftsCount, 2);
    assert.equal(brief.activitySeparation.draftActivity.invoiceDraftsTotal.amount, 1161.6);
    assert.equal(brief.activitySeparation.draftActivity.invoiceDraftsTotal.provenance, "stored_field");

    assert.equal(brief.activitySeparation.issuedActivity.realOutstandingBalanceDeterminable, false);
    assert.equal(
      brief.activitySeparation.issuedActivity.unpaidNominalSemantics,
      "nominal_unpaid_invoice_totals_without_partial_payments",
    );
    assert.equal(brief.activitySeparation.issuedActivity.issuedInvoicesCount, 3);
    assert.equal(brief.activitySeparation.issuedActivity.issuedInvoicesTotal.amount, 1952);
    assert.equal(brief.activitySeparation.issuedActivity.paidInvoicesCount, 1);
    assert.equal(brief.activitySeparation.issuedActivity.paidInvoicesTotal.amount, 500);
    assert.equal(brief.activitySeparation.issuedActivity.unpaidNominalInvoicesCount, 2);
    assert.equal(brief.activitySeparation.issuedActivity.unpaidNominalTotal.amount, 1452);
    assert.equal(brief.activitySeparation.issuedActivity.unpaidNominalTotalsByCurrency.EUR.amount, 1452);
    assert.equal(brief.activitySeparation.issuedActivity.overdueNominalInvoicesCount, 1);
    assert.equal(brief.activitySeparation.issuedActivity.overdueNominalTotal.amount, 605);
    assert.equal(brief.activitySeparation.issuedActivity.onTimeNominalPendingCount, 1);
    assert.equal(brief.activitySeparation.issuedActivity.onTimeNominalPendingTotal.amount, 847);
    assert.deepEqual(brief.activitySeparation.issuedActivity.issuedInvoicesByStatus, {
      overdue: 1,
      sent: 1,
      paid: 1,
    });

    // Temporal separation: operational sample (includes Sept overdue 605 EUR -> 1952 EUR) vs 2026-10 subset (847 + 500 = 1347 EUR)
    assert.equal(brief.activitySeparation.currentMonthActivity.referenceMonth, "2026-10");
    assert.equal(brief.activitySeparation.currentMonthActivity.issuedInvoicesInMonthCount, 2);
    assert.equal(brief.activitySeparation.currentMonthActivity.issuedInvoicesInMonthTotal.amount, 1347);
    assert.equal(brief.activitySeparation.currentMonthActivity.invoiceDraftsInMonthCount, 2);
    assert.equal(brief.activitySeparation.currentMonthActivity.invoiceDraftsInMonthTotal.amount, 1161.6);
    assert.equal(brief.activitySeparation.currentMonthActivity.expensesInMonthCount, 2);
    assert.equal(brief.activitySeparation.currentMonthActivity.expensesInMonthTotal.amount, 153.5);

    // Non-deductible expense with complete vendor/category is NOT treated as an error by default
    assert.equal(brief.activitySeparation.recordedExpenses.expensesCount, 3);
    assert.equal(brief.activitySeparation.recordedExpenses.deductibleCount, 1);
    assert.equal(brief.activitySeparation.recordedExpenses.deductibleTotal.amount, 121);
    assert.equal(brief.activitySeparation.recordedExpenses.nonDeductibleCount, 1);
    assert.equal(brief.activitySeparation.recordedExpenses.nonDeductibleTotal.amount, 45.99);
    assert.equal(brief.activitySeparation.recordedExpenses.pendingReviewCount, 1);
    const expensePriority = brief.priorities.find((p) => p.category === "expense_review");
    assert.ok(expensePriority);
    assert.deepEqual(
      expensePriority.recordRefs.map((r) => r.id),
      ["exp_incomplete_1"],
    );

    // Priorities include overdue invoice, draft invoices, expense review, CRM follow-up, and plan quota
    const categories = brief.priorities.map((p) => p.category);
    assert.deepEqual(categories, [
      "overdue_invoice",
      "draft_invoice",
      "expense_review",
      "client_followup",
      "plan_quota",
    ]);

    // Every suggested action has autoExecuted === false
    for (const item of brief.priorities) {
      assert.equal(item.suggestedNextAction.autoExecuted, false);
    }
    assert.equal(brief.mutationsExecuted, 0);

    // Markdown explicitly states operational sample scope and nominal unpaid wording (never "Saldo pendiente de cobro" unqualified)
    assert.ok(
      brief.markdown.includes(
        "Corte operativo a 2026-10-28 · Muestra abierta/reciente sin filtro mensual",
      ),
    );
    assert.ok(
      brief.markdown.includes(
        "Importe nominal de facturas no marcadas como pagadas (saldo pendiente real no determinable sin cobros parciales)",
      ),
    );
    assert.ok(
      brief.knownUnknowns.some((u) => u.includes("Saldo bancario real y posición de tesorería")),
    );
  });

  test("Scenario 2 (partial multi-page coverage): discloses partial sample, distinguishes derived item totals from stored totals, and flags past-due sent invoice", async () => {
    const callLog: string[] = [];
    const brief = await generateDailyOperationalBrief(
      buildScenario2PartialCoverageClient(callLog),
      { asOfDate: "2026-10-28", pageLimit: 2 },
    );

    assert.equal(brief.coverage.isPartial, true);
    assert.equal(brief.coverage.resources.invoices.inspected, 2);
    assert.equal(brief.coverage.resources.invoices.total, 47);
    assert.equal(brief.coverage.resources.invoices.complete, false);
    assert.equal(brief.coverage.resources.expenses.inspected, 1);
    assert.equal(brief.coverage.resources.expenses.total, 35);
    assert.equal(brief.coverage.resources.expenses.complete, false);

    // Legacy draft without stored total is marked derived_from_items (3 * 100 * 1.21 = 363)
    assert.equal(brief.activitySeparation.draftActivity.invoiceDraftsTotal.amount, 363);
    assert.equal(
      brief.activitySeparation.draftActivity.invoiceDraftsTotal.provenance,
      "derived_from_items",
    );

    // Partial coverage warning is the first knownUnknown and appears in markdown
    assert.ok(brief.knownUnknowns[0].includes("Cobertura parcial del espacio de trabajo"));
    assert.ok(brief.markdown.includes("COBERTURA PARCIAL"));
    assert.ok(brief.markdown.includes("2/47 (parcial)"));
  });

  test("Golden Counterexample 1: missing amount ({}) returns unavailable (amount: null), never 0 EUR", () => {
    const emptyDoc = resolveDocumentAmount({});
    assert.equal(emptyDoc.amount, null);
    assert.equal(emptyDoc.provenance, "unavailable");
    assert.equal(emptyDoc.unavailableCount, 1);

    // Explicit zero-price line item IS valid 0 EUR
    const explicitZero = resolveDocumentAmount({
      items: [{ quantity: 1, unitPrice: 0 }],
      taxRate: 21,
    });
    assert.equal(explicitZero.amount, 0);
    assert.equal(explicitZero.provenance, "derived_from_items");

    // Summing a valid amount with an unavailable amount marks the aggregate unavailable (never coercing the missing doc to 0)
    const combined = sumProvenancedAmounts(
      [resolveDocumentAmount({ total: 100, currency: "EUR" }), emptyDoc],
      "EUR",
    );
    assert.equal(combined.amount, null);
    assert.equal(combined.provenance, "unavailable");
    assert.equal(combined.unavailableCount, 1);
    assert.equal(combined.totalsByCurrency?.EUR?.amount, 100);
  });

  test("Golden Counterexample 2: multi-currency documents (100 EUR + 100 USD) are kept separate in totalsByCurrency and never summed into 200 EUR", () => {
    const multi = sumProvenancedAmounts(
      [
        resolveDocumentAmount({ total: 100, currency: "EUR" }),
        resolveDocumentAmount({ total: 100, currency: "USD" }),
      ],
      "EUR",
    );
    assert.equal(multi.amount, null);
    assert.equal(multi.currency, "MIXED");
    assert.equal(multi.provenance, "mixed_currency_unconverted");
    assert.equal(multi.totalsByCurrency?.EUR?.amount, 100);
    assert.equal(multi.totalsByCurrency?.EUR?.documentCount, 1);
    assert.equal(multi.totalsByCurrency?.USD?.amount, 100);
    assert.equal(multi.totalsByCurrency?.USD?.documentCount, 1);
  });

  test("Golden Counterexample 3: resolveDocumentAmount applies document discountRate, line discount, equivalenceSurchargeRate, and irpfRate", () => {
    // Reviewer's exact counterexample: 1 x 100 with discountRate: 10 -> 90 EUR
    const discounted = resolveDocumentAmount({
      items: [{ quantity: 1, unitPrice: 100 }],
      discountRate: 10,
      taxRate: 0,
      irpfRate: 0,
    });
    assert.equal(discounted.provenance, "derived_from_items");
    assert.equal(discounted.amount, 90);

    // Combined line discount (10%), document discount (5%), IVA (21%), RE (5.2%), IRPF (15%)
    const fullCanonical = resolveDocumentAmount({
      items: [{ quantity: 2, unitPrice: 100, discount: 10 }],
      discountRate: 5,
      taxRate: 21,
      equivalenceSurchargeRate: 5.2,
      irpfRate: 15,
    });
    assert.equal(fullCanonical.provenance, "derived_from_items");
    assert.equal(fullCanonical.amount, 190.15);

    // Unsupported modifiers without stored total fail closed to unavailable
    const unsupported = resolveDocumentAmount({
      items: [{ quantity: 1, unitPrice: 121 }],
      pricesIncludeTax: true,
      taxRate: 21,
    });
    assert.equal(unsupported.amount, null);
    assert.equal(unsupported.provenance, "unavailable");
  });
});
