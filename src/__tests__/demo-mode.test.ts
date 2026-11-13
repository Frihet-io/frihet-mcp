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
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { localMcpSurfaceComposition, registerMcpSurface, type McpSurfaceComposition } from "../server-composition.js";
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

describe("DemoFrihetClient — intelligence reconciles with fixture reads", () => {
  test("context references existing records and reports receivables as of the frozen demo date", async () => {
    const client = new DemoFrihetClient();
    const [context, invoices, clients, expenses] = await Promise.all([
      client.getBusinessContext(), client.listInvoices(), client.listClients(), client.listExpenses(),
    ]);
    const recent = context.recentActivity as Record<string, unknown>;
    const lastInvoice = recent.lastInvoice as Record<string, unknown>;
    const lastExpense = recent.lastExpense as Record<string, unknown>;
    const topClients = context.topClients as Array<{ name: string; totalRevenue: number; invoiceCount: number }>;

    assert.equal(invoices.total, 9);
    assert.equal(clients.total, 5);
    assert.ok(invoices.data.some((invoice) => invoice.documentNumber === lastInvoice.number
      && invoice.issueDate === lastInvoice.date && invoice.clientName === lastInvoice.client));
    assert.ok(expenses.data.some((expense) => expense.date === lastExpense.date
      && expense.vendor === lastExpense.vendor && expense.amount === lastExpense.amount));
    assert.ok(String(lastInvoice.date) <= fixtures.DEMO_NOW.slice(0, 10));
    assert.ok(String(lastExpense.date) <= fixtures.DEMO_NOW.slice(0, 10));
    assert.equal(recent.overdueCount, 2, "a sent invoice due before today is also overdue");
    assert.equal(recent.overdueAmount, 3385.5);
    assert.equal(recent.unpaidCount, 4, "draft and paid invoices are not outstanding receivables");
    assert.equal((recent.coverage as Record<string, unknown>).totalAnalyzed, invoices.total);
    assert.deepEqual(context.series, [{ id: "default", prefix: "F", current: 9, year: 2026 }]);
    assert.deepEqual(topClients.map((entry) => entry.totalRevenue), [1248, 1089, 770.4]);
    for (const topClient of topClients) {
      assert.ok(clients.data.some((entry) => entry.name === topClient.name));
      const paid = invoices.data.filter((invoice) => invoice.clientName === topClient.name && invoice.status === "paid");
      assert.equal(topClient.invoiceCount, paid.length);
      assert.equal(topClient.totalRevenue, paid.reduce((sum, invoice) => sum + Number(invoice.total), 0));
    }
    assert.equal(context._demo, true);
    assert.equal(context._demoNotice, fixtures.READ_STAMP._demoNotice);
  });

  test("current month agrees with the monthly summary and excludes the two July drafts from revenue", async () => {
    const client = new DemoFrihetClient();
    const before = JSON.stringify([fixtures.demoInvoices, fixtures.demoExpenses]);
    const context = await client.getBusinessContext();
    const summary = await client.getMonthlySummary();
    const revenue = summary.revenue as Record<string, number>;
    const expenses = summary.expenses as Record<string, number>;
    const profit = summary.profit as Record<string, number>;
    const invoices = summary.invoices as Record<string, number>;
    const month = context.currentMonth as Record<string, number>;

    assert.equal(summary.period, fixtures.DEMO_NOW.slice(0, 7));
    assert.deepEqual(month, { revenue: 0, expenses: 105.4, profit: -105.4, invoiceCount: 2, expenseCount: 2 });
    assert.equal(month.revenue, revenue.total);
    assert.equal(month.expenses, expenses.total);
    assert.equal(month.profit, profit.gross);
    assert.equal(month.invoiceCount, invoices.created);
    const plan = context.plan as Record<string, { used: number }>;
    assert.equal(plan.invoices!.used, month.invoiceCount);
    assert.equal(plan.expenses!.used, month.expenseCount);
    assert.deepEqual(revenue, { total: 0, taxBase: 0, tax: 0, irpf: 0 });
    assert.deepEqual(summary.topClients, []);
    assert.equal(JSON.stringify([fixtures.demoInvoices, fixtures.demoExpenses]), before, "reads must not mutate fixtures");
  });

  test("requested months change the records and amounts instead of relabelling a fixed response", async () => {
    const client = new DemoFrihetClient();
    const june = await client.getMonthlySummary("2026-06");
    assert.deepEqual(june.revenue, { total: 7355.4, taxBase: 6540, tax: 815.4, irpf: 0 });
    assert.deepEqual(june.expenses, { total: 180.2, deductible: 180.2, tax: 0 });
    assert.deepEqual(june.profit, { gross: 7175.2, net: 6359.8 });
    assert.deepEqual(june.invoices, { created: 5, sent: 3, paid: 2, overdue: 0 });
    assert.deepEqual(june.byCategory, { office_supplies: 48.2, meals: 62, travel: 70 });
    assert.deepEqual(june.taxLiability, { vatPayable: 815.4, irpfRetained: 0, estimatedModel303: 815.4 });
    assert.equal(june._demo, true);

    const empty = await client.getMonthlySummary("2025-01");
    assert.deepEqual(empty.revenue, { total: 0, taxBase: 0, tax: 0, irpf: 0 });
    assert.deepEqual(empty.expenses, { total: 0, deductible: 0, tax: 0 });
    assert.deepEqual(empty.profit, { gross: 0, net: 0 });
    assert.deepEqual(empty.invoices, { created: 0, sent: 0, paid: 0, overdue: 0 });
    assert.deepEqual(empty.topClients, []);
    assert.deepEqual(empty.byCategory, {});
  });
});

describe("DemoFrihetClient — writes are simulated", () => {
  test("simulated creates cannot alias existing fixture IDs or persist into subsequent reads", async () => {
    const client = new DemoFrihetClient();
    const before = JSON.stringify(await client.listClients());
    const existingIds = new Set(fixtures.demoClients.map((entry) => entry.id));
    const first = await client.createClient({ name: "Simulated example one", email: "one@example.com" });
    const second = await client.createClient({ name: "Simulated example two", email: "two@example.com" });

    assert.equal(existingIds.has(first.id), false, "a new simulated client must not resolve to a different fixture client");
    assert.equal(existingIds.has(second.id), false);
    assert.notEqual(first.id, second.id);
    for (const created of [first, second]) {
      assert.equal(created._demo, true);
      assert.equal(created._demoNotice, fixtures.WRITE_STAMP._demoNotice);
      const fetched = await client.getClient(String(created.id));
      assert.equal(fetched.name, undefined, "simulated creation is not persisted");
    }
    assert.equal(JSON.stringify(await client.listClients()), before);
  });

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


const PAGINATED_DEMO_TOOLS = [
  "list_invoices", "search_invoices", "list_quotes", "list_recurring_invoices",
  "list_deposits", "list_expenses", "list_vendors", "list_clients",
  "list_client_contacts", "list_client_activities", "list_client_notes",
  "list_bank_accounts", "list_transactions", "frihet_bank_rules_list",
  "leave_list", "anomaly_list", "list_team_members", "list_time_entries",
  "list_products", "list_purchase_orders", "list_reservations", "list_properties",
  "list_terminals", "list_sales", "list_kitchen_tickets", "list_kitchen_stations",
  "list_menu_items", "global_search",
];

const DEMO_PROFILES = [
  ["general", localMcpSurfaceComposition(false, false)],
  ["grouped", localMcpSurfaceComposition(false, true)],
  ["claude", localMcpSurfaceComposition(false, false, true)],
  ["claude-grouped", localMcpSurfaceComposition(false, true, true)],
  ["openai", localMcpSurfaceComposition(true, false)],
  ["openai-review", localMcpSurfaceComposition(true, true)],
  ["google", localMcpSurfaceComposition(false, false, false, true)],
  ["muse", localMcpSurfaceComposition(false, false, false, false, true)],
] as const;

async function withPaginationSdk(
  api: IFrihetClient,
  composition: McpSurfaceComposition,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const server = new McpServer({ name: "demo-pagination", version: "1.0.0" });
  registerMcpSurface(server, api, composition);
  const client = new Client({ name: "demo-pagination-client", version: "1.0.0" }, {
    jsonSchemaValidator: new AjvJsonSchemaValidator(),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    await run(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

for (const [profile, composition] of DEMO_PROFILES) {
  describe(`Demo pagination through the real MCP SDK: ${profile}`, () => {
    test("every paginated tool labels empty pages in closed schemas, structured content and text", async (t) => {
      await withPaginationSdk(new DemoFrihetClient(), composition, async (client) => {
        const { tools } = await client.listTools();
        const paginated = tools.filter((tool) => ["data", "total", "limit", "offset"]
          .every((key) => key in (tool.outputSchema?.properties ?? {})));
        const expected = PAGINATED_DEMO_TOOLS.filter((name) => tools.some((tool) => tool.name === name));
        assert.deepEqual(paginated.map((tool) => tool.name).sort(), expected.sort());
        if (profile === "general" || profile === "grouped") assert.equal(paginated.length, 28);
        assert.ok(paginated.length > 0);
        for (const tool of paginated) {
          await t.test(tool.name, async () => {
            const result = await client.callTool({ name: tool.name, arguments: {
              limit: 5, offset: 100,
              ...(["list_client_contacts", "list_client_activities", "list_client_notes"].includes(tool.name)
                ? { clientId: "demo_cli_001" } : {}),
              ...(tool.name === "search_invoices" ? { query: "no-matching-demo-record" } : {}),
              ...(tool.name === "global_search" ? { q: "no-matching-demo-record" } : {}),
            } });
            assert.equal(result.isError, undefined);
            const structured = result.structuredContent as Record<string, unknown>;
            assert.deepEqual(structured.data, []);
            assert.equal(structured._demo, true);
            assert.equal(structured._demoNotice, fixtures.READ_STAMP._demoNotice);
            const text = (result.content as Array<{ text: string }>)[0]!.text;
            assert.deepEqual(JSON.parse(text), structured);
            assert.ok(tool.outputSchema);
            assert.equal(tool.outputSchema.additionalProperties, false);
            const validate = new AjvJsonSchemaValidator().getValidator(tool.outputSchema);
            assert.equal(validate(structured).valid, true);
            for (const patch of [
              { _demo: false }, { _demoNotice: "real data" }, { total: "invalid" },
              { meta: { private: "must not be allowed" } },
            ]) assert.equal(validate({ ...structured, ...patch }).valid, false);
            const { _demo, _demoNotice, ...withoutStamp } = structured;
            assert.equal(validate(withoutStamp).valid, false, "demo marker is required, never merely optional");
          });
        }
      });
    });

    test("populated invoice, client and product pages retain identical demo JSON and structured data", async () => {
      await withPaginationSdk(new DemoFrihetClient(), composition, async (client) => {
        await client.listTools();
        for (const name of ["list_invoices", "list_clients", "list_products"]) {
          const result = await client.callTool({ name, arguments: { limit: 5 } });
          assert.equal(result.isError, undefined, name);
          const structured = result.structuredContent as Record<string, unknown>;
          assert.ok(Array.isArray(structured.data) && structured.data.length > 0);
          assert.equal(structured._demo, true, name);
          assert.equal(structured._demoNotice, fixtures.READ_STAMP._demoNotice, name);
          assert.deepEqual(JSON.parse((result.content as Array<{ text: string }>)[0]!.text), structured);
          assert.ok((result.content as unknown[]).length > 1, "preserve the existing profile's summary and hints");
        }
      });
    });

    test("live pagination schemas and payloads have no demo fields", async () => {
      const page = { data: [], total: 0, limit: 5, offset: 0 };
      const api = new Proxy({}, { get: () => async () => page }) as IFrihetClient;
      await withPaginationSdk(api, composition, async (client) => {
        const { tools } = await client.listTools();
        for (const name of ["list_invoices", "list_clients", "list_products"]) {
          const descriptor = tools.find((tool) => tool.name === name)!;
          assert.ok(descriptor.outputSchema);
          assert.equal("_demo" in (descriptor.outputSchema.properties ?? {}), false);
          assert.equal("_demoNotice" in (descriptor.outputSchema.properties ?? {}), false);
          const result = await client.callTool({ name, arguments: { limit: 5 } });
          assert.equal(result.isError, undefined);
          assert.deepEqual(result.structuredContent, page);
          assert.doesNotMatch(JSON.stringify(result.content), /_demo|DEMO MODE/);
        }
      });
    });

    test("error responses are not converted into successful stamped pages", async () => {
      await withPaginationSdk(new DemoFrihetClient(), composition, async (client) => {
        await client.listTools();
        const result = await client.callTool({ name: "list_clients", arguments: { q: "example", after: "cursor" } });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent, undefined);
        assert.doesNotMatch(JSON.stringify(result.content), /_demo|DEMO MODE/);
      });
    });
  });
}
