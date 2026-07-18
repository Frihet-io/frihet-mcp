/**
 * Demo mode (`FRIHET_DEMO=1`) — DemoFrihetClient contract + fixture PII safety.
 *
 * Verifies the fixture-backed client serves stamped example data with ZERO
 * network calls, simulates writes with a demo id, labels fiscal actions as
 * simulated, and that no fixture email leaks a non-@example.com domain.
 *
 * Run: npm test (after build)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { DemoFrihetClient } from "../demo-client.js";
import * as fixtures from "../demo-fixtures.js";

describe("DemoFrihetClient — reads", () => {
  test("listInvoices returns a non-empty stamped PaginatedResponse", async () => {
    const client = new DemoFrihetClient();
    const res = await client.listInvoices();
    assert.ok(Array.isArray(res.data), "data is an array");
    assert.ok(res.data.length > 0, "data is non-empty");
    assert.equal(res.total, res.data.length);
    assert.equal((res as unknown as { _demo: boolean })._demo, true);
    assert.ok((res as unknown as { _demoNotice?: string })._demoNotice, "_demoNotice present");
  });

  test("getInvoice(<fixture id>) returns the fixture stamped _demo:true", async () => {
    const client = new DemoFrihetClient();
    const firstId = fixtures.demoInvoices[0]!.id as string;
    const res = await client.getInvoice(firstId);
    assert.equal(res.id, firstId);
    assert.equal(res._demo, true);
    assert.ok(res._demoNotice, "_demoNotice present");
  });
});

describe("DemoFrihetClient — writes are simulated", () => {
  test("createInvoice returns _demo:true with a demo_-prefixed id, purely", async () => {
    const client = new DemoFrihetClient();
    const res = await client.createInvoice({
      clientName: "Test Client",
      items: [{ description: "Work", quantity: 2, unitPrice: 100 }],
      taxRate: 21,
    });
    assert.equal(res._demo, true);
    assert.equal(typeof res.id, "string");
    assert.ok((res.id as string).startsWith("demo_"), `id "${res.id as string}" starts with demo_`);
    // Echoes input + computes totals.
    assert.equal(res.clientName, "Test Client");
    assert.equal(res.subtotal, 200);
    assert.equal(res.taxAmount, 42);
    assert.equal(res.total, 242);
    // WRITE notice communicates non-persistence.
    assert.match(res._demoNotice as string, /Simulated — not persisted/);
  });

  test("createInvoice is a pure function — no throw, no network, repeatable", async () => {
    const client = new DemoFrihetClient();
    // Called twice back-to-back; neither throws nor hangs on a socket.
    const a = await client.createInvoice({ clientName: "A", items: [] });
    const b = await client.createInvoice({ clientName: "B", items: [] });
    assert.equal(a._demo, true);
    assert.equal(b._demo, true);
    assert.notEqual(a.id, b.id, "ids are distinct across calls");
  });
});

describe("DemoFrihetClient — fiscal actions are simulated only", () => {
  test("sendEInvoice returns _demo:true + a simulated queued status, never throws", async () => {
    const client = new DemoFrihetClient();
    const res = await client.sendEInvoice({ invoiceId: "demo_inv_001", format: "facturae", dispatchMode: "peppol" });
    assert.equal(res.status, "queued");
    assert.equal(typeof res.workflowRunId, "string");
    assert.equal((res as unknown as { _demo: boolean })._demo, true);
    const notice = (res as unknown as { _demoNotice?: string })._demoNotice;
    assert.ok(notice, "_demoNotice present");
    assert.match(notice as string, /no submission was made to any tax authority/);
  });

  test("faceSubmit + ticketbaiSubmit are labeled simulated, never real submissions", async () => {
    const client = new DemoFrihetClient();
    const face = await client.faceSubmit({ invoiceId: "demo_inv_001", mode: "sandbox" });
    assert.equal(face.status, "submitted");
    assert.equal((face as unknown as { _demo: boolean })._demo, true);
    const tbai = await client.ticketbaiSubmit({ invoiceId: "demo_inv_001", sandbox: true });
    assert.equal((tbai as unknown as { _demo: boolean })._demo, true);
    assert.match((tbai as unknown as { _demoNotice: string })._demoNotice, /no submission was made to any tax authority/);
  });
});

describe("demo fixtures — PII safety", () => {
  test("every email string in the fixtures ends with @example.com", () => {
    // Collect every string value that looks like an email across all fixture
    // exports; assert none uses a domain other than example.com.
    const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    const emails: string[] = [];
    const seen = new Set<unknown>();
    const walk = (val: unknown): void => {
      if (val == null) return;
      if (typeof val === "string") {
        const matches = val.match(emailRe);
        if (matches) emails.push(...matches);
        return;
      }
      if (typeof val !== "object") return;
      if (seen.has(val)) return;
      seen.add(val);
      for (const v of Object.values(val as Record<string, unknown>)) walk(v);
    };
    walk(fixtures);

    assert.ok(emails.length > 0, "fixtures contain at least one email (sanity)");
    for (const email of emails) {
      assert.ok(email.endsWith("@example.com"), `email "${email}" must be under @example.com`);
    }
  });

  test("fixtures use the ECBS/AEAT test IBAN, not a real one", () => {
    assert.equal(fixtures.DEMO_TEST_IBAN, "ES9121000418450200051332");
    const account = fixtures.demoBankAccounts[0]!;
    assert.equal(account.iban, fixtures.DEMO_TEST_IBAN);
  });
});
