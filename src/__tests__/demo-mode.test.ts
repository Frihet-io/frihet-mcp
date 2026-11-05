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
import { permissionsMatrixOutput, permissionsMeOutput } from "../tools/shared.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { localMcpSurfaceComposition, registerMcpSurface } from "../server-composition.js";
import { claudeToolResult } from "../claude-output-privacy.js";
import type { IFrihetClient } from "../client-interface.js";

describe("DemoFrihetClient — reads", () => {
  test("listInvoices returns a non-empty canonical PaginatedResponse", async () => {
    const client = new DemoFrihetClient();
    const res = await client.listInvoices();
    assert.ok(Array.isArray(res.data), "data is an array");
    assert.ok(res.data.length > 0, "data is non-empty");
    assert.equal(res.total, res.data.length);
  });

  test("getInvoice(<fixture id>) returns the fixture stamped _demo:true", async () => {
    const client = new DemoFrihetClient();
    const firstId = fixtures.demoInvoices[0]!.id as string;
    const res = await client.getInvoice(firstId);
    assert.equal(res.id, firstId);
    assert.equal(res._demo, true);
    assert.ok(res._demoNotice, "_demoNotice present");
  });

  test("permission reads use the same truthful payload contracts as live ERP", async () => {
    const client = new DemoFrihetClient();
    const matrix = await client.getPermissionsMatrix();
    const me = await client.getMyPermissions();
    const roles = matrix.roles;

    assert.equal(permissionsMatrixOutput.safeParse(matrix).success, true);
    assert.equal(permissionsMeOutput.safeParse(me).success, true);
    assert.ok(Array.isArray(roles));
    assert.equal(typeof roles[0], "string", "matrix roles are role names, not fabricated role objects");
    assert.deepEqual(me.denied, { einvoice: false });
    assert.deepEqual(me.notIncluded, ["featureFlags", "deployedEndpoints"]);
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

describe("Grouped meta-tools in demoMode (#118) and Claude diagnostic error allowlist (#228)", () => {
  test("list_tool_groups, search_tools, and describe_tool carry _demo:true and _demoNotice when client is DemoFrihetClient", async () => {
    const server = new McpServer({ name: "demo-grouped-test", version: "1.0.0" });
    registerMcpSurface(server, new DemoFrihetClient(), localMcpSurfaceComposition(false, true));
    const client = new Client({ name: "demo-grouped-client", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const groupsRes = await client.callTool({ name: "list_tool_groups", arguments: {} });
      const groupsPayload = groupsRes.structuredContent as Record<string, unknown>;
      assert.equal(groupsPayload._demo, true);
      assert.equal(groupsPayload._demoNotice, fixtures.READ_STAMP._demoNotice);
      const groupsText = JSON.parse((groupsRes.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
      assert.equal(groupsText._demo, true);
      assert.equal(groupsText._demoNotice, fixtures.READ_STAMP._demoNotice);

      const searchRes = await client.callTool({ name: "search_tools", arguments: { query: "invoice" } });
      const searchPayload = searchRes.structuredContent as Record<string, unknown>;
      assert.equal(searchPayload._demo, true);
      assert.equal(searchPayload._demoNotice, fixtures.READ_STAMP._demoNotice);
      const searchText = JSON.parse((searchRes.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
      assert.equal(searchText._demo, true);
      assert.equal(searchText._demoNotice, fixtures.READ_STAMP._demoNotice);

      const describeRes = await client.callTool({ name: "describe_tool", arguments: { name: "create_invoice" } });
      const describePayload = describeRes.structuredContent as Record<string, unknown>;
      assert.equal(describePayload._demo, true);
      assert.equal(describePayload._demoNotice, fixtures.READ_STAMP._demoNotice);
      const describeText = JSON.parse((describeRes.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
      assert.equal(describeText._demo, true);
      assert.equal(describeText._demoNotice, fixtures.READ_STAMP._demoNotice);

      // Unknown tool error in demoMode also carries READ_STAMP in its JSON text
      const unknownRes = await client.callTool({ name: "describe_tool", arguments: { name: "nonexistent_tool_xyz" } });
      assert.equal(unknownRes.isError, true);
      const unknownText = JSON.parse((unknownRes.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
      assert.equal(unknownText._demo, true);
      assert.equal(unknownText._demoNotice, fixtures.READ_STAMP._demoNotice);
      assert.equal(unknownText.error, "No tool named 'nonexistent_tool_xyz'.");
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  test("list_tool_groups, search_tools, and describe_tool omit _demo and _demoNotice when demoMode is false", async () => {
    const liveMock = new Proxy({}, { get: () => async () => ({ data: [], total: 0, limit: 20, offset: 0 }) }) as IFrihetClient;
    const server = new McpServer({ name: "live-grouped-test", version: "1.0.0" });
    registerMcpSurface(server, liveMock, localMcpSurfaceComposition(false, true));
    const client = new Client({ name: "live-grouped-client", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      for (const call of [
        { name: "list_tool_groups", arguments: {} },
        { name: "search_tools", arguments: { query: "invoice" } },
        { name: "describe_tool", arguments: { name: "create_invoice" } },
      ] as const) {
        const res = await client.callTool(call);
        const structured = res.structuredContent as Record<string, unknown>;
        assert.equal("_demo" in structured, false, `${call.name} structuredContent must not contain _demo in live mode`);
        assert.equal("_demoNotice" in structured, false, `${call.name} structuredContent must not contain _demoNotice in live mode`);
        const rawText = (res.content as Array<{ text: string }>)[0]!.text;
        assert.doesNotMatch(rawText, /"_demo"/);
        assert.doesNotMatch(rawText, /"_demoNotice"/);
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  test("claudeToolResult allowlists static diagnostic reasons without leaking raw provider prose or PII (#228)", () => {
    const leakedProse = "Error: search for B12345678 / secret@acme.io hit 499 matches in workspace_secret_99";
    const truncOut = claudeToolResult({
      isError: true,
      content: [{ type: "text", text: leakedProse }],
      _meta: {
        "io.frihet/searchScanTruncated": true,
        "io.frihet/unallowlistedSecret": "B12345678",
      },
    });
    assert.equal(truncOut.isError, true);
    assert.equal(truncOut.structuredContent, undefined);
    const truncText = (truncOut.content as Array<{ text: string }>)[0]!.text;
    assert.match(truncText, /^SEARCH_SCAN_TRUNCATED:/);
    assert.doesNotMatch(truncText, /B12345678|secret@acme\.io|499|workspace_secret_99/);
    assert.deepEqual(truncOut._meta, { "io.frihet/searchScanTruncated": true });

    const cursorOut = claudeToolResult({
      isError: true,
      content: [{ type: "text", text: leakedProse }],
      _meta: {
        "io.frihet/cursorWithQueryUnsupported": true,
        "io.frihet/unallowlistedSecret": true,
      },
    });
    assert.equal(cursorOut.isError, true);
    assert.equal(cursorOut.structuredContent, undefined);
    const cursorText = (cursorOut.content as Array<{ text: string }>)[0]!.text;
    assert.match(cursorText, /^CURSOR_WITH_QUERY_UNSUPPORTED:/);
    assert.doesNotMatch(cursorText, /B12345678|secret@acme\.io|499|workspace_secret_99/);
    assert.deepEqual(cursorOut._meta, { "io.frihet/cursorWithQueryUnsupported": true });

    // Precedence: uncertain outcome flags still take precedence over diagnostic flags
    const uncertainOut = claudeToolResult({
      isError: true,
      content: [{ type: "text", text: leakedProse }],
      _meta: {
        "io.frihet/operationOutcomeUnknown": true,
        "io.frihet/searchScanTruncated": true,
      },
    });
    const uncertainText = (uncertainOut.content as Array<{ text: string }>)[0]!.text;
    assert.equal(
      uncertainText,
      "Frihet could not complete or confirm this request. Check access and read the current record before deciding whether to retry.",
    );
  });
});
