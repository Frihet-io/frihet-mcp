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

import { applyOpenAIProfile } from "../openai-profile.js";
import { registerAllTools } from "../tools/register-all.js";
import { registerAllPrompts } from "../prompts/register-all.js";
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
  registerAllPrompts(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer);
  return server;
}

describe("OpenAI profile", () => {
  test("exposes exactly the reviewed 53-tool surface", () => {
    const server = makeOpenAIServer();

    assert.equal(server.tools.size, 53);
    assert.equal(server.prompts.length, 0);

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
});
