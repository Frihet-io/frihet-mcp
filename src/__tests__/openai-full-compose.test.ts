/**
 * Trust-Area tests for the exact OpenAI full-description composition.
 *
 * The reviewed host exposes 33 allow-listed business tools directly. It does
 * not use the grouped progressive-disclosure layer, so ChatGPT sees complete
 * descriptions and cannot route through list_tool_groups/search_tools/
 * describe_tool before the expected business operation.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod/v4";

import {
  applyOpenAIReviewProfiles,
  OPENAI_ALLOWED_TOOL_COUNT,
  OPENAI_REVIEW_CONFIRM_REQUIRED_TOOLS,
  OPENAI_REVIEWED_TOOL_ALLOWLIST,
  OPENAI_WORKSPACE_WEBHOOK_EVENT_TOOLS,
} from "../openai-profile.js";
import { registerAllTools } from "../tools/register-all.js";
import { registerAllPrompts } from "../prompts/register-all.js";
import { registerAllResources } from "../resources/register-all.js";
import type { IFrihetClient } from "../client-interface.js";

interface ToolConfig {
  title?: string;
  description: string;
  annotations?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: unknown;
  _meta?: Record<string, unknown>;
}

type ToolHandler = (args?: Record<string, unknown>) => Promise<{
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
  return new Proxy(
    {},
    {
      get: (_target, prop) => async (input?: unknown) => {
        if (prop === "createClient") {
          return {
            id: "cli_compose",
            name: "Compose Test Corp",
            email: "test@example.com",
            taxId: "B12345678",
            secret: "should-not-leak",
          };
        }
        return { data: [], total: 0, limit: 10, offset: 0, input };
      },
    },
  ) as IFrihetClient;
}

const asMcp = (server: StubMcpServer) =>
  server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

function makeReviewedServer(): StubMcpServer {
  const server = new StubMcpServer();
  applyOpenAIReviewProfiles(asMcp(server));
  registerAllTools(asMcp(server), makeClient());
  registerAllResources(asMcp(server));
  registerAllPrompts(asMcp(server));
  return server;
}

function inputShape(tool: RegisteredTool): Record<string, unknown> {
  const schema = tool.config.inputSchema;
  return schema instanceof z.ZodObject
    ? schema.shape as Record<string, unknown>
    : schema ?? {};
}

const DISCOVERY_META_TOOLS = [
  "list_tool_groups",
  "search_tools",
  "describe_tool",
] as const;

const NON_REVIEWED_TOOLS = [
  "get_quarterly_taxes",
  "get_invoice_einvoice",
  "get_invoice_pdf",
  "list_webhooks",
  "get_webhook",
  "create_webhook",
  "update_webhook",
  "delete_webhook",
  "apply_late_fee",
  "update_invoice",
  "mark_invoice_paid",
  "delete_invoice",
  "send_invoice",
  "duplicate_invoice",
  "create_credit_note",
  "delete_client",
  "delete_expense",
  "send_quote",
  "send_einvoice",
  "validate_einvoice_xml",
  "create_reservation",
  "payroll_export",
  "invite_team_member",
  "get_modelo_303_summary",
] as const;

describe("OpenAI full-description composition: exact reviewed surface", () => {
  test("registers exactly the 33 business tools and no discovery, prompts, or resources", () => {
    const server = makeReviewedServer();
    assert.equal(OPENAI_ALLOWED_TOOL_COUNT, 33);
    assert.equal(server.tools.size, OPENAI_ALLOWED_TOOL_COUNT);
    assert.deepEqual(
      [...server.tools.keys()].sort(),
      [...OPENAI_REVIEWED_TOOL_ALLOWLIST].sort(),
    );
    for (const name of DISCOVERY_META_TOOLS) {
      assert.equal(server.tools.has(name), false, `${name} must not be registered`);
    }
    assert.equal(server.prompts.length, 0);
    assert.equal(server.resources.length, 0);
  });

  test("drops every sampled non-reviewed operation", () => {
    const server = makeReviewedServer();
    for (const name of NON_REVIEWED_TOOLS) {
      assert.equal(server.tools.has(name), false, `${name} must stay outside OpenAI`);
    }
  });
});

describe("OpenAI full-description composition: model-facing truth", () => {
  test("every tool keeps a complete description and explicit action hints", () => {
    const server = makeReviewedServer();
    for (const [name, tool] of server.tools) {
      const description = tool.config.description;
      assert.ok(description.length >= 80, `${name} description is unexpectedly terse`);
      assert.doesNotMatch(description, /^\[[a-z]+\] /u, `${name} must not be grouped`);
      assert.doesNotMatch(description, /describe_tool\(/u, `${name} must be self-contained`);
      assert.match(description, /openWorldHint: (?:true|false)/u, `${name} lacks rationale`);
      for (const hint of [
        "readOnlyHint",
        "openWorldHint",
        "destructiveHint",
        "idempotentHint",
      ]) {
        assert.equal(
          typeof tool.config.annotations?.[hint],
          "boolean",
          `${name}.${hint} must be an explicit boolean`,
        );
      }
    }
  });

  test("webhook-capable writes stay open-world while reads stay closed-world", () => {
    const server = makeReviewedServer();
    for (const name of OPENAI_WORKSPACE_WEBHOOK_EVENT_TOOLS) {
      const tool = server.tools.get(name)!;
      assert.equal(tool.config.annotations?.openWorldHint, true, `${name} annotation`);
      assert.match(tool.config.description, /openWorldHint: true/u);
      assert.doesNotMatch(tool.config.description, /openWorldHint: false/u);
    }
    const read = server.tools.get("list_invoices")!;
    assert.equal(read.config.annotations?.openWorldHint, false);
    assert.match(read.config.description, /openWorldHint: false/u);
  });

  test("all reviewed writes expose confirmation in both schema and description", () => {
    const server = makeReviewedServer();
    for (const name of OPENAI_REVIEW_CONFIRM_REQUIRED_TOOLS) {
      const tool = server.tools.get(name);
      assert.ok(tool, `${name} must be registered`);
      assert.equal("confirm" in inputShape(tool), true, `${name} must require confirm`);
      assert.match(tool.config.description, /confirm/iu, `${name} must explain confirmation`);
    }
  });

  test("full descriptions preserve input stripping and runtime output redaction", async () => {
    const server = makeReviewedServer();
    assert.equal("taxId" in inputShape(server.tools.get("create_client")!), false);
    assert.equal("confirm" in inputShape(server.tools.get("create_invoice")!), true);

    const result = await server.tools.get("create_client")!.handler({
      name: "Compose Test Corp",
      confirm: true,
    });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("taxId"), false);
    assert.equal(serialized.includes("B12345678"), false);
    assert.equal(serialized.includes("should-not-leak"), false);
  });
});
