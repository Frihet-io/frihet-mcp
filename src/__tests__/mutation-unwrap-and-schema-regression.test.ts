/**
 * Regression tests for the "invoices INOPERABLE via MCP" bug set (LANE B1).
 *
 * Two independent bugs made every WRITE path fail MCP output validation while
 * reads (fixed in #64) worked:
 *
 *   BUG-1 (envelope leak on mutations): create/update/action client methods
 *     called `this.request(...)` (RAW) instead of `this.requestUnwrapped(...)`.
 *     The live Frihet `/v1` API wraps EVERY mutation in `{ data, meta }`
 *     (publicApi.ts: 201/PUT/PATCH → `{ data: <resource>, meta }`; action POSTs
 *     → `actionResponse = { data: actionResult, meta }`). The raw envelope went
 *     straight into `structuredContent`, so `id`/`clientName`/`items`/`success`
 *     all read as `undefined` and the tool's outputSchema rejected the call.
 *
 *   BUG-2 (output schemas too strict): list/search item schemas required fields
 *     that `fields=` projections and drafts legitimately omit (`GET
 *     /invoices?fields=id,total` → `{ id }`-shaped rows), and `actionResultOutput`
 *     required `success`+`id` that action endpoints never return in full.
 *
 * Part A boots a `node:http` mock backend that mimics the LIVE mutation envelope
 * and drives a REAL `FrihetClient` (same pattern as
 * get-envelope-unwrap-regression.test.ts) — it would fail before the BUG-1 fix.
 * Part B pins the relaxed schemas against the real projected/draft/action shapes
 * — it would fail before the BUG-2 fix. The final guard asserts the schemas are
 * still strict enough to REJECT a raw envelope, so removing the unwrap regresses.
 *
 * Run: npm test (after build)
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { FrihetClient } from "../client.js";
import {
  invoiceItemOutput,
  paginatedOutput,
  actionResultOutput,
  creditNoteResultOutput,
} from "../tools/shared.js";

// ── Mock ERP backend: every mutation wraps its result in { data, meta } ──

let server: Server;
let baseUrl: string;

function envelope(data: unknown, meta: Record<string, unknown> = { requestId: "test" }) {
  return { data, meta };
}

const FULL_INVOICE = {
  id: "inv_new",
  clientName: "Acme Corp",
  items: [{ description: "Consulting", quantity: 1, unitPrice: 100 }],
  status: "draft",
  taxRate: 21,
};
const FULL_CLIENT = { id: "cli_new", name: "Acme Corp", email: "billing@acme.example" };

async function readBody(req: import("node:http").IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on("data", () => {});
    req.on("end", () => resolve());
  });
}

before(async () => {
  server = createServer(async (req, res) => {
    await readBody(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Content-Type", "application/json");
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };

    // create invoice (201) — main-resource envelope
    if (url.pathname === "/invoices" && req.method === "POST") {
      return send(201, envelope(FULL_INVOICE));
    }
    // update invoice (PATCH) — main-resource envelope
    if (url.pathname === "/invoices/inv_new" && req.method === "PATCH") {
      return send(200, envelope({ ...FULL_INVOICE, status: "sent" }));
    }
    // mark paid (POST action, 200) — action envelope, NO id, has success/status/paidAt
    if (url.pathname === "/invoices/inv_new/paid" && req.method === "POST") {
      return send(200, envelope({ success: true, status: "paid", paidAt: "2026-07-10" }));
    }
    // credit note (POST action) — action envelope with { success, creditNote }
    if (url.pathname === "/invoices/inv_new/credit-note" && req.method === "POST") {
      return send(201, envelope({
        success: true,
        creditNote: { id: "cn_1", documentNumber: "CN-FRI-0001", originalInvoiceId: "inv_new", reason: "error", fullCredit: true },
      }));
    }
    // create client (201) — sibling-resource envelope (proves the fix is systemic)
    if (url.pathname === "/clients" && req.method === "POST") {
      return send(201, envelope(FULL_CLIENT));
    }
    res.statusCode = 404;
    return send(404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeClient(): FrihetClient {
  return new FrihetClient("fri_test_key", baseUrl);
}

function assertNoEnvelopeLeak(result: unknown) {
  assert.equal(typeof result, "object");
  assert.ok(result !== null);
  assert.equal("data" in (result as object), false, "envelope 'data' key must NOT leak into the mutation result");
  assert.equal("meta" in (result as object), false, "envelope 'meta' key must NOT leak into the mutation result");
}

describe("BUG-1 — mutation client methods unwrap the { data, meta } envelope", () => {
  test("createInvoice unwraps + validates against invoiceItemOutput", async () => {
    const result = await makeClient().createInvoice(FULL_INVOICE);
    assertNoEnvelopeLeak(result);
    assert.equal((result as { id: string }).id, "inv_new");
    assert.equal(invoiceItemOutput.safeParse(result).success, true);
  });

  test("updateInvoice unwraps the envelope", async () => {
    const result = await makeClient().updateInvoice("inv_new", { status: "sent" });
    assertNoEnvelopeLeak(result);
    assert.equal((result as { status: string }).status, "sent");
  });

  test("markInvoicePaid unwraps to the action result (success/status/paidAt)", async () => {
    const result = await makeClient().markInvoicePaid("inv_new");
    assertNoEnvelopeLeak(result);
    assert.equal((result as { success: boolean }).success, true);
    assert.equal(actionResultOutput.safeParse(result).success, true);
  });

  test("createCreditNote unwraps to { success, creditNote }", async () => {
    const result = await makeClient().createCreditNote("inv_new", { reason: "error" });
    assertNoEnvelopeLeak(result);
    assert.equal(creditNoteResultOutput.safeParse(result).success, true);
  });

  test("createClient unwraps — the fix is systemic across resources", async () => {
    const result = await makeClient().createClient(FULL_CLIENT);
    assertNoEnvelopeLeak(result);
    assert.equal((result as { id: string }).id, "cli_new");
  });
});

describe("BUG-2 — output schemas tolerate projections, drafts, and action shapes", () => {
  const listOf = (rows: unknown[]) => ({ data: rows, total: rows.length, limit: 20, offset: 0 });

  test("list schema accepts a fields=id,total projection ({ id } / { id,total } rows)", () => {
    const schema = paginatedOutput(invoiceItemOutput);
    assert.equal(schema.safeParse(listOf([{ id: "e2e-invoice-4" }])).success, true);
    assert.equal(schema.safeParse(listOf([{ id: "a", total: 5 }, { id: "b" }])).success, true);
  });

  test("invoiceItemOutput accepts a draft (no items) and a null clientName", () => {
    assert.equal(invoiceItemOutput.safeParse({ id: "inv_draft" }).success, true);
    assert.equal(invoiceItemOutput.safeParse({ id: "inv_draft", clientName: null }).success, true);
  });

  test("actionResultOutput accepts the already-paid shape ({ message, status }) and the happy path", () => {
    assert.equal(actionResultOutput.safeParse({ message: "Invoice already marked as paid", status: "paid" }).success, true);
    assert.equal(actionResultOutput.safeParse({ success: true, status: "paid", paidAt: "2026-07-10" }).success, true);
  });

  test("creditNoteResultOutput accepts the { success, creditNote } action shape", () => {
    assert.equal(creditNoteResultOutput.safeParse({
      success: true,
      creditNote: { id: "cn_1", documentNumber: "CN-1" },
    }).success, true);
  });

  test("GUARD: invoiceItemOutput still REJECTS a raw { data, meta } envelope (id stays required)", () => {
    // `id` stays required precisely so create/update/get can't silently surface
    // the envelope if a future edit drops requestUnwrapped — the envelope has no
    // top-level `id`. actionResultOutput is deliberately permissive (all fields
    // optional so already-paid `{ message, status }` validates), so for ACTION
    // paths the unwrap pinned in Part A — not the schema — is the envelope guard.
    assert.equal(invoiceItemOutput.safeParse({ data: FULL_INVOICE, meta: {} }).success, false);
  });
});
