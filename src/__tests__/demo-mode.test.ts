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
import { captureRegisteredTools } from "./schema-parity.gate.js";

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

  test("the credit-note fixture mirrors the live 201 body, field by field", async () => {
    // The fixture's whole job is to teach a reviewing agent (App Store /
    // ChatGPT connector review runs in demo mode) what the live response looks
    // like. Every field here is pinned against the live builder in
    // Frihet-ERP/functions/src/publicApi.ts, not against a previous fixture.
    const client = new DemoFrihetClient();
    const invoiceId = fixtures.demoInvoices[0]!.id as string;
    const originalNumber = fixtures.demoInvoices[0]!.documentNumber as string | undefined;
    const res = (await client.createCreditNote(invoiceId, {
      reason: "refund",
      fullCredit: true,
    })) as { creditNote: Record<string, unknown> };

    const cn = res.creditNote;
    assert.equal(cn.status, "draft", "live creates a DRAFT — never an issued document");
    assert.equal(cn.rectificationMethod, "I", "the API only ever emits I (por diferencias)");
    assert.equal(cn.originalInvoiceId, invoiceId);
    assert.equal(cn.fullCredit, true, "live hardcodes fullCredit:true in the 201");
    assert.equal(
      cn.documentNumber,
      `CN-${originalNumber ?? "DEMO-001"}`,
      "live numbering is CN-<original>; encoding the R-type here teaches a parse that fails on real data",
    );
    assert.doesNotMatch(
      cn.documentNumber as string,
      /^R[1-5]-/,
      "documentNumber must not encode the R-type",
    );

    // Documented divergence, pinned so it cannot widen silently: demo never
    // throws, so fullCredit:false returns a draft where live answers
    // 400 PARTIAL_CREDIT_NOT_IMPLEMENTED. The echoed field must still be true.
    const partial = (await client.createCreditNote(invoiceId, {
      reason: "refund",
      fullCredit: false,
    })) as { creditNote: Record<string, unknown> };
    assert.equal(partial.creditNote.fullCredit, true);
  });

  test("fixtures use the ECBS/AEAT test IBAN, not a real one", () => {
    assert.equal(fixtures.DEMO_TEST_IBAN, "ES9121000418450200051332");
    const account = fixtures.demoBankAccounts[0]!;
    assert.equal(account.iban, fixtures.DEMO_TEST_IBAN);
  });
});

/* ------------------------------------------------------------------ */
/*  Demo ⇄ outputSchema parity                                         */
/* ------------------------------------------------------------------ */

/**
 * THE REGRESSION THIS EXISTS TO CATCH.
 *
 * `demo-client.ts` is a second, hand-written implementation of the same wire
 * contract the real `FrihetClient` speaks — and NOTHING connected the two. When
 * `permissionsMatrixOutput` was corrected to the backend's real payload
 * (`roles: string[]`), demo-client kept returning `roles: [{ role, permissions }]`.
 * The MCP SDK validates `structuredContent` against the declared `outputSchema`
 * before it leaves the server, so `permissions_matrix` began throwing
 * `McpError: InvalidParams` for every demo user — on the zero-install onboarding
 * surface, the first thing a new user touches. The schema-parity gate did not see
 * it because that gate drives the REAL client against HTTP fixtures.
 *
 * So: drive every registered tool through `DemoFrihetClient` and validate the
 * result against that tool's own `outputSchema`.
 *
 * WHY A BASELINE INSTEAD OF A BLANKET ASSERT. 27 tools already fail, all of the
 * same pre-existing kind: generic demo stubs (`findOrStub` returns `{ id }`) that
 * omit fields the schema requires. Fixing those is a demo-fixtures change, not a
 * contract change, and a gate that ships red gets switched off. The baseline is
 * therefore EXPLICIT and NAMED: a tool not listed here must pass. Removing a name
 * (fixing a stub) needs no ceremony; ADDING one is a deliberate, reviewable act in
 * the same diff as whatever broke it.
 */
const DEMO_PARITY_KNOWN_FAILURES = new Set([
  // Generic `findOrStub` / `simulateWrite` stubs that omit required fields.
  "get_expense", "update_expense", "get_client", "update_client",
  "get_product", "update_product", "get_vendor", "update_vendor",
  "get_webhook", "update_webhook", "get_deposit", "update_deposit",
  "get_deposit", "get_time_entry", "update_time_entry",
  "get_reservation", "sync_channel", "refund_sale",
  "categorize_transaction", "match_transaction_to_invoice",
  "gestoria_message_send",
  // Fiscal/e-invoice simulations that intentionally return a notice, not a payload.
  "einvoice_export", "face_submit", "face_status",
  "ticketbai_submit", "ticketbai_status", "verifactu_resubmit",
  // Deliberately unavailable in demo mode (returns isError by design).
  "ksef_submit",
]);

/** Tools whose required inputs cannot be synthesized generically (nested objects). */
const DEMO_PARITY_UNSYNTHESIZABLE = new Set([
  "create_invoice", "create_quote", "invite_team_member", "frihet_bank_rule_create",
]);

const ARG_CANDIDATES: unknown[] = [
  "2026-07", "2026", "2026-07-15", "demo_001", "https://example.com/hook", "a3",
  1, 10, true, [], ["invoice.created"], {}, "test", "2026-07-15T10:00:00Z",
];

interface ZodField {
  safeParse: (v: unknown) => { success: boolean; error?: unknown };
  options?: unknown;
  def?: { entries?: unknown };
}

/** First value that satisfies a required input field, or undefined if none does. */
function synthesizeArg(field: ZodField): unknown {
  const opts = field.options ?? field.def?.entries;
  if (opts) {
    const first = Array.isArray(opts) ? opts[0] : Object.values(opts as object)[0];
    if (field.safeParse(first).success) return first;
  }
  for (const candidate of ARG_CANDIDATES) {
    if (field.safeParse(candidate).success) return candidate;
  }
  return undefined;
}

describe("DemoFrihetClient ⇄ declared outputSchemas", () => {
  test("every tool outside the named baseline validates against its own outputSchema", async () => {
    const tools = captureRegisteredTools(new DemoFrihetClient());
    const unexpected: string[] = [];
    const nowPassing: string[] = [];
    let checked = 0;

    for (const [name, entry] of tools) {
      const schema = entry.config.outputSchema as ZodField | undefined;
      if (typeof schema?.safeParse !== "function") continue;
      if (DEMO_PARITY_UNSYNTHESIZABLE.has(name)) continue;

      const shape = (entry.config.inputSchema ?? {}) as Record<string, ZodField>;
      const args: Record<string, unknown> = {};
      let synthesizable = true;
      for (const [key, field] of Object.entries(shape)) {
        if (typeof field?.safeParse !== "function") continue;
        if (field.safeParse(undefined).success) continue; // optional
        const value = synthesizeArg(field);
        if (value === undefined) { synthesizable = false; break; }
        args[key] = value;
      }
      if (!synthesizable) continue;

      checked += 1;
      let failed: string | undefined;
      try {
        const result = await entry.handler(args);
        if (result.isError) {
          failed = `isError: ${(result.content?.[0]?.text ?? "").slice(0, 120)}`;
        } else if (result.structuredContent) {
          const parsed = schema.safeParse(result.structuredContent);
          if (!parsed.success) failed = JSON.stringify(parsed.error).slice(0, 300);
        }
      } catch (error) {
        failed = `threw: ${(error as Error).message}`;
      }

      if (failed && !DEMO_PARITY_KNOWN_FAILURES.has(name)) {
        unexpected.push(`${name} → ${failed}`);
      }
      if (!failed && DEMO_PARITY_KNOWN_FAILURES.has(name)) nowPassing.push(name);
    }

    // Name the scan scope: a gate that asserts an invariant over a silent subset
    // is a green that lies.
    assert.ok(checked > 100, `demo parity scanned only ${checked} tools — expected >100`);
    assert.deepEqual(
      unexpected,
      [],
      `demo-client returns a shape its tool's outputSchema REJECTS. The MCP SDK ` +
        `validates structuredContent, so each of these throws McpError for every ` +
        `demo user. Fix demo-client.ts to match the backend — never widen the schema.`,
    );
    assert.deepEqual(
      nowPassing,
      [],
      `these tools now PASS demo parity but are still listed in ` +
        `DEMO_PARITY_KNOWN_FAILURES — delete them from the baseline so it cannot rot ` +
        `into cover for a future regression.`,
    );
  });
});
