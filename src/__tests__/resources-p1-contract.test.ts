import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { registerAllResources } from "../resources/register-all.js";
import type { IFrihetClient } from "../client-interface.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface ResourceConfig {
  description: string;
  mimeType: string;
}

type ResourceHandler = (uri: string) => Promise<{
  contents: Array<{
    uri: string;
    mimeType: string;
    text: string;
  }>;
}>;

class StubMcpServer {
  resources = new Map<string, { uri: string; config: ResourceConfig; handler: ResourceHandler }>();

  registerResource(name: string, uri: string, config: ResourceConfig, handler: ResourceHandler): void {
    this.resources.set(uri, { uri, config, handler });
  }
}

describe("MCP Resources P1 Contract (#2340)", () => {
  test("invoice-statuses resource includes partial status and legal transition paths", async () => {
    const server = new StubMcpServer();
    registerAllResources(server as unknown as McpServer);

    const resource = server.resources.get("frihet://config/invoice-statuses");
    assert.ok(resource, "frihet://config/invoice-statuses must be registered");

    const result = await resource.handler("frihet://config/invoice-statuses");
    assert.equal(result.contents.length, 1);
    const text = result.contents[0].text;

    assert.match(text, /\bPARTIAL\b/);
    assert.match(text, /partial\s+—\s+Invoice partially paid/i);
    assert.match(text, /partial\s+->\s+paid\s+\|\s+overdue\s+\|\s+cancelled/);
  });

  test("invoice-statuses resource only names real invoice webhook events", async () => {
    const canonicalEvents = new Set([
      "invoice.created",
      "invoice.updated",
      "invoice.generated",
      "invoice.one_off_created",
      "invoice.paid",
      "invoice.overdue",
      "invoice.voided",
      "invoice.payment_status_updated",
      "invoice.payment_failure",
    ]);

    const server = new StubMcpServer();
    registerAllResources(server as unknown as McpServer);

    const resource = server.resources.get("frihet://config/invoice-statuses");
    assert.ok(resource, "frihet://config/invoice-statuses must be registered");

    const result = await resource.handler("frihet://config/invoice-statuses");
    const text = result.contents[0].text;

    assert.doesNotMatch(text, /invoice\.partial/);
    assert.doesNotMatch(text, /invoice\.cancelled/);

    const mentioned = text.match(/invoice\.[a-z_]+/g) ?? [];
    assert.ok(mentioned.length > 0, "resource must still document webhook events");
    for (const event of mentioned) {
      assert.ok(canonicalEvents.has(event), `${event} is not a real invoice webhook event`);
    }
  });

  test("overdue-invoices resource declares pagination bounds and returns truncation metadata", async () => {
    const mockInvoices = Array.from({ length: 100 }, (_, i) => ({
      id: `inv_${i + 1}`,
      number: `FAC-2026-${i + 1}`,
      status: "overdue",
      amount: 100,
    }));

    const mockClient = {
      listInvoices: async (params?: { status?: string; limit?: number }) => {
        assert.equal(params?.status, "overdue");
        assert.equal(params?.limit, 100);
        return {
          data: mockInvoices,
          total: 250,
          limit: 100,
          offset: 0,
        };
      },
    } as unknown as IFrihetClient;

    const server = new StubMcpServer();
    registerAllResources(server as unknown as McpServer, mockClient);

    const resource = server.resources.get("frihet://overdue-invoices");
    assert.ok(resource, "frihet://overdue-invoices must be registered when client is provided");
    assert.match(resource.config.description, /first page up to 100/i);

    const result = await resource.handler("frihet://overdue-invoices");
    assert.equal(result.contents.length, 1);
    const parsed = JSON.parse(result.contents[0].text);

    assert.equal(parsed.limit, 100);
    assert.equal(parsed.offset, 0);
    assert.equal(parsed.total, 250);
    assert.equal(parsed.hasMore, true);
    assert.equal(parsed.data.length, 100);
    assert.match(parsed.note, /100 records with status overdue/i);
    assert.match(parsed.note, /not a complete receivables or unpaid-balance report/i);
  });

  test("resources declare explicit authority and provenance headers", async () => {
    const server = new StubMcpServer();
    registerAllResources(server as unknown as McpServer);

    // API schema snapshot
    const apiSchema = server.resources.get("frihet://api/schema");
    assert.ok(apiSchema, "api-schema must be registered");
    const apiSchemaText = (await apiSchema.handler("frihet://api/schema")).contents[0].text;
    assert.match(apiSchemaText, /Informational Reference Summary Snapshot/i);
    assert.match(apiSchemaText, /https:\/\/api\.frihet\.io\/v1\/openapi\.json/);
    assert.match(apiSchema.config.description, /canonical contract/i);

    // Tax rates
    const taxRates = server.resources.get("frihet://tax/rates");
    assert.ok(taxRates, "tax-rates must be registered");
    const taxRatesText = (await taxRates.handler("frihet://tax/rates")).contents[0].text;
    assert.match(taxRatesText, /Authority:/);
    assert.match(taxRatesText, /Ley 37\/1992 del IVA \(AEAT\)/);
    assert.match(taxRatesText, /Ley 20\/1991 del IGIC \(Agencia Tributaria Canaria\)/);
    assert.match(taxRatesText, /Ley 8\/1991 del IPSI/);
    assert.match(taxRatesText, /NOT a dynamic tax engine/i);

    // Tax calendar
    const taxCalendar = server.resources.get("frihet://tax/calendar");
    assert.ok(taxCalendar, "tax-calendar must be registered");
    const taxCalendarText = (await taxCalendar.handler("frihet://tax/calendar")).contents[0].text;
    assert.match(taxCalendarText, /Authority: Calendario del Contribuyente/);

    // Expense categories
    const expenseCategories = server.resources.get("frihet://config/expense-categories");
    assert.ok(expenseCategories, "expense-categories must be registered");
    const expenseCategoriesText = (await expenseCategories.handler("frihet://config/expense-categories")).contents[0].text;
    assert.match(expenseCategoriesText, /Authority: Statutory deductibility rules derived from Ley 35\/2006[\s\S]*Ley 37\/1992/);
  });

  test("plan-limits resource extracts quotas and usage from structured context and handles missing fields", async () => {
    // 1. Nested plan object (as returned by live /context and demo client)
    const mockClientNested = {
      getBusinessContext: async () => ({
        plan: {
          name: "starter",
          invoices: { used: 7, limit: 50 },
          expenses: { used: 3, limit: 50 },
          aiMessages: { used: 12, limit: 100 },
        },
      }),
    } as unknown as IFrihetClient;

    const server1 = new StubMcpServer();
    registerAllResources(server1 as unknown as McpServer, mockClientNested);
    const res1 = server1.resources.get("frihet://status/plan-limits");
    assert.ok(res1);
    const parsed1 = JSON.parse((await res1.handler("frihet://status/plan-limits")).contents[0].text);
    assert.equal(parsed1.plan, "starter");
    assert.deepEqual(parsed1.limits, { invoices: 50, expenses: 50, aiMessages: 100 });
    assert.deepEqual(parsed1.usage, { invoices: 7, expenses: 3, aiMessages: 12 });

    // 2. Direct top-level limits and usage with string plan
    const mockClientDirect = {
      getBusinessContext: async () => ({
        plan: "pro",
        limits: { invoices: 999, apiRateLimit: 100 },
        usage: { invoices: 120, apiRateLimit: 12 },
      }),
    } as unknown as IFrihetClient;

    const server2 = new StubMcpServer();
    registerAllResources(server2 as unknown as McpServer, mockClientDirect);
    const res2 = server2.resources.get("frihet://status/plan-limits");
    assert.ok(res2);
    const parsed2 = JSON.parse((await res2.handler("frihet://status/plan-limits")).contents[0].text);
    assert.equal(parsed2.plan, "pro");
    assert.deepEqual(parsed2.limits, { invoices: 999, apiRateLimit: 100 });
    assert.deepEqual(parsed2.usage, { invoices: 120, apiRateLimit: 12 });

    // 3. Fallback on empty context
    const mockClientEmpty = {
      getBusinessContext: async () => ({}),
    } as unknown as IFrihetClient;

    const server3 = new StubMcpServer();
    registerAllResources(server3 as unknown as McpServer, mockClientEmpty);
    const res3 = server3.resources.get("frihet://status/plan-limits");
    assert.ok(res3);
    const parsed3 = JSON.parse((await res3.handler("frihet://status/plan-limits")).contents[0].text);
    assert.equal(parsed3.plan, "free");
    assert.deepEqual(parsed3.limits, {});
    assert.deepEqual(parsed3.usage, {});
  });
});
