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
    assert.match(parsed.note, /100 overdue invoices/i);
  });
});
