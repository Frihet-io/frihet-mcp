/**
 * Pinning tests for the two codex findings on PR #65's schema relaxation:
 *
 * 1. HIGH — all-optional + passthrough action schemas would VALIDATE a raw
 *    {data, meta} envelope, silently re-hiding the unwrap bug this PR fixes if
 *    a client method ever regresses to raw request(). The anti-envelope
 *    tripwire (data/meta: z.never().optional()) must reject it.
 *
 * 2. MEDIUM — paginatedOutput applied `.partial()` to EVERY list, dropping the
 *    id/core contract for families whose tools expose no `fields=` projection
 *    (time, POS, banking, kitchen, team, ...). Now `.partial()` is opt-in via
 *    { projectable: true } — only the 10 list tools that actually accept
 *    `fields=` use it.
 *
 * Run: npm test (after build)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  actionResultOutput,
  creditNoteResultOutput,
  paginatedOutput,
  invoiceItemOutput,
  timeEntryItemOutput,
} from "../tools/shared.js";

const ENVELOPE = { data: { success: true, status: "paid" }, meta: { requestId: "req_1" } };

describe("anti-envelope tripwire — raw {data,meta} must NEVER validate", () => {
  test("actionResultOutput rejects a raw envelope", () => {
    assert.equal(actionResultOutput.safeParse(ENVELOPE).success, false);
  });

  test("creditNoteResultOutput rejects a raw envelope", () => {
    assert.equal(creditNoteResultOutput.safeParse(ENVELOPE).success, false);
  });

  test("actionResultOutput still accepts every legitimate live action shape", () => {
    // POST /invoices/:id/paid happy path
    assert.ok(actionResultOutput.safeParse({ success: true, status: "paid", paidAt: "2026-07-10" }).success);
    // already-paid path ({message, status}, no success)
    assert.ok(actionResultOutput.safeParse({ message: "Invoice already paid", status: "paid" }).success);
  });

  test("creditNoteResultOutput still accepts the live credit-note shape", () => {
    assert.ok(
      creditNoteResultOutput.safeParse({
        success: true,
        creditNote: { id: "cn_1", documentNumber: "R-2026-001", originalInvoiceId: "inv_1" },
      }).success,
    );
  });
});

describe("paginatedOutput — partial rows are opt-in (projectable), not global", () => {
  const page = (row: Record<string, unknown>) => ({ data: [row], total: 1, limit: 20, offset: 0 });

  test("projectable list (invoices, exposes fields=) accepts an {id}-only projected row", () => {
    const schema = paginatedOutput(invoiceItemOutput, { projectable: true });
    assert.ok(schema.safeParse(page({ id: "inv_1" })).success);
  });

  test("non-projectable list (time entries, no fields= param) rejects an empty row", () => {
    const schema = paginatedOutput(timeEntryItemOutput);
    assert.equal(schema.safeParse(page({})).success, false);
  });

  test("non-projectable list still accepts a full row", () => {
    const schema = paginatedOutput(timeEntryItemOutput);
    assert.ok(schema.safeParse(page({ id: "te_1", hours: 2 })).success);
  });
});
