/**
 * Barrel module that registers all 111 Frihet ERP tools on an McpServer.
 *
 * Used by both the local (stdio) and remote (Cloudflare Workers) servers
 * so tool definitions stay in sync — one source of truth.
 *
 * Langfuse observability is injected by patching server.registerTool once
 * before any tool registration. This wraps every tool callback with
 * traceMCPTool so all 111 tools are instrumented at zero per-tool cost.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IFrihetClient } from "../client-interface.js";
import { traceMCPTool } from "../observability.js";
import { registerInvoiceTools } from "./invoices.js";
import { registerExpenseTools } from "./expenses.js";
import { registerClientTools } from "./clients.js";
import { registerProductTools } from "./products.js";
import { registerQuoteTools } from "./quotes.js";
import { registerVendorTools } from "./vendors.js";
import { registerWebhookTools } from "./webhooks.js";
import { registerIntelligenceTools } from "./intelligence.js";
import { registerCrmTools } from "./crm.js";
import { registerDepositTools } from "./deposits.js";
import { registerEInvoiceTools } from "./einvoice.js";
import { registerStayTools } from "./stay.js";
import { registerPosTools } from "./pos.js";
import { registerBankingTools } from "./banking.js";
import { registerFiscalTools } from "./fiscal.js";
import { registerTimeTools } from "./time.js";
import { registerRecurringTools } from "./recurring.js";
import { registerTeamTools } from "./team.js";

/**
 * Patches server.registerTool to wrap every tool callback with Langfuse tracing.
 *
 * The patch is applied once before tool registration so all 62 tools are
 * instrumented without per-tool edits. Tool call signatures are unchanged —
 * existing MCP clients continue to work identically.
 *
 * traceMCPTool is fail-open: any Langfuse error → warn log, tool proceeds.
 */
function patchServerWithTracing(server: McpServer): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalRegisterTool = server.registerTool.bind(server);

  // We override registerTool to wrap the callback (cb) with Langfuse tracing.
  // The override preserves full TypeScript compatibility via a broad signature
  // cast — the runtime types are identical; we only intercept the callback.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = function patchedRegisterTool(
    name: string,
    config: Record<string, unknown>,
    cb: (args: unknown, extra: unknown) => unknown,
  ): unknown {
    const tracedCb = async (args: unknown, extra: unknown): Promise<unknown> => {
      return traceMCPTool(name, args, () => cb(args, extra) as Promise<unknown>);
    };
    return originalRegisterTool(name, config as Parameters<typeof originalRegisterTool>[1], tracedCb as Parameters<typeof originalRegisterTool>[2]);
  };
}

export function registerAllTools(server: McpServer, client: IFrihetClient): void {
  // Inject Langfuse tracing into all subsequent registerTool calls (fail-open)
  patchServerWithTracing(server);

  registerIntelligenceTools(server, client);
  registerInvoiceTools(server, client);
  registerExpenseTools(server, client);
  registerClientTools(server, client);
  registerCrmTools(server, client);
  registerProductTools(server, client);
  registerQuoteTools(server, client);
  registerVendorTools(server, client);
  registerWebhookTools(server, client);
  registerDepositTools(server, client);
  registerEInvoiceTools(server, client);
  registerStayTools(server, client);
  registerPosTools(server, client);
  registerBankingTools(server, client);
  registerFiscalTools(server, client);
  registerTimeTools(server, client);
  registerRecurringTools(server, client);
  registerTeamTools(server, client);
}
