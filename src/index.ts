#!/usr/bin/env node

/**
 * Frihet MCP Server
 *
 * Model Context Protocol server for Frihet ERP.
 * Provides AI-powered access to invoices, expenses, clients, products, quotes, and webhooks.
 *
 * Authentication: Set the FRIHET_API_KEY environment variable with your Frihet API key.
 * Transport: stdio (designed for CLI tools like Claude Code, Cursor, Windsurf).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { FrihetClient } from "./client.js";
import { registerAllTools } from "./tools/register-all.js";
import { registerAllResources } from "./resources/register-all.js";
import { registerAllPrompts } from "./prompts/register-all.js";
import { applyOpenAIProfile, OPENAI_ALLOWED_TOOL_COUNT, OPENAI_EXCLUDED_COUNT, OPENAI_EXCLUDED_RESOURCE_COUNT } from "./openai-profile.js";
import { resolveToolMode, applyToolExposureProfile, GROUPED_META_TOOL_COUNT } from "./tool-exposure.js";
import { log } from "./logger.js";
import { registerShutdownHook } from "./metrics.js";
import { setTraceContext } from "./observability.js";

function main(): void {
  const apiKey = process.env.FRIHET_API_KEY;

  if (!apiKey) {
    console.error(
      "Error: FRIHET_API_KEY environment variable is required.\n\n" +
        "Get your API key:\n" +
        "  1. Create a free account at https://app.frihet.io\n" +
        "  2. Go to Settings > Developers > API Keys\n" +
        "  3. Create a key and add it to your MCP configuration\n\n" +
        "Documentation: https://docs.frihet.io/desarrolladores/mcp-server\n",
    );
    process.exit(1);
  }

  const baseUrl = process.env.FRIHET_API_URL;

  if (baseUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      console.error(
        `Error: FRIHET_API_URL is not a valid URL: "${baseUrl}"\n` +
          "It must be a valid https:// URL with a frihet.io hostname.\n",
      );
      process.exit(1);
    }

    if (parsed.protocol !== "https:") {
      console.error(
        `Error: FRIHET_API_URL must use https:// (got "${parsed.protocol}").\n`,
      );
      process.exit(1);
    }

    if (!parsed.hostname.endsWith("frihet.io")) {
      console.error(
        `Error: FRIHET_API_URL hostname must be under frihet.io (got "${parsed.hostname}").\n` +
          "This prevents redirection to untrusted servers.\n",
      );
      process.exit(1);
    }
  }

  const client = new FrihetClient(apiKey, baseUrl);

  // Set trace context for Langfuse (reads LANGFUSE_* from process.env automatically).
  // clientName can be overridden via FRIHET_CLIENT_NAME env var by the MCP host.
  setTraceContext({
    mcpVersion: "mcp/1.0",
    clientName: process.env.FRIHET_CLIENT_NAME,
  });

  const server = new McpServer({
    name: "frihet-erp",
    version: "1.13.0",
    description:
      "AI-native MCP server for Frihet ERP — invoices, expenses, clients, products, quotes, webhooks, and deposits. " +
      "Provides 151 tools (including business context, monthly summaries, quarterly taxes, invoice duplication, CRM subcollections, and deposit management), " +
      "11 resources (8 static + 3 live), and 10 workflow prompts for business management " +
      "with full Spanish tax compliance (IVA, IGIC, IPSI).",
  });

  // Apply OpenAI-safe profile if enabled (strips sensitive fields, fixes annotations)
  const openaiMode = process.env.FRIHET_OPENAI_MODE === "true";
  if (openaiMode) {
    applyOpenAIProfile(server);
    log({
      level: "info",
      message: `OpenAI safety profile active — ${OPENAI_ALLOWED_TOOL_COUNT} tools allowed, prompts hidden, ${OPENAI_EXCLUDED_COUNT} defense-in-depth exclusions, ${OPENAI_EXCLUDED_RESOURCE_COUNT} resources excluded, gov IDs + credentials redacted`,
      operation: "startup",
    });
  }

  // Apply grouped tool-exposure profile if enabled (progressive disclosure).
  // FRIHET_TOOL_MODE=grouped collapses the 151 full tool descriptions into terse
  // one-liners + adds list_tool_groups / search_tools / describe_tool meta-tools,
  // so agents load depth on demand instead of a flat 151-tool wall of context.
  // Default (unset / "full") is byte-identical to current behavior. Independent
  // of OpenAI mode; if both are set, OpenAI's allowlist runs first, then this
  // collapses whatever survived.
  const toolMode = resolveToolMode();
  if (toolMode === "grouped") {
    applyToolExposureProfile(server);
    log({
      level: "info",
      message: `Grouped tool-exposure active — 151 tools collapsed to terse summaries, ${GROUPED_META_TOOL_COUNT} discovery meta-tools added (list_tool_groups, search_tools, describe_tool); full depth served on demand`,
      operation: "startup",
    });
  }

  // Register tools (62 full / 60 in OpenAI mode)
  registerAllTools(server, client);

  // Register 11 resources (8 static + 3 dynamic via API)
  registerAllResources(server, client);

  // Register 10 workflow prompts
  registerAllPrompts(server);

  // Register shutdown hook to log final metrics summary
  registerShutdownHook();

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    console.error("[frihet-mcp] v1.13.0 | 151 tools | https://github.com/Frihet-io/frihet-mcp");
    log({
      level: "info",
      message: "Frihet MCP server running on stdio",
      operation: "startup",
      metadata: { version: "1.13.0", transport: "stdio" },
    });
  }).catch((error: unknown) => {
    log({
      level: "error",
      message: "Failed to start Frihet MCP server",
      operation: "startup",
      error: { message: error instanceof Error ? error.message : String(error) },
    });
    process.exit(1);
  });
}

main();
