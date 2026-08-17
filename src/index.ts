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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { FrihetClient } from "./client.js";
import { DemoFrihetClient } from "./demo-client.js";
import type { IFrihetClient } from "./client-interface.js";
import { normalizePublicApiBaseUrl } from "./api-origin.js";

// Single source of truth for the server version: package.json (read at runtime
// from dist/../package.json). Hardcoding it here caused repeated version drift
// (server.json/index.ts/console out of sync → audit:mcp-refs gate failure).
// Reading it once means a `npm version` bump is the ONLY place version lives.
const PKG_VERSION: string = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();
import { OPENAI_ALLOWED_TOOL_COUNT, OPENAI_EXCLUDED_COUNT, OPENAI_EXCLUDED_RESOURCE_COUNT } from "./openai-profile.js";
import { resolveToolMode, GROUPED_META_TOOL_COUNT } from "./tool-exposure.js";
import {
  localMcpSurfaceComposition,
  registerMcpSurface,
} from "./server-composition.js";
import { log } from "./logger.js";
import { registerShutdownHook } from "./metrics.js";
import { setTraceContext } from "./observability.js";

function main(): void {
  const apiKey = process.env.FRIHET_API_KEY;

  // Demo mode: FRIHET_DEMO=1|true serves fixture-backed example data with NO
  // network calls and NO API key required. It's an explicit opt-in, so it wins
  // even if a real key happens to be present. See demo-client.ts / demo-fixtures.ts.
  const demoFlag = process.env.FRIHET_DEMO;
  const demoMode = demoFlag === "1" || demoFlag === "true";

  if (!demoMode && !apiKey) {
    console.error(
      "Error: FRIHET_API_KEY environment variable is required.\n\n" +
        "Get your API key:\n" +
        "  1. Create a free account at https://app.frihet.io\n" +
        "  2. Go to Settings > Developers > API Keys\n" +
        "  3. Create a key and add it to your MCP configuration\n\n" +
        "Or try it instantly with no key: set FRIHET_DEMO=1 for example data.\n\n" +
        "Documentation: https://docs.frihet.io/desarrolladores/mcp-server\n",
    );
    process.exit(1);
  }

  const baseUrlRaw = process.env.FRIHET_API_URL;
  let baseUrl: string | undefined;

  if (!demoMode && baseUrlRaw !== undefined) {
    try {
      baseUrl = normalizePublicApiBaseUrl(baseUrlRaw);
    } catch (error) {
      console.error(
        `Error: ${error instanceof Error ? error.message : "FRIHET_API_URL is invalid"}.\n` +
          "It must be a canonical https:// URL with a trusted frihet.io hostname.\n",
      );
      process.exit(1);
    }
  }

  const client: IFrihetClient = demoMode
    ? new DemoFrihetClient()
    : new FrihetClient(apiKey as string, baseUrl);

  if (demoMode) {
    console.error(
      "[frihet-mcp] DEMO MODE — serving example fixtures, no real data, nothing persisted",
    );
  }

  // Set the fixed protocol fact for Langfuse (reads LANGFUSE_* from process.env automatically).
  // Client identity is deliberately omitted from telemetry.
  setTraceContext({
    mcpVersion: "mcp/1.0",
  });

  const server = new McpServer({
    name: "frihet-erp",
    version: PKG_VERSION,
    description:
      "AI-native MCP server for Frihet ERP — invoices, expenses, clients, products, quotes, webhooks, and deposits. " +
      "Provides a catalogue of 157 canonical operations; fiscal aliases and optional grouped discovery names are reported separately. " +
      "The local package serves 11 resources (7 static + 4 API-backed) and 10 workflow prompts " +
      "with full Spanish tax compliance (IVA, IGIC, IPSI).",
  });

  const openaiMode = process.env.FRIHET_OPENAI_MODE === "true";
  const toolMode = resolveToolMode();

  if (toolMode === "grouped") {
    log({
      level: "info",
      message: `Grouped tool-exposure active — tools collapsed to terse summaries, ${GROUPED_META_TOOL_COUNT} discovery meta-tools added (list_tool_groups, search_tools, describe_tool); full depth served on demand`,
      operation: "startup",
    });
  }

  if (openaiMode) {
    log({
      level: "info",
      message: `OpenAI safety profile active — ${OPENAI_ALLOWED_TOOL_COUNT} tools allowed, prompts hidden, ${OPENAI_EXCLUDED_COUNT} defense-in-depth exclusions, ${OPENAI_EXCLUDED_RESOURCE_COUNT} resources excluded, gov IDs + credentials redacted`,
      operation: "startup",
    });
  }

  registerMcpSurface(
    server,
    client,
    localMcpSurfaceComposition(openaiMode, toolMode === "grouped"),
  );

  // Register shutdown hook to log final metrics summary
  registerShutdownHook();

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    console.error(`[frihet-mcp] v${PKG_VERSION} | capability truth enabled | https://github.com/Frihet-io/frihet-mcp`);
    log({
      level: "info",
      message: "Frihet MCP server running on stdio",
      operation: "startup",
      metadata: { version: PKG_VERSION, transport: "stdio" },
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
