/**
 * Tests and synthetic scenarios for the Daily Operational Brief workflow
 * ("¿Qué debería revisar hoy en mi negocio y por qué?").
 *
 * Scenarios:
 *   1. Complete workspace coverage (`isPartial: false`):
 *      - Separates 2 draft invoices (non-issued) from 2 issued invoices (1 overdue, 1 sent).
 *      - Flags 1 expense with `taxDeductible: false` / incomplete metadata vs 1 deductible expense.
 *      - Surfaces client follow-up activity on Acme SL.
 *      - Flags monthly expense plan quota at 80% (4/5).
 *      - Zero mutating calls executed (`mutationsExecuted === 0`).
 *   2. Partial workspace coverage (`isPartial: true`, multi-page workspace):
 *      - `list_invoices` returns 2 of 47 (`complete: false`) and `list_expenses` returns 2 of 35 (`complete: false`).
 *      - Computes derived total (`derived_from_items`) when a legacy draft lacks `doc.total`.
 *      - Prepends explicit partial-coverage warning in `knownUnknowns` and markdown header.
 *      - Never claims complete revenue or healthy bank treasury.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildScenario1CompleteWorkspaceClient,
  buildScenario2PartialCoverageClient,
  generateDailyOperationalBrief,
  resolveDocumentAmount,
  type DailyOperationalBrief,
} from "../workflows/daily-operational-brief.js";

export { buildScenario1CompleteWorkspaceClient, buildScenario2PartialCoverageClient };

describe("Daily Operational Brief — '¿Qué debería revisar hoy en mi negocio y por qué?'", () => {
  test("Scenario 1 (complete workspace): separates drafts from issued invoices, flags overdue + expense + CRM follow-up + quota, and executes zero writes", async () => {
    const callLog: string[] = [];
    const brief: DailyOperationalBrief = await generateDailyOperationalBrief(
      buildScenario1CompleteWorkspaceClient(callLog),
      { asOfDate: "2026-10-28", pageLimit: 20 },
    );

    assert.equal(brief.coverage.isPartial, false);
    assert.equal(brief.coverage.resources.invoices.complete, true);
    assert.equal(brief.coverage.resources.invoices.inspected, 5);
    assert.equal(brief.coverage.resources.invoices.total, 5);

    // Strict separation between drafts, issued invoices, paid, and outstanding (overdue vs on-time)
    assert.equal(brief.activitySeparation.draftActivity.invoiceDraftsCount, 2);
    assert.equal(brief.activitySeparation.draftActivity.invoiceDraftsTotal.amount, 1161.6);
    assert.equal(brief.activitySeparation.draftActivity.invoiceDraftsTotal.provenance, "stored_field");

    assert.equal(brief.activitySeparation.issuedActivity.issuedInvoicesCount, 3);
    assert.equal(brief.activitySeparation.issuedActivity.issuedInvoicesTotal.amount, 1952);
    assert.equal(brief.activitySeparation.issuedActivity.paidInvoicesCount, 1);
    assert.equal(brief.activitySeparation.issuedActivity.paidInvoicesTotal.amount, 500);
    assert.equal(brief.activitySeparation.issuedActivity.outstandingInvoicesCount, 2);
    assert.equal(brief.activitySeparation.issuedActivity.outstandingInvoicesTotal.amount, 1452);
    assert.equal(brief.activitySeparation.issuedActivity.overdueInvoicesCount, 1);
    assert.equal(brief.activitySeparation.issuedActivity.overdueInvoicesTotal.amount, 605);
    assert.equal(brief.activitySeparation.issuedActivity.onTimePendingCount, 1);
    assert.equal(brief.activitySeparation.issuedActivity.onTimePendingTotal.amount, 847);
    assert.deepEqual(brief.activitySeparation.issuedActivity.issuedInvoicesByStatus, {
      overdue: 1,
      sent: 1,
      paid: 1,
    });

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

    // Known unknowns explicitly disclaim bank treasury / cashflow knowledge
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

  test("resolveDocumentAmount distinguishes stored_field vs derived_from_items with IRPF", () => {
    const stored = resolveDocumentAmount({ total: 121, currency: "EUR" });
    assert.equal(stored.provenance, "stored_field");
    assert.equal(stored.amount, 121);

    const derived = resolveDocumentAmount({
      items: [{ quantity: 2, unitPrice: 100 }],
      taxRate: 21,
      irpfRate: 15,
    });
    assert.equal(derived.provenance, "derived_from_items");
    assert.equal(derived.amount, 212);
  });
});
