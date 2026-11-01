/**
 * Meta Muse Profile for the Frihet MCP Server.
 *
 * Implements the curated 18-tool financial management surface submitted
 * for the Meta Muse Business Application catalog.
 *
 * Requirements:
 * - Curated catalogue: 18 high-value small business & freelancer tools.
 * - Human-in-the-loop: Invoices and financial documents are created strictly in draft status.
 * - Zero unconfirmed destructive actions (no direct AEAT / VeriFactu fiscal submissions).
 * - Standard output redaction for sensitive fields.
 */

import { deepRedact, redactText } from "./redaction.js";

export const MUSE_CANDIDATE_TOOLS: ReadonlySet<string> = new Set([
  "get_business_context",
  "get_monthly_summary",
  "get_quarterly_taxes",
  "list_invoices",
  "get_invoice",
  "search_invoices",
  "list_expenses",
  "get_expense",
  "create_expense",
  "list_clients",
  "get_client",
  "create_client",
  "list_products",
  "get_product",
  "list_quotes",
  "get_quote",
  "create_quote",
  "create_invoice",
]);

export const MUSE_CANDIDATE_TOOL_COUNT = MUSE_CANDIDATE_TOOLS.size; // 18

export const MUSE_INSTRUCTIONS = `Frihet ERP — natural-language business and financial management for Meta Muse.
Use get_business_context for complete company health and plan limits.
Query and review invoices, expenses, quotes, clients, and products with pagination.
All created invoices are drafts. Confirm parameters with the user before creating records.`;

export function museToolResult(result: unknown): unknown {
  if (result === null || typeof result !== "object") return result;
  const res = result as Record<string, unknown>;

  // Deep-redact structured output if present (in-place deletion of sensitive fields)
  if (res.structuredContent && typeof res.structuredContent === "object") {
    deepRedact(res.structuredContent);
  }

  // Redact text content items
  if (Array.isArray(res.content)) {
    res.content = res.content.map((item: unknown) => {
      if (item && typeof item === "object" && "text" in item && typeof (item as { text: unknown }).text === "string") {
        return {
          ...(item as Record<string, unknown>),
          text: redactText((item as { text: string }).text),
        };
      }
      return item;
    });
  }

  return res;
}

export const MUSE_FORCED_INPUT_VALUES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  create_invoice: { status: "draft" },
  create_quote: { status: "draft" },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyMuseProfile(server: any): void {
  const registerTool = server.registerTool.bind(server);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerTool = (name: string, config: any, handler: any) => {
    if (!MUSE_CANDIDATE_TOOLS.has(name)) return undefined;

    let description = config.description ?? "";
    let inputSchema = config.inputSchema;

    if (name === "create_invoice") {
      description = `${description} [Meta Muse: Generates an invoice strictly in 'draft' status for human review. No irreversible fiscal submission occurs.]`;
      if (inputSchema && typeof inputSchema === "object" && "status" in inputSchema) {
        const { status: _omittedStatus, ...rest } = inputSchema;
        inputSchema = rest;
      }
    } else if (name === "create_quote") {
      description = `${description} [Meta Muse: Generates a quote strictly in 'draft' status for human review.]`;
      if (inputSchema && typeof inputSchema === "object" && "status" in inputSchema) {
        const { status: _omittedStatus, ...rest } = inputSchema;
        inputSchema = rest;
      }
    }

    return registerTool(
      name,
      {
        ...config,
        description,
        inputSchema,
        annotations: {
          ...config.annotations,
          ...(config.annotations?.readOnlyHint !== true ? { destructiveHint: true } : {}),
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (...args: any[]) => {
        try {
          let input = args[0];
          if (input && typeof input === "object") {
            const forced = MUSE_FORCED_INPUT_VALUES[name];
            if (forced) {
              input = { ...input, ...forced };
            }
          }
          const res = await handler(input, ...args.slice(1));
          return museToolResult(res);
        } catch {
          return museToolResult({
            isError: true,
            _meta: { "io.frihet/operationOutcomeUnknown": true },
          });
        }
      },
    );
  };

  // Meta Muse profile intentionally registers 0 raw prompts or dynamic resources
  server.registerResource = () => undefined;
  server.registerPrompt = () => undefined;
}
