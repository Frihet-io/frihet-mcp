import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MUSE_CANDIDATE_TOOLS,
  MUSE_CANDIDATE_TOOL_COUNT,
  applyMuseProfile,
  museToolResult,
} from "../muse-profile.js";
import { registerMcpSurface, localMcpSurfaceComposition } from "../server-composition.js";
import type { IFrihetClient } from "../client-interface.js";

const stubClient: IFrihetClient = {
  get: async () => ({}),
  post: async () => ({}),
  patch: async () => ({}),
  delete: async () => ({}),
  put: async () => ({}),
  request: async () => ({}),
} as unknown as IFrihetClient;

test("muse-profile: inventory matches exactly 18 curated small-business tools", () => {
  assert.equal(MUSE_CANDIDATE_TOOL_COUNT, 18);
  assert.equal(MUSE_CANDIDATE_TOOLS.size, 18);
  assert.ok(MUSE_CANDIDATE_TOOLS.has("get_business_context"));
  assert.ok(MUSE_CANDIDATE_TOOLS.has("get_monthly_summary"));
  assert.ok(MUSE_CANDIDATE_TOOLS.has("get_quarterly_taxes"));
  assert.ok(MUSE_CANDIDATE_TOOLS.has("list_invoices"));
  assert.ok(MUSE_CANDIDATE_TOOLS.has("get_invoice"));
  assert.ok(MUSE_CANDIDATE_TOOLS.has("search_invoices"));
  assert.ok(MUSE_CANDIDATE_TOOLS.has("list_expenses"));
  assert.ok(MUSE_CANDIDATE_TOOLS.has("get_expense"));
  assert.ok(MUSE_CANDIDATE_TOOLS.has("create_expense"));
  assert.ok(MUSE_CANDIDATE_TOOLS.has("list_clients"));
  assert.ok(MUSE_CANDIDATE_TOOLS.has("get_client"));
  assert.ok(MUSE_CANDIDATE_TOOLS.has("create_client"));
  assert.ok(MUSE_CANDIDATE_TOOLS.has("list_products"));
  assert.ok(MUSE_CANDIDATE_TOOLS.has("get_product"));
  assert.ok(MUSE_CANDIDATE_TOOLS.has("list_quotes"));
  assert.ok(MUSE_CANDIDATE_TOOLS.has("get_quote"));
  assert.ok(MUSE_CANDIDATE_TOOLS.has("create_quote"));
  assert.ok(MUSE_CANDIDATE_TOOLS.has("create_invoice"));
});

test("muse-profile: registerMcpSurface in museMode exposes exactly 18 tools, 0 resources, 0 prompts", () => {
  const server = new McpServer({ name: "test-muse", version: "1.0.0" });
  const comp = localMcpSurfaceComposition(false, false, false, false, true);

  registerMcpSurface(server, stubClient, comp);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registeredTools = Object.keys((server as any)._registeredTools ?? {});
  assert.equal(registeredTools.length, 18);
  for (const name of registeredTools) {
    assert.ok(MUSE_CANDIDATE_TOOLS.has(name), `Unexpected tool in muse profile: ${name}`);
  }

  // Resources and prompts must be 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registeredResources = Object.keys((server as any)._registeredResources ?? {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registeredPrompts = Object.keys((server as any)._registeredPrompts ?? {});
  assert.equal(registeredResources.length, 0);
  assert.equal(registeredPrompts.length, 0);
});

test("muse-profile: create_invoice includes draft-only human-in-the-loop notice", () => {
  const server = new McpServer({ name: "test-muse", version: "1.0.0" });
  const comp = localMcpSurfaceComposition(false, false, false, false, true);

  registerMcpSurface(server, stubClient, comp);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools?.["create_invoice"];
  assert.ok(tool);
  assert.match(tool.description, /Meta Muse: Generates an invoice strictly in 'draft' status/);
});

test("muse-profile: create_invoice strictly forces draft status on real composition even if caller specifies status='sent'", async () => {
  const server = new McpServer({ name: "test-muse", version: "1.0.0" });
  const comp = localMcpSurfaceComposition(false, false, false, false, true);

  let capturedInvoicePayload: Record<string, unknown> | undefined;
  const mockClient = {
    ...stubClient,
    createInvoice: async (data: Record<string, unknown>) => {
      capturedInvoicePayload = data;
      return { id: "inv_123", status: data.status, invoiceNumber: "FAC-2026-001" };
    },
  } as unknown as IFrihetClient;

  registerMcpSurface(server, mockClient, comp);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools?.["create_invoice"];
  assert.ok(tool);

  // Status must be omitted from inputSchema to prevent agent confusion
  assert.equal(tool.config?.inputSchema?.status, undefined);

  // Even if caller bypasses and passes status: 'sent'
  const result = await tool.handler({
    clientName: "Test Client",
    items: [{ description: "Service", quantity: 1, unitPrice: 100 }],
    status: "sent",
  });

  assert.ok(capturedInvoicePayload, "client.createInvoice must be called");
  assert.equal(capturedInvoicePayload.status, "draft", "Disallowed non-draft status must NEVER reach the client");
  assert.ok(result);
});

test("muse-profile: create_quote strictly forces draft status on real composition", async () => {
  const server = new McpServer({ name: "test-muse", version: "1.0.0" });
  const comp = localMcpSurfaceComposition(false, false, false, false, true);

  let capturedQuotePayload: Record<string, unknown> | undefined;
  const mockClient = {
    ...stubClient,
    createQuote: async (data: Record<string, unknown>) => {
      capturedQuotePayload = data;
      return { id: "quo_123", status: data.status };
    },
  } as unknown as IFrihetClient;

  registerMcpSurface(server, mockClient, comp);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools?.["create_quote"];
  assert.ok(tool);
  assert.equal(tool.config?.inputSchema?.status, undefined);

  await tool.handler({
    clientName: "Test Client",
    items: [{ description: "Consulting", quantity: 1, unitPrice: 500 }],
    status: "accepted",
  });

  assert.ok(capturedQuotePayload);
  assert.equal(capturedQuotePayload.status, "draft");
});

test("muse-profile: redaction strips sensitive fiscal IDs and secrets from output", () => {
  const raw = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          client: "Acme Corp",
          taxId: "B12345678",
          iban: "ES9121000418450200051332",
        }),
      },
    ],
    structuredContent: {
      client: {
        name: "Acme Corp",
        taxId: "B12345678",
        iban: "ES9121000418450200051332",
      },
      apiKey: "fri_live_secret123",
    },
  };

  const output = museToolResult(raw) as {
    structuredContent: Record<string, any>;
    content: Array<{ text: string }>;
  };

  // Structured fields deleted/masked
  assert.equal(output.structuredContent.apiKey, undefined);
  assert.equal(output.structuredContent.client.taxId, undefined);
  assert.equal(output.structuredContent.client.iban, undefined);
  assert.equal(output.structuredContent.client.name, "Acme Corp");

  // Serialized text JSON patterns stripped
  assert.doesNotMatch(output.content[0].text, /"taxId"/);
  assert.doesNotMatch(output.content[0].text, /"iban"/);
  assert.match(output.content[0].text, /Acme Corp/);
});

test("muse-profile: mutual exclusivity blocks combinations with other profiles", () => {
  const server = new McpServer({ name: "test-exclusive", version: "1.0.0" });
  assert.throws(
    () => registerMcpSurface(server, stubClient, localMcpSurfaceComposition(true, false, false, false, true)),
    /mutually exclusive/,
  );
  assert.throws(
    () => registerMcpSurface(server, stubClient, localMcpSurfaceComposition(false, false, true, false, true)),
    /mutually exclusive/,
  );
  assert.throws(
    () => registerMcpSurface(server, stubClient, localMcpSurfaceComposition(false, false, false, true, true)),
    /mutually exclusive/,
  );
});
