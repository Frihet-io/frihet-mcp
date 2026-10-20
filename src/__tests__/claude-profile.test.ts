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
// Independent inventory oracle: all 156 canonical names in the existing public capture.
const publicSurfaces = JSON.parse(readFixture("public-capability-contract.json")).surfaces as Record<string, {
  tools: Array<{ name: string; annotations: Record<string, boolean> }>;
}>;
const fullNames = publicSurfaces.localFull.tools.map((tool) => tool.name);
const originalAnnotations = new Map([
  ...publicSurfaces.localFull.tools,
  ...publicSurfaces.remoteGrouped.tools,
].map((tool) => [tool.name, tool.annotations]));
// The owner-approved consultation inventory is independent of runtime constants.
const canonical = ["list_clients", "list_expenses", "list_invoices", "list_products", "list_quotes", "list_vendors"];
const excluded = fullNames.filter((name) => !(name in FISCAL_MODELO_ALIASES) && !canonical.includes(name)).sort();
const deniedAliases = Object.keys(FISCAL_MODELO_ALIASES);
const expectedNames = [...canonical];
const discovery = ["list_tool_groups", "search_tools", "describe_tool"];
const invoice = { id: "inv_candidate", status: "partial", currency: "USD", total: 250, amountPaid: 100, dueDate: "2026-09-01" };

function recordingApi(calls: Array<{ method: string; args: unknown[] }>): IFrihetClient {
  return new Proxy({}, { get: (_target, method) => async (...args: unknown[]) => {
    calls.push({ method: String(method), args });
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
  assert.equal(fullNames.length - Object.keys(FISCAL_MODELO_ALIASES).length, 156);
  assert.equal(canonical.length, 6);
  assert.equal(excluded.length, 150);
  assert.equal(deniedAliases.length, Object.keys(FISCAL_MODELO_ALIASES).length);
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
  test(`Claude ${local ? "local" : "remote composition"}/${grouped ? "grouped" : "full"}: exact catalog, Directory titles, denial and discovery`, async () => {
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
        assert.deepEqual(tool.annotations, {
          ...originalAnnotations.get(tool.name),
          title: tool.title,
        }, `${tool.name} must duplicate its title and preserve every existing hint`);
        const capability = tool._meta?.[CAPABILITY_META_KEY] as { callability: string; externalSideEffects: string[] };
        assert.ok(capability);
        assert.ok(!["unavailable", "deferred"].includes(capability.callability), tool.name);
        assert.ok(!capability.externalSideEffects.includes("money_movement"), tool.name);
      }
      assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false));
      for (const name of [...excluded, ...deniedAliases, "future_unknown_tool", "execute_tool"]) await denied(client, name);
      if (grouped) {
        const groups = (await client.callTool({ name: "list_tool_groups", arguments: {} })).structuredContent as { totalTools: number; groups: Array<{ group: string; toolCount: number; blurb: string }> };
        assert.equal(groups.totalTools, 6);
        assert.equal(groups.groups.reduce((sum, group) => sum + group.toolCount, 0), 6);
        assert.deepEqual(groups.groups.map((group) => [group.group, group.toolCount]).sort(), [["catalog", 1], ["crm", 1], ["expenses", 2], ["invoicing", 2]]);
        assert.doesNotMatch(JSON.stringify(groups), /create, send, pay|KSeF|payroll|VIES|fiscal submission/);
        const searched = (await client.callTool({ name: "search_tools", arguments: { limit: 1000 } })).structuredContent as { count: number; tools: Array<{ name: string }> };
        assert.equal(searched.count, 6);
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
          if (name === "list_clients" || name === "list_vendors") {
            assert.match(String(detail.description), /tax identifiers are omitted/);
            assert.doesNotMatch(String(detail.description), /Returns contact info, tax IDs|Devuelve informacion de contacto, NIF\/CIF/);
          }
        }
        for (const name of [...excluded, ...deniedAliases, "future_unknown_tool"]) {
          assert.equal((await client.callTool({ name: "describe_tool", arguments: { name } })).isError, true);
          const result = (await client.callTool({ name: "search_tools", arguments: { query: name, limit: 1000 } })).structuredContent as { tools: Array<{ name: string }> };
          assert.ok(!result.tools.some((tool) => tool.name === name));
        }
      }
      assert.deepEqual(calls, [], "catalog and all denied calls must not touch the API");
      const got = await client.callTool({ name: "list_invoices", arguments: { limit: 100, offset: 0 } });
      assert.notEqual(got.isError, true);
      const record = got.structuredContent as { data: Array<Record<string, unknown>> };
      assert.equal(record.data[0].id, invoice.id);
      assert.equal(record.data[0].amountPaid, 100);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls.map((call: { method: string }) => call.method), ["listInvoices"]);
    } finally { await close(); }
  });
}

for (const local of [true, false]) {
  test(`Claude ${local ? "local" : "remote composition"}: retained prompt/resource content and excluded requests`, async () => {
    const { client, calls, close } = await connect(local, false);
    try {
      assert.equal(client.getServerCapabilities()?.prompts, undefined);
      const resources = (await client.listResources()).resources;
      assert.deepEqual(resources.map((resource) => resource.uri), ["frihet://config/currencies"]);
      const result = await client.readResource({ uri: "frihet://config/currencies" });
      assert.equal(result.contents.length, 1);
      assert.ok("text" in result.contents[0]);
      const currencies = JSON.parse(result.contents[0].text);
      assert.equal(currencies.EUR.symbol, "€");
      assert.equal(currencies.USD.decimals, 2);
      assert.equal(currencies.JPY.decimals, 0);
      for (const [name, reason] of Object.entries(CLAUDE_EXCLUDED_PROMPTS)) {
        assert.ok(reason.length > 10);
        await assert.rejects(client.getPrompt({ name }));
      }
      for (const [uri, reason] of Object.entries(CLAUDE_EXCLUDED_RESOURCES)) {
        assert.ok(reason.length > 10);
        await assert.rejects(client.readResource({ uri }));
      }
      assert.deepEqual(calls, [], "resources and unavailable prompts must not bypass consultation scope");
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
    assert.match(client.getServerVersion()?.description ?? "", /6 read-only canonical operations/);
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

test("Claude texts never instruct a partial status filter and the unfiltered list_invoices call validates", async () => {
  const { client, calls, close } = await connect(true, false);
  try {
    const texts: string[] = [CLAUDE_CANDIDATE_INSTRUCTIONS, JSON.stringify((await client.listResources()).resources)];
    for (const text of [texts.join("\n")]) {
      assert.doesNotMatch(text, /list_invoices for sent, partial/i);
      assert.doesNotMatch(text, /list_invoices[^.]*including (sent and )?partial/i);
      assert.doesNotMatch(text, /list_invoices pagination including/i);
      assert.match(text, /without a status filter/i);
      assert.match(text, /client-side/i);
    }
    // The schema enum has no `partial`: the old instruction produced -32602 with 0 API calls.
    const before = calls.length;
    const filtered = await client.callTool({ name: "list_invoices", arguments: { status: "partial" } });
    assert.equal(filtered.isError, true);
    assert.match(JSON.stringify(filtered.content), /-32602|invalid/i);
    assert.equal(calls.length, before);
    // The call shape the prompts now instruct: no status filter, paginated.
    const result = await client.callTool({ name: "list_invoices", arguments: { limit: 100, offset: 0 } });
    assert.notEqual(result.isError, true);
    assert.deepEqual((result.structuredContent as { data: unknown[] }).data, [invoice]);
    const sent = calls.filter((call) => call.method === "listInvoices").at(-1)!.args[0] as Record<string, unknown>;
    assert.equal(sent.status, undefined);
    assert.equal(sent.limit, 100);
    assert.equal(sent.offset, 0);
  } finally { await close(); }
});

test("M2: the Claude pilot credential has no einvoice scope, so no einvoice/face/ticketbai tool is allowlisted", () => {
  const scoped = [...CLAUDE_CANDIDATE_TOOLS].filter((name) => /^(einvoice_export|face_|ticketbai_|send_einvoice$)/u.test(name));
  assert.deepEqual(scoped, []);
  for (const name of ["einvoice_export", "face_submit", "face_status", "ticketbai_submit", "ticketbai_status", "send_einvoice"]) {
    assert.ok(name in CLAUDE_EXCLUDED_TOOLS, `${name} must be an explicit exclusion`);
  }
  assert.doesNotMatch(readFixture("claude-candidate-contract.json"), /einvoice:write/u);
});
