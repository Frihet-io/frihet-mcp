#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  assertOpenAIReviewContract,
  buildOpenAIReviewContract,
  captureOpenAIReviewMcpSurface,
  serializeOpenAIReviewContract,
} from "../dist/openai-review-contract.js";
import { buildOpenAIReviewOAuthContract } from "../dist/openai-review-oauth.js";

const DESCRIPTOR_PATH = fileURLToPath(
  new URL("../src/__tests__/fixtures/openai-review-descriptor.snapshot.json", import.meta.url),
);
const SUBMISSION_PATH = fileURLToPath(
  new URL("../marketplace/openai/chatgpt-app-submission.json", import.meta.url),
);
const WORKER_LOCK_PATH = fileURLToPath(
  new URL("../workers/remote-mcp/package-lock.json", import.meta.url),
);

const read = (object) => ({ kind: "read", object });
const internalWrite = (behavior, nonDestructiveReason) => ({
  kind: "internal_write",
  behavior,
  nonDestructiveReason,
});
const internalUpdate = (behavior) => ({ kind: "internal_update", behavior });
const webhookWrite = (behavior, openWorldEffect, irreversible) => ({
  kind: "webhook_write",
  behavior,
  openWorldEffect,
  irreversible,
});
const hardDelete = (object) => ({ kind: "hard_delete", object });
const DISCOVERY_TOOL_NAMES = new Set([
  "list_tool_groups",
  "search_tools",
  "describe_tool",
]);

// Curated from the real handlers and their downstream ERP routes; parity with
// tools/list is enforced below so no tool can enter the submission by naming
// convention or generic inference.
const TOOL_FACTS = {
  create_client: webhookWrite(
    "creates a client record without a dedicated government-identifier or precise-address field",
    "deliver the resulting client event to active endpoints previously configured by the workspace owner",
    "an external webhook delivery cannot be recalled",
  ),
  create_client_contact: internalWrite(
    "adds a contact under one selected client",
    "the new contact remains editable and no existing record is deleted",
  ),
  create_client_note: internalWrite(
    "adds a free-text note under one selected client",
    "the new note is separately removable and no existing record is overwritten",
  ),
  create_expense: webhookWrite(
    "creates an expense record on an explicit date that determines its accounting and future tax-report period, may create and link a vendor when no exact match exists, and records an explicit tax-deductible choice without filing anything",
    "deliver the resulting expense-created event to active owner-configured endpoints, notify eligible workspace admins or accountants in-app and through Novu, and possibly award referral activation credits to another Frihet account",
    "external event delivery, workspace notification, and any referral-credit award cannot be recalled",
  ),
  create_invoice: webhookWrite(
    "creates a numbered invoice draft, advances the workspace numbering counter, consumes monthly invoice usage, and may create and link a client when no exact match exists",
    "possibly send invoice-creation analytics to PostHog's EU-hosted analytics service, deliver one or more resulting invoice-created or client-created events to active owner-configured endpoints, notify eligible workspace admins or accountants in-app and through Novu, and award referral activation credits to another Frihet account",
    "the numbering-counter advance, analytics and external event delivery, workspace notification, and any referral-credit award cannot be recalled",
  ),
  create_product: webhookWrite(
    "creates a product or service catalogue record",
    "deliver the resulting product-created event to active endpoints previously configured by the workspace owner",
    "an external webhook delivery cannot be recalled",
  ),
  create_quote: webhookWrite(
    "creates a numbered quote draft, advances the workspace numbering counter, and may create and link a client when no exact match exists",
    "deliver one or more resulting quote-created or client-created events to active endpoints previously configured by the workspace owner",
    "the numbering-counter advance and any external webhook delivery cannot be recalled",
  ),
  create_vendor: internalWrite(
    "creates a vendor record without a dedicated government-identifier or precise-address field",
    "the new vendor remains editable and no existing record is deleted",
  ),
  delete_client_contact: hardDelete("one contact from a selected client"),
  delete_client_note: hardDelete("one note from a selected client"),
  delete_quote: {
    kind: "quote_delete",
    behavior: "permanently removes only a clean draft with no delivery, response, attachment, or conversion evidence, refuses a protected draft, or cancels a non-draft quote",
    event: "a quote-updated event when a non-draft quote is cancelled",
  },
  describe_tool: read("the reviewed description and input field names for one allowed tool"),
  get_business_context: read("workspace defaults, plan usage, recent activity, and current-month totals"),
  get_client: read("one client record through a reviewed DTO with no dedicated government-identifier or precise-address fields"),
  get_expense: read("one expense record"),
  get_invoice: read("one invoice with its stored line items, linked-client context, dates, and lifecycle status, while a calculated total may be absent"),
  get_product: read("one product or service catalogue record"),
  get_quote: read("one quote with its stored line items, linked-client context, dates, and status, while a calculated total may be absent"),
  get_vendor: read("one vendor record through a reviewed DTO with no dedicated government-identifier or precise-address fields"),
  list_client_activities: read("the activity timeline for one client"),
  list_client_contacts: read("the contacts attached to one client"),
  list_client_notes: read("the notes attached to one client"),
  list_clients: read("the paginated client list through a reviewed DTO with no dedicated government-identifier or precise-address fields"),
  list_expenses: read("the paginated expense list and selected business filters"),
  list_invoices: read("the paginated invoice list and selected status or date filters"),
  list_products: read("the product and service catalogue"),
  list_quotes: read("the paginated quote list and selected status or date filters"),
  list_tool_groups: read("the reviewed tool groups and their exact tool counts"),
  list_vendors: read("the paginated vendor list through a reviewed DTO with no dedicated government-identifier or precise-address fields"),
  log_client_activity: webhookWrite(
    "adds a call, email, meeting, or task entry to one client timeline and, for call, meeting, or email entries, updates the parent client's latest-activity fields",
    "deliver the resulting full client-updated event to active owner-configured endpoints for call, meeting, or email entries, while task entries do not update the parent client",
    "an external webhook delivery cannot be recalled",
  ),
  search_invoices: read("invoice records matching a text query and selected filters"),
  search_tools: read("the names of reviewed tools matching a capability query"),
  update_client: webhookWrite(
    "updates only the supplied fields on one client",
    "deliver the resulting client-updated event to active endpoints previously configured by the workspace owner",
    "an external webhook delivery cannot be recalled",
  ),
  update_expense: webhookWrite(
    "updates only description, category, date, or tax-deductible classification on one expense; a changed date moves its accounting and future tax-report period, a tax-deductible classification affects internal accounting, no filing occurs, and amount or supplier identity cannot be changed",
    "deliver the resulting expense-updated event to active endpoints previously configured by the workspace owner",
    "an external webhook delivery cannot be recalled",
  ),
  update_product: webhookWrite(
    "updates only the supplied fields on one product or service",
    "deliver the resulting product-updated event to active endpoints previously configured by the workspace owner",
    "an external webhook delivery cannot be recalled",
  ),
  update_vendor: internalUpdate("overwrites the supplied fields on one vendor using PATCH semantics"),
};

const EXPECTED_HINTS = {
  read: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  internal_write: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  internal_update: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
  webhook_write: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  hard_delete: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
  quote_delete: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
};

function justifications(name, fact) {
  if (fact.kind === "read") {
    const openWorldObject = DISCOVERY_TOOL_NAMES.has(name)
      ? "the in-process reviewed tool catalog"
      : "the authenticated Frihet workspace";
    return {
      read_only_justification: `The ${name} operation only reads ${fact.object} and changes no Frihet record.`,
      open_world_justification: `The ${name} operation has no user-directed external effect and only reads ${openWorldObject}.`,
      destructive_justification: `The ${name} operation cannot delete or overwrite workspace data.`,
    };
  }
  if (fact.kind === "internal_write") {
    return {
      read_only_justification: `The ${name} operation ${fact.behavior}, so it changes Frihet state after explicit confirmation.`,
      open_world_justification: `The ${name} operation has no user-directed external effect and only adds data inside the authenticated Frihet workspace.`,
      destructive_justification: `The ${name} operation is non-destructive because ${fact.nonDestructiveReason}.`,
    };
  }
  if (fact.kind === "internal_update") {
    return {
      read_only_justification: `The ${name} operation ${fact.behavior}, so it changes Frihet state after explicit confirmation.`,
      open_world_justification: `The ${name} operation has no user-directed external effect and only changes data inside the authenticated Frihet workspace.`,
      destructive_justification: `The ${name} operation is destructive because replacing prior vendor values has no undo operation in this connector.`,
    };
  }
  if (fact.kind === "webhook_write") {
    return {
      read_only_justification: `The ${name} operation ${fact.behavior}, so it changes Frihet state after explicit confirmation.`,
      open_world_justification: `The ${name} operation can ${fact.openWorldEffect}.`,
      destructive_justification: `The ${name} operation is treated as destructive because ${fact.irreversible}.`,
    };
  }
  if (fact.kind === "hard_delete") {
    return {
      read_only_justification: `The ${name} operation permanently deletes ${fact.object} after explicit confirmation.`,
      open_world_justification: `The ${name} operation has no user-directed external effect and only removes data inside the authenticated Frihet workspace.`,
      destructive_justification: `The ${name} operation is destructive because deleting the record cannot be undone by this connector.`,
    };
  }
  if (fact.kind === "quote_delete") {
    return {
      read_only_justification: `The ${name} operation ${fact.behavior} after explicit confirmation.`,
      open_world_justification: `The ${name} operation can also deliver ${fact.event} to active endpoints previously configured by the workspace owner.`,
      destructive_justification: `The ${name} operation is destructive because eligible clean-draft deletion is permanent, while cancellation changes lifecycle status and its external event cannot be recalled.`,
    };
  }
  throw new Error(`Unsupported reviewed tool fact kind for ${name}: ${fact.kind}`);
}

function validateOneSentence(value, location) {
  if (value.includes("\n") || !value.endsWith(".")) {
    throw new Error(`${location} must be one line ending in a period`);
  }
  const punctuation = value.match(/[.!?]/g) ?? [];
  if (punctuation.length !== 1) {
    throw new Error(`${location} must contain exactly one sentence; got ${punctuation.length}`);
  }
}

async function resolvedOAuthProviderVersion() {
  const lock = JSON.parse(await readFile(WORKER_LOCK_PATH, "utf8"));
  const version = lock.packages?.["node_modules/@cloudflare/workers-oauth-provider"]?.version;
  if (typeof version !== "string" || !version) {
    throw new Error("Cannot resolve the Worker OAuth provider version");
  }
  return version;
}

async function captureCurrentContract() {
  const surface = await captureOpenAIReviewMcpSurface();
  return buildOpenAIReviewContract(surface, {
    providerPackageVersion: await resolvedOAuthProviderVersion(),
    ...buildOpenAIReviewOAuthContract(),
  });
}

function buildSubmission(contract) {
  const descriptorNames = contract.tools.map(({ name }) => name).sort();
  const factNames = Object.keys(TOOL_FACTS).sort();
  if (JSON.stringify(descriptorNames) !== JSON.stringify(factNames)) {
    const missing = descriptorNames.filter((name) => !factNames.includes(name));
    const stale = factNames.filter((name) => !descriptorNames.includes(name));
    throw new Error(`Curated submission facts drifted; missing=${missing.join(",")}; stale=${stale.join(",")}`);
  }

  const tools = {};
  const uniqueJustifications = new Set();
  for (const tool of [...contract.tools].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!tool.outputSchema) throw new Error(`${tool.name} has no outputSchema`);
    const fact = TOOL_FACTS[tool.name];
    const annotations = tool.annotations;
    const selected = {
      readOnlyHint: annotations?.readOnlyHint,
      openWorldHint: annotations?.openWorldHint,
      destructiveHint: annotations?.destructiveHint,
    };
    const expected = EXPECTED_HINTS[fact.kind];
    if (JSON.stringify(selected) !== JSON.stringify(expected)) {
      throw new Error(`${tool.name} annotations do not match the reviewed implementation facts`);
    }
    const reviewJustifications = justifications(tool.name, fact);
    for (const [field, value] of Object.entries(reviewJustifications)) {
      validateOneSentence(value, `${tool.name}.${field}`);
      if (uniqueJustifications.has(value)) throw new Error(`Duplicate justification: ${value}`);
      uniqueJustifications.add(value);
    }
    tools[tool.name] = { annotations: selected, justifications: reviewJustifications };
  }

  const positive = [
    {
      description: "Read the seeded workspace context while verifying the reviewed redaction boundary.",
      user_prompt: "Give me my current Frihet business context overview.",
      file_attachment_urls: null,
      tools_triggered: "get_business_context",
      expected_output: "A concise workspace summary with business defaults, plan, recent activity, and current-month totals through a reviewed DTO with no dedicated government-identifier, precise-address, credential, or internal-telemetry fields.",
      expected_output_url: null,
    },
    {
      description: "List seeded invoice drafts without requesting a write.",
      user_prompt: "Show me my draft invoices.",
      file_attachment_urls: null,
      tools_triggered: "list_invoices",
      expected_output: "A summary list of draft invoices containing only record ID, invoice number, client name, issue and due dates, status, and stored total when present; line items, notes, contact details, dedicated government identifiers, and precise addresses are omitted.",
      expected_output_url: null,
    },
    {
      description: "Create a numbered invoice draft after explicit authorization without using a stored client identifier.",
      user_prompt: "I confirm: prepare an invoice draft for Acme SL with 5 hours of consulting at 100 EUR per hour and a 21 percent tax rate.",
      file_attachment_urls: null,
      tools_triggered: "create_invoice",
      expected_output: "A newly numbered invoice draft with stored line items and clear notes that the numbering counter advanced, monthly invoice usage increased, Frihet may have created and linked the client, PostHog's EU-hosted analytics service may have received invoice-creation analytics, owner-configured webhooks may receive resulting business events, eligible admins or accountants may receive Frihet and Novu notifications, and first-use referral credits may be awarded; a calculated total may be absent.",
      expected_output_url: null,
    },
    {
      description: "Create an office expense after explicit authorization.",
      user_prompt: "I confirm: record a 45.99 EUR office-supplies expense dated 2026-08-28 in the office category and mark it as not tax deductible.",
      file_attachment_urls: null,
      tools_triggered: "create_expense",
      expected_output: "A confirmed 45.99 EUR office expense dated 2026-08-28 and explicitly marked not tax deductible, with clear notes that the date selects its accounting and future tax-report period, owner-configured webhooks may receive resulting business events, eligible admins or accountants may receive Frihet and Novu notifications, and first-use referral credits may be awarded.",
      expected_output_url: null,
    },
    {
      description: "List seeded catalogue items without requesting a write.",
      user_prompt: "Show me my active products and services.",
      file_attachment_urls: null,
      tools_triggered: "list_products",
      expected_output: "A list of active catalogue records with names, unit prices, tax rates, and status.",
      expected_output_url: null,
    },
  ];
  const negative = [
    {
      description: "Do not trigger Frihet for payroll execution because payroll and HR are outside the reviewed connector.",
      user_prompt: "Run payroll for all employees for August 2026.",
      file_attachment_urls: null,
      tools_triggered: null,
      expected_output: "The app should not be invoked because payroll and HR workflows are outside the reviewed Frihet connector.",
      expected_output_url: null,
    },
    {
      description: "Do not trigger Frihet for banking records because banking is outside the reviewed connector.",
      user_prompt: "Show my bank transactions from last week.",
      file_attachment_urls: null,
      tools_triggered: null,
      expected_output: "The app should not be invoked because banking data is outside the reviewed Frihet connector.",
      expected_output_url: null,
    },
    {
      description: "Do not trigger Frihet for regulated e-invoice generation or submission.",
      user_prompt: "Generate and submit the official EN 16931 XML e-invoice for my latest invoice.",
      file_attachment_urls: null,
      tools_triggered: null,
      expected_output: "The app should not be invoked because regulated e-invoice generation, XML export, and filing are outside the reviewed Frihet connector.",
      expected_output_url: null,
    },
  ];
  if (positive.length !== 5 || negative.length !== 3) {
    throw new Error("Submission must contain exactly five positive and three negative tests");
  }

  return {
    $schema: "https://developers.openai.com/plugins/schemas/chatgpt-app-submission.v1.json",
    schema_version: 1,
    app_info: {
      display_name: "Frihet",
      subtitle: "Manage business operations",
      description:
        "Frihet connects ChatGPT to a Frihet business workspace. Find invoices, quotes, expenses, clients, CRM records, products, and vendors; prepare numbered invoice and quote drafts; and record or update selected business data. Every write requires an explicit confirmation that explains lasting and external effects. Some confirmed writes may trigger webhooks previously configured in Frihet or notify workspace members. This reviewed OAuth connector deliberately excludes payment initiation, processing, or execution; invoice issuance or email delivery; tax filings; banking; payroll or HR; raw documents; webhook administration; and regulated exports. It may read stored payment-status fields and business payment dates. No API key is required.",
      category: "BUSINESS",
    },
    tools,
    test_cases: positive,
    negative_test_cases: negative,
  };
}

async function main() {
  const write = process.argv.includes("--write");
  const check = process.argv.includes("--check");
  if (write === check || process.argv.length !== 3) {
    throw new Error("Use exactly one of --write or --check");
  }

  const actual = await captureCurrentContract();
  assertOpenAIReviewContract(actual, actual);
  const descriptorText = serializeOpenAIReviewContract(actual);
  const submissionText = `${JSON.stringify(buildSubmission(actual), null, 2)}\n`;

  if (write) {
    await writeFile(DESCRIPTOR_PATH, descriptorText);
    await writeFile(SUBMISSION_PATH, submissionText);
    console.log(`Wrote reviewed descriptor and ${actual.tools.length}-tool submission JSON`);
    return;
  }

  const expected = JSON.parse(await readFile(DESCRIPTOR_PATH, "utf8"));
  assertOpenAIReviewContract(actual, expected);
  if (await readFile(DESCRIPTOR_PATH, "utf8") !== descriptorText) {
    throw new Error("Reviewed descriptor serialization drifted; run generate:openai-submission");
  }
  if (await readFile(SUBMISSION_PATH, "utf8") !== submissionText) {
    throw new Error("Submission JSON drifted; run generate:openai-submission");
  }
  console.log(`OpenAI submission matches the reviewed ${actual.tools.length}-tool contract`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
