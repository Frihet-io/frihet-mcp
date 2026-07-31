/**
 * Tests for the OpenAI-safe MCP profile.
 *
 * The public ChatGPT app intentionally exposes a narrower tool surface than
 * the full MCP server. This prevents regulated or sensitive workflows added
 * to the general MCP server from becoming part of the OpenAI submission by
 * accident.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod/v4";

import {
  applyOpenAIProfile,
  OPENAI_COMMERCIAL_DOCUMENT_NUMBER_TOOLS,
} from "../openai-profile.js";
import { SENSITIVE_FIELD_NAMES } from "../redaction.js";
import { registerAllTools } from "../tools/register-all.js";
import { registerAllPrompts } from "../prompts/register-all.js";
import { registerAllResources } from "../resources/register-all.js";
import type { IFrihetClient } from "../client-interface.js";

interface ToolConfig {
  title: string;
  description: string;
  annotations?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: unknown;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

interface RegisteredTool {
  name: string;
  config: ToolConfig;
  handler: ToolHandler;
}

class StubMcpServer {
  tools: Map<string, RegisteredTool> = new Map();
  prompts: string[] = [];
  resources: string[] = [];

  registerTool(name: string, config: ToolConfig, handler: ToolHandler): void {
    this.tools.set(name, { name, config, handler });
  }

  registerPrompt(name: string): void {
    this.prompts.push(name);
  }

  registerResource(name: string): void {
    this.resources.push(name);
  }
}

function makeClient(): IFrihetClient {
  return new Proxy({}, {
    get: (_target, prop) => async (input?: unknown) => {
      if (prop === "createClient") {
        return {
          id: "cli_openai",
          name: "OpenAI Test Corp",
          email: "test@example.com",
          taxId: "B12345678",
          secret: "should-not-leak",
        };
      }
      if (prop === "listInvoices") {
        return {
          data: [{
            id: "inv_openai",
            documentNumber: "FAC-2026-0042",
            clientTaxId: "B12345678",
          }],
          total: 1,
          limit: 20,
          offset: 0,
        };
      }
      if (prop === "createCreditNote") {
        return {
          success: true,
          creditNote: {
            id: "cn_openai",
            documentNumber: "R-2026-0007",
            clientTaxId: "B12345678",
          },
        };
      }
      return {
        data: [],
        total: 0,
        limit: 10,
        offset: 0,
        input,
      };
    },
  }) as IFrihetClient;
}

function makeOpenAIServer(): StubMcpServer {
  const server = new StubMcpServer();
  applyOpenAIProfile(server);
  registerAllTools(
    server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    makeClient(),
  );
  registerAllResources(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer);
  registerAllPrompts(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer);
  return server;
}

describe("OpenAI profile", () => {
  test("exposes exactly the reviewed 53-tool surface", () => {
    const server = makeOpenAIServer();

    assert.equal(server.tools.size, 53);
    assert.equal(server.prompts.length, 0);
    assert.equal(server.resources.length, 0);

    for (const hiddenTool of [
      "get_quarterly_taxes",
      "get_invoice_einvoice",
      "send_einvoice",
      "validate_einvoice_xml",
      "frihet_tax_id_vies_lookup",
      "create_reservation",
      "payroll_export",
      "invite_team_member",
    ]) {
      assert.equal(server.tools.has(hiddenTool), false, `${hiddenTool} must not be exposed in OpenAI mode`);
    }
  });

  test("keeps only reviewed open-world tools marked openWorldHint=true", () => {
    const server = makeOpenAIServer();
    const openWorldTools = [...server.tools.values()]
      .filter((tool) => tool.config.annotations?.["openWorldHint"] === true)
      .map((tool) => tool.name)
      .sort();

    assert.deepEqual(openWorldTools, [
      "create_webhook",
      "send_invoice",
      "send_quote",
      "update_webhook",
    ]);
  });

  test("removes restricted input fields from OpenAI-visible schemas", () => {
    const server = makeOpenAIServer();

    for (const name of ["create_client", "update_client", "create_vendor", "update_vendor"]) {
      const tool = server.tools.get(name);
      assert.ok(tool, `${name} should be visible`);
      assert.equal("taxId" in (tool.config.inputSchema ?? {}), false);
    }

    for (const name of ["create_invoice", "update_invoice", "create_quote", "update_quote"]) {
      const tool = server.tools.get(name);
      assert.ok(tool, `${name} should be visible`);
      assert.equal("clientTaxId" in (tool.config.inputSchema ?? {}), false);
    }

    for (const name of ["send_invoice", "send_quote"]) {
      const tool = server.tools.get(name);
      assert.ok(tool, `${name} should be visible`);
      assert.equal("to" in (tool.config.inputSchema ?? {}), false);
    }

    for (const name of ["create_webhook", "update_webhook"]) {
      const tool = server.tools.get(name);
      assert.ok(tool, `${name} should be visible`);
      assert.equal("secret" in (tool.config.inputSchema ?? {}), false);
    }
  });

  test("every reviewed tool states an explicit openWorldHint rationale", () => {
    const server = makeOpenAIServer();

    for (const tool of server.tools.values()) {
      // OpenAI review: openWorldHint must be explicit (not null) AND justified per tool.
      assert.equal(
        typeof tool.config.annotations?.["openWorldHint"],
        "boolean",
        `${tool.name} must have an explicit boolean openWorldHint`,
      );
      assert.ok(
        tool.config.description.includes("openWorldHint"),
        `${tool.name} description must state an openWorldHint rationale`,
      );
    }

    // Closed-world read tool carries the closed-world rationale.
    assert.match(
      server.tools.get("list_invoices")!.config.description,
      /openWorldHint: false/,
    );
    // Open-world tool keeps its bespoke true rationale (not double-appended).
    const sendInvoiceDesc = server.tools.get("send_invoice")!.config.description;
    assert.match(sendInvoiceDesc, /openWorldHint: true/);
    assert.doesNotMatch(sendInvoiceDesc, /openWorldHint: false/);
  });

  test("redacts restricted output fields from structured content and text", async () => {
    const server = makeOpenAIServer();
    const tool = server.tools.get("create_client");
    assert.ok(tool, "create_client should be visible");

    const result = await tool.handler({ name: "OpenAI Test Corp" });
    const serialized = JSON.stringify(result);

    assert.equal(serialized.includes("taxId"), false);
    assert.equal(serialized.includes("B12345678"), false);
    assert.equal(serialized.includes("secret"), false);
    assert.equal(serialized.includes("should-not-leak"), false);
  });

  test("preserves commercial document numbers while redacting client tax identity", async () => {
    const server = makeOpenAIServer();

    const invoiceResult = await server.tools.get("list_invoices")!.handler({});
    const invoiceSerialized = JSON.stringify(invoiceResult);
    assert.equal(invoiceSerialized.includes("FAC-2026-0042"), true);
    assert.equal(invoiceSerialized.includes("clientTaxId"), false);
    assert.equal(invoiceSerialized.includes("B12345678"), false);

    const creditNoteTool = server.tools.get("create_credit_note")!;
    const creditNoteResult = await creditNoteTool.handler({
      invoiceId: "inv_openai",
      reason: "error",
    });
    const creditNoteSerialized = JSON.stringify(creditNoteResult);
    assert.equal(creditNoteSerialized.includes("R-2026-0007"), true);
    assert.equal(creditNoteSerialized.includes("clientTaxId"), false);
    assert.equal(creditNoteSerialized.includes("B12345678"), false);

    const publishedSchema = z.toJSONSchema(creditNoteTool.config.outputSchema as z.ZodType);
    assert.equal(JSON.stringify(publishedSchema).includes("documentNumber"), true);
  });

  test("no reviewed tool DECLARES a sensitive field in its outputSchema", () => {
    const server = makeOpenAIServer();

    // Inspect the JSON Schema that clients receive, not the same Zod internals
    // used by the stripping implementation. The previous mirror traversal was
    // Zod-3-only and therefore passed vacuously over every Zod 4 tool schema.
    const collectPropertyNames = (value: unknown, acc: Set<string>): Set<string> => {
      if (Array.isArray(value)) {
        for (const item of value) collectPropertyNames(item, acc);
        return acc;
      }
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
            for (const propertyName of Object.keys(child as Record<string, unknown>)) {
              acc.add(propertyName);
            }
          }
          collectPropertyNames(child, acc);
        }
      }
      return acc;
    };

    for (const tool of server.tools.values()) {
      const out = tool.config.outputSchema;
      if (!out) continue;
      const publishedSchema = z.toJSONSchema(out as z.ZodType);
      const keys = collectPropertyNames(publishedSchema, new Set<string>());
      for (const field of SENSITIVE_FIELD_NAMES) {
        if (
          field === "documentNumber" &&
          OPENAI_COMMERCIAL_DOCUMENT_NUMBER_TOOLS.has(tool.name)
        ) {
          continue;
        }
        assert.equal(
          keys.has(field),
          false,
          `${tool.name} outputSchema must not declare sensitive field "${field}"`,
        );
      }
    }
  });
});
