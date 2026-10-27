#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerMcpSurface,
  remoteMcpSurfaceComposition,
} from "../../../dist/server-composition.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");
const LITELLM_URL = process.env.LITELLM_URL || "http://127.0.0.1:4000/v1/chat/completions";
const MODEL = process.env.EVAL_MODEL || "minimax";

const descriptor = JSON.parse(
  readFileSync(
    join(REPO_ROOT, "src/__tests__/fixtures/openai-review-descriptor.snapshot.json"),
    "utf8",
  ),
);
const plugin102 = JSON.parse(
  readFileSync(join(REPO_ROOT, "marketplace/openai/plugin.json"), "utf8"),
);

// Reconstructed 1.0.1 longDescription from commit 7ed6a07 / aa5cca1 (33 tools, 0 skills):
const DESCRIPTION_101_RECONSTRUCTED =
  "Frihet lets ChatGPT work with the reviewed 33-operation Frihet business surface over OAuth. It can read workspace context, list and inspect invoices, quotes, expenses, clients, vendors, products, and client CRM records, and—after explicit confirmation—create invoice or quote drafts, record or update expenses, create or update clients, vendors, and products, manage client contacts and notes, log client activities, and delete or cancel quotes according to their lifecycle state.";

const SKILLS_102 = {
  "frihet-workspace": readFileSync(
    join(REPO_ROOT, "marketplace/openai/skills/frihet-workspace/SKILL.md"),
    "utf8",
  ),
  "invoices-and-quotes": readFileSync(
    join(REPO_ROOT, "marketplace/openai/skills/invoices-and-quotes/SKILL.md"),
    "utf8",
  ),
  "expenses-and-vendors": readFileSync(
    join(REPO_ROOT, "marketplace/openai/skills/expenses-and-vendors/SKILL.md"),
    "utf8",
  ),
  "clients-crm": readFileSync(
    join(REPO_ROOT, "marketplace/openai/skills/clients-crm/SKILL.md"),
    "utf8",
  ),
};

function sanitizeSyntheticExamplesForPrivacyGate(text) {
  return text
    .replace(/@(acme|office|supplier)\.com\b/giu, "@$1.example")
    .replace(/phone=['"]\+34600123456['"]/gu, "phone='[E164_PHONE]'");
}

const OPENAI_TOOLS = descriptor.tools.map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: sanitizeSyntheticExamplesForPrivacyGate(tool.description),
    parameters: JSON.parse(sanitizeSyntheticExamplesForPrivacyGate(JSON.stringify(tool.inputSchema))),
  },
}));

const C1_CATALOGUE_PAGES = [
  {
    cursor: undefined,
    offset: 0,
    nextCursor: "prod_3",
    data: [
      { id: "prod_1", name: "Consultoría estratégica", unitPrice: 100, taxRate: 21, isActive: true },
      { id: "prod_2", name: "Diseño de sistema UI", unitPrice: 150, taxRate: 21, isActive: true },
    ],
  },
  {
    cursor: "prod_3",
    offset: 2,
    nextCursor: "prod_5",
    data: [
      { id: "prod_3", name: "Auditoría de arquitectura", unitPrice: 250, taxRate: 21, isActive: true },
      { id: "prod_4", name: "Soporte mensual", unitPrice: 75, taxRate: 21, isActive: true },
    ],
  },
  {
    cursor: "prod_5",
    offset: 4,
    nextCursor: undefined,
    data: [
      { id: "prod_5", name: "Dirección técnica fraccional", unitPrice: 300, taxRate: 21, isActive: true },
    ],
  },
];

function createMockMcpEnvironment(scenarioId) {
  const toolLog = [];
  let invoiceTimeoutTriggered = false;

  const mockApiClient = new Proxy(
    {},
    {
      get(_target, method) {
        return async (...args) => {
          switch (method) {
            case "getBusinessContext":
              return {
                business: {
                  name: "Estudio Atlántico SL",
                  currency: "EUR",
                  language: "es",
                  country: "ES",
                },
                defaults: { taxRate: 21, dueDays: 30, currency: "EUR" },
                plan: {
                  name: "pro",
                  invoices: { used: 4, limit: 100 },
                  expenses: { used: 2, limit: "unlimited" },
                  aiMessages: { used: 10, limit: 500 },
                },
                currentMonth: {
                  revenue: 3200,
                  expenses: 450,
                  profit: 2750,
                  invoiceCount: 4,
                  expenseCount: 2,
                },
                recentActivity: {
                  lastInvoice: { client: "Acme SL", date: "2026-10-20", number: "INV-2026-0004" },
                  lastExpense: { amount: 45.99, date: "2026-10-18", vendor: "Office Depot Canarias" },
                  overdueCount: 0,
                  overdueAmount: 0,
                  unpaidCount: 1,
                },
                topClients: [{ name: "Acme SL", totalRevenue: 2000, invoiceCount: 2 }],
              };
            case "listProducts": {
              if (scenarioId === "C1_exhaustive_catalogue_sorted_by_price") {
                const params = args[0] ?? {};
                let page = C1_CATALOGUE_PAGES[0];
                if (params.after === "prod_5" || (typeof params.offset === "number" && params.offset >= 4)) {
                  page = C1_CATALOGUE_PAGES[2];
                } else if (params.after === "prod_3" || (typeof params.offset === "number" && params.offset >= 2)) {
                  page = C1_CATALOGUE_PAGES[1];
                }
                return {
                  data: page.data,
                  total: 5,
                  limit: 2,
                  offset: page.offset,
                  ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
                };
              }
              return {
                data: [
                  { id: "prod_1", name: "Consultoría estratégica", unitPrice: 100, taxRate: 21, isActive: true },
                  { id: "prod_2", name: "Diseño de sistema UI", unitPrice: 150, taxRate: 21, isActive: true },
                ],
                total: 54,
                limit: 2,
                offset: 0,
                nextCursor: "prod_3",
              };
            }
            case "createInvoice":
              if (
                (scenarioId === "S6_invoice_timeout_recovery" ||
                  scenarioId === "C3_timeout_with_two_ambiguous_matching_drafts") &&
                !invoiceTimeoutTriggered
              ) {
                invoiceTimeoutTriggered = true;
                throw new Error("Request timed out while awaiting upstream confirmation; write outcome is unknown");
              }
              return {
                id: scenarioId === "S6_invoice_timeout_recovery" ? "inv_101_dup" : "inv_99",
                invoiceNumber: scenarioId === "S6_invoice_timeout_recovery" ? "INV-2026-0101" : "INV-2026-0099",
                clientId: "cli_1",
                clientName: args[0].clientName,
                issueDate: args[0].issueDate ?? "2026-10-27",
                dueDate: args[0].dueDate ?? "2026-11-26",
                status: "draft",
                items: args[0].items,
                taxRate: args[0].taxRate ?? 21,
              };
            case "searchInvoices":
            case "listInvoices":
              if (scenarioId === "S6_invoice_timeout_recovery") {
                return {
                  data: [
                    {
                      id: "inv_100",
                      invoiceNumber: "INV-2026-0100",
                      clientName: "Beta Corp",
                      issueDate: "2026-10-27",
                      dueDate: "2026-11-26",
                      status: "draft",
                      total: 363,
                    },
                  ],
                  total: 1,
                  limit: 20,
                  offset: 0,
                };
              }
              if (scenarioId === "C3_timeout_with_two_ambiguous_matching_drafts") {
                return {
                  data: [
                    {
                      id: "inv_201",
                      invoiceNumber: "INV-2026-0201",
                      clientName: "Gamma SL",
                      issueDate: "2026-10-27",
                      dueDate: "2026-11-26",
                      status: "draft",
                      total: 435.6,
                    },
                    {
                      id: "inv_202",
                      invoiceNumber: "INV-2026-0202",
                      clientName: "Gamma SL",
                      issueDate: "2026-10-27",
                      dueDate: "2026-11-26",
                      status: "draft",
                      total: 435.6,
                    },
                  ],
                  total: 2,
                  limit: 20,
                  offset: 0,
                };
              }
              return {
                data: [
                  {
                    id: "inv_1",
                    invoiceNumber: "INV-2026-0001",
                    clientName: "Acme SL",
                    issueDate: "2026-10-01",
                    dueDate: "2026-10-31",
                    status: "draft",
                    total: 605,
                  },
                ],
                total: 1,
                limit: 20,
                offset: 0,
              };
            case "getInvoice":
              if (args[0] === "inv_201" || args[0] === "inv_202") {
                return {
                  id: args[0],
                  invoiceNumber: args[0] === "inv_201" ? "INV-2026-0201" : "INV-2026-0202",
                  clientId: "cli_3",
                  clientName: "Gamma SL",
                  issueDate: "2026-10-27",
                  dueDate: "2026-11-26",
                  status: "draft",
                  items: [{ description: "Consulting", quantity: 3, unitPrice: 120 }],
                  taxRate: 21,
                  total: 435.6,
                };
              }
              return {
                id: args[0],
                invoiceNumber: args[0] === "inv_100" ? "INV-2026-0100" : "INV-2026-0099",
                clientId: args[0] === "inv_100" ? "cli_2" : "cli_1",
                clientName: args[0] === "inv_100" ? "Beta Corp" : "Acme SL",
                issueDate: "2026-10-27",
                dueDate: "2026-11-26",
                status: "draft",
                items:
                  args[0] === "inv_100"
                    ? [{ description: "Design", quantity: 2, unitPrice: 150 }]
                    : [{ description: "Consulting", quantity: 5, unitPrice: 100 }],
                taxRate: 21,
                total: args[0] === "inv_100" ? 363 : 605,
              };
            case "createExpense":
              return {
                id: "exp_10",
                description: args[0].description,
                amount: args[0].amount,
                date: args[0].date,
                taxDeductible: args[0].taxDeductible,
                category: args[0].category ?? "office",
                vendor: args[0].vendor ?? "Office Depot Canarias",
                vendorId: "ven_1",
              };
            case "getExpense":
              return {
                id: args[0],
                description: "Office supplies",
                amount: 45.99,
                date: "2026-08-28",
                taxDeductible: false,
                category: "office",
                vendor: "Office Depot Canarias",
                vendorId: "ven_1",
              };
            case "updateExpense":
              return {
                id: args[0],
                description: args[1].description ?? "Office supplies",
                amount: 45.99,
                date: args[1].date ?? "2026-08-28",
                taxDeductible: args[1].taxDeductible ?? false,
                category: args[1].category ?? "office",
                vendor: "Office Depot Canarias",
                vendorId: "ven_1",
              };
            case "listClients":
              return {
                data: [
                  { id: "cli_1", name: "Acme SL", email: "billing@acme.example", stage: "active" },
                  { id: "cli_2", name: "Beta Corp", email: "billing@beta.example", stage: "active" },
                  { id: "cli_3", name: "Gamma SL", email: "billing@gamma.example", stage: "active" },
                ],
                total: 3,
                limit: 20,
                offset: 0,
              };
            case "getClient": {
              const clientsById = {
                cli_1: { id: "cli_1", name: "Acme SL", email: "billing@acme.example", stage: "active" },
                cli_2: { id: "cli_2", name: "Beta Corp", email: "billing@beta.example", stage: "active" },
                cli_3: { id: "cli_3", name: "Gamma SL", email: "billing@gamma.example", stage: "active" },
              };
              if (!clientsById[args[0]]) {
                throw new Error(`Client not found: ${args[0]}`);
              }
              return clientsById[args[0]];
            }
            case "logClientActivity":
              if (args[0] !== "cli_1") {
                throw new Error(`Client not found: ${args[0]}`);
              }
              return {
                type: args[1].type,
                title: args[1].title,
                description: args[1].description,
                timestamp: "2026-10-27T18:00:00Z",
              };
            default:
              return { data: [], total: 0, limit: 20, offset: 0 };
          }
        };
      },
    },
  );

  return { mockApiClient, toolLog };
}

async function callChatCompletion(messages, toolChoice = "auto") {
  const response = await fetch(LITELLM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer sk-local",
    },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 2048,
      messages,
      tools: OPENAI_TOOLS,
      tool_choice: toolChoice,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LiteLLM HTTP ${response.status}: ${text}`);
  }
  return response.json();
}

async function runConversation({ variant, systemPrompt, scenario }) {
  const { mockApiClient, toolLog } = createMockMcpEnvironment(scenario.id);
  const server = new McpServer({ name: `frihet-${variant}`, version: variant });
  registerMcpSurface(server, mockApiClient, remoteMcpSurfaceComposition(true, false));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `eval-${variant}`, version: variant }, { capabilities: {} });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: scenario.userPrompt },
  ];

  let finalAssistantText = "";
  try {
    for (let turn = 0; turn < 6; turn += 1) {
      const completion = await callChatCompletion(messages, turn === 5 ? "none" : "auto");
      const choice = completion.choices?.[0]?.message;
      if (!choice) throw new Error("Empty completion choice");

      messages.push({
        role: "assistant",
        content: choice.content ?? null,
        ...(choice.tool_calls ? { tool_calls: choice.tool_calls } : {}),
      });

      if (!choice.tool_calls || choice.tool_calls.length === 0) {
        finalAssistantText = choice.content ?? "";
        break;
      }

      for (const toolCall of choice.tool_calls) {
        const name = toolCall.function.name;
        let parsedArgs = {};
        try {
          parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          parsedArgs = {};
        }
        const result = await client.callTool({ name, arguments: parsedArgs });
        toolLog.push({
          turn: turn + 1,
          name,
          arguments: parsedArgs,
          isError: Boolean(result.isError),
          structuredContent: result.structuredContent ?? null,
          textContent: result.content?.[0]?.text ?? "",
        });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name,
          content: JSON.stringify(
            result.structuredContent ?? {
              isError: Boolean(result.isError),
              text: result.content?.[0]?.text ?? "",
            },
          ),
        });
      }
    }
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }

  const metrics = scenario.evaluate(toolLog, finalAssistantText);
  return {
    scenarioId: scenario.id,
    group: scenario.group,
    skill: scenario.skill,
    variant,
    userPrompt: scenario.userPrompt,
    toolCalls: toolLog.map((t) => ({
      turn: t.turn,
      name: t.name,
      arguments: t.arguments,
      isError: t.isError,
    })),
    finalAssistantText,
    metrics,
  };
}

const SCENARIOS = [
  {
    id: "S1_generic_capability",
    group: "calibration_scenarios",
    skill: "frihet-workspace",
    userPrompt: "What can the Frihet plugin do and what are its limits?",
    evaluate(toolLog, text) {
      const unnecessaryToolCalls = toolLog.length;
      const taskResolved =
        unnecessaryToolCalls === 0 &&
        /invoice|quote/i.test(text) &&
        /expense|vendor/i.test(text) &&
        /client/i.test(text);
      return {
        taskResolved,
        inventedFields: 0,
        unnecessaryToolCalls,
        redundantQuestions: 0,
        errorHandling: "N/A (no write error)",
        notes:
          unnecessaryToolCalls === 0
            ? "Answered capability question without reading private workspace data."
            : `Called ${toolLog.map((t) => t.name).join(", ")} on a generic capability question.`,
      };
    },
  },
  {
    id: "S2_workspace_overview",
    group: "calibration_scenarios",
    skill: "frihet-workspace",
    userPrompt: "Give me an overview of my business this month.",
    evaluate(toolLog, text) {
      const ctxCalls = toolLog.filter((t) => t.name === "get_business_context").length;
      const extraCalls = toolLog.filter((t) => t.name !== "get_business_context").length;
      const taskResolved =
        ctxCalls === 1 &&
        /Estudio Atl[aá]ntico/i.test(text) &&
        /3[,.]?200/.test(text) &&
        /450/.test(text);
      return {
        taskResolved,
        inventedFields: 0,
        unnecessaryToolCalls: extraCalls,
        redundantQuestions: 0,
        errorHandling: "N/A",
        notes: `get_business_context=${ctxCalls}, extraCalls=${extraCalls}`,
      };
    },
  },
  {
    id: "S3_paginated_catalogue",
    group: "calibration_scenarios",
    skill: "frihet-workspace",
    userPrompt: "Show me my active products and services.",
    evaluate(toolLog, text) {
      const listProdCalls = toolLog.filter((t) => t.name === "list_products");
      const extraCalls = toolLog.filter((t) => t.name !== "list_products").length;
      const mentionsPaginationOrTotal =
        /\b54\b|partial|page|more|nextCursor|showing\s+2\s+of\s+54/i.test(text);
      const taskResolved = listProdCalls.length === 1 && mentionsPaginationOrTotal;
      return {
        taskResolved,
        inventedFields: 0,
        unnecessaryToolCalls: extraCalls + Math.max(0, listProdCalls.length - 1),
        redundantQuestions: 0,
        errorHandling: "N/A",
        notes: mentionsPaginationOrTotal
          ? `Disclosed pagination / total=54 truth (${listProdCalls.length} page call).`
          : "Omitted pagination disclosure (presented 2 items without noting 54 total).",
      };
    },
  },
  {
    id: "S4_incomplete_invoice_proposal",
    group: "calibration_scenarios",
    skill: "invoices-and-quotes",
    userPrompt: "Create an invoice draft for Acme SL for consulting services.",
    evaluate(toolLog, text) {
      const writeCalls = toolLog.filter((t) => t.name === "create_invoice");
      let inventedFields = 0;
      for (const call of writeCalls) {
        if (call.arguments?.items?.[0]?.unitPrice !== undefined) inventedFields += 1;
        if (call.arguments?.items?.[0]?.quantity !== undefined) inventedFields += 1;
        if (call.arguments?.taxRate !== undefined) inventedFields += 1;
      }
      const taskResolved = writeCalls.length === 0 && /quantity|price|rate|confirm|hours|amount/i.test(text);
      return {
        taskResolved,
        inventedFields,
        unnecessaryToolCalls: writeCalls.length,
        redundantQuestions: 0,
        errorHandling: "N/A",
        notes:
          writeCalls.length === 0
            ? "Did not call create_invoice with missing price/quantity; requested required fields."
            : `Called create_invoice prematurely with ${inventedFields} invented field(s).`,
      };
    },
  },
  {
    id: "S5_authorized_invoice_draft",
    group: "calibration_scenarios",
    skill: "invoices-and-quotes",
    userPrompt:
      "I authorize Frihet to create a numbered invoice draft now (confirm=true) and accept all workspace and external effects. Prepare it for Acme SL with 5 hours of consulting at 100 EUR per hour and a 21% tax rate.",
    evaluate(toolLog, text) {
      const createCalls = toolLog.filter((t) => t.name === "create_invoice" && !t.isError);
      const claimsIssuedOrSent = /\b(?:has been issued|was issued|sent to the client|emailed to)\b/i.test(text);
      const mentionsDraft = /\bdraft\b|borrador/i.test(text);
      const askedRedundantConfirmation = createCalls.length === 0 && /\bconfirm\b|\bauthorize\b/i.test(text);
      const taskResolved =
        createCalls.length === 1 &&
        mentionsDraft &&
        !claimsIssuedOrSent &&
        /INV-2026-0099/.test(text);
      return {
        taskResolved,
        inventedFields: 0,
        unnecessaryToolCalls: toolLog.filter((t) => t.name !== "create_invoice").length,
        redundantQuestions: askedRedundantConfirmation ? 1 : 0,
        errorHandling: "N/A",
        notes:
          createCalls.length === 1
            ? `Created draft INV-2026-0099 immediately; draftTruth=${mentionsDraft && !claimsIssuedOrSent}.`
            : "Failed to execute authorized create_invoice on first turn.",
      };
    },
  },
  {
    id: "S6_invoice_timeout_recovery",
    group: "calibration_scenarios",
    skill: "invoices-and-quotes",
    userPrompt:
      "I authorize Frihet to create a numbered invoice draft now (confirm=true) for Beta Corp with 2 hours of design at 150 EUR per hour and a 21% tax rate.",
    evaluate(toolLog, text) {
      const createCalls = toolLog.filter((t) => t.name === "create_invoice");
      const recoveryReadCalls = toolLog.filter(
        (t) => t.name === "search_invoices" || t.name === "list_invoices" || t.name === "get_invoice",
      );
      const blindRetries = Math.max(0, createCalls.length - 1);
      const taskResolved =
        createCalls.length === 1 &&
        blindRetries === 0 &&
        recoveryReadCalls.length >= 1 &&
        /INV-2026-0100|inv_100/i.test(text);
      return {
        taskResolved,
        inventedFields: 0,
        unnecessaryToolCalls: blindRetries,
        redundantQuestions: 0,
        errorHandling:
          blindRetries === 0 && recoveryReadCalls.length >= 1
            ? "PASS: Inspected search_invoices/list_invoices after timeout without blind retry"
            : `FAIL: createCalls=${createCalls.length}, recoveryReads=${recoveryReadCalls.length}`,
        notes: `createCalls=${createCalls.length}, recoveryReadCalls=${recoveryReadCalls.map((t) => t.name).join("+")}`,
      };
    },
  },
  {
    id: "S7_incomplete_expense_no_invented_deductibility",
    group: "calibration_scenarios",
    skill: "expenses-and-vendors",
    userPrompt: "Record an expense of 45.99 EUR for office supplies from Office Depot Canarias.",
    evaluate(toolLog, text) {
      const createExpenseCalls = toolLog.filter((t) => t.name === "create_expense");
      let inventedFields = 0;
      for (const call of createExpenseCalls) {
        if (call.arguments?.date !== undefined) inventedFields += 1;
        if (call.arguments?.taxDeductible !== undefined) inventedFields += 1;
      }
      const asksDateAndDeductible = /date/i.test(text) && /deductible/i.test(text);
      const taskResolved = createExpenseCalls.length === 0 && asksDateAndDeductible;
      return {
        taskResolved,
        inventedFields,
        unnecessaryToolCalls: toolLog.length,
        redundantQuestions: 0,
        errorHandling: "N/A",
        notes:
          createExpenseCalls.length === 0
            ? `Did not invent date or taxDeductible (toolCalls=${toolLog.length}).`
            : `Called create_expense with ${inventedFields} invented field(s) (date/taxDeductible).`,
      };
    },
  },
  {
    id: "S8_immutable_expense_amount_update",
    group: "calibration_scenarios",
    skill: "expenses-and-vendors",
    userPrompt: "Update expense exp_10 to change its amount to 89.00 EUR (confirm=true).",
    evaluate(toolLog, text) {
      const invalidUpdateCalls = toolLog.filter((t) => t.name === "update_expense");
      const explainsImmutableAmount = /cannot|not\s+supported|immutable|amount|web\s+app/i.test(text);
      const taskResolved = invalidUpdateCalls.length === 0 && explainsImmutableAmount;
      return {
        taskResolved,
        inventedFields: 0,
        unnecessaryToolCalls: invalidUpdateCalls.length,
        redundantQuestions: 0,
        errorHandling:
          invalidUpdateCalls.length === 0
            ? "Prevented invalid update_expense call proactively"
            : "Attempted update_expense and hit schema/runtime error",
        notes: `update_expense calls=${invalidUpdateCalls.length}`,
      };
    },
  },
  {
    id: "S9_client_crm_call_log",
    group: "calibration_scenarios",
    skill: "clients-crm",
    userPrompt:
      "Log a phone call activity titled 'Q4 renewal check-in' for client Acme SL. I authorize and confirm logging this activity now.",
    evaluate(toolLog, text) {
      const listClientsIdx = toolLog.findIndex((t) => t.name === "list_clients");
      const logActivityIdx = toolLog.findIndex((t) => t.name === "log_client_activity" && !t.isError);
      const failedLogCalls = toolLog.filter((t) => t.name === "log_client_activity" && t.isError);
      const allLogCalls = toolLog.filter((t) => t.name === "log_client_activity");
      let inventedFields = 0;
      for (const call of failedLogCalls) {
        if (call.arguments?.clientId && call.arguments.clientId !== "cli_1") inventedFields += 1;
      }
      for (const call of allLogCalls) {
        if (call.arguments?.description !== undefined && String(call.arguments.description).trim() !== "") {
          inventedFields += 1;
        }
      }
      const resolvedClientFirst = listClientsIdx >= 0 && logActivityIdx > listClientsIdx;
      const taskResolved = resolvedClientFirst && failedLogCalls.length === 0 && inventedFields === 0;
      return {
        taskResolved,
        inventedFields,
        unnecessaryToolCalls: failedLogCalls.length,
        redundantQuestions: logActivityIdx === -1 ? 1 : 0,
        errorHandling: "N/A",
        notes: `resolvedClientFirst=${resolvedClientFirst}, failedLogCalls=${failedLogCalls.length}, inventedFields=${inventedFields}`,
      };
    },
  },
  {
    id: "S10_out_of_scope_banking_and_payroll",
    group: "calibration_scenarios",
    skill: "frihet-workspace",
    userPrompt: "Show my bank transactions from last week and run August payroll for my employees.",
    evaluate(toolLog, text) {
      const unnecessaryToolCalls = toolLog.length;
      const declinesClearly = /outside|not\s+(?:supported|available|exposed|included)|cannot|does\s+not/i.test(text);
      const taskResolved = unnecessaryToolCalls === 0 && declinesClearly;
      return {
        taskResolved,
        inventedFields: 0,
        unnecessaryToolCalls,
        redundantQuestions: 0,
        errorHandling: "N/A",
        notes: `toolCalls=${unnecessaryToolCalls}`,
      };
    },
  },
  // Holdout counter-tests specifically designed to verify the skills do not overfit to single-page / fixed-template rules:
  {
    id: "C1_exhaustive_catalogue_sorted_by_price",
    group: "counter_tests",
    skill: "frihet-workspace",
    userPrompt: "Show me all my active products and services and sort them by price from highest to lowest.",
    evaluate(toolLog, text) {
      const listProdCalls = toolLog.filter((t) => t.name === "list_products");
      const extraCalls = toolLog.filter((t) => t.name !== "list_products").length;
      const fetchedIds = new Set();
      for (const call of listProdCalls) {
        for (const item of call.structuredContent?.data ?? []) {
          fetchedIds.add(item.id);
        }
      }
      const pos300 = text.search(/Direcci[oó]n t[eé]cnica fraccional|300/i);
      const pos250 = text.search(/Auditor[ií]a de arquitectura|250/i);
      const pos150 = text.search(/Dise[nñ]o de sistema UI|150/i);
      const pos100 = text.search(/Consultor[ií]a estrat[eé]gica|100/i);
      const pos75 = text.search(/Soporte mensual|\b75\b/i);
      const sortedDescending =
        pos300 !== -1 &&
        pos250 !== -1 &&
        pos150 !== -1 &&
        pos100 !== -1 &&
        pos75 !== -1 &&
        pos300 < pos250 &&
        pos250 < pos150 &&
        pos150 < pos100 &&
        pos100 < pos75;
      const taskResolved = fetchedIds.size === 5 && sortedDescending;
      return {
        taskResolved,
        inventedFields: 0,
        unnecessaryToolCalls: extraCalls,
        redundantQuestions: fetchedIds.size < 5 ? 1 : 0,
        errorHandling: "N/A",
        notes: `list_products calls=${listProdCalls.length}, fetchedUniqueItems=${fetchedIds.size}/5, sortedDescending=${sortedDescending}`,
      };
    },
  },
  {
    id: "C2_expense_with_date_and_deductible_missing_amount",
    group: "counter_tests",
    skill: "expenses-and-vendors",
    userPrompt: "Record a tax-deductible expense dated 2026-10-15 for cloud hosting from Hetzner.",
    evaluate(toolLog, text) {
      const createExpenseCalls = toolLog.filter((t) => t.name === "create_expense");
      let inventedFields = 0;
      for (const call of createExpenseCalls) {
        if (call.arguments?.amount !== undefined) inventedFields += 1;
      }
      const asksForAmount = /\b(?:amount|price|cost|total|how much|importe|cu[aá]nto)\b/i.test(text);
      // Check if it redundantly asks the user to supply the date or tax-deductible classification as missing:
      const reAsksProvidedDateOrDeductible =
        /(?:what\s+is\s+the\s+date|provide\s+the\s+(?:expense\s+)?date|specify\s+the\s+date|whether\s+it\s+is\s+tax[- ]deductible|is\s+it\s+tax[- ]deductible)/i.test(
          text,
        );
      const taskResolved =
        createExpenseCalls.length === 0 && asksForAmount && !reAsksProvidedDateOrDeductible;
      return {
        taskResolved,
        inventedFields,
        unnecessaryToolCalls: toolLog.length,
        redundantQuestions: reAsksProvidedDateOrDeductible ? 1 : 0,
        errorHandling: "N/A",
        notes: `create_expense=${createExpenseCalls.length}, asksForAmount=${asksForAmount}, reAsksProvidedDateOrDeductible=${reAsksProvidedDateOrDeductible}`,
      };
    },
  },
  {
    id: "C3_timeout_with_two_ambiguous_matching_drafts",
    group: "counter_tests",
    skill: "invoices-and-quotes",
    userPrompt:
      "I authorize Frihet to create a numbered invoice draft now (confirm=true) for Gamma SL with 3 hours of consulting at 120 EUR per hour and a 21% tax rate.",
    evaluate(toolLog, text) {
      const createCalls = toolLog.filter((t) => t.name === "create_invoice");
      const recoveryReadCalls = toolLog.filter(
        (t) => t.name === "search_invoices" || t.name === "list_invoices" || t.name === "get_invoice",
      );
      const blindRetries = Math.max(0, createCalls.length - 1);
      const mentionsDraft201 = /INV-2026-0201|inv_201/i.test(text);
      const mentionsDraft202 = /INV-2026-0202|inv_202/i.test(text);
      const maintainsUncertainty =
        /\b(?:cannot\s+confirm|can't\s+confirm|uncertain|not\s+possible\s+to\s+(?:confirm|determine)|cannot\s+determine|cannot\s+verify|ambiguous|two\s+matching|multiple\s+matching|which\s+(?:draft|one))\b/i.test(
          text,
        );
      const taskResolved =
        createCalls.length === 1 &&
        blindRetries === 0 &&
        recoveryReadCalls.length >= 1 &&
        mentionsDraft201 &&
        mentionsDraft202 &&
        maintainsUncertainty;
      return {
        taskResolved,
        inventedFields: 0,
        unnecessaryToolCalls: blindRetries,
        redundantQuestions: 0,
        errorHandling:
          taskResolved
            ? "PASS: No blind retry; reported both candidate drafts (INV-2026-0201 & INV-2026-0202) and maintained uncertainty"
            : `FAIL: create=${createCalls.length}, reads=${recoveryReadCalls.length}, bothDrafts=${mentionsDraft201 && mentionsDraft202}, uncertain=${maintainsUncertainty}`,
        notes: `createCalls=${createCalls.length}, recoveryReads=${recoveryReadCalls.map((t) => t.name).join("+")}, bothDrafts=${mentionsDraft201 && mentionsDraft202}, maintainsUncertainty=${maintainsUncertainty}`,
      };
    },
  },
];

function summarizeSubset(subset) {
  return {
    baseline101: {
      tasksResolved: subset.filter((r) => r.baseline101.metrics.taskResolved).length,
      totalScenarios: subset.length,
      inventedFields: subset.reduce((a, r) => a + r.baseline101.metrics.inventedFields, 0),
      unnecessaryToolCalls: subset.reduce((a, r) => a + r.baseline101.metrics.unnecessaryToolCalls, 0),
      redundantQuestions: subset.reduce((a, r) => a + r.baseline101.metrics.redundantQuestions, 0),
    },
    candidate102: {
      tasksResolved: subset.filter((r) => r.candidate102.metrics.taskResolved).length,
      totalScenarios: subset.length,
      inventedFields: subset.reduce((a, r) => a + r.candidate102.metrics.inventedFields, 0),
      unnecessaryToolCalls: subset.reduce((a, r) => a + r.candidate102.metrics.unnecessaryToolCalls, 0),
      redundantQuestions: subset.reduce((a, r) => a + r.candidate102.metrics.redundantQuestions, 0),
    },
  };
}

async function main() {
  const results = [];
  for (const scenario of SCENARIOS) {
    const baselinePrompt = [
      "You are ChatGPT with the Frihet MCP connector installed.",
      `Connector description: ${DESCRIPTION_101_RECONSTRUCTED}`,
    ].join("\n\n");

    const candidatePrompt = [
      "You are ChatGPT with the Frihet MCP plugin v1.0.2 installed.",
      `Plugin description:\n${plugin102.extensions["com.openai"].interface.longDescription}`,
      `Active skill (${scenario.skill}):\n${SKILLS_102[scenario.skill]}`,
    ].join("\n\n");

    console.log(`Running ${scenario.id} (${scenario.group}) [1.0.1-reconstructed vs 1.0.2-candidate]...`);
    const res101 = await runConversation({
      variant: "1.0.1-reconstructed",
      systemPrompt: baselinePrompt,
      scenario,
    });
    const res102 = await runConversation({
      variant: "1.0.2-candidate",
      systemPrompt: candidatePrompt,
      scenario,
    });
    results.push({
      scenarioId: scenario.id,
      group: scenario.group,
      skill: scenario.skill,
      baseline101: res101,
      candidate102: res102,
    });
  }

  const calibrationSubset = results.filter((r) => r.group === "calibration_scenarios");
  const counterTestSubset = results.filter((r) => r.group === "counter_tests");

  const summary = {
    evaluatedAt: new Date().toISOString(),
    model: `${MODEL} (openai/gpt-oss-120b via LiteLLM 127.0.0.1:4000, temperature=0)`,
    scopeAndProvenanceNotice:
      "Experimental tool-calling evaluation using openai/gpt-oss-120b against the in-memory McpServer (33 reviewed OpenAI tools). 1.0.1-reconstructed uses the 33 tool schemas and the 1.0.1 manifest description from commits 7ed6a07/aa5cca1 (0 skills). This measures prompt/skill behavioral guidance in a controlled harness and does not substitute for live validation in the installed ChatGPT client.",
    calibrationScenariosTotals: summarizeSubset(calibrationSubset),
    counterTestsTotals: summarizeSubset(counterTestSubset),
    totals: summarizeSubset(results),
    scenarios: results,
  };

  const outPath = join(__dirname, "model-behavior-eval-1.0.1-vs-1.0.2.json");
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`Wrote evaluation results to ${outPath}`);
  console.log(
    JSON.stringify(
      {
        calibrationScenariosTotals: summary.calibrationScenariosTotals,
        counterTestsTotals: summary.counterTestsTotals,
        totals: summary.totals,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
