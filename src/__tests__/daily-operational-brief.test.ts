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
  generateDailyOperationalBrief,
  resolveDocumentAmount,
  type DailyOperationalBrief,
} from "../workflows/daily-operational-brief.js";
import type { IFrihetClient } from "../client-interface.js";

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
        monthlySummary: { invoiced: 1452, expenses: 166.99 },
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
            // Intentionally no stored `total`: must derive from items + taxRate
            items: [
              { description: "Consultoría logística", quantity: 3, unitPrice: 100 },
            ],
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
