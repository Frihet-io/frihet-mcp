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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  applyOpenAIProfile,
  applyOpenAIReviewProfiles,
  OPENAI_REVIEW_BUSINESS_CONTEXT_TOP_CLIENTS_MAX,
  OPENAI_REVIEW_DOCUMENT_LINE_ITEM_MAX,
  OPENAI_REVIEW_FREE_TEXT_WARNING,
  OPENAI_REVIEW_FREE_TEXT_WARNING_PATHS,
  OPENAI_REVIEW_LIST_LIMIT_MAX,
  OPENAI_REVIEW_LIST_OUTPUT_FIELDS,
  OPENAI_REVIEW_OFFSET_MAX,
  OPENAI_REVIEW_PAGINATION_DEFAULT,
  OPENAI_REVIEW_PAGINATION_LIMITS,
  OPENAI_REVIEW_CONFIRM_REQUIRED_TOOLS,
  OPENAI_WORKSPACE_WEBHOOK_EVENT_TOOLS,
} from "../openai-profile.js";
import { FrihetApiError } from "../client.js";
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
  _meta?: Record<string, unknown>;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
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
          taxIdNormalized: "B12345678",
          searchTokens: ["openai", "test@example.com", "B12345678"],
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
  registerAllResources(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer);
  registerAllPrompts(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer);
  return server;
}

function inputShape(tool: RegisteredTool): Record<string, unknown> {
  const schema = tool.config.inputSchema;
  return schema instanceof z.ZodObject
    ? schema.shape as Record<string, unknown>
    : schema ?? {};
}

describe("OpenAI profile", () => {
  test("exposes exactly the reviewed 33-tool business surface", () => {
    const server = makeOpenAIServer();

    assert.equal(server.tools.size, 33);
    assert.equal(server.prompts.length, 0);
    assert.equal(server.resources.length, 0);

    for (const hiddenTool of [
      "get_quarterly_taxes",
      "get_invoice_einvoice",
      "get_invoice_pdf",
      "apply_late_fee",
      "list_webhooks",
      "get_webhook",
      "create_webhook",
      "update_webhook",
      "delete_webhook",
      "update_invoice",
      "mark_invoice_paid",
      "delete_invoice",
      "send_invoice",
      "duplicate_invoice",
      "create_credit_note",
      "delete_client",
      "delete_expense",
      "send_quote",
      "update_quote",
      "delete_product",
      "get_monthly_summary",
      "delete_vendor",
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

  test("marks exactly the reviewed external-effect tools open-world", () => {
    const server = makeOpenAIServer();
    const openWorldTools = [...server.tools.values()]
      .filter((tool) => tool.config.annotations?.["openWorldHint"] === true)
      .map((tool) => tool.name)
      .sort();

    assert.deepEqual(openWorldTools, [...OPENAI_WORKSPACE_WEBHOOK_EVENT_TOOLS].sort());
  });

  test("removes restricted input fields from OpenAI-visible schemas", () => {
    const server = makeOpenAIServer();

    for (const name of ["create_client", "update_client", "create_vendor", "update_vendor"]) {
      const tool = server.tools.get(name);
      assert.ok(tool, `${name} should be visible`);
      assert.equal("taxId" in inputShape(tool), false);
      assert.equal("address" in inputShape(tool), false);
    }

    for (const name of ["create_invoice", "create_quote"]) {
      const tool = server.tools.get(name);
      assert.ok(tool, `${name} should be visible`);
      assert.equal("clientTaxId" in inputShape(tool), false);
      assert.equal("clientAddress" in inputShape(tool), false);
      assert.equal("clientLocation" in inputShape(tool), false);
    }
    assert.equal("paidDate" in inputShape(server.tools.get("create_expense")!), false);
    assert.equal("vendor" in inputShape(server.tools.get("update_expense")!), false);
    assert.equal("amount" in inputShape(server.tools.get("update_expense")!), false);
    const expenseShape = inputShape(server.tools.get("create_expense")!);
    for (const field of ["date", "taxDeductible"]) {
      const fieldSchema = expenseShape[field] as z.ZodTypeAny;
      assert.ok(fieldSchema, `${field} must remain visible`);
      assert.equal(fieldSchema.safeParse(undefined).success, false, `${field} must be required`);
    }

    const createInvoice = server.tools.get("create_invoice")!;
    for (const field of [
      "clientId", "clientTaxId", "clientAddress", "clientLocation", "status",
      "irpfRate", "equivalenceSurchargeRate", "prepayment", "seriesId",
      "documentNumber", "poNumber", "operationType",
    ]) {
      assert.equal(field in inputShape(createInvoice), false, `${field} must be hidden`);
    }

    for (const name of [
      "list_invoices",
      "search_invoices",
      "list_expenses",
      "list_clients",
      "list_products",
      "list_quotes",
      "list_vendors",
    ]) {
      const tool = server.tools.get(name);
      assert.ok(tool, `${name} should be visible`);
      assert.equal("fields" in inputShape(tool), false);
    }
    for (const name of ["list_clients", "list_vendors"]) {
      assert.equal(
        "q" in inputShape(server.tools.get(name)!),
        false,
        `${name}.q must not expose backend tax-ID search`,
      );
    }
  });

  test("reviewed client and vendor lists strip free-text search before the API call", async () => {
    const captured: Record<string, Record<string, unknown>> = {};
    const client = new Proxy({}, {
      get: (_target, property) => async (params: Record<string, unknown>) => {
        captured[String(property)] = params;
        return { data: [], total: 0, limit: 20, offset: 0 };
      },
    }) as IFrihetClient;
    const server = new StubMcpServer();
    applyOpenAIProfile(server);
    registerAllTools(
      server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      client,
    );

    const governmentIdentifierProbe = "ESB12345678";
    assert.notEqual(
      (await server.tools.get("list_clients")!.handler({
        q: governmentIdentifierProbe,
      })).isError,
      true,
    );
    assert.notEqual(
      (await server.tools.get("list_vendors")!.handler({
        q: governmentIdentifierProbe,
      })).isError,
      true,
    );
    assert.equal(captured.listClients?.q, undefined);
    assert.equal(captured.listVendors?.q, undefined);
  });

  test("rejects invalid or empty reviewed writes before the ERP client is called", async () => {
    let calls = 0;
    const client = new Proxy({}, {
      get: () => async () => {
        calls += 1;
        return { id: "unexpected" };
      },
    }) as IFrihetClient;
    const server = new StubMcpServer();
    applyOpenAIProfile(server);
    registerAllTools(
      server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      client,
    );

    const invalid: Array<[string, Record<string, unknown>]> = [
      ["create_invoice", { clientName: "   ", items: [{ description: "Service", quantity: 1, unitPrice: 10 }], confirm: true }],
      ["create_invoice", { clientName: "Acme", items: [{ description: "   ", quantity: 1, unitPrice: 10 }], confirm: true }],
      ["create_invoice", { clientName: "Acme", items: [{ description: "Service", quantity: 0, unitPrice: 10 }], confirm: true }],
      ["create_invoice", { clientName: "Acme", items: [{ description: "Service", quantity: 1, unitPrice: 10 }], issueDate: "2026-02-29", confirm: true }],
      ["create_invoice", { clientName: "Acme", items: [{ description: "Service", quantity: 1, unitPrice: 10 }], dueDate: "2026-04-31", confirm: true }],
      ["create_invoice", { clientName: "Acme", items: [{ description: "Service", quantity: 1, unitPrice: 10 }], notes: "x".repeat(10_001), confirm: true }],
      ["create_invoice", { clientName: "Acme", items: Array.from({ length: OPENAI_REVIEW_DOCUMENT_LINE_ITEM_MAX + 1 }, () => ({ description: "Service", quantity: 1, unitPrice: 10 })), confirm: true }],
      ["create_quote", { clientName: "Acme", items: [{ description: "Service", quantity: 1, unitPrice: -1 }], confirm: true }],
      ["create_quote", { clientName: "Acme", items: [{ description: "Service", quantity: 1, unitPrice: 10 }], validUntil: "2026-02-29", confirm: true }],
      ["create_quote", { clientName: "Acme", items: [{ description: "Service", quantity: 1, unitPrice: 10 }], notes: "x".repeat(10_001), confirm: true }],
      ["create_quote", { clientName: "Acme", items: Array.from({ length: OPENAI_REVIEW_DOCUMENT_LINE_ITEM_MAX + 1 }, () => ({ description: "Service", quantity: 1, unitPrice: 10 })), confirm: true }],
      ["create_expense", { description: "Supplies", amount: 10, date: "2026-08-28", taxDeductible: true, category: "x".repeat(101), confirm: true }],
      ["update_expense", { id: "exp_1", description: "x".repeat(1_001), confirm: true }],
      ["update_expense", { id: "exp_1", category: "x".repeat(101), confirm: true }],
      ["create_expense", { description: "Supplies", amount: 0, date: "2026-08-28", taxDeductible: true, confirm: true }],
      ["create_expense", { description: "Supplies", amount: 10, date: "2026-02-29", taxDeductible: true, confirm: true }],
      ["create_product", { name: "   ", unitPrice: 10, confirm: true }],
      ["create_product", { name: "Service", unitPrice: -1, confirm: true }],
      ["create_client", { name: "   ", confirm: true }],
      ["create_client", { name: "Acme", email: "not-an-email", confirm: true }],
      ["create_vendor", { name: "   ", confirm: true }],
      ["create_client_contact", { clientId: "c1", name: "   ", confirm: true }],
      ["log_client_activity", { clientId: "c1", type: "call", title: "   ", confirm: true }],
      ["create_client_note", { clientId: "c1", content: "   ", confirm: true }],
      ["update_expense", { id: "e1", amount: 99, confirm: true }],
      ["update_expense", { id: "e1", date: "2026-04-31", confirm: true }],
      ["update_client", { id: "c1", taxId: "B12345678", confirm: true }],
    ];

    for (const [name, input] of invalid) {
      const result = await server.tools.get(name)!.handler(input);
      assert.equal(result.isError, true, `${name} accepted invalid reviewed input`);
      assert.equal(calls, 0, `${name} reached the ERP client`);
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
    // Open-world creation keeps its bespoke true rationale (not double-appended).
    const createInvoiceDesc = server.tools.get("create_invoice")!.config.description;
    assert.match(createInvoiceDesc, /openWorldHint: true/);
    assert.match(createInvoiceDesc, /PostHog's EU-hosted analytics service/);
    assert.match(createInvoiceDesc, /Novu/);
    assert.doesNotMatch(createInvoiceDesc, /openWorldHint: false/);
  });

  test("every reviewed free-text path carries the model-facing sensitive-data warning", () => {
    const server = makeOpenAIServer();

    for (const [name, paths] of Object.entries(OPENAI_REVIEW_FREE_TEXT_WARNING_PATHS)) {
      for (const path of paths) {
        let shape = inputShape(server.tools.get(name)!);
        let fieldSchema: z.ZodTypeAny | undefined;
        for (const rawSegment of path.split(".")) {
          const isArray = rawSegment.endsWith("[]");
          const segment = isArray ? rawSegment.slice(0, -2) : rawSegment;
          fieldSchema = shape[segment] as z.ZodTypeAny | undefined;
          assert.ok(fieldSchema, `${name}.${path} must exist`);
          if (isArray) {
            assert.ok(fieldSchema instanceof z.ZodArray, `${name}.${path} must traverse an array`);
            assert.ok(fieldSchema.element instanceof z.ZodObject, `${name}.${path} array items must be objects`);
            shape = fieldSchema.element.shape as Record<string, unknown>;
          }
        }
        assert.match(
          fieldSchema?.description ?? "",
          new RegExp(OPENAI_REVIEW_FREE_TEXT_WARNING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          `${name}.${path} lost its warning`,
        );
      }
    }
  });

  test("reviewed intelligence tools expose concrete output properties", () => {
    const server = makeOpenAIServer();
    const expectedProperties: Record<string, string[]> = {
      get_business_context: ["business", "defaults", "plan", "recentActivity", "currentMonth"],
      create_invoice: ["id", "clientName", "items", "invoiceNumber", "status", "externalEffects"],
    };

    for (const [name, expected] of Object.entries(expectedProperties)) {
      const tool = server.tools.get(name);
      assert.ok(tool, `${name} should be visible`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shape = (tool.config.outputSchema as any)?.shape as Record<string, unknown> | undefined;
      assert.ok(shape, `${name} should expose an object output schema`);
      for (const property of expected) {
        assert.ok(property in shape, `${name} should declare output property "${property}"`);
      }
    }

  });

  test("reviewed create and quote-delete outputs expose exact successful invariants", () => {
    const server = makeOpenAIServer();

    const deleteQuoteInput = inputShape(server.tools.get("delete_quote")!);
    const deleteQuoteConfirm = deleteQuoteInput.confirm as z.ZodTypeAny;
    assert.match(deleteQuoteConfirm.description ?? "", /clean draft/i);
    assert.match(deleteQuoteConfirm.description ?? "", /protected draft is refused/i);
    assert.match(deleteQuoteConfirm.description ?? "", /retain and cancel/i);
    assert.match(deleteQuoteConfirm.description ?? "", /webhooks/i);

    const createExpenseConfirm = inputShape(
      server.tools.get("create_expense")!,
    ).confirm as z.ZodTypeAny;
    assert.match(createExpenseConfirm.description ?? "", /separate step/i);
    assert.match(createExpenseConfirm.description ?? "", /may persist/i);
    assert.match(createExpenseConfirm.description ?? "", /expense write fails/i);

    for (const [name, numberField] of [
      ["create_invoice", "invoiceNumber"],
      ["create_quote", "quoteNumber"],
    ] as const) {
      const schema = server.tools.get(name)!.config.outputSchema as z.ZodTypeAny;
      const guaranteed = name === "create_invoice"
        ? {
            clientId: "client_1",
            clientName: "Acme",
            items: [{ description: "Service", quantity: 1, unitPrice: 10 }],
            issueDate: "2026-08-28",
            dueDate: "2026-09-27",
          }
        : {
            clientId: "client_1",
            clientName: "Acme",
            items: [{ description: "Service", quantity: 1, unitPrice: 10 }],
            issueDate: "2026-08-28",
          };
      const valid = {
        id: `${name}_1`,
        [numberField]: "2026-0001",
        status: "draft",
        externalEffects: [],
        ...guaranteed,
      };
      assert.equal(schema.safeParse(valid).success, true);
      assert.equal(schema.safeParse({
        ...valid,
        [numberField]: undefined,
      }).success, false, `${name} accepted a missing reserved document number`);
      assert.equal(schema.safeParse({
        ...valid,
        status: "sent",
      }).success, false, `${name} accepted a non-draft reviewed result`);
      for (const field of Object.keys(guaranteed)) {
        assert.equal(schema.safeParse({ ...valid, [field]: undefined }).success, false,
          `${name} accepted missing guaranteed field ${field}`);
      }
      assert.equal(
        "total" in (schema as z.ZodObject).shape,
        false,
        `${name} declared the impossible create total field`,
      );
    }

    const createClient = server.tools.get("create_client")!.config.outputSchema as z.ZodObject;
    assert.equal("stage" in createClient.shape, false);
    const createProduct = server.tools.get("create_product")!.config.outputSchema as z.ZodObject;
    assert.equal("isActive" in createProduct.shape, false);
    const createExpense = server.tools.get("create_expense")!.config.outputSchema as z.ZodObject;
    const expenseResult = {
      id: "expense_1",
      description: "Supplies",
      amount: 10,
      date: "2026-08-28",
      taxDeductible: true,
      externalEffects: [],
    };
    assert.equal(createExpense.safeParse(expenseResult).success, true);
    assert.equal(createExpense.safeParse({ ...expenseResult, date: undefined }).success, false);
    assert.equal(createExpense.safeParse({ ...expenseResult, taxDeductible: undefined }).success, false);
    assert.equal("paidDate" in createExpense.shape, false);

    const deleteQuote = server.tools.get("delete_quote")!.config.outputSchema as z.ZodTypeAny;
    assert.equal(deleteQuote.safeParse({
      success: true,
      id: "quote_draft",
      result: { outcome: "deleted" },
    }).success, true);
    assert.equal(deleteQuote.safeParse({
      success: true,
      id: "quote_sent",
      result: {
        outcome: "cancelled",
        status: "cancelled",
        previousStatus: null,
        externalEffects: [],
      },
    }).success, true);
    assert.equal(deleteQuote.safeParse({
      success: true,
      id: "quote_unknown",
      result: {},
    }).success, false, "delete_quote accepted a missing outcome");
    assert.equal(deleteQuote.safeParse({
      success: true,
      id: "quote_sent",
      result: { outcome: "cancelled", status: "sent", externalEffects: [] },
    }).success, false, "delete_quote accepted an impossible post-cancel status");
    assert.equal(deleteQuote.safeParse({
      success: true,
      id: "quote_draft",
      result: { outcome: "deleted", status: "cancelled" },
    }).success, false, "delete_quote accepted cancellation fields for a deleted row");
    assert.equal(deleteQuote.safeParse({
      success: true,
      id: "quote_draft",
      result: { outcome: "deleted", externalEffects: [] },
    }).success, false, "delete_quote advertised a webhook effect for hard deletion");
    assert.equal(deleteQuote.safeParse({
      success: true,
      id: "quote_sent",
      result: { outcome: "cancelled", externalEffects: [] },
    }).success, false, "delete_quote accepted cancellation without status=cancelled");

    for (const name of ["get_invoice", "create_invoice", "get_quote", "create_quote"]) {
      const output = server.tools.get(name)!.config.outputSchema as z.ZodObject;
      const items = output.shape.items as z.ZodOptional<z.ZodArray<z.ZodObject>> | z.ZodArray<z.ZodObject>;
      const itemArray = items instanceof z.ZodOptional ? items.unwrap() : items;
      assert.equal("id" in itemArray.element.shape, false, `${name} exposed an unusable line-item id`);
      const row = { description: "Service", quantity: 1, unitPrice: 10 };
      assert.equal(
        itemArray.safeParse(Array.from({ length: OPENAI_REVIEW_DOCUMENT_LINE_ITEM_MAX }, () => row)).success,
        true,
      );
      assert.equal(
        itemArray.safeParse(Array.from({ length: OPENAI_REVIEW_DOCUMENT_LINE_ITEM_MAX + 1 }, () => row)).success,
        false,
        `${name} accepted an oversized reviewed line-item output`,
      );
    }

    for (const name of ["create_invoice", "create_quote"]) {
      const inputItems = inputShape(server.tools.get(name)!).items as z.ZodArray<z.ZodObject>;
      const row = { description: "Service", quantity: 1, unitPrice: 10 };
      assert.equal(
        inputItems.safeParse(Array.from({ length: OPENAI_REVIEW_DOCUMENT_LINE_ITEM_MAX }, () => row)).success,
        true,
      );
      assert.equal(
        inputItems.safeParse(Array.from({ length: OPENAI_REVIEW_DOCUMENT_LINE_ITEM_MAX + 1 }, () => row)).success,
        false,
        `${name} accepted an oversized reviewed line-item input`,
      );
    }

    const topClients = (
      server.tools.get("get_business_context")!.config.outputSchema as z.ZodObject
    ).shape.topClients as z.ZodArray<z.ZodObject>;
    const topClient = { name: "Acme", totalRevenue: 100, invoiceCount: 1 };
    assert.equal(
      topClients.safeParse(Array.from({ length: OPENAI_REVIEW_BUSINESS_CONTEXT_TOP_CLIENTS_MAX }, () => topClient)).success,
      true,
    );
    assert.equal(
      topClients.safeParse(Array.from({ length: OPENAI_REVIEW_BUSINESS_CONTEXT_TOP_CLIENTS_MAX + 1 }, () => topClient)).success,
      false,
      "get_business_context accepted more than five top clients",
    );
  });

  test("reviewed lists expose only summary fields and cap each page", () => {
    const server = makeOpenAIServer();
    for (const [name, expectedFields] of Object.entries(
      OPENAI_REVIEW_LIST_OUTPUT_FIELDS,
    )) {
      const tool = server.tools.get(name)!;
      const input = inputShape(tool);
      const limit = input.limit as z.ZodTypeAny;
      assert.equal(limit.safeParse(OPENAI_REVIEW_LIST_LIMIT_MAX).success, true);
      assert.equal(limit.safeParse(OPENAI_REVIEW_LIST_LIMIT_MAX + 1).success, false);

      const output = tool.config.outputSchema as z.ZodObject;
      const data = output.shape.data as z.ZodArray<z.ZodObject>;
      assert.deepEqual(
        Object.keys(data.element.shape).sort(),
        [...expectedFields].sort(),
        name,
      );
    }
  });

  test("every reviewed paginated tool caps limit, offset, and omitted-limit defaults", async () => {
    const server = makeOpenAIServer();
    for (const [name, maximum] of Object.entries(OPENAI_REVIEW_PAGINATION_LIMITS)) {
      const input = inputShape(server.tools.get(name)!);
      const limit = input.limit as z.ZodTypeAny;
      const offset = input.offset as z.ZodTypeAny;
      assert.equal(limit.safeParse(maximum).success, true, name);
      assert.equal(limit.safeParse(maximum + 1).success, false, name);
      assert.equal(offset.safeParse(OPENAI_REVIEW_OFFSET_MAX).success, true, name);
      assert.equal(offset.safeParse(OPENAI_REVIEW_OFFSET_MAX + 1).success, false, name);
    }

    let returnedRows = OPENAI_REVIEW_PAGINATION_DEFAULT;
    let capturedLimit: number | undefined;
    const apiClient = new Proxy({}, {
      get: (_target, property) => async (_clientId: string, params: { limit?: number }) => {
        if (property === "listClientNotes") {
          capturedLimit = params.limit;
          return {
            data: Array.from({ length: returnedRows }, (_, index) => ({
              id: `note_${index}`,
              content: `Note ${index}`,
            })),
            total: returnedRows,
            limit: params.limit ?? 50,
            offset: 0,
          };
        }
        return { data: [], total: 0, limit: 20, offset: 0 };
      },
    }) as IFrihetClient;
    const runtimeServer = new StubMcpServer();
    applyOpenAIProfile(runtimeServer);
    registerAllTools(
      runtimeServer as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      apiClient,
    );
    const handler = runtimeServer.tools.get("list_client_notes")!.handler;
    const normal = await handler({ clientId: "client_1" });
    assert.notEqual(normal.isError, true);
    assert.equal(capturedLimit, OPENAI_REVIEW_PAGINATION_DEFAULT);

    returnedRows = OPENAI_REVIEW_PAGINATION_DEFAULT + 1;
    const oversized = await handler({ clientId: "client_1" });
    assert.equal(oversized.isError, true, "backend row overflow must fail closed");
    assert.match(oversized.content[0]!.text, /reviewed output contract/i);
  });

  test("reviewed list runtime removes detail fields and does not duplicate rows in text", async () => {
    const client = new Proxy({}, {
      get: (_target, prop) => async () => {
        if (prop === "listInvoices") {
          return {
            data: [{
              id: "inv_summary",
              documentNumber: "INV-2026-0099",
              clientName: "Summary Client",
              status: "draft",
              total: 25,
              items: [{ description: "private line item", quantity: 1, unitPrice: 25 }],
              notes: "private invoice note",
            }],
            total: 1,
            limit: 50,
            offset: 0,
          };
        }
        return { data: [], total: 0, limit: 10, offset: 0 };
      },
    }) as IFrihetClient;
    const server = new StubMcpServer();
    applyOpenAIProfile(server);
    registerAllTools(
      server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      client,
    );

    const result = await server.tools.get("list_invoices")!.handler({ limit: 50 });
    const row = (result.structuredContent!.data as Record<string, unknown>[])[0]!;
    assert.equal(row.invoiceNumber, "INV-2026-0099");
    assert.equal("items" in row, false);
    assert.equal("notes" in row, false);
    assert.doesNotMatch(result.content[0]!.text, /Summary Client|private line item|private invoice note/);
    assert.match(result.content[0]!.text, /1 reviewed summary record/);
  });

  test("redacts restricted output fields from structured content and text", async () => {
    const server = makeOpenAIServer();
    const tool = server.tools.get("create_client");
    assert.ok(tool, "create_client should be visible");

    const result = await tool.handler({ name: "OpenAI Test Corp", confirm: true });
    const serialized = JSON.stringify(result);

    assert.equal(serialized.includes("taxId"), false);
    assert.equal(serialized.includes("B12345678"), false);
    assert.equal(serialized.includes("secret"), false);
    assert.equal(serialized.includes("should-not-leak"), false);
  });

  test("removes impossible demo metadata from reviewed CRM activity outputs", async () => {
    const activity = {
      id: "activity_1",
      type: "call",
      title: "Follow-up",
      timestamp: "2026-08-28T09:00:00.000Z",
      createdBy: "user",
      _demo: true,
      _demoNotice: "Simulated — not persisted",
    };
    const apiClient = new Proxy({}, {
      get: (_target, property) => async () => {
        if (property === "listClientActivities") {
          return { data: [structuredClone(activity)], total: 1, limit: 20, offset: 0 };
        }
        if (property === "logClientActivity") return structuredClone(activity);
        return { data: [], total: 0, limit: 20, offset: 0 };
      },
    }) as IFrihetClient;
    const server = new StubMcpServer();
    applyOpenAIProfile(server);
    registerAllTools(
      server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      apiClient,
    );

    const results = [
      await server.tools.get("list_client_activities")!.handler({ clientId: "client_1" }),
      await server.tools.get("log_client_activity")!.handler({
        clientId: "client_1",
        type: "call",
        title: "Follow-up",
        confirm: true,
      }),
    ];
    for (const result of results) {
      assert.notEqual(result.isError, true);
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes("_demo"), false);
      assert.equal(serialized.includes("Simulated — not persisted"), false);
      assert.equal(serialized.includes("createdBy"), false);
      assert.equal(serialized.includes("activity_1"), false);
    }
  });

  test("projects raw invoice, client, and vendor records onto closed reviewed outputs", async () => {
    const restrictedInvoice = {
      id: "inv_projection",
      clientName: "Projection Client",
      status: "draft",
      publicHash: "public-capability-link",
      paymentUrl: "https://payments.example/secret-link",
      paymentDetails: { paymentIntentId: "pi_secret" },
      bankTransactionId: "bank_tx_secret",
      bankIncomeAuthority: { source: "bank-feed" },
      verifactu: { hash: "fiscal-hash", previousHash: "previous-fiscal-hash" },
      verifactuAnulacion: { status: "submitted" },
      verifactuSubmission: { csv: "CSV-SECRET", lastError: "raw filing error" },
      undeclaredFutureBackendField: "future-secret",
    };
    const restrictedParty = {
      id: "party_projection",
      name: "Projection Party",
      email: "projection@example.com",
      taxIdNormalized: "B76543210",
      searchTokens: ["projection", "B76543210", "projection@example.com"],
      address: { street: "Restricted street", postalCode: "38000" },
      undeclaredFutureBackendField: "future-party-secret",
    };
    const apiClient = new Proxy({}, {
      get: (_target, property) => async () => {
        if (property === "getInvoice") return structuredClone(restrictedInvoice);
        if (property === "listInvoices" || property === "searchInvoices") {
          return { data: [structuredClone(restrictedInvoice)], total: 1, limit: 20, offset: 0 };
        }
        if (property === "getClient" || property === "getVendor") {
          return structuredClone(restrictedParty);
        }
        if (property === "listClients" || property === "listVendors") {
          return { data: [structuredClone(restrictedParty)], total: 1, limit: 20, offset: 0 };
        }
        return { data: [], total: 0, limit: 20, offset: 0 };
      },
    }) as IFrihetClient;
    const server = new StubMcpServer();
    applyOpenAIProfile(server);
    registerAllTools(
      server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      apiClient,
    );

    const calls: Array<[string, Record<string, unknown>]> = [
      ["get_invoice", { id: "projection" }],
      ["list_invoices", {}],
      ["search_invoices", { query: "projection" }],
      ["get_client", { id: "projection" }],
      ["list_clients", {}],
      ["get_vendor", { id: "projection" }],
      ["list_vendors", {}],
    ];
    for (const [name, input] of calls) {
      const result = await server.tools.get(name)!.handler(input);
      assert.notEqual(result.isError, true, `${name} should return its safe projection`);
      const serialized = JSON.stringify(result);
      for (const forbidden of [
        "taxIdNormalized",
        "B76543210",
        "searchTokens",
        "Restricted street",
        "publicHash",
        "public-capability-link",
        "paymentUrl",
        "pi_secret",
        "bankTransactionId",
        "verifactu",
        "fiscal-hash",
        "CSV-SECRET",
        "undeclaredFutureBackendField",
        "future-secret",
      ]) {
        assert.equal(serialized.includes(forbidden), false, `${name} leaked ${forbidden}`);
      }
    }
  });

  test("every reviewed confirmed write fails closed in the wrapper", async () => {
    const server = makeOpenAIServer();
    const expected = [...OPENAI_REVIEW_CONFIRM_REQUIRED_TOOLS].sort();
    const declared = [...server.tools.values()]
      .filter((tool) => {
        const schema = tool.config.inputSchema;
        const shape = schema instanceof z.ZodObject ? schema.shape : schema ?? {};
        return "confirm" in shape;
      })
      .map((tool) => tool.name)
      .sort();
    assert.deepEqual(declared, expected);

    for (const name of expected) {
      const result = await server.tools.get(name)!.handler({ id: "test_1", confirm: false });
      assert.equal(result.isError, true, `${name} accepted confirm=false`);
      assert.match(result.content[0]!.text, /confirm=true/i);
    }
  });

  test("create_invoice forces draft status behind the reviewed schema", async () => {
    const calls: unknown[][] = [];
    const client = new Proxy({}, {
      get: (_target, prop) => async (...args: unknown[]) => {
        if (prop === "createInvoice") {
          calls.push(args);
          return {
            id: "inv_draft",
            documentNumber: "INV-2026-0001",
            status: "draft",
            clientId: "client_1",
            clientName: "Acme",
            items: [],
            issueDate: "2026-08-28",
            dueDate: "2026-09-27",
          };
        }
        return { data: [], total: 0, limit: 10, offset: 0 };
      },
    }) as IFrihetClient;
    const server = new StubMcpServer();
    applyOpenAIProfile(server);
    registerAllTools(
      server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      client,
    );

    const result = await server.tools.get("create_invoice")!.handler({
      clientName: "Acme",
      items: [{ description: "Service", quantity: 1, unitPrice: 100 }],
      status: "sent",
      clientTaxId: "B12345678",
      confirm: true,
    });
    assert.notEqual(result.isError, true);
    assert.equal(calls.length, 1);
    assert.equal((calls[0]![0] as Record<string, unknown>).status, "draft");
    assert.equal("clientTaxId" in (calls[0]![0] as Record<string, unknown>), false);
    assert.equal("confirm" in (calls[0]![0] as Record<string, unknown>), false);
  });

  test("reviewed document writes reject unknown nested line-item fields", async () => {
    const calls: string[] = [];
    const client = new Proxy({}, {
      get: (_target, prop) => async () => {
        calls.push(String(prop));
        return { id: "unexpected_write" };
      },
    }) as IFrihetClient;
    const server = new StubMcpServer();
    applyOpenAIProfile(server);
    registerAllTools(
      server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      client,
    );

    for (const name of ["create_invoice", "create_quote"]) {
      const result = await server.tools.get(name)!.handler({
        clientName: "Acme",
        items: [{
          description: "Service",
          quantity: 1,
          unitPrice: 100,
          undeclaredFutureField: "must-not-pass",
        }],
        confirm: true,
      });
      assert.equal(result.isError, true, `${name} accepted an undeclared line-item field`);
      assert.equal(calls.length, 0, `${name} reached the backend with invalid nested input`);
    }
  });

  test("create_expense fails closed unless date and deductibility are explicit", async () => {
    let writes = 0;
    let captured: Record<string, unknown> | undefined;
    const client = new Proxy({}, {
      get: (_target, prop) => async (input: Record<string, unknown>) => {
        if (prop === "createExpense") {
          writes += 1;
          captured = input;
          return {
            id: "exp_explicit",
            description: "Supplies",
            amount: 25,
            date: input.date,
            taxDeductible: input.taxDeductible,
          };
        }
        return { data: [], total: 0, limit: 10, offset: 0 };
      },
    }) as IFrihetClient;
    const server = new StubMcpServer();
    applyOpenAIProfile(server);
    registerAllTools(
      server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      client,
    );
    const handler = server.tools.get("create_expense")!.handler;

    for (const input of [
      { description: "Supplies", amount: 25, confirm: true },
      { description: "Supplies", amount: 25, date: "2026-08-28", confirm: true },
      { description: "Supplies", amount: 25, taxDeductible: false, confirm: true },
    ]) {
      const result = await handler(input);
      assert.equal(result.isError, true);
      assert.equal(writes, 0);
    }

    const accepted = await handler({
      description: "Supplies",
      amount: 25,
      date: "2026-08-28",
      taxDeductible: false,
      confirm: true,
    });
    assert.notEqual(accepted.isError, true);
    assert.equal(writes, 1);
    assert.equal(captured?.date, "2026-08-28");
    assert.equal(captured?.taxDeductible, false);
  });

  test("update_expense cannot change amount or supplier identity and strips both before the ERP call", async () => {
    let capturedId: string | undefined;
    let capturedData: Record<string, unknown> | undefined;
    const client = new Proxy({}, {
      get: (_target, prop) => async (...args: unknown[]) => {
        if (prop === "updateExpense") {
          capturedId = args[0] as string;
          capturedData = args[1] as Record<string, unknown>;
          return { id: capturedId, description: "Supplies", amount: 25 };
        }
        return { data: [], total: 0, limit: 10, offset: 0 };
      },
    }) as IFrihetClient;
    const server = new StubMcpServer();
    applyOpenAIProfile(server);
    registerAllTools(
      server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      client,
    );

    const result = await server.tools.get("update_expense")!.handler({
      id: "exp_supplier_guard",
      vendor: "Different Supplier",
      amount: 999,
      date: "2026-08-28",
      taxDeductible: false,
      confirm: true,
    });

    assert.notEqual(result.isError, true);
    assert.equal(capturedId, "exp_supplier_guard");
    assert.equal(capturedData?.vendor, undefined);
    assert.equal(capturedData?.amount, undefined);
    assert.equal(capturedData?.date, "2026-08-28");
    assert.equal(capturedData?.taxDeductible, false);
    assert.equal(capturedData?.confirm, undefined);
  });

  test("runtime output discloses numbering, implicit records, usage, analytics, notifications, and referrals", async () => {
    const client = new Proxy({}, {
      get: (_target, prop) => async () => {
        if (prop === "createQuote") {
          return {
            id: "quo_effects",
            documentNumber: "QUO-2026-0001",
            status: "draft",
            clientId: "client_1",
            clientName: "Acme",
            items: [],
            issueDate: "2026-08-28",
          };
        }
        if (prop === "createInvoice") {
          return {
            id: "inv_effects",
            documentNumber: "INV-2026-0002",
            status: "draft",
            clientId: "client_1",
            clientName: "Acme",
            items: [],
            issueDate: "2026-08-28",
            dueDate: "2026-09-27",
          };
        }
        if (prop === "createExpense") {
          return {
            id: "exp_effects",
            description: "Supplies",
            amount: 25,
            date: "2026-08-28",
            taxDeductible: false,
            vendor: "Vendor",
          };
        }
        if (prop === "logClientActivity") {
          return { id: "act_effects", type: "call", title: "Follow-up", timestamp: "2026-08-28T00:00:00Z" };
        }
        return { data: [], total: 0, limit: 10, offset: 0 };
      },
    }) as IFrihetClient;
    const server = new StubMcpServer();
    applyOpenAIProfile(server);
    registerAllTools(
      server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      client,
    );

    const created = await server.tools.get("create_quote")!.handler({
      clientName: "Acme",
      items: [{ description: "Service", quantity: 1, unitPrice: 100 }],
      confirm: true,
    });
    const createText = JSON.stringify(created);
    assert.match(createText, /advanced the workspace numbering counter/);
    assert.match(createText, /created and linked a client record/);

    const invoice = await server.tools.get("create_invoice")!.handler({
      clientName: "Acme",
      items: [{ description: "Service", quantity: 1, unitPrice: 100 }],
      confirm: true,
    });
    const invoiceText = JSON.stringify(invoice);
    assert.match(invoiceText, /monthly invoice usage/);
    assert.match(invoiceText, /PostHog's EU-hosted analytics service/);
    assert.match(invoiceText, /Novu/);
    assert.match(invoiceText, /activation credits/);

    const expense = await server.tools.get("create_expense")!.handler({
      description: "Supplies",
      amount: 25,
      date: "2026-08-28",
      taxDeductible: false,
      confirm: true,
    });
    const expenseText = JSON.stringify(expense);
    assert.match(expenseText, /vendor record/);
    assert.match(expenseText, /Novu/);
    assert.match(expenseText, /activation credits/);

    const activity = await server.tools.get("log_client_activity")!.handler({
      clientId: "cli_effects",
      type: "call",
      title: "Follow-up",
      confirm: true,
    });
    const activityText = JSON.stringify(activity);
    assert.match(activityText, /full resulting client\.updated event/);
    assert.match(activityText, /task entries do not update the parent client/);

  });

  test("delete_quote wire result separates webhook-free deletion from cancellation effects", async () => {
    const client = new Proxy({}, {
      get: (_target, prop) => async (id: string) => {
        if (prop === "deleteQuote") {
          return id === "quote_sent"
            ? { status: "cancelled", previousStatus: "sent", cancelledVia: "soft_cancel" }
            : undefined;
        }
        return { data: [], total: 0, limit: 10, offset: 0 };
      },
    }) as IFrihetClient;
    const server = new StubMcpServer();
    applyOpenAIProfile(server);
    registerAllTools(
      server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      client,
    );

    const deleted = await server.tools.get("delete_quote")!.handler({
      id: "quote_draft",
      confirm: true,
    });
    assert.notEqual(deleted.isError, true);
    assert.deepEqual(deleted.structuredContent, {
      success: true,
      id: "quote_draft",
      result: { outcome: "deleted" },
    });

    const cancelled = await server.tools.get("delete_quote")!.handler({
      id: "quote_sent",
      confirm: true,
    });
    assert.notEqual(cancelled.isError, true);
    assert.deepEqual(cancelled.structuredContent, {
      success: true,
      id: "quote_sent",
      result: {
        outcome: "cancelled",
        status: "cancelled",
        previousStatus: "sent",
        externalEffects: [
          "One or more active webhook endpoints previously configured by the workspace owner may receive the full resulting quote.updated event.",
        ],
      },
    });
  });

  test("post-write output mismatch is explicit and marked non-retryable", async () => {
    let writes = 0;
    const client = new Proxy({}, {
      get: (_target, prop) => async () => {
        if (prop === "createVendor") {
          writes += 1;
          return { unexpected: "backend drift", id: "ven_drift" };
        }
        return { data: [], total: 0, limit: 10, offset: 0 };
      },
    }) as IFrihetClient;
    const server = new StubMcpServer();
    applyOpenAIProfile(server);
    registerAllTools(
      server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      client,
    );

    const result = await server.tools.get("create_vendor")!.handler({
      name: "Drift Supplier",
      confirm: true,
    }) as Awaited<ReturnType<ToolHandler>> & { _meta?: Record<string, unknown> };

    assert.equal(writes, 1);
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /may already have completed this write/i);
    assert.match(result.content[0]!.text, /ven_drift/);
    assert.match(result.content[0]!.text, /Do not retry automatically/i);
    assert.equal(result._meta?.["io.frihet/retryable"], false);
    assert.equal(result._meta?.["io.frihet/operationMayHaveCompleted"], true);
  });

  test("ambiguous write transport failure is explicit and never auto-retried", async () => {
    let writes = 0;
    const client = new Proxy({}, {
      get: (_target, prop) => async () => {
        if (prop === "createVendor") {
          writes += 1;
          throw new FrihetApiError(
            408,
            "request_timeout",
            "Request timed out after 25 seconds",
          );
        }
        return { data: [], total: 0, limit: 10, offset: 0 };
      },
    }) as IFrihetClient;
    const server = new StubMcpServer();
    applyOpenAIProfile(server);
    registerAllTools(
      server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      client,
    );

    const result = await server.tools.get("create_vendor")!.handler({
      name: "Ambiguous Supplier",
      confirm: true,
    });

    assert.equal(writes, 1);
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /may already have completed/i);
    assert.match(result.content[0]!.text, /Do not retry automatically/i);
    assert.match(result.content[0]!.text, /read or list tool/i);
    assert.equal(result._meta?.["io.frihet/transportOutcomeUnknown"], true);
    assert.equal(result._meta?.["io.frihet/retryable"], false);
    assert.equal(result._meta?.["io.frihet/operationMayHaveCompleted"], true);
  });

  test("create_expense ambiguity discloses that a separately created vendor may remain", async () => {
    const client = new Proxy({}, {
      get: (_target, prop) => async () => {
        if (prop === "createExpense") {
          throw new FrihetApiError(500, "internal_error", "Internal server error");
        }
        return { data: [], total: 0, limit: 10, offset: 0 };
      },
    }) as IFrihetClient;
    const server = new StubMcpServer();
    applyOpenAIProfile(server);
    registerAllTools(
      server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      client,
    );

    const result = await server.tools.get("create_expense")!.handler({
      description: "Supplies",
      amount: 25,
      date: "2026-08-28",
      vendor: "Supplier",
      taxDeductible: false,
      confirm: true,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /vendor created while handling this request may remain/i);
    assert.match(result.content[0]!.text, /expense itself was not created/i);
    assert.match(result.content[0]!.text, /Do not retry automatically/i);
  });

  test("ambiguous write server, body, and idempotency failures are never auto-retried", async () => {
    for (const error of [
      new FrihetApiError(500, "internal_error", "Internal server error"),
      new FrihetApiError(
        201,
        "invalid_response_after_success",
        "Unreadable success response",
      ),
      new FrihetApiError(
        409,
        "IDEMPOTENCY_REQUEST_IN_PROGRESS",
        "Original request outcome is unresolved",
      ),
    ]) {
      const client = new Proxy({}, {
        get: (_target, prop) => async () => {
          if (prop === "createVendor") throw error;
          return { data: [], total: 0, limit: 10, offset: 0 };
        },
      }) as IFrihetClient;
      const server = new StubMcpServer();
      applyOpenAIProfile(server);
      registerAllTools(
        server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
        client,
      );

      const result = await server.tools.get("create_vendor")!.handler({
        name: "Ambiguous Supplier",
        confirm: true,
      });

      assert.equal(result.isError, true, error.errorCode);
      assert.match(result.content[0]!.text, /may already have completed/i);
      assert.match(result.content[0]!.text, /Do not retry automatically/i);
      assert.equal(result._meta?.["io.frihet/retryable"], false);
      assert.equal(result._meta?.["io.frihet/operationMayHaveCompleted"], true);
    }
  });

  test("real MCP callTool validation and wrapper both fail closed on confirmation", async () => {
    let writes = 0;
    const registrationClient = new Proxy({}, {
      get: (_target, prop) => async (..._args: unknown[]) => {
        if (prop === "createVendor") {
          writes += 1;
          return { id: "ven_protocol", name: "Protocol Supplier" };
        }
        return { data: [], total: 0, limit: 10, offset: 0 };
      },
    }) as IFrihetClient;
    const server = new McpServer({ name: "openai-confirm-test", version: "1.0.0" });
    applyOpenAIReviewProfiles(server);
    registerAllTools(server, registrationClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const protocolClient = new Client(
      { name: "openai-confirm-client", version: "1.0.0" },
      { capabilities: {} },
    );

    try {
      await Promise.all([server.connect(serverTransport), protocolClient.connect(clientTransport)]);
      for (const args of [
        { name: "Protocol Supplier" },
        { name: "Protocol Supplier", confirm: false },
      ]) {
        try {
          const result = await protocolClient.callTool({ name: "create_vendor", arguments: args });
          assert.equal(result.isError, true);
        } catch (error) {
          assert.match(String(error), /confirm|validation|invalid/i);
        }
        assert.equal(writes, 0, "invalid confirmation must not reach the client");
      }

      const accepted = await protocolClient.callTool({
        name: "create_vendor",
        arguments: { name: "Protocol Supplier", confirm: true },
      });
      assert.notEqual(accepted.isError, true);
      assert.equal(writes, 1);
    } finally {
      await Promise.allSettled([protocolClient.close(), server.close()]);
    }
  });

  test("no reviewed tool DECLARES sensitive or internal fields in its outputSchema", () => {
    const server = makeOpenAIServer();

    // Recursively collect every object key declared by a Zod output schema.
    const collectKeys = (schema: unknown, acc: Set<string>): Set<string> => {
      if (schema instanceof z.ZodObject) {
        for (const [key, value] of Object.entries(schema.shape as Record<string, unknown>)) {
          acc.add(key);
          collectKeys(value, acc);
        }
      } else if (schema instanceof z.ZodArray) {
        collectKeys(schema.element, acc);
      } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
        collectKeys(schema.unwrap(), acc);
      }
      return acc;
    };

    for (const tool of server.tools.values()) {
      const out = tool.config.outputSchema;
      if (!out) continue;
      const keys = collectKeys(out, new Set<string>());
      for (const field of [
        ...SENSITIVE_FIELD_NAMES,
        "_demo",
        "_demoNotice",
        "createdAt",
        "updatedAt",
        "cancelledVia",
      ]) {
        assert.equal(
          keys.has(field),
          false,
          `${tool.name} outputSchema must not declare restricted field "${field}"`,
        );
      }
    }
  });

  test("every reviewed output object is closed against undeclared backend fields", () => {
    const server = makeOpenAIServer();

    const assertClosed = (schema: unknown, path: string): void => {
      if (schema instanceof z.ZodObject) {
        assert.equal(
          schema._def.catchall instanceof z.ZodUnknown,
          false,
          `${path} must not preserve passthrough output fields`,
        );
        for (const [key, value] of Object.entries(schema.shape as Record<string, unknown>)) {
          assertClosed(value, `${path}.${key}`);
        }
      } else if (schema instanceof z.ZodArray) {
        assertClosed(schema.element, `${path}[]`);
      } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
        assertClosed(schema.unwrap(), path);
      } else if (schema instanceof z.ZodUnion) {
        for (const [index, option] of schema.options.entries()) {
          assertClosed(option, `${path}|${index}`);
        }
      } else if (schema instanceof z.ZodRecord) {
        assertClosed(schema.valueType, `${path}{}`);
      }
    };

    for (const tool of server.tools.values()) {
      assertClosed(tool.config.outputSchema, tool.name);
    }
  });
});
