import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { applyClaudeCandidateProfile } from "../claude-profile.js";
import { claudeToolResult, sanitizeClaudeOutput } from "../claude-output-privacy.js";
import { FrihetApiError } from "../client.js";
import { SENSITIVE_FIELD_NAMES } from "../redaction.js";
import { registerMcpSurface, localMcpSurfaceComposition, remoteMcpSurfaceComposition } from "../server-composition.js";
import type { IFrihetClient } from "../client-interface.js";
import { initLangfuse } from "../observability.js";

const privateFields = Object.fromEntries([...SENSITIVE_FIELD_NAMES, "nss", "Authorization", "clientSecret"].map((name) => [name, `PRIVATE_${name}_fixture`]));
const record: Record<string, unknown> = {
  id: "synthetic_record", name: "Synthetic customer", total: 250, amountPaid: 100,
  currency: "EUR", status: "draft", description: "Synthetic record", amount: 250, unitPrice: 250, ...privateFields,
  details: [{ nested: { ...privateFields, visible: "Keep this business value" } }],
  notes: `A copy of ${privateFields.taxId} and ${privateFields.iban}`,
  serialized: JSON.stringify({ customer: { taxId: 'PRIVATE_escaped_"value', name: "Synthetic" } }),
};

function assertPrivate(value: unknown): void {
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_/u);
}

async function connect(server: McpServer) {
  const client = new Client({ name: "claude-privacy-fixtures", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, close: () => Promise.allSettled([client.close(), server.close()]) };
}

function api(calls: Array<{ method: string; args: unknown[] }>): IFrihetClient {
  return new Proxy({}, { get: (_target, method) => async (...args: unknown[]) => {
    calls.push({ method: String(method), args });
    if (method === "getBusinessContext") return {
      ...record,
      business: { name: "Synthetic", taxId: "PRIVATE_taxId_fixture", fiscalZone: "peninsula", currency: "EUR", language: "es", country: "ES" },
      defaults: { taxRate: 21, irpfRate: 0, dueDays: 30, currency: "EUR" },
      plan: { name: "pro", invoices: { used: 1, limit: 100 }, expenses: { used: 1, limit: 100 }, aiMessages: { used: 0, limit: "unlimited" } },
      series: [], recentActivity: { lastInvoice: null, lastExpense: null, overdueCount: 0, overdueAmount: 0, unpaidCount: 0 },
      topClients: [], currentMonth: { revenue: 250, expenses: 0, profit: 250, invoiceCount: 1, expenseCount: 0 },
    };
    if (String(method).startsWith("list")) return { data: [record], total: 1, limit: 20, offset: 0 };
    if (method === "createCreditNote") return { success: true, creditNote: { id: "credit_synthetic", documentNumber: "PRIVATE_documentNumber_fixture", totalCredited: 50 } };
    if (method === "createWebhook") return {
      id: "webhook_synthetic", name: "Synthetic", url: "https://example.invalid/hook", events: ["invoice.created"],
      status: "active", hasSecret: true, secret: "PRIVATE_secret_fixture", metadata: { nested: privateFields },
    };
    if (method === "exportPayroll") return {
      month: "2026-10", format: "a3", employees: [{ id: "employee_synthetic", name: "Synthetic employee",
        nss: "PRIVATE_nss_fixture", iban: "PRIVATE_iban_fixture", irpfPct: 10, salaryGrossAnnual: 30000,
        convenioColectivo: null, categoriaProfesional: null, prorrateoPagasExtras: false, formaPago: "transferencia" }],
      summary: { exportedCount: 1, skippedNotReady: 0, totalGrossAnnual: 30000 },
    };
    return record;
  } }) as IFrihetClient;
}

const confirmationCases = [
  ["delete_invoice", { id: "PRIVATE_invoice_fixture", confirm: false }],
  ["delete_quote", { id: "PRIVATE_quote_fixture", confirm: false }],
  ["delete_recurring_invoice", { id: "PRIVATE_recurring_fixture", confirm: false }],
  ["delete_time_entry", { id: "PRIVATE_time_fixture", confirm: false }],
  ["match_transaction_to_invoice", { transactionId: "PRIVATE_transaction_fixture", documentId: "PRIVATE_invoice_fixture", documentType: "invoice", confirm: false }],
  ["refund_deposit", { id: "PRIVATE_deposit_fixture", confirm: false }],
  ["remove_team_member", { memberId: "PRIVATE_member_fixture", confirm: false }],
  ["run_recurring_now", { templateId: "PRIVATE_recurring_fixture", draftOnly: true, confirm: false }],
  ["send_invoice", { id: "PRIVATE_invoice_fixture", to: "PRIVATE_recipient@example.invalid", confirm: false }],
  ["verifactu_resubmit", { invoiceId: "PRIVATE_invoice_fixture", confirm: false }],
] as const;

const CONFIRMATION_TEXT = "CONFIRMATION_REQUIRED: This action requires explicit confirmation (confirm=true). No action was performed. Review the action and its side effects before confirming.";

for (const local of [true, false]) for (const claude of [true, false]) {
  test(`${claude ? "Claude" : "general"} ${local ? "local" : "remote"} confirms all ten real guards before any API or network IO`, async () => {
    let apiCalls = 0;
    let networkCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { networkCalls++; throw new Error("PRIVATE_unexpected_network"); };
    initLangfuse({});
    const clientApi = new Proxy({}, { get: () => async () => {
      apiCalls++;
      throw new Error("PRIVATE_unexpected_API");
    } }) as IFrihetClient;
    const server = new McpServer({ name: "confirmation-boundary", version: "1.0.0" });
    registerMcpSurface(server, clientApi, (local ? localMcpSurfaceComposition : remoteMcpSurfaceComposition)(false, true, claude));
    const { client, close } = await connect(server);
    try {
      for (const [name, args] of confirmationCases) {
        const result = await client.callTool({ name, arguments: args });
        assert.equal(result.isError, true, name);
        assert.deepEqual(result._meta, { "io.frihet/confirmationRequired": true }, name);
        assert.equal(result.structuredContent, undefined, name);
        const text = (result.content as Array<{ text: string }>)[0].text;
        if (claude) assert.equal(text, CONFIRMATION_TEXT, name);
        else assert.match(text, /confirm=true/u, name);
        assertPrivate(result);
      }
      assert.equal(apiCalls, 0, "a confirmation guard must precede reads as well as writes");
      assert.equal(networkCalls, 0, "denial must not contact providers or emit telemetry");
    } finally { await close(); globalThis.fetch = originalFetch; }
  });
}

test("Claude renders only typed confirmation flags and preserves uncertain-outcome precedence", () => {
  const content = [{ type: "text", text: "PRIVATE_provider_claim: confirm=true is required" }];
  const confirmed = claudeToolResult({ isError: true, content, structuredContent: { id: "PRIVATE_record", message: "PRIVATE_provider" },
    _meta: { "io.frihet/confirmationRequired": true, arbitrary: "PRIVATE_metadata" } });
  assert.equal((confirmed.content as Array<{ text: string }>)[0].text, CONFIRMATION_TEXT);
  assert.deepEqual(confirmed._meta, { "io.frihet/confirmationRequired": true });
  assert.equal(confirmed.structuredContent, undefined);
  assertPrivate(confirmed);
  for (const value of [undefined, false, "true", 1, null, { raw: "PRIVATE_metadata" }]) {
    const result = claudeToolResult({ isError: true, content, _meta: { "io.frihet/confirmationRequired": value } });
    assert.doesNotMatch((result.content as Array<{ text: string }>)[0].text, /^CONFIRMATION_REQUIRED:/u);
    assertPrivate(result);
  }
  for (const flag of ["operationOutcomeUnknown", "transportOutcomeUnknown", "operationMayHaveCompleted"]) {
    const result = claudeToolResult({ isError: true, content, structuredContent: { id: "PRIVATE_record" },
      _meta: { "io.frihet/confirmationRequired": true, [`io.frihet/${flag}`]: true } });
    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.match(text, /could not complete or confirm/u);
    assert.doesNotMatch(text, /^CONFIRMATION_REQUIRED:|No action was performed/u);
    assertPrivate(result);
  }
});

test("OpenAI keeps the reviewed catalogue and rejects false confirmation before IO", async () => {
  let calls = 0;
  const server = new McpServer({ name: "openai-confirmation-regression", version: "1.0.0" });
  const clientApi = new Proxy({}, { get: () => async () => { calls++; throw new Error("PRIVATE_API"); } }) as IFrihetClient;
  registerMcpSurface(server, clientApi, remoteMcpSurfaceComposition(true, false));
  const { client, close } = await connect(server);
  try {
    const listed = (await client.listTools()).tools;
    assert.equal(listed.length, 33);
    assert.ok(!listed.some(tool => tool.name === "frihet_gl_entry_audit_log"));
    const result = await client.callTool({ name: "delete_quote", arguments: { id: "PRIVATE_quote", confirm: false } });
    assert.equal(result.isError, true);
    assert.equal(calls, 0);
    assertPrivate(result);
  } finally { await close(); }
});

for (const local of [true, false]) for (const grouped of [true, false]) {
  test(`Claude ${local ? "stdio composition" : "Worker composition"}/${grouped ? "grouped" : "full"} redacts actual SDK calls without replaying writes`, async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const server = new McpServer({ name: "privacy-surface", version: "1.0.0" });
    registerMcpSurface(server, api(calls), (local ? localMcpSurfaceComposition : remoteMcpSurfaceComposition)(false, grouped, true));
    const { client, close } = await connect(server);
    try {
      const listed = (await client.listTools()).tools;
      assert.doesNotMatch(JSON.stringify(listed.find((tool) => tool.name === "payroll_export")!.outputSchema), /"iban"|"nss"/u);
      assert.ok("secret" in listed.find((tool) => tool.name === "create_webhook")!.inputSchema.properties!);
      for (const [name, args] of [
        ["get_invoice", { id: "synthetic_record" }],
        ["get_client", { id: "synthetic_record" }],
        ["get_bank_account", { id: "synthetic_record" }],
        ["list_invoices", {}],
        ["get_business_context", {}],
        ["payroll_export", { format: "a3", month: "2026-10" }],
        ["create_webhook", { name: "Synthetic", url: "https://example.invalid/hook", events: ["invoice.created"], secret: "PRIVATE_secret_fixture" }],
        ["create_credit_note", { invoiceId: "synthetic_record", reason: "refund", idempotencyKey: "synthetic-idempotency-key" }],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
        assertPrivate(result);
        assert.equal((result.content as Array<{ text: string }>)[0].text, JSON.stringify(result.structuredContent, null, 2));
      }
      assert.equal(calls.filter((call) => call.method === "createWebhook").length, 1);
      assert.equal((calls.find((call) => call.method === "createWebhook")!.args[0] as { secret: string }).secret, "PRIVATE_secret_fixture");
      assert.equal(calls.filter((call) => call.method === "createCreditNote").length, 1);
      assert.equal(calls.find((call) => call.method === "createCreditNote")!.args[2], "synthetic-idempotency-key");
      const output = await client.callTool({ name: "get_invoice", arguments: { id: "synthetic_record" } });
      const structured = output.structuredContent as Record<string, unknown>;
      assert.equal(structured.total, 250);
      assert.equal(structured.amountPaid, 100);
      assert.deepEqual(structured.details, [{ nested: { visible: "Keep this business value" } }]);
      for (const name of ["list_clients", "list_quotes", "list_expenses", "list_vendors", "list_products"]) {
        const result = await client.callTool({ name, arguments: {} });
        assert.notEqual(result.isError, true);
        assertPrivate(result);
      }
      const beforeDenied = calls.length;
      for (const name of ["get_invoice_pdf", "get_invoice_einvoice"]) {
        const result = await client.callTool({ name, arguments: { id: "synthetic_record" } });
        assert.equal(result.isError, true);
      }
      assert.equal(calls.length, beforeDenied);
      assert.equal(record.taxId, "PRIVATE_taxId_fixture", "shared API object must not be mutated");
    } finally { await close(); }
  });
}

test("Claude removes required sensitive schema fields, opaque content and arbitrary metadata through real SDK", async () => {
  const server = new McpServer({ name: "privacy-blocks", version: "1.0.0" });
  applyClaudeCandidateProfile(server);
  server.registerTool("get_invoice", {
    outputSchema: z.object({ id: z.string(), taxId: z.string(), nested: z.array(z.object({ iban: z.string(), amount: z.number() })) }),
  }, async () => ({
    content: [
      { type: "text", text: "PRIVATE_raw_text" },
      { type: "image", data: "PRIVATE_binary", mimeType: "image/png" },
      { type: "resource", resource: { uri: "frihet://PRIVATE_uri", text: "PRIVATE_resource" } },
    ],
    structuredContent: { id: "synthetic", taxId: "PRIVATE_taxId", nested: [{ iban: "PRIVATE_iban", amount: 10 }] },
    _meta: { privateContext: "PRIVATE_metadata", "io.frihet/retryable": false },
  }));
  const { client, close } = await connect(server);
  try {
    const descriptor = (await client.listTools()).tools[0];
    assert.doesNotMatch(JSON.stringify(descriptor.outputSchema), /"taxId"|"iban"/u);
    const result = await client.callTool({ name: "get_invoice", arguments: {} });
    assert.notEqual(result.isError, true);
    assertPrivate(result);
    assert.deepEqual(result.structuredContent, { id: "synthetic", nested: [{ amount: 10 }] });
    assert.deepEqual(result._meta, { "io.frihet/retryable": false });
    assert.equal((result.content as unknown[]).length, 1);
  } finally { await close(); }
});

test("Claude error paths retain outcome flags without returning arbitrary text or exceptions", async () => {
  const server = new McpServer({ name: "privacy-errors", version: "1.0.0" });
  applyClaudeCandidateProfile(server);
  server.registerTool("get_invoice", {}, async () => ({ isError: true, content: [{ type: "text", text: "PRIVATE_error" }],
    _meta: { "io.frihet/operationOutcomeUnknown": true, "io.frihet/authenticationRequired": true, "io.frihet/retryable": false, raw: "PRIVATE_meta" },
  }));
  server.registerTool("get_client", {}, async () => { throw new Error("PRIVATE_exception"); });
  server.registerResource("currencies", "frihet://config/currencies", {}, async () => ({
    contents: [{ uri: "frihet://config/currencies", mimeType: "application/octet-stream", blob: "PRIVATE_blob" }],
  }));
  const { client, close } = await connect(server);
  try {
    const result = await client.callTool({ name: "get_invoice", arguments: {} });
    assert.equal(result.isError, true);
    assertPrivate(result);
    assert.deepEqual(result._meta, { "io.frihet/authenticationRequired": true, "io.frihet/operationOutcomeUnknown": true, "io.frihet/retryable": false });
    assertPrivate(await client.callTool({ name: "get_client", arguments: {} }));
    await assert.rejects(client.readResource({ uri: "frihet://config/currencies" }), (error: Error) => {
      assert.doesNotMatch(error.message, /PRIVATE_/u);
      assert.match(error.message, /withheld/u);
      return true;
    });
  } finally { await close(); }
});

test("real Claude product handlers expose actionable fixed denial text without provider details or retries", async () => {
  for (const [status, flag, code] of [
    [404, "resourceNotFound", "NOT_FOUND"],
    [403, "accessDenied", "ACCESS_DENIED"],
    [401, "authenticationRequired", "AUTHENTICATION_REQUIRED"],
  ] as const) {
    const server = new McpServer({ name: "privacy-denial", version: "1.0.0" });
    let calls = 0;
    const clientApi = new Proxy({}, { get: () => async () => {
      calls++;
      throw new FrihetApiError(status, "PRIVATE_code", "PRIVATE_message", "PRIVATE_detail");
    } }) as IFrihetClient;
    registerMcpSurface(server, clientApi, remoteMcpSurfaceComposition(false, true, true));
    const { client, close } = await connect(server);
    try {
      const result = await client.callTool({ name: "get_product", arguments: { id: "synthetic_record" } });
      assert.equal(result.isError, true);
      assert.deepEqual(result._meta, { [`io.frihet/${flag}`]: true });
      assert.equal(result.structuredContent, undefined);
      assertPrivate(result);
      assert.match((result.content as Array<{ text: string }>)[0].text, new RegExp(`^${code}:`));
      assert.equal(calls, 1, "rendering a denial must never replay the API request");
    } finally { await close(); }
  }
  for (const value of ["true", 1, null, { raw: "PRIVATE_metadata" }]) {
    const result = claudeToolResult({ isError: true, content: [{ type: "text", text: "PRIVATE_error" }],
      _meta: { "io.frihet/resourceNotFound": value, "io.frihet/accessDenied": value, raw: "PRIVATE_metadata" } });
    assert.equal(result._meta, undefined);
    assertPrivate(result);
  }
});

test("Claude denial messages never overrule an uncertain operation outcome", () => {
  for (const unknown of ["operationOutcomeUnknown", "transportOutcomeUnknown", "operationMayHaveCompleted"]) {
    const result = claudeToolResult({ isError: true, content: [{ type: "text", text: "PRIVATE_error" }],
      _meta: { [`io.frihet/${unknown}`]: true, "io.frihet/resourceNotFound": true, "io.frihet/accessDenied": true,
        "io.frihet/authenticationRequired": true, raw: "PRIVATE_metadata" } });
    assertPrivate(result);
    assert.equal((result.content as Array<{ text: string }>)[0].text,
      "Frihet could not complete or confirm this request. Check access and read the current record before deciding whether to retry.");
    assert.equal(result.structuredContent, undefined);
  }
  const falseFlag = claudeToolResult({ isError: true, _meta: { "io.frihet/resourceNotFound": false } });
  assert.doesNotMatch((falseFlag.content as Array<{ text: string }>)[0].text, /^NOT_FOUND:/);
});

test("general profile retains its existing outputs and inputs", async () => {
  const server = new McpServer({ name: "general-unchanged", version: "1.0.0" });
  registerMcpSurface(server, api([]), localMcpSurfaceComposition(false, false));
  const { client, close } = await connect(server);
  try {
    const result = await client.callTool({ name: "get_invoice", arguments: { id: "synthetic_record" } });
    assert.equal((result.structuredContent as Record<string, unknown>).taxId, "PRIVATE_taxId_fixture");
    assert.equal((result.structuredContent as Record<string, unknown>).iban, "PRIVATE_iban_fixture");
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === "get_invoice_pdf"));
  } finally { await close(); }
});

test("actual stdio uses the Claude output boundary with synthetic data", async () => {
  const composition = new URL("../server-composition.js", import.meta.url).href;
  const program = `
    import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
    import { registerMcpSurface, localMcpSurfaceComposition } from ${JSON.stringify(composition)};
    const server = new McpServer({name:'stdio-privacy-fixture',version:'1.0.0'});
    const fixture = ${JSON.stringify(record)};
    const api = new Proxy({}, {get:()=>async()=>fixture});
    registerMcpSurface(server, api, localMcpSurfaceComposition(false, true, true));
    await server.connect(new StdioServerTransport());
  `;
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--input-type=module", "-e", program], stderr: "pipe" });
  const client = new Client({ name: "stdio-privacy-client", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "get_invoice", arguments: { id: "synthetic_record" } });
    assert.notEqual(result.isError, true);
    assertPrivate(result);
    assert.equal((result.structuredContent as Record<string, unknown>).total, 250);
  } finally { await client.close(); }
});

test("redaction is bounded and non-mutating for cyclic unexpected values", () => {
  const cyclic: Record<string, unknown> = { taxId: "PRIVATE_cycle" };
  cyclic.child = cyclic;
  assertPrivate(sanitizeClaudeOutput(cyclic));
  assert.equal(cyclic.taxId, "PRIVATE_cycle");
});

test("short sensitive identifiers cannot corrupt unrelated record IDs or enum values", () => {
  assert.deepEqual(sanitizeClaudeOutput({
    documentNumber: "1", requestId: "x", id: "invoice_1x", status: "partial", total: 100,
  }), { id: "invoice_1x", status: "partial", total: 100 });
});

test("Claude client identity survives the derived search index without exposing its copies", async () => {
  const nonce = "2f2897c069044e27a1bf7742d8925f65";
  const indexed = {
    id: `qa-claude-read-${nonce}-clients`,
    name: `Example Test Client / ${nonce} / QA reversible 7e81c4`,
    searchTokens: [nonce, "reversible", "only_index_private_value"],
    notes: `${nonce} reversible only_index_private_value`,
    details: { name: "reversible", id: nonce },
    serialized: JSON.stringify({ name: "reversible", notes: "only_index_private_value" }),
  };
  const before = JSON.stringify(indexed);
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const clientApi = new Proxy({}, { get: (_target, method) => async (...args: unknown[]) => {
    calls.push({ method: String(method), args });
    return method === "listClients" ? { data: [indexed], total: 1, limit: 20, offset: 0 } : indexed;
  } }) as IFrihetClient;
  const server = new McpServer({ name: "client-index-identity", version: "1.0.0" });
  registerMcpSurface(server, clientApi, remoteMcpSurfaceComposition(false, true, true));
  const { client, close } = await connect(server);
  try {
    for (const [name, args] of [
      ["get_client", { id: indexed.id }],
      ["update_client", { id: indexed.id, name: indexed.name }],
      ["create_client", { name: indexed.name }],
      ["list_clients", {}],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true);
      const structured = result.structuredContent as Record<string, unknown>;
      const output = (name === "list_clients" ? (structured.data as unknown[])[0] : structured) as Record<string, unknown>;
      assert.equal(output.id, indexed.id, `${name}: indexed name token must not corrupt the record ID`);
      assert.equal(output.name, indexed.name);
      assert.equal(output.notes, "[redacted] [redacted] [redacted]");
      assert.deepEqual(output.details, { name: "[redacted]", id: "[redacted]" });
      assert.deepEqual(JSON.parse(output.serialized as string), { name: "[redacted]", notes: "[redacted]" });
      assert.equal(output.searchTokens, undefined);
      assert.equal((result.content as Array<{ text: string }>)[0].text, JSON.stringify(structured, null, 2));
    }
    assert.equal(calls.filter((call) => call.method === "updateClient").length, 1);
    assert.equal(calls.filter((call) => call.method === "createClient").length, 1);
    assert.equal(JSON.stringify(indexed), before, "privacy filtering must not mutate the shared response");
    assert.match((sanitizeClaudeOutput(indexed) as { id: string }).id, /\[redacted\]/u,
      "unknown output contexts keep the conservative policy");
  } finally { await close(); }
});

test("client identity never overrides known secrets, including normalized tax IDs and serialized sources", () => {
  for (const source of [
    { taxId: "b12345678" },
    { taxId: "B-12345678" },
    { nested: { taxIdNormalized: "B12345678" } },
    { iban: "b12345678" },
    { credentials: { secret: "b12345678" } },
    { serialized: JSON.stringify({ nested: { secret: "b12345678" } }) },
  ]) {
    const value = { id: "client-b12345678", name: "Example b12345678", searchTokens: ["b12345678"],
      notes: "b12345678", ...source };
    const before = JSON.stringify(value);
    const output = sanitizeClaudeOutput(value, "get_client") as Record<string, unknown>;
    assert.equal(output.id, "client-[redacted]", JSON.stringify(source));
    assert.equal(output.name, "Example [redacted]");
    assert.equal(output.notes, "[redacted]");
    assert.equal(JSON.stringify(value), before);
  }
});

test("malformed search indexes and unexpected tool/record paths keep the conservative policy", () => {
  for (const searchTokens of ["reversible", { token: "reversible" }, ["reversible", 1],
    ["reversible", "INVALID"], Array(33).fill("reversible")]) {
    const value = { id: "client-reversible", name: "Example reversible", searchTokens };
    const output = sanitizeClaudeOutput(value, "get_client") as Record<string, unknown>;
    assert.equal(output.id, "client-[redacted]");
    assert.equal(output.name, "Example [redacted]");
    assert.equal(output.searchTokens, undefined);
  }
  const value = { id: "client-reversible", name: "Example reversible", searchTokens: ["reversible"] };
  for (const toolName of [undefined, "get_invoice", "get_vendor", "list_client_contacts", "get_client_unknown"]) {
    assert.equal((sanitizeClaudeOutput(value, toolName) as { id: string }).id, "client-[redacted]");
  }
  const nested = sanitizeClaudeOutput({ id: "parent", name: "Parent", child: value }, "get_client") as { child: { id: string } };
  assert.equal(nested.child.id, "client-[redacted]");
  const error = claudeToolResult({ isError: true, structuredContent: value }, "get_client");
  assert.equal((error.structuredContent as { id: string }).id, "client-[redacted]");
});

test("identity exemptions belong to their client record and never consume another record's secrets", () => {
  const first = { id: "client-reversible", name: "Example reversible", searchTokens: ["reversible"] };
  const second = { id: "other-reversible", name: "Different ordinary", searchTokens: ["ordinary"] };
  const output = sanitizeClaudeOutput({ data: [first, second] }, "list_clients") as { data: Array<{ id: string }> };
  assert.equal(output.data[0].id, first.id);
  assert.equal(output.data[1].id, "other-[redacted]");
  const collision = sanitizeClaudeOutput({ data: [first, { ...second, secret: "reversible" }] }, "list_clients") as typeof output;
  assert.equal(collision.data[0].id, "client-[redacted]");
  const unproven = sanitizeClaudeOutput({ id: "client-only_index_private", name: "Different ordinary",
    searchTokens: ["only_index_private"], notes: "only_index_private" }, "get_client") as Record<string, unknown>;
  assert.equal(unproven.id, "client-[redacted]");
  assert.equal(unproven.notes, "[redacted]");
});

test("incomplete sensitive-source inspection disables every client identity exception", () => {
  let deep: Record<string, unknown> = { secret: "reversible" };
  for (let i = 0; i < 18; i++) deep = { child: deep };
  const cyclic: Record<string, unknown> = {};
  cyclic.child = cyclic;
  for (const extra of [deep, cyclic, { serialized: '{"secret":"reversible"' },
    { serialized: 'prose {"secret":"reversible"}' },
    { serialized: JSON.stringify(JSON.stringify({ secret: "reversible" })) }]) {
    const output = sanitizeClaudeOutput({ id: "client-reversible", name: "Example reversible",
      searchTokens: ["reversible"], extra }, "get_client") as Record<string, unknown>;
    assert.equal(output.id, "client-[redacted]");
    assert.equal(output.name, "Example [redacted]");
  }
});
