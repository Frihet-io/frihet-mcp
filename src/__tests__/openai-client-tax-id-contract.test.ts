/**
 * Owner-approved #139 correction for the reviewed clientTaxId contract.
 * Direct MCP keeps the field; the OpenAI-reviewed profile removes it from the
 * descriptor/forwarded call and redacts both camel/snake output variants.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { IFrihetClient } from "../client-interface.js";
import { applyOpenAIReviewProfiles } from "../openai-profile.js";
import { registerAllTools } from "../tools/register-all.js";

const DIRECT_TAX_ID_TOOLS = [
  "create_invoice",
  "update_invoice",
  "create_quote",
  "update_quote",
] as const;

const REVIEWED_TAX_ID_TOOLS = [
  "create_invoice",
  "create_quote",
] as const;

interface CapturedCall {
  method: string;
  input: Record<string, unknown>;
}

interface Harness {
  client: Client;
  server: McpServer;
  calls: CapturedCall[];
}

function makeApiClient(calls: CapturedCall[]): IFrihetClient {
  const respond = (method: string, input: Record<string, unknown>) => {
    calls.push({ method, input: structuredClone(input) });
    return {
      id: `${method}_139`,
      clientId: "cli_139",
      issueDate: "2026-08-28",
      ...(method.endsWith("Invoice")
        ? { invoiceNumber: "INV-139", dueDate: "2026-09-27" }
        : { quoteNumber: "QUO-139" }),
      status: "draft",
      clientName: "Contract Test Client",
      items: [{ description: "Reviewed contract", quantity: 1, unitPrice: 100 }],
      clientTaxId: "REVIEWED-CAMEL-MUST-REDACT",
      client_tax_id: "REVIEWED-SNAKE-MUST-REDACT",
    };
  };

  return new Proxy({}, {
    get: (_target, property) => {
      if (property === "createInvoice") {
        return async (input: Record<string, unknown>) => respond("createInvoice", input);
      }
      if (property === "updateInvoice") {
        return async (id: string, input: Record<string, unknown>) =>
          respond("updateInvoice", { id, ...input });
      }
      if (property === "createQuote") {
        return async (input: Record<string, unknown>) => respond("createQuote", input);
      }
      if (property === "updateQuote") {
        return async (id: string, input: Record<string, unknown>) =>
          respond("updateQuote", { id, ...input });
      }
      return async () => ({ data: [], total: 0, limit: 20, offset: 0 });
    },
  }) as IFrihetClient;
}

async function makeHarness(reviewed: boolean): Promise<Harness> {
  const calls: CapturedCall[] = [];
  const server = new McpServer(
    { name: reviewed ? "frihet-reviewed-139" : "frihet-direct-139", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  if (reviewed) applyOpenAIReviewProfiles(server);
  registerAllTools(server, makeApiClient(calls));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "frihet-client-tax-id-contract", version: "0.0.0" },
    { capabilities: {} },
  );
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server, calls };
}

async function dispose(harness: Harness): Promise<void> {
  await harness.client.close();
  await harness.server.close();
}

function schemaProperties(tool: { inputSchema?: unknown }): Record<string, unknown> {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
  return schema?.properties ?? {};
}

const CREATE_ARGS = {
  clientName: "Contract Test Client",
  clientTaxId: "DIRECT-CLIENT-TAX-ID",
  items: [{ description: "Reviewed contract", quantity: 1, unitPrice: 100 }],
};

const UPDATE_ARGS = {
  id: "doc_139",
  clientTaxId: "DIRECT-CLIENT-TAX-ID",
};

describe("#139 reviewed clientTaxId policy — real MCP SDK", () => {
  test("reviewed tools/list removes every visible clientTaxId input path", async () => {
    const harness = await makeHarness(true);
    try {
      const { tools } = await harness.client.listTools();
      assert.equal(tools.length, 33, "reviewed surface remains exactly 33 business tools");
      assert.equal(tools.some((tool) => tool.name === "update_invoice"), false);
      assert.equal(tools.some((tool) => tool.name === "update_quote"), false);
      for (const name of REVIEWED_TAX_ID_TOOLS) {
        const tool = tools.find((candidate) => candidate.name === name);
        assert.ok(tool, `${name} remains reviewed`);
        assert.equal("clientTaxId" in schemaProperties(tool), false, `${name} must not declare clientTaxId`);
      }
    } finally {
      await dispose(harness);
    }
  });

  test("reviewed calls reject unknown tax-ID fields, then omit them from valid calls and outputs", async () => {
    const harness = await makeHarness(true);
    try {
      for (const [name, args] of [
        ["create_invoice", { ...CREATE_ARGS, confirm: true }],
        ["create_quote", { ...CREATE_ARGS, confirm: true }],
      ] as const) {
        const rejected = await harness.client.callTool({ name, arguments: args });
        assert.equal(rejected.isError, true, `${name} must reject undeclared clientTaxId`);
      }
      assert.equal(harness.calls.length, 0, "strict reviewed schemas must reject before ERP");

      const calls = [
        ["create_invoice", { clientName: CREATE_ARGS.clientName, items: CREATE_ARGS.items, confirm: true }],
        ["create_quote", { clientName: CREATE_ARGS.clientName, items: CREATE_ARGS.items, confirm: true }],
      ] as const;

      for (const [name, args] of calls) {
        const result = await harness.client.callTool({ name, arguments: args });
        assert.equal(result.isError, undefined, `${name} should execute after reviewed field stripping`);
        const serialized = JSON.stringify(result);
        assert.equal(serialized.includes("clientTaxId"), false);
        assert.equal(serialized.includes("client_tax_id"), false);
        assert.equal(serialized.includes("REVIEWED-CAMEL-MUST-REDACT"), false);
        assert.equal(serialized.includes("REVIEWED-SNAKE-MUST-REDACT"), false);
      }

      assert.equal(harness.calls.length, 2);
      for (const call of harness.calls) {
        assert.equal("clientTaxId" in call.input, false, `${call.method} must not receive clientTaxId`);
      }
    } finally {
      await dispose(harness);
    }
  });

  test("direct MCP keeps the existing descriptor and forwarding contract", async () => {
    const harness = await makeHarness(false);
    try {
      const { tools } = await harness.client.listTools();
      for (const name of DIRECT_TAX_ID_TOOLS) {
        const tool = tools.find((candidate) => candidate.name === name);
        assert.ok(tool, `${name} exists directly`);
        assert.equal("clientTaxId" in schemaProperties(tool), true, `${name} keeps direct clientTaxId`);
      }

      const result = await harness.client.callTool({
        name: "create_invoice",
        arguments: CREATE_ARGS,
      });
      assert.equal(result.isError, undefined);
      assert.equal(harness.calls[0]?.input.clientTaxId, "DIRECT-CLIENT-TAX-ID");
      assert.equal(
        (result.structuredContent as { clientTaxId?: string }).clientTaxId,
        "REVIEWED-CAMEL-MUST-REDACT",
        "direct MCP output remains unchanged",
      );
    } finally {
      await dispose(harness);
    }
  });
});
