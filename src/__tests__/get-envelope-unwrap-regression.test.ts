/**
 * Regression test for the "Output validation error" bug on every single-object
 * get_* tool (get_invoice, get_expense, get_client, ... ) — root cause fix.
 *
 * BUG: single-object read methods in client.ts (getInvoice, getExpense, etc.)
 * called `this.request(...)` (RAW) instead of `this.requestUnwrapped(...)`.
 * The live Frihet ERP REST API wraps every single-object response in a
 * `{ data: <item>, meta: {...} }` envelope (the same convention documented for
 * the already-fixed `getFiscalModeloSummary`). Because the raw envelope was
 * returned straight into the tool's `structuredContent`, and every get_* tool's
 * `outputSchema` expects the FLAT item (not `{data, meta}`), every single-object
 * get_* tool failed MCP output validation ("Output validation error") the
 * moment a real backend response came back.
 *
 * Unlike `contract.test.ts` (which only proves the *schema* accepts an
 * already-unwrapped fixture, via a hand-rolled `unwrap()` mirror function),
 * THIS file boots a real `node:http` mock backend and points a REAL
 * `FrihetClient` at it — the same pattern as `banking-client-contract.test.ts`.
 * It exercises the actual `request()` → `requestUnwrapped()` wiring, so it
 * would have caught the bug: before the fix, every assertion below that checks
 * `"data" in result` / `"meta" in result` would have failed (the envelope keys
 * would have leaked straight into the tool's structuredContent).
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
  expenseItemOutput,
  clientItemOutput,
  productItemOutput,
  quoteItemOutput,
  vendorItemOutput,
  webhookItemOutput,
  depositItemOutput,
  reservationItemOutput,
  posSaleItemOutput,
  kitchenTicketItemOutput,
  bankAccountItemOutput,
  timeEntryItemOutput,
  timeSummaryOutput,
  recurringInvoiceItemOutput,
  pdfResultOutput,
} from "../tools/shared.js";
import { eInvoiceStatusOutput } from "../tools/einvoice.js";

// ── Mock ERP backend: every single-object GET wraps the item in { data, meta } ──

let server: Server;
let baseUrl: string;

/** Wrap an item exactly like the live CF does for single-object reads. */
function envelope(item: unknown, meta: Record<string, unknown> = { source: "test" }) {
  return { data: item, meta };
}

const FIXTURES = {
  invoice: { id: "inv_1", clientName: "Acme Corp", items: [{ description: "Consulting", quantity: 1, unitPrice: 100 }], total: 121, status: "sent" },
  expense: { id: "exp_1", description: "AWS", amount: 42.5, category: "software" },
  client: { id: "cli_1", name: "Acme Corp", email: "billing@acme.example" },
  product: { id: "prod_1", name: "Widget", unitPrice: 19.99 },
  quote: { id: "quo_1", clientName: "Acme Corp", items: [{ description: "Design", quantity: 1, unitPrice: 500 }] },
  vendor: { id: "vend_1", name: "AWS Inc" },
  webhook: { id: "wh_1", url: "https://example.com/hook", events: ["invoice.paid"] },
  deposit: { id: "dep_1", clientId: "cli_1", amount: 300 },
  reservation: { id: "res_1", propertyId: "prop_1", status: "confirmed", checkIn: "2026-08-01", checkOut: "2026-08-05", guestCount: 2 },
  sale: { id: "sale_1", terminalId: "term_1", status: "succeeded", amountCents: 1500 },
  kitchenTicket: { id: "kt_1", stationId: "station_1", status: "queued" },
  bankAccount: { id: "acct_1", alias: "Main", ibanLast4: "4321" },
  timeEntry: { id: "te_1", userId: "u_1", hours: 3.5 },
  recurringInvoice: { id: "rec_1", templateName: "Monthly retainer", frequency: "monthly", status: "active" },
  invoicePdf: { id: "inv_1", url: "https://cdn.example.com/inv_1.pdf", contentType: "application/pdf" },
  timeSummary: { from: "2026-06-01", to: "2026-06-30", totalHours: 40, billableHours: 32, nonBillableHours: 8 },
  einvoiceStatus: { status: "succeeded" as const, step: "delivered", ackId: "ack_123" },
};

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Content-Type", "application/json");

    const send = (body: unknown) => res.end(JSON.stringify(body));

    if (url.pathname === "/invoices" && req.method === "GET") {
      // List path — must stay as the RAW paginated envelope (requestPaginated).
      return send({ data: [FIXTURES.invoice], total: 1, limit: 20, offset: 0 });
    }
    if (url.pathname === "/invoices/inv_1" && req.method === "GET") return send(envelope(FIXTURES.invoice));
    if (url.pathname === "/invoices/inv_1/pdf" && req.method === "GET") return send(envelope(FIXTURES.invoicePdf));
    if (url.pathname === "/invoices/inv_1/xml" && req.method === "GET") {
      return send(envelope({ xml: "<Invoice/>", filename: "inv_1.xml", format: "ubl" }));
    }
    if (url.pathname === "/invoices/plain-xml/xml" && req.method === "GET") {
      // `data` present but NOT an object (a bare string) — must NOT be unwrapped.
      return send({ data: "<Invoice/>", meta: {} });
    }
    if (url.pathname === "/expenses/exp_1" && req.method === "GET") return send(envelope(FIXTURES.expense));
    if (url.pathname === "/clients/cli_1" && req.method === "GET") return send(envelope(FIXTURES.client));
    if (url.pathname === "/products/prod_1" && req.method === "GET") return send(envelope(FIXTURES.product));
    if (url.pathname === "/quotes/quo_1" && req.method === "GET") return send(envelope(FIXTURES.quote));
    if (url.pathname === "/vendors/vend_1" && req.method === "GET") return send(envelope(FIXTURES.vendor));
    if (url.pathname === "/webhooks/wh_1" && req.method === "GET") return send(envelope(FIXTURES.webhook));
    if (url.pathname === "/deposits/dep_1" && req.method === "GET") return send(envelope(FIXTURES.deposit));
    if (url.pathname === "/stay/reservations/res_1" && req.method === "GET") return send(envelope(FIXTURES.reservation));
    if (url.pathname === "/pos/sales/sale_1" && req.method === "GET") return send(envelope(FIXTURES.sale));
    if (url.pathname === "/kitchen/tickets/kt_1" && req.method === "GET") return send(envelope(FIXTURES.kitchenTicket));
    if (url.pathname === "/banking/accounts/acct_1" && req.method === "GET") return send(envelope(FIXTURES.bankAccount));
    if (url.pathname === "/time/entries/te_1" && req.method === "GET") return send(envelope(FIXTURES.timeEntry));
    if (url.pathname === "/time/summary" && req.method === "GET") return send(envelope(FIXTURES.timeSummary));
    if (url.pathname === "/recurring/invoices/rec_1" && req.method === "GET") return send(envelope(FIXTURES.recurringInvoice));
    if (url.pathname === "/einvoice/status/wf_1" && req.method === "GET") return send(envelope(FIXTURES.einvoiceStatus));

    res.statusCode = 404;
    return send({ error: "not_found" });
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

/** Every fixed getter must (a) unwrap the envelope AND (b) validate against
 *  the exact outputSchema the tool declares — the two facts together are what
 *  "Output validation error" required to be true before the fix was applied. */
function assertUnwrappedAndValid(result: unknown, schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }) {
  assert.equal(typeof result, "object");
  assert.ok(result !== null);
  assert.equal("data" in (result as object), false, "envelope 'data' key must NOT leak into the tool result");
  assert.equal("meta" in (result as object), false, "envelope 'meta' key must NOT leak into the tool result");
  const parsed = schema.safeParse(result);
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error, null, 2));
}

describe("client.ts single-object get_* reads unwrap the { data, meta } envelope", () => {
  test("getInvoice unwraps + validates against invoiceItemOutput", async () => {
    const result = await makeClient().getInvoice("inv_1");
    assertUnwrappedAndValid(result, invoiceItemOutput);
    assert.equal((result as { id: string }).id, "inv_1");
  });

  test("getExpense unwraps + validates against expenseItemOutput", async () => {
    const result = await makeClient().getExpense("exp_1");
    assertUnwrappedAndValid(result, expenseItemOutput);
  });

  test("getClient unwraps + validates against clientItemOutput", async () => {
    const result = await makeClient().getClient("cli_1");
    assertUnwrappedAndValid(result, clientItemOutput);
  });

  test("getProduct unwraps + validates against productItemOutput", async () => {
    const result = await makeClient().getProduct("prod_1");
    assertUnwrappedAndValid(result, productItemOutput);
  });

  test("getQuote unwraps + validates against quoteItemOutput", async () => {
    const result = await makeClient().getQuote("quo_1");
    assertUnwrappedAndValid(result, quoteItemOutput);
  });

  test("getVendor unwraps + validates against vendorItemOutput", async () => {
    const result = await makeClient().getVendor("vend_1");
    assertUnwrappedAndValid(result, vendorItemOutput);
  });

  test("getWebhook unwraps + validates against webhookItemOutput", async () => {
    const result = await makeClient().getWebhook("wh_1");
    assertUnwrappedAndValid(result, webhookItemOutput);
  });

  test("getDeposit unwraps + validates against depositItemOutput", async () => {
    const result = await makeClient().getDeposit("dep_1");
    assertUnwrappedAndValid(result, depositItemOutput);
  });

  test("getReservation unwraps + validates against reservationItemOutput", async () => {
    const result = await makeClient().getReservation("res_1");
    assertUnwrappedAndValid(result, reservationItemOutput);
  });

  test("getSale unwraps + validates against posSaleItemOutput", async () => {
    const result = await makeClient().getSale("sale_1");
    assertUnwrappedAndValid(result, posSaleItemOutput);
  });

  test("getKitchenTicket unwraps + validates against kitchenTicketItemOutput", async () => {
    const result = await makeClient().getKitchenTicket("kt_1");
    assertUnwrappedAndValid(result, kitchenTicketItemOutput);
  });

  test("getBankAccount unwraps + validates against bankAccountItemOutput", async () => {
    const result = await makeClient().getBankAccount("acct_1");
    assertUnwrappedAndValid(result, bankAccountItemOutput);
  });

  test("getTimeEntry unwraps + validates against timeEntryItemOutput", async () => {
    const result = await makeClient().getTimeEntry("te_1");
    assertUnwrappedAndValid(result, timeEntryItemOutput);
  });

  test("getTimeSummary unwraps + validates against timeSummaryOutput", async () => {
    const result = await makeClient().getTimeSummary({ from: "2026-06-01", to: "2026-06-30" });
    assertUnwrappedAndValid(result, timeSummaryOutput);
  });

  test("getRecurringInvoice unwraps + validates against recurringInvoiceItemOutput", async () => {
    const result = await makeClient().getRecurringInvoice("rec_1");
    assertUnwrappedAndValid(result, recurringInvoiceItemOutput);
  });

  test("getInvoicePdf unwraps + validates against pdfResultOutput", async () => {
    const result = await makeClient().getInvoicePdf("inv_1");
    assertUnwrappedAndValid(result, pdfResultOutput);
  });

  test("getEInvoiceStatus unwraps + validates against eInvoiceStatusOutput", async () => {
    const result = await makeClient().getEInvoiceStatus("wf_1");
    assertUnwrappedAndValid(result, eInvoiceStatusOutput);
  });

  test("getInvoiceEInvoice unwraps the object-data envelope", async () => {
    const result = (await makeClient().getInvoiceEInvoice("inv_1")) as Record<string, unknown>;
    assert.equal("data" in result, false);
    assert.equal("meta" in result, false);
    assert.equal(result.xml, "<Invoice/>");
    assert.equal(result.filename, "inv_1.xml");
  });

  test("getInvoiceEInvoice does NOT false-unwrap a non-object 'data' value", async () => {
    // Guards the adversarial-review concern: requestUnwrapped only unwraps when
    // `data` is itself a non-array OBJECT. A bare-string `data` (not an envelope,
    // just a coincidentally-named field) must pass through untouched.
    const result = await makeClient().getInvoiceEInvoice("plain-xml");
    assert.deepEqual(result, { data: "<Invoice/>", meta: {} });
  });

  test("listInvoices is unaffected — keeps the raw { data: [...], total, ... } envelope", async () => {
    const result = await makeClient().listInvoices();
    assert.ok(Array.isArray(result.data), "list reads must keep data as an array");
    assert.equal(result.total, 1);
    assert.equal(result.data[0]!.id, "inv_1");
  });
});
