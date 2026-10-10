import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { IFrihetClient } from "../client-interface.js";
import { CLAUDE_CANDIDATE_TOOLS, CLAUDE_EXCLUDED_TOOLS, CLAUDE_EXCLUDED_PROMPTS, CLAUDE_EXCLUDED_RESOURCES, CLAUDE_CANDIDATE_INSTRUCTIONS } from "../claude-profile.js";
import { assertClaudeCandidateCaptureParity, captureClaudeCandidateContract, serializeClaudeCandidateContract } from "../claude-candidate-contract.js";
import { FISCAL_MODELO_ALIASES } from "../fiscal-aliases.js";
import { CAPABILITY_META_KEY } from "../capability-truth.js";
import { localMcpSurfaceComposition, remoteMcpSurfaceComposition, registerMcpSurface } from "../server-composition.js";

const readFixture = (name: string) => readFileSync(new URL(`../../src/__tests__/fixtures/${name}`, import.meta.url), "utf8");
// Independent inventory oracle: all 158 canonical names in the existing public capture.
const fullNames: string[] = JSON.parse(readFixture("public-capability-contract.json")).surfaces.localFull.tools.map((tool: { name: string }) => tool.name);
const excluded = [
  "ksef_submit", "get_modelo_180_summary", "frihet_modelo_415_summary", "frihet_modelo_418_summary", "frihet_modelo_425_summary", "frihet_aiem_calculate", "frihet_modelo_200_summary", "frihet_modelo_202_summary",
  "period_close", "period_reopen", "gestoria_message_send", "gestoria_messages_list", "gestoria_template_bulk_send", "gestoria_aging_consolidated", "create_reservation", "sync_channel",
  "onboarding_status", "onboarding_persona_set", "refund_sale", "delete_client", "delete_expense", "send_quote",
].sort();
const allowedAliases = Object.entries(FISCAL_MODELO_ALIASES).filter(([, canonical]) => !excluded.includes(canonical));
const deniedAliases = Object.entries(FISCAL_MODELO_ALIASES).filter(([, canonical]) => excluded.includes(canonical)).map(([alias]) => alias);
const canonical = fullNames.filter((name) => !(name in FISCAL_MODELO_ALIASES) && !excluded.includes(name)).sort();
const expectedNames = [...canonical, ...allowedAliases.map(([alias]) => alias)].sort();
const discovery = ["list_tool_groups", "search_tools", "describe_tool"];
const invoice = { id: "inv_candidate", status: "partial", currency: "USD", total: 250, amountPaid: 100, dueDate: "2026-09-01" };
const business = { businessName: "Candidate fixture", plan: { name: "pro", invoices: { used: 3, limit: 100 } } };
const monthly = { month: "2026-09", currency: "USD", revenue: 150, expenses: 20 };

function recordingApi(calls: Array<{ method: string; args: unknown[] }>): IFrihetClient {
  return new Proxy({}, { get: (_target, method) => async (...args: unknown[]) => {
    calls.push({ method: String(method), args });
    if (method === "getBusinessContext") return business;
    if (method === "getMonthlySummary") return monthly;
    if (method === "getInvoice") return invoice;
    if (method === "listInvoices") return { data: [invoice], total: 201, limit: 100, offset: 0 };
    return {};
  } }) as IFrihetClient;
}

async function connect(local: boolean, grouped: boolean) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const server = new McpServer({ name: "claude-test", version: "1.0.0" });
  registerMcpSurface(server, recordingApi(calls), (local ? localMcpSurfaceComposition : remoteMcpSurfaceComposition)(false, grouped, true));
  // A future canonical registration must fail closed before discovery or SDK insertion.
  server.registerTool("future_unknown_tool", { description: "Not reviewed" }, async () => {
    calls.push({ method: "future_unknown_tool", args: [] });
    return { content: [] };
  });
  const client = new Client({ name: "claude-test-client", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server, calls, close: () => Promise.allSettled([client.close(), server.close()]) };
}

async function denied(client: Client, name: string) {
  const result = await client.request({ method: "tools/call", params: { name, arguments: {} } }, CallToolResultSchema);
  assert.equal(result.isError, true, `${name} must fail before client dispatch`);
  assert.match(JSON.stringify(result.content), /not found/i);
}

test("Claude candidate exactly matches the regenerated SDK descriptor and inventory arithmetic", async () => {
  assert.equal(fullNames.length - Object.keys(FISCAL_MODELO_ALIASES).length, 158);
  assert.equal(canonical.length, 136);
  assert.equal(excluded.length, 22);
  assert.equal(allowedAliases.length, 4);
  assert.deepEqual([...CLAUDE_CANDIDATE_TOOLS].sort(), canonical);
  assert.deepEqual(Object.keys(CLAUDE_EXCLUDED_TOOLS).sort(), excluded);
  const actual = await captureClaudeCandidateContract();
  assert.equal(serializeClaudeCandidateContract(actual), readFixture("claude-candidate-contract.json"));
});

test("descriptor deduplication rejects drift in every discarded surface field", () => {
  const fixture = JSON.parse(readFixture("claude-candidate-contract.json"));
  const surface = (tools: "full" | "grouped", resources: "local" | "remote") => ({
    tools: fixture.tools[tools], resources: fixture.resources[resources],
    prompts: fixture.prompts, promptContent: fixture.promptContent, currencies: fixture.currencies,
    ...(tools === "grouped" ? { groups: fixture.groups } : {}),
  });
  const baseline = {
    localFull: surface("full", "local"), localGrouped: surface("grouped", "local"),
    remoteFull: surface("full", "remote"), remoteGrouped: surface("grouped", "remote"),
  };
  assert.doesNotThrow(() => assertClaudeCandidateCaptureParity(baseline));
  const discarded = [
    ["remoteFull", "tools"], ["remoteGrouped", "tools"],
    ["localGrouped", "resources"], ["remoteGrouped", "resources"], ["localGrouped", "groups"],
    ...(["localGrouped", "remoteFull", "remoteGrouped"] as const).flatMap((name) =>
      (["prompts", "promptContent", "currencies"] as const).map((key) => [name, key] as const)),
  ] as const;
  for (const [name, key] of discarded) {
    const changed = structuredClone(baseline);
    changed[name][key] = { unexpected: "descriptor drift" };
    assert.throws(() => assertClaudeCandidateCaptureParity(changed), /capture diverged/, `${name}.${key}`);
  }
});

for (const local of [true, false]) for (const grouped of [false, true]) {
  test(`Claude ${local ? "local" : "remote composition"}/${grouped ? "grouped" : "full"}: exact catalog, denial and discovery`, async () => {
    const { client, calls, close } = await connect(local, grouped);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [...expectedNames, ...(grouped ? discovery : [])].sort());
      for (const tool of tools) {
        assert.match(tool.name, /^[A-Za-z0-9_-]{1,64}$/u);
        assert.ok(tool.title?.trim(), `${tool.name} title`);
        for (const annotation of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
          assert.equal(typeof tool.annotations?.[annotation], "boolean", `${tool.name}.${annotation}`);
        }
        const capability = tool._meta?.[CAPABILITY_META_KEY] as { callability: string; externalSideEffects: string[] };
        assert.ok(capability);
        assert.ok(!["unavailable", "deferred"].includes(capability.callability), tool.name);
        assert.ok(!capability.externalSideEffects.includes("money_movement"), tool.name);
      }
      for (const name of ["get_quarterly_taxes", "send_einvoice", "send_invoice", "payroll_export", "list_bank_accounts", "match_transaction_to_invoice", "refund_deposit", "run_recurring_now"]) {
        assert.ok(tools.some((tool) => tool.name === name), `${name} family retained`);
      }
      assert.ok(tools.find((tool) => tool.name === "run_recurring_now")!.inputSchema.required!.includes("confirm"));
      const refund = tools.find((tool) => tool.name === "refund_deposit")!;
      assert.equal(refund.inputSchema.additionalProperties, false);
      assert.deepEqual(Object.keys(refund.inputSchema.properties!).sort(), ["amount", "confirm", "id"]);
      for (const name of [...excluded, ...deniedAliases, "future_unknown_tool", "execute_tool"]) await denied(client, name);
      if (grouped) {
        const groups = (await client.callTool({ name: "list_tool_groups", arguments: {} })).structuredContent as { totalTools: number; groups: Array<{ group: string; toolCount: number; blurb: string }> };
        assert.equal(groups.totalTools, 136);
        assert.equal(groups.groups.reduce((sum, group) => sum + group.toolCount, 0), 136);
        assert.doesNotMatch(JSON.stringify(groups), /refunds|KSeF|channel sync|onboarding|200\/202|period close,/);
        const searched = (await client.callTool({ name: "search_tools", arguments: { limit: 1000 } })).structuredContent as { count: number; tools: Array<{ name: string }> };
        assert.equal(searched.count, 136);
        assert.deepEqual(searched.tools.map((tool) => tool.name).sort(), canonical);
        for (const group of groups.groups) {
          const result = (await client.callTool({ name: "search_tools", arguments: { group: group.group, limit: 1000 } })).structuredContent as { count: number };
          assert.equal(result.count, group.toolCount);
        }
        for (const name of canonical) {
          const described = await client.callTool({ name: "describe_tool", arguments: { name } });
          const detail = described.structuredContent as Record<string, unknown>;
          assert.equal(detail.name, name);
          assert.equal(typeof detail.description, "string");
        }
        for (const name of [...excluded, ...deniedAliases, "future_unknown_tool"]) {
          assert.equal((await client.callTool({ name: "describe_tool", arguments: { name } })).isError, true);
          const result = (await client.callTool({ name: "search_tools", arguments: { query: name, limit: 1000 } })).structuredContent as { tools: Array<{ name: string }> };
          assert.ok(!result.tools.some((tool) => tool.name === name));
        }
      }
      assert.deepEqual(calls, [], "catalog and all denied calls must not touch the API");
      // Permitted aliases have the exact canonical handler/schema, including schema denial.
      for (const [alias, target] of allowedAliases) {
        const targetTool = tools.find((tool) => tool.name === target)!;
        const aliasTool = tools.find((tool) => tool.name === alias)!;
        assert.deepEqual({ ...aliasTool, name: target }, targetTool);
        assert.equal((await client.callTool({ name: alias, arguments: { period: "invalid" } })).isError, true);
      }
      assert.deepEqual(calls, []);
      const got = await client.callTool({ name: "get_invoice", arguments: { id: invoice.id } });
      assert.notEqual(got.isError, true);
      const record = got.structuredContent as Record<string, unknown>;
      assert.equal(record.id, invoice.id);
      assert.equal(record.amountPaid, 100);
      assert.deepEqual(calls, [{ method: "getInvoice", args: [invoice.id] }]);
    } finally { await close(); }
  });
}

for (const local of [true, false]) {
  test(`Claude ${local ? "local" : "remote composition"}: retained prompt/resource content and excluded requests`, async () => {
    const { client, calls, close } = await connect(local, false);
    try {
      const prompts = (await client.listPrompts()).prompts;
      assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), ["invoice-aging-review", "overdue-followup"]);
      const resources = (await client.listResources()).resources;
      assert.deepEqual(resources.map((resource) => resource.uri).sort(), ["frihet://config/currencies", ...(local ? ["frihet://business-profile", "frihet://monthly-snapshot", "frihet://overdue-invoices", "frihet://status/plan-limits"] : [])].sort());
      const received: string[] = [CLAUDE_CANDIDATE_INSTRUCTIONS, JSON.stringify(resources), JSON.stringify(prompts)];
      for (const { name } of prompts) {
        const result = await client.getPrompt({ name });
        assert.equal(result.messages.length, 1);
        const text = JSON.stringify(result.messages);
        received.push(text);
        for (const requirement of [/Paginate/i, /partial/i, /remaining unpaid balance/i, /not count full invoice totals/i, /currency/i, /not-yet-due/i, /user approval before any actions/i]) assert.match(text, requirement, name);
        assert.doesNotMatch(text, /95%|80%|50%|25%|10%|€100/);
      }
      for (const { uri } of resources) {
        const result = await client.readResource({ uri });
        assert.equal(result.contents.length, 1);
        assert.equal(result.contents[0].uri, uri);
        assert.ok("text" in result.contents[0]);
        const text = result.contents[0].text;
        const data = JSON.parse(text);
        received.push(text);
        if (uri === "frihet://config/currencies") {
          assert.equal(data.EUR.symbol, "€");
          assert.equal(data.USD.decimals, 2);
          assert.equal(data.JPY.decimals, 0);
        } else if (uri === "frihet://business-profile") assert.deepEqual(data, business);
        else if (uri === "frihet://monthly-snapshot") assert.deepEqual(data, monthly);
        else if (uri === "frihet://status/plan-limits") assert.deepEqual(data, { plan: "pro", limits: { invoices: 100 }, usage: { invoices: 3 }, breakdown: business.plan });
        else {
          assert.deepEqual(data.data, [invoice]);
          assert.equal(data.hasMore, true);
          assert.equal(data.total, 201);
          assert.match(data.note, /not a complete receivables or unpaid-balance report/);
        }
      }
      for (const [name, reason] of Object.entries(CLAUDE_EXCLUDED_PROMPTS)) {
        assert.ok(reason.length > 10);
        await assert.rejects(client.getPrompt({ name }));
      }
      for (const [uri, reason] of Object.entries(CLAUDE_EXCLUDED_RESOURCES)) {
        assert.ok(reason.length > 10);
        await assert.rejects(client.readResource({ uri }));
      }
      for (const name of [...excluded, ...Object.keys(CLAUDE_EXCLUDED_RESOURCES)]) assert.ok(!received.join("\n").includes(name), name);
      assert.deepEqual(calls.map((call) => call.method).sort(), local ? ["getBusinessContext", "getBusinessContext", "getMonthlySummary", "listInvoices"] : []);
      if (local) assert.deepEqual(calls.find((call) => call.method === "listInvoices")!.args, [{ status: "overdue", limit: 100 }]);
    } finally { await close(); }
  });
}

test("contradictory modes fail before any registration", () => {
  for (const compose of [localMcpSurfaceComposition, remoteMcpSurfaceComposition]) for (const grouped of [false, true]) {
    const server = new McpServer({ name: "mixed-mode", version: "1.0.0" });
    server.registerTool = (() => { assert.fail("mixed mode registered a tool"); }) as typeof server.registerTool;
    assert.throws(() => registerMcpSurface(server, recordingApi([]), compose(true, grouped, true)), /mutually exclusive/);
  }
});

test("actual stdio Claude flag exposes truthful candidate and rejects mixed flags using injected env", { timeout: 30000 }, async () => {
  const entry = fileURLToPath(new URL("../index.js", import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { FRIHET_DEMO: "1", FRIHET_CLAUDE_MODE: "true" }, stderr: "pipe" });
  const client = new Client({ name: "stdio-candidate-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), expectedNames);
    assert.equal(client.getInstructions(), CLAUDE_CANDIDATE_INSTRUCTIONS);
    assert.match(client.getServerVersion()?.description ?? "", /136 canonical operations/);
    assert.doesNotMatch(client.getServerVersion()?.description ?? "", /158|11 resources|full Spanish tax compliance/);
  } finally { await client.close(); }
  await assert.rejects(promisify(execFile)(process.execPath, [entry], {
    env: { FRIHET_DEMO: "1", FRIHET_CLAUDE_MODE: "true", FRIHET_OPENAI_MODE: "true" }, timeout: 10000,
  }), (error: unknown) => {
    const result = error as { code: number; stdout: string; stderr: string };
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /mutually exclusive/);
    return true;
  });
});
