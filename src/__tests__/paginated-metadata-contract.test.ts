/**
 * Inspector regression: real API pages include transport `meta`, but the
 * published paginated outputSchema is closed. Exercise the real HTTP client,
 * tool handlers and SDK/Ajv output validator rather than a clean client stub.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { FrihetClient } from "../client.js";
import { applyClaudeCandidateProfile } from "../claude-profile.js";
import { applyOpenAIReviewProfiles } from "../openai-profile.js";
import { registerAllTools } from "../tools/register-all.js";

const PAGINATED_TOOLS = [
  "list_invoices", "search_invoices", "list_quotes", "list_recurring_invoices",
  "list_deposits", "list_expenses", "list_vendors", "list_clients",
  "list_client_contacts", "list_client_activities", "list_client_notes",
  "list_bank_accounts", "list_transactions", "frihet_bank_rules_list",
  "leave_list", "anomaly_list", "list_team_members", "list_time_entries",
  "list_products", "list_reservations", "list_properties", "list_terminals",
  "list_sales", "list_kitchen_tickets", "list_kitchen_stations", "list_menu_items",
] as const;

const PROFILES = ["general", "claude", "openai-review"] as const;
type Profile = typeof PROFILES[number];
const META = { timestamp: "2026-10-20T21:54:37.725Z" };
const EMPTY_PAGE = { data: [], total: 0, limit: 5, offset: 0 };
const PRODUCT = {
  id: "qa-product-1", _isSample: true,
  name: "Synthetic service", description: "Synthetic MCP contract fixture",
  unitPrice: 25, taxRate: 0, irpfRate: 0, isActive: true,
  createdAt: "2026-10-20T16:26:06.406Z", updatedAt: "2026-10-20T16:26:06.406Z",
};

function argumentsFor(name: string): Record<string, unknown> {
  return {
    limit: 5,
    ...(["list_client_contacts", "list_client_activities", "list_client_notes"].includes(name)
      ? { clientId: "qa-client-1" } : {}),
    ...(name === "search_invoices" ? { query: "synthetic" } : {}),
  };
}

async function withHarness(
  profile: Profile,
  apiResponse: Record<string, unknown>,
  run: (client: Client, requests: string[]) => Promise<void>,
): Promise<void> {
  const requests: string[] = [];
  const http = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(apiResponse));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  const api = new FrihetClient("fri_synthetic_contract", `http://127.0.0.1:${port}`);
  const server = new McpServer({ name: "pagination-contract", version: "1.0.0" });
  if (profile === "claude") applyClaudeCandidateProfile(server);
  if (profile === "openai-review") applyOpenAIReviewProfiles(server);
  registerAllTools(server, api);
  const client = new Client({ name: "pagination-validator", version: "1.0.0" }, {
    jsonSchemaValidator: new AjvJsonSchemaValidator(),
  });
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await run(client, requests);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  }
}

for (const profile of PROFILES) {
  test(`${profile}: every paginated family validates when the API includes transport metadata`, async (t) => {
    await withHarness(profile, { ...EMPTY_PAGE, meta: META }, async (client, requests) => {
      const { tools } = await client.listTools();
      const paginated = tools.filter((tool) => {
        const properties = tool.outputSchema?.properties;
        // global_search has a separate contract with hasMore/query/types.
        return properties && !("hasMore" in properties)
          && ["data", "total", "limit", "offset"].every((key) => key in properties);
      }).map((tool) => tool.name).sort();
      const expected = PAGINATED_TOOLS.filter((name) => tools.some((tool) => tool.name === name)).sort();
      assert.deepEqual(paginated, expected, "every published paginated tool must be exercised");
      if (profile !== "openai-review") assert.equal(expected.length, 26);
      assert.ok(expected.length > 0);
      for (const name of expected) {
        await t.test(name, async () => {
          const before = requests.length;
          const result = await client.callTool({ name, arguments: argumentsFor(name) });
          assert.equal(result.isError, undefined, "the valid request must succeed");
          assert.ok(requests.length > before, "the real HTTP client must reach the synthetic API");
          assert.deepEqual(result.structuredContent, EMPTY_PAGE);
        });
      }
    });
  });

  test(`${profile}: product rows, totals, offsets and continuation survive envelope normalization`, async () => {
    const page = { data: [PRODUCT], total: 42, limit: 5, offset: 15, nextCursor: "next-page-cursor" };
    const raw = { ...page, meta: META, transportExtension: "not-a-business-field" };
    await withHarness(profile, raw, async (client) => {
      const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "list_products");
      assert.ok(descriptor?.outputSchema);
      const validate = new AjvJsonSchemaValidator().getValidator(descriptor.outputSchema);
      const rejected = validate(raw);
      assert.equal(rejected.valid, false, "the published schema must stay closed to transport metadata");
      assert.match(rejected.errorMessage ?? "", /additional properties/i);
      const result = await client.callTool({ name: "list_products", arguments: { q: "Synthetic", limit: 5 } });
      assert.equal(result.isError, undefined);
      const expected = profile === "openai-review" ? {
        ...page,
        data: [{ id: PRODUCT.id, name: PRODUCT.name, unitPrice: 25, taxRate: 0, isActive: true }],
      } : page;
      assert.deepEqual(result.structuredContent, expected, "preserve business data under each profile's existing policy");
    });
  });
}

for (const profile of ["general", "claude"] as const) {
  test(`${profile}: global search preserves its distinct pagination and query contract`, async () => {
    const page = {
      data: [{ type: "products", id: PRODUCT.id, name: PRODUCT.name }],
      total: 42, limit: 5, offset: 15, hasMore: true,
      query: "synthetic", types: ["products"], truncated: true,
    };
    await withHarness(profile, { ...page, meta: META }, async (client) => {
      await client.listTools();
      const result = await client.callTool({ name: "global_search", arguments: { q: "synthetic", limit: 5 } });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, page);
    });
  });
}
