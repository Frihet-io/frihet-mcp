/**
 * Fail-closed contract capture for the ChatGPT-reviewed MCP surface.
 *
 * This intentionally uses a real McpServer, real Client, in-memory MCP
 * transport, and the production registration path. It therefore captures what
 * tools/list serializes, not an approximation of registration config objects.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IFrihetClient } from "./client-interface.js";
import {
  OPENAI_REVIEW_BUSINESS_CONTEXT_TOP_CLIENTS_MAX,
  OPENAI_REVIEW_DOCUMENT_LINE_ITEM_MAX,
  OPENAI_REVIEW_FREE_TEXT_WARNING,
  OPENAI_REVIEW_FREE_TEXT_WARNING_PATHS,
  OPENAI_REVIEW_LIST_OUTPUT_FIELDS,
  OPENAI_REVIEW_OFFSET_MAX,
  OPENAI_REVIEW_PAGINATION_LIMITS,
  OPENAI_REVIEW_TEXT_INPUT_LIMITS,
  OPENAI_REVIEW_CONFIRM_REQUIRED_TOOLS,
  OPENAI_REVIEWED_TOOL_ALLOWLIST,
  OPENAI_WORKSPACE_WEBHOOK_EVENT_TOOLS,
} from "./openai-profile.js";
import { SENSITIVE_FIELD_NAMES } from "./redaction.js";
import { FRIHET_CONNECTOR_SCOPE } from "./openai-review-oauth.js";
import {
  registerMcpSurface,
  remoteMcpSurfaceComposition,
} from "./server-composition.js";

export const OPENAI_REVIEW_CONTRACT_VERSION = 6;
export const OPENAI_REVIEW_BUSINESS_TOOL_COUNT = 33;
export const OPENAI_REVIEW_TOTAL_TOOL_COUNT = OPENAI_REVIEW_BUSINESS_TOOL_COUNT;

const FORBIDDEN_REVIEW_TOOLS = [
  "get_invoice_pdf",
  "get_monthly_summary",
  "apply_late_fee",
  "update_invoice",
  "mark_invoice_paid",
  "delete_invoice",
  "send_invoice",
  "duplicate_invoice",
  "create_credit_note",
  "delete_client",
  "delete_expense",
  "delete_product",
  "delete_vendor",
  "send_quote",
  "update_quote",
  "list_webhooks",
  "get_webhook",
  "create_webhook",
  "update_webhook",
  "delete_webhook",
] as const;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface OpenAIReviewTool extends Record<string, JsonValue> {
  name: string;
}

export interface OpenAIReviewContract {
  contractVersion: number;
  tools: OpenAIReviewTool[];
  prompts: JsonValue[];
  resources: JsonValue[];
  oauth: Record<string, JsonValue>;
}

export interface OpenAIReviewMcpSurface {
  tools: OpenAIReviewTool[];
  prompts: JsonValue[];
  resources: JsonValue[];
}

function makeRegistrationClient(): IFrihetClient {
  return new Proxy(
    {},
    {
      get: () => async () => ({ data: [], total: 0, limit: 0, offset: 0 }),
    },
  ) as IFrihetClient;
}

export interface OpenAIReviewSdkRuntime {
  Client: typeof Client;
  InMemoryTransport: typeof InMemoryTransport;
  McpServer: typeof McpServer;
}

function isMethodNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === -32601
  );
}

async function listPromptsOrEmpty(client: Client): Promise<JsonValue[]> {
  const prompts: JsonValue[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = await client.listPrompts(cursor ? { cursor } : undefined);
      prompts.push(...(page.prompts as unknown as JsonValue[]));
      cursor = page.nextCursor;
    } while (cursor);
  } catch (error) {
    if (isMethodNotFound(error)) return [];
    throw error;
  }
  return prompts;
}

async function listResourcesOrEmpty(client: Client): Promise<JsonValue[]> {
  const resources: JsonValue[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = await client.listResources(cursor ? { cursor } : undefined);
      resources.push(...(page.resources as unknown as JsonValue[]));
      cursor = page.nextCursor;
    } while (cursor);
  } catch (error) {
    if (isMethodNotFound(error)) return [];
    throw error;
  }
  return resources;
}

/** Capture the exact OpenAI full-description surface with a caller-selected SDK tree. */
export async function captureOpenAIReviewMcpSurfaceWithRuntime(
  sdkRuntime: OpenAIReviewSdkRuntime,
): Promise<OpenAIReviewMcpSurface> {
  const server = new sdkRuntime.McpServer({
    name: "frihet-openai-review-contract",
    version: "1.0.0",
  });
  registerMcpSurface(
    server as unknown as McpServer,
    makeRegistrationClient(),
    remoteMcpSurfaceComposition(true, false),
  );

  const [clientTransport, serverTransport] = sdkRuntime.InMemoryTransport.createLinkedPair();
  // The MCP SDK client parses tools/list through the generic MCP ToolSchema,
  // which currently strips OpenAI's top-level `securitySchemes` extension.
  // Capture the server's actual wire result so this contract proves what the
  // review scanner receives, including both the standard OpenAI field and its
  // legacy `_meta` mirror.
  const wireTools: OpenAIReviewTool[] = [];
  const originalServerSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    if (
      typeof message === "object"
      && message !== null
      && "result" in message
      && typeof message.result === "object"
      && message.result !== null
      && "tools" in message.result
      && Array.isArray(message.result.tools)
    ) {
      wireTools.push(...(message.result.tools as unknown as OpenAIReviewTool[]));
    }
    await originalServerSend(message, options);
  };
  const client = new sdkRuntime.Client(
    { name: "frihet-openai-review-contract-client", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      cursor = page.nextCursor;
    } while (cursor);

    const [prompts, resources] = await Promise.all([
      listPromptsOrEmpty(client),
      listResourcesOrEmpty(client),
    ]);

    return { tools: wireTools, prompts, resources };
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

/** Capture the package-local surface; deploy gates inject the Worker runtime. */
export async function captureOpenAIReviewMcpSurface(): Promise<OpenAIReviewMcpSurface> {
  return captureOpenAIReviewMcpSurfaceWithRuntime({
    Client,
    InMemoryTransport,
    McpServer,
  });
}

export function buildOpenAIReviewContract(
  surface: OpenAIReviewMcpSurface,
  oauth: Record<string, JsonValue>,
): OpenAIReviewContract {
  return {
    contractVersion: OPENAI_REVIEW_CONTRACT_VERSION,
    tools: surface.tools,
    prompts: surface.prompts,
    resources: surface.resources,
    oauth,
  };
}

function canonicalizeValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeValue(child)]),
    );
  }
  return value;
}

/** Canonicalize object-key and tools/list order only; arrays remain semantic. */
export function canonicalizeOpenAIReviewContract(
  contract: OpenAIReviewContract,
): OpenAIReviewContract {
  const canonical = canonicalizeValue(
    contract as unknown as JsonValue,
  ) as unknown as OpenAIReviewContract;
  canonical.tools.sort((left, right) => left.name.localeCompare(right.name));
  return canonical;
}

export function serializeOpenAIReviewContract(contract: OpenAIReviewContract): string {
  return `${JSON.stringify(canonicalizeOpenAIReviewContract(contract), null, 2)}\n`;
}

function schemaSensitivePaths(tools: readonly OpenAIReviewTool[]): Set<string> {
  const sensitive = new Set([
    ...SENSITIVE_FIELD_NAMES.map((field) => field.toLowerCase()),
    // Opaque documents cannot be inspected by field-level redaction. A raw
    // base64 payload on the reviewed surface can therefore smuggle regulated
    // identifiers even when every surrounding JSON key is safe.
    "base64",
    // The reviewed connector does not request or echo precise address fields,
    // nor does its monthly summary expose filing-estimate payloads.
    "address",
    "clientaddress",
    "clientlocation",
    "taxliability",
    "estimatedmodel303",
    "vatpayable",
    "irpfretained",
    "fiscalzone",
    "series",
  ]);
  const paths = new Set<string>();

  const visit = (value: JsonValue | undefined, path: string): void => {
    if (value === undefined || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (sensitive.has(key.toLowerCase())) {
        paths.add(childPath);
      }
      visit(child, childPath);
    }
  };

  for (const tool of tools) {
    visit(tool.inputSchema, `${tool.name}.inputSchema`);
    visit(tool.outputSchema, `${tool.name}.outputSchema`);
  }
  return paths;
}

interface Difference {
  path: string;
  expected: JsonValue | undefined;
  actual: JsonValue | undefined;
}

function firstDifference(
  expected: JsonValue | undefined,
  actual: JsonValue | undefined,
  path = "$",
): Difference | undefined {
  if (Object.is(expected, actual)) return undefined;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return { path, expected, actual };
    }
    if (expected.length !== actual.length) return { path: `${path}.length`, expected: expected.length, actual: actual.length };
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(expected[index], actual[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return undefined;
  }
  if (
    expected !== null &&
    actual !== null &&
    typeof expected === "object" &&
    typeof actual === "object"
  ) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      const difference = firstDifference(expected[key], actual[key], `${path}.${key}`);
      if (difference) return difference;
    }
    return undefined;
  }
  return { path, expected, actual };
}

function preview(value: JsonValue | undefined): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return "<missing>";
  return serialized.length > 180 ? `${serialized.slice(0, 177)}...` : serialized;
}

function jsonObject(
  value: JsonValue | undefined,
): { [key: string]: JsonValue } | undefined {
  return value !== null && value !== undefined && !Array.isArray(value) && typeof value === "object"
    ? value
    : undefined;
}

function assertClosedReviewedOutputSchema(value: JsonValue | undefined, path: string): void {
  if (value === undefined || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      assertClosedReviewedOutputSchema(child, `${path}[${index}]`),
    );
    return;
  }
  if (value.type === "object") {
    if (value.additionalProperties !== false) {
      throw new Error(`${path} must set additionalProperties=false`);
    }
    const properties = value.properties;
    if (
      properties === null
      || Array.isArray(properties)
      || typeof properties !== "object"
      || Object.keys(properties).length === 0
    ) {
      throw new Error(`${path} must declare at least one reviewed property`);
    }
  }
  for (const [key, child] of Object.entries(value)) {
    assertClosedReviewedOutputSchema(child, `${path}.${key}`);
  }
}

function assertClosedReviewedInputSchema(value: JsonValue | undefined, path: string): void {
  if (value === undefined || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      assertClosedReviewedInputSchema(child, `${path}[${index}]`),
    );
    return;
  }
  if (value.type === "object" && value.additionalProperties !== false) {
    throw new Error(`${path} must set additionalProperties=false`);
  }
  for (const [key, child] of Object.entries(value)) {
    assertClosedReviewedInputSchema(child, `${path}.${key}`);
  }
}

function assertReviewedOAuthSecuritySchemes(
  value: JsonValue | undefined,
  path: string,
): void {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`${path} must contain exactly one reviewed OAuth scheme`);
  }
  const scheme = value[0];
  if (
    scheme === null
    || Array.isArray(scheme)
    || typeof scheme !== "object"
    || Object.keys(scheme).sort().join(",") !== "scopes,type"
    || scheme.type !== "oauth2"
    || !Array.isArray(scheme.scopes)
    || scheme.scopes.length !== 1
    || scheme.scopes[0] !== FRIHET_CONNECTOR_SCOPE
  ) {
    throw new Error(`${path} must require only the reviewed connector OAuth scope`);
  }
}

function reviewedInputFieldSchema(
  tool: OpenAIReviewTool | undefined,
  path: string,
): Record<string, JsonValue> | undefined {
  let current: JsonValue | undefined = tool?.inputSchema;
  for (const rawSegment of path.split(".")) {
    const arraySegment = rawSegment.endsWith("[]");
    const segment = arraySegment ? rawSegment.slice(0, -2) : rawSegment;
    if (current === null || Array.isArray(current) || typeof current !== "object") {
      return undefined;
    }
    const properties = current.properties;
    if (properties === null || Array.isArray(properties) || typeof properties !== "object") {
      return undefined;
    }
    current = properties[segment];
    if (arraySegment) {
      if (current === null || Array.isArray(current) || typeof current !== "object") {
        return undefined;
      }
      current = current.items;
    }
  }
  return current !== null && !Array.isArray(current) && typeof current === "object"
    ? current
    : undefined;
}

/**
 * Fail closed on any semantic drift from the reviewed descriptor snapshot.
 */
export function assertOpenAIReviewContract(
  actual: OpenAIReviewContract,
  expected: OpenAIReviewContract,
): void {
  if (actual.contractVersion !== OPENAI_REVIEW_CONTRACT_VERSION) {
    throw new Error(`Unsupported OpenAI review contract version: ${actual.contractVersion}`);
  }
  if (actual.tools.length !== OPENAI_REVIEW_TOTAL_TOOL_COUNT) {
    throw new Error(
      `OpenAI review surface must expose exactly ${OPENAI_REVIEW_TOTAL_TOOL_COUNT} tools; got ${actual.tools.length}`,
    );
  }

  const names = actual.tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length) {
    throw new Error("OpenAI review surface contains duplicate tool names");
  }
  const businessNames = names;
  if (businessNames.length !== OPENAI_REVIEW_BUSINESS_TOOL_COUNT) {
    throw new Error(
      `OpenAI review surface must expose exactly ${OPENAI_REVIEW_BUSINESS_TOOL_COUNT} business tools; got ${businessNames.length}`,
    );
  }
  const forbidden = FORBIDDEN_REVIEW_TOOLS.filter((name) => names.includes(name));
  if (forbidden.length > 0) {
    throw new Error(
      `Unsafe tools are forbidden in the OpenAI review surface: ${forbidden.join(", ")}`,
    );
  }

  const leaks = businessNames.filter(
    (name) => !OPENAI_REVIEWED_TOOL_ALLOWLIST.has(name),
  );
  if (leaks.length > 0) {
    throw new Error(`Non-reviewed tools leaked into OpenAI surface: ${leaks.join(", ")}`);
  }

  const byName = new Map(actual.tools.map((tool) => [tool.name, tool]));
  for (const tool of actual.tools) {
    const annotations = tool.annotations;
    if (
      annotations === null ||
      Array.isArray(annotations) ||
      typeof annotations !== "object"
    ) {
      throw new Error(`${tool.name} must declare annotations`);
    }
    for (const hint of [
      "readOnlyHint",
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
    ]) {
      if (typeof annotations[hint] !== "boolean") {
        throw new Error(`${tool.name}.${hint} must be an explicit boolean`);
      }
    }

    assertReviewedOAuthSecuritySchemes(
      tool.securitySchemes,
      `${tool.name}.securitySchemes`,
    );
    const metadata = tool._meta;
    assertReviewedOAuthSecuritySchemes(
      metadata !== null
      && !Array.isArray(metadata)
      && typeof metadata === "object"
        ? metadata.securitySchemes
        : undefined,
      `${tool.name}._meta.securitySchemes`,
    );
    if (!tool.outputSchema) throw new Error(`${tool.name} must declare an output schema`);
    assertClosedReviewedOutputSchema(tool.outputSchema, `${tool.name}.outputSchema`);
    const inputSchema = tool.inputSchema;
    if (
      inputSchema === null
      || Array.isArray(inputSchema)
      || typeof inputSchema !== "object"
      || inputSchema.type !== "object"
      || inputSchema.additionalProperties !== false
    ) {
      throw new Error(`${tool.name}.inputSchema must be a closed object`);
    }
    assertClosedReviewedInputSchema(inputSchema, `${tool.name}.inputSchema`);
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
    const output = byName.get(name)?.outputSchema;
    const item = output
      && !Array.isArray(output)
      && typeof output === "object"
      && output.properties
      && !Array.isArray(output.properties)
      && typeof output.properties === "object"
      ? output.properties.data
      : undefined;
    const row = item
      && !Array.isArray(item)
      && typeof item === "object"
      && item.items
      && !Array.isArray(item.items)
      && typeof item.items === "object"
      ? item.items
      : undefined;
    if (!row || !Array.isArray(row.required) || !row.required.includes("id")) {
      throw new Error(`${name} rows must require an id after fields projection is removed`);
    }
  }

  for (const [name, expectedFields] of Object.entries(
    OPENAI_REVIEW_LIST_OUTPUT_FIELDS,
  )) {
    const tool = byName.get(name);
    const outputSchema = tool?.outputSchema;
    const outputProperties =
      outputSchema !== null
      && !Array.isArray(outputSchema)
      && typeof outputSchema === "object"
      && outputSchema.properties !== null
      && !Array.isArray(outputSchema.properties)
      && typeof outputSchema.properties === "object"
        ? outputSchema.properties
        : undefined;
    const data = outputProperties?.data;
    const item =
      data !== null
      && !Array.isArray(data)
      && typeof data === "object"
      && data.items !== null
      && !Array.isArray(data.items)
      && typeof data.items === "object"
        ? data.items
        : undefined;
    const itemProperties =
      item?.properties !== null
      && !Array.isArray(item?.properties)
      && typeof item?.properties === "object"
        ? item.properties
        : undefined;
    const actualFields = itemProperties ? Object.keys(itemProperties).sort() : [];
    if (
      actualFields.length !== expectedFields.length
      || actualFields.some((field, index) =>
        field !== [...expectedFields].sort()[index]
      )
    ) {
      throw new Error(`${name} must expose only its reviewed summary fields`);
    }
  }

  for (const [name, maximum] of Object.entries(OPENAI_REVIEW_PAGINATION_LIMITS)) {
    const tool = byName.get(name);
    const inputSchema = tool?.inputSchema;
    const inputProperties =
      inputSchema !== null
      && !Array.isArray(inputSchema)
      && typeof inputSchema === "object"
      && inputSchema.properties !== null
      && !Array.isArray(inputSchema.properties)
      && typeof inputSchema.properties === "object"
        ? inputSchema.properties
        : undefined;
    const limit = inputProperties?.limit;
    const offset = inputProperties?.offset;
    if (
      limit === null
      || Array.isArray(limit)
      || typeof limit !== "object"
      || limit.maximum !== maximum
      || offset === null
      || Array.isArray(offset)
      || typeof offset !== "object"
      || offset.maximum !== OPENAI_REVIEW_OFFSET_MAX
    ) {
      throw new Error(
        `${name} must cap reviewed pagination at ${maximum} rows and offset ${OPENAI_REVIEW_OFFSET_MAX}`,
      );
    }

    const outputSchema = tool?.outputSchema;
    const outputProperties =
      outputSchema !== null
      && !Array.isArray(outputSchema)
      && typeof outputSchema === "object"
      && outputSchema.properties !== null
      && !Array.isArray(outputSchema.properties)
      && typeof outputSchema.properties === "object"
        ? outputSchema.properties
        : undefined;
    const data = outputProperties?.data;
    if (
      data === null
      || Array.isArray(data)
      || typeof data !== "object"
      || data.maxItems !== maximum
    ) {
      throw new Error(`${name} must cap reviewed structured output at ${maximum} rows`);
    }
  }

  for (const [name, limits] of Object.entries(OPENAI_REVIEW_TEXT_INPUT_LIMITS)) {
    const inputSchema = byName.get(name)?.inputSchema;
    const properties =
      inputSchema !== null
      && !Array.isArray(inputSchema)
      && typeof inputSchema === "object"
      && inputSchema.properties !== null
      && !Array.isArray(inputSchema.properties)
      && typeof inputSchema.properties === "object"
        ? inputSchema.properties
        : undefined;
    for (const [field, maximum] of Object.entries(limits)) {
      const fieldSchema = properties?.[field];
      if (
        fieldSchema === null
        || Array.isArray(fieldSchema)
        || typeof fieldSchema !== "object"
        || fieldSchema.maxLength !== maximum
      ) {
        throw new Error(`${name}.${field} must be capped at ${maximum} characters`);
      }
    }
  }

  for (const [name, paths] of Object.entries(OPENAI_REVIEW_FREE_TEXT_WARNING_PATHS)) {
    for (const path of paths) {
      const fieldSchema = reviewedInputFieldSchema(byName.get(name), path);
      if (
        !fieldSchema
        || typeof fieldSchema.description !== "string"
        || !fieldSchema.description.includes(OPENAI_REVIEW_FREE_TEXT_WARNING)
      ) {
        throw new Error(`${name}.${path} must warn against sensitive free-text input`);
      }
    }
  }

  for (const name of ["create_invoice", "create_quote"]) {
    const items = reviewedInputFieldSchema(byName.get(name), "items");
    if (
      !items
      || items.minItems !== 1
      || items.maxItems !== OPENAI_REVIEW_DOCUMENT_LINE_ITEM_MAX
    ) {
      throw new Error(
        `${name}.items must contain 1-${OPENAI_REVIEW_DOCUMENT_LINE_ITEM_MAX} reviewed line items`,
      );
    }
  }

  const businessContextOutput = byName.get("get_business_context")?.outputSchema;
  const businessContextProperties =
    businessContextOutput !== null
    && !Array.isArray(businessContextOutput)
    && typeof businessContextOutput === "object"
    && businessContextOutput.properties !== null
    && !Array.isArray(businessContextOutput.properties)
    && typeof businessContextOutput.properties === "object"
      ? businessContextOutput.properties
      : undefined;
  const topClients = businessContextProperties?.topClients;
  if (
    topClients === null
    || Array.isArray(topClients)
    || typeof topClients !== "object"
    || topClients.maxItems !== OPENAI_REVIEW_BUSINESS_CONTEXT_TOP_CLIENTS_MAX
  ) {
    throw new Error(
      `get_business_context.topClients must cap reviewed output at ${OPENAI_REVIEW_BUSINESS_CONTEXT_TOP_CLIENTS_MAX}`,
    );
  }

  for (const name of ["get_invoice", "create_invoice", "get_quote", "create_quote"]) {
    const output = byName.get(name)?.outputSchema;
    const outputProperties =
      output !== null
      && !Array.isArray(output)
      && typeof output === "object"
      && output.properties !== null
      && !Array.isArray(output.properties)
      && typeof output.properties === "object"
        ? output.properties
        : undefined;
    const items = outputProperties?.items;
    const lineItem =
      items !== null
      && !Array.isArray(items)
      && typeof items === "object"
      && items.items !== null
      && !Array.isArray(items.items)
      && typeof items.items === "object"
        ? items.items
        : undefined;
    const lineItemProperties =
      lineItem?.properties !== null
      && !Array.isArray(lineItem?.properties)
      && typeof lineItem?.properties === "object"
        ? lineItem.properties
        : undefined;
    if (
      !lineItemProperties
      || "id" in lineItemProperties
      || items === null
      || Array.isArray(items)
      || typeof items !== "object"
      || items.maxItems !== OPENAI_REVIEW_DOCUMENT_LINE_ITEM_MAX
    ) {
      throw new Error(
        `${name} must omit unusable reviewed line-item ids and cap output at ${OPENAI_REVIEW_DOCUMENT_LINE_ITEM_MAX} items`,
      );
    }
  }

  for (const name of ["list_client_activities", "log_client_activity"]) {
    const output = byName.get(name)?.outputSchema;
    const outputProperties =
      output !== null
      && !Array.isArray(output)
      && typeof output === "object"
      && output.properties !== null
      && !Array.isArray(output.properties)
      && typeof output.properties === "object"
        ? output.properties
        : undefined;
    const record = name === "list_client_activities"
      ? (() => {
          const data = outputProperties?.data;
          return data !== null
            && !Array.isArray(data)
            && typeof data === "object"
            && data.items !== null
            && !Array.isArray(data.items)
            && typeof data.items === "object"
            ? data.items
            : undefined;
        })()
      : output;
    const recordProperties =
      record !== null
      && !Array.isArray(record)
      && typeof record === "object"
      && record.properties !== null
      && !Array.isArray(record.properties)
      && typeof record.properties === "object"
        ? record.properties
        : undefined;
    if (!recordProperties || "id" in recordProperties || "createdBy" in recordProperties) {
      throw new Error(`${name} must omit unnecessary reviewed activity identifiers and creator markers`);
    }
  }

  for (const name of OPENAI_WORKSPACE_WEBHOOK_EVENT_TOOLS) {
    const annotations = byName.get(name)?.annotations as Record<string, JsonValue> | undefined;
    if (
      annotations?.destructiveHint !== true ||
      annotations?.idempotentHint !== false ||
      annotations?.openWorldHint !== true ||
      annotations?.readOnlyHint !== false
    ) {
      throw new Error(
        `${name} may emit an irreversible workspace webhook and must be destructive, non-idempotent, open-world, and mutating`,
      );
    }
  }

  for (const name of OPENAI_REVIEW_CONFIRM_REQUIRED_TOOLS) {
    const inputSchema = byName.get(name)?.inputSchema;
    if (
      inputSchema === null ||
      Array.isArray(inputSchema) ||
      typeof inputSchema !== "object"
    ) {
      throw new Error(`${name} must declare an input schema`);
    }
    const properties = inputSchema.properties;
    const required = inputSchema.required;
    const confirmSchema =
      properties &&
      !Array.isArray(properties) &&
      typeof properties === "object"
        ? properties.confirm
        : undefined;
    if (
      properties === null ||
      Array.isArray(properties) ||
      typeof properties !== "object" ||
      !("confirm" in properties) ||
      !Array.isArray(required) ||
      !required.includes("confirm") ||
      confirmSchema === null ||
      Array.isArray(confirmSchema) ||
      typeof confirmSchema !== "object" ||
      confirmSchema.const !== true
    ) {
      throw new Error(`${name} must expose confirm as a required literal-true reviewed input`);
    }
  }

  for (const name of ["delete_quote"]) {
    const tool = byName.get(name);
    if (typeof tool?.description !== "string" || /permanently delete/i.test(tool.description)) {
      throw new Error(`${name} must describe draft deletion versus non-draft cancellation truthfully`);
    }
    const outputSchema = jsonObject(tool.outputSchema);
    const outputProperties = jsonObject(outputSchema?.properties);
    const outputRequired = outputSchema?.required;
    const success = jsonObject(outputProperties?.success);
    const result = jsonObject(outputProperties?.result);
    const branches = result?.anyOf;
    const branchObjects = Array.isArray(branches)
      ? branches.map((branch) => jsonObject(branch))
      : [];
    const branchByOutcome = new Map<string, { [key: string]: JsonValue }>();
    for (const branch of branchObjects) {
      const properties = jsonObject(branch?.properties);
      const outcome = jsonObject(properties?.outcome)?.const;
      if (branch && typeof outcome === "string") branchByOutcome.set(outcome, branch);
    }
    const deleted = branchByOutcome.get("deleted");
    const deletedProperties = jsonObject(deleted?.properties);
    const cancelled = branchByOutcome.get("cancelled");
    const cancelledProperties = jsonObject(cancelled?.properties);
    const deletedRequired = deleted?.required;
    const cancelledRequired = cancelled?.required;
    const cancelledStatus = jsonObject(cancelledProperties?.status);
    const cancelledEffects = jsonObject(cancelledProperties?.externalEffects);
    const cancelledEffectItems = jsonObject(cancelledEffects?.items);
    if (
      !outputSchema ||
      outputSchema.type !== "object" ||
      outputSchema.additionalProperties !== false ||
      !outputProperties ||
      Object.keys(outputProperties).length !== 3 ||
      !Array.isArray(outputRequired) ||
      !["success", "id", "result"].every((field) =>
        outputRequired.includes(field)
      ) ||
      outputRequired.length !== 3 ||
      success?.const !== true ||
      !result ||
      branchObjects.length !== 2 ||
      branchObjects.some((branch) => !branch) ||
      branchByOutcome.size !== 2 ||
      !deleted ||
      deleted.type !== "object" ||
      deleted.additionalProperties !== false ||
      !deletedProperties ||
      Object.keys(deletedProperties).length !== 1 ||
      !Array.isArray(deletedRequired) ||
      deletedRequired.length !== 1 ||
      deletedRequired[0] !== "outcome" ||
      !cancelled ||
      cancelled.type !== "object" ||
      cancelled.additionalProperties !== false ||
      !cancelledProperties ||
      Object.keys(cancelledProperties).some((field) =>
        !["outcome", "status", "previousStatus", "externalEffects"].includes(field)
      ) ||
      !Array.isArray(cancelledRequired) ||
      cancelledRequired.length !== 3 ||
      !["outcome", "status", "externalEffects"].every((field) =>
        cancelledRequired.includes(field)
      ) ||
      cancelledStatus?.const !== "cancelled" ||
      cancelledEffects?.type !== "array" ||
      cancelledEffectItems?.type !== "string"
    ) {
      throw new Error(
        `${name} output schema must expose exactly two closed result branches: webhook-free deleted or status=cancelled with external effects`,
      );
    }
  }

  for (const [name, numberField] of [
    ["create_invoice", "invoiceNumber"],
    ["create_quote", "quoteNumber"],
  ] as const) {
    const outputSchema = byName.get(name)?.outputSchema;
    const properties =
      outputSchema !== null
      && !Array.isArray(outputSchema)
      && typeof outputSchema === "object"
      && outputSchema.properties !== null
      && !Array.isArray(outputSchema.properties)
      && typeof outputSchema.properties === "object"
        ? outputSchema.properties
        : undefined;
    const required =
      outputSchema !== null
      && !Array.isArray(outputSchema)
      && typeof outputSchema === "object"
        ? outputSchema.required
        : undefined;
    const status = properties?.status;
    if (
      !properties
      || !Array.isArray(required)
      || !["id", numberField, "status", "externalEffects"].every((field) =>
        required.includes(field)
      )
      || status === null
      || Array.isArray(status)
      || typeof status !== "object"
      || status.const !== "draft"
    ) {
      throw new Error(
        `${name} output schema must require its reserved number and literal draft status`,
      );
    }
  }

  const createOutputContracts: Record<string, {
    required: readonly string[];
    forbidden: readonly string[];
  }> = {
    create_client: { required: ["id", "name", "externalEffects"], forbidden: ["stage"] },
    create_expense: {
      required: ["id", "description", "amount", "date", "taxDeductible", "externalEffects"],
      forbidden: ["paidDate"],
    },
    create_invoice: {
      required: ["id", "invoiceNumber", "clientId", "clientName", "items", "issueDate", "dueDate", "status", "externalEffects"],
      forbidden: ["total"],
    },
    create_product: {
      required: ["id", "name", "unitPrice", "externalEffects"],
      forbidden: ["isActive"],
    },
    create_quote: {
      required: ["id", "quoteNumber", "clientId", "clientName", "items", "issueDate", "status", "externalEffects"],
      forbidden: ["total"],
    },
  };
  for (const [name, contract] of Object.entries(createOutputContracts)) {
    const output = jsonObject(byName.get(name)?.outputSchema);
    const properties = jsonObject(output?.properties);
    const required = output?.required;
    if (
      !properties
      || !Array.isArray(required)
      || !contract.required.every((field) => required.includes(field))
      || contract.forbidden.some((field) => field in properties)
    ) {
      throw new Error(
        `${name} output schema must require guaranteed create fields and omit impossible create-only fields`,
      );
    }
  }

  const createInvoice = byName.get("create_invoice");
  const createInvoiceInput = createInvoice?.inputSchema;
  const createInvoiceProperties =
    createInvoiceInput &&
    !Array.isArray(createInvoiceInput) &&
    typeof createInvoiceInput === "object" &&
    createInvoiceInput.properties &&
    !Array.isArray(createInvoiceInput.properties) &&
    typeof createInvoiceInput.properties === "object"
      ? createInvoiceInput.properties
      : undefined;
  if (!createInvoiceProperties) {
    throw new Error("create_invoice must declare a reviewed input schema");
  }
  const forbiddenInvoiceInputs = [
    "clientId",
    "clientTaxId",
    "clientAddress",
    "clientLocation",
    "status",
    "irpfRate",
    "equivalenceSurchargeRate",
    "prepayment",
    "seriesId",
    "documentNumber",
    "poNumber",
    "operationType",
  ].filter((field) => field in createInvoiceProperties);
  if (forbiddenInvoiceInputs.length > 0) {
    throw new Error(
      `create_invoice must remain draft-only and minimal; forbidden inputs: ${forbiddenInvoiceInputs.join(", ")}`,
    );
  }
  if (
    typeof createInvoice?.description !== "string" ||
    !/draft/i.test(createInvoice.description) ||
    !/(reserves?|assigns?).*document number/i.test(createInvoice.description) ||
    !/(does not|cannot).*(issue|email|submit|file)/i.test(createInvoice.description) ||
    !/(create|link).*client/i.test(createInvoice.description)
  ) {
    throw new Error(
      "create_invoice must disclose draft-only behavior, numbering, and possible client creation",
    );
  }

  const createQuote = byName.get("create_quote");
  const createQuoteInput = createQuote?.inputSchema;
  const createQuoteProperties =
    createQuoteInput &&
    !Array.isArray(createQuoteInput) &&
    typeof createQuoteInput === "object" &&
    createQuoteInput.properties &&
    !Array.isArray(createQuoteInput.properties) &&
    typeof createQuoteInput.properties === "object"
      ? createQuoteInput.properties
      : undefined;
  if (!createQuoteProperties || "status" in createQuoteProperties) {
    throw new Error("create_quote must remain draft-only and hide lifecycle status");
  }
  if (
    typeof createQuote?.description !== "string" ||
    !/draft/i.test(createQuote.description) ||
    !/(reserves?|assigns?).*document number/i.test(createQuote.description) ||
    !/advances?.*numbering counter/i.test(createQuote.description) ||
    !/(create|link).*client/i.test(createQuote.description) ||
    !/(does not|cannot).*(send|accept)/i.test(createQuote.description)
  ) {
    throw new Error(
      "create_quote must disclose draft-only behavior, numbering, and possible client creation",
    );
  }

  for (const name of ["create_expense", "update_expense"]) {
    const description = byName.get(name)?.description;
    if (
      typeof description !== "string" ||
      !/tax-deductible (?:classification|choice)[^.!?]{0,120}affect(?:s)? Frihet's (?:internal )?accounting/i.test(description) ||
      !/(?:does not file anything|files nothing)/i.test(description)
    ) {
      throw new Error(`${name} must disclose the internal tax-classification effect without implying filing`);
    }
  }

  const createExpenseInput = byName.get("create_expense")?.inputSchema;
  const createExpenseProperties =
    createExpenseInput &&
    !Array.isArray(createExpenseInput) &&
    typeof createExpenseInput === "object" &&
    createExpenseInput.properties &&
    !Array.isArray(createExpenseInput.properties) &&
    typeof createExpenseInput.properties === "object"
      ? createExpenseInput.properties
      : undefined;
  const createExpenseRequired =
    createExpenseInput &&
    !Array.isArray(createExpenseInput) &&
    typeof createExpenseInput === "object" &&
    Array.isArray(createExpenseInput.required)
      ? createExpenseInput.required
      : [];
  if (
    !createExpenseProperties ||
    "paidDate" in createExpenseProperties ||
    !createExpenseRequired.includes("date") ||
    !createExpenseRequired.includes("taxDeductible")
  ) {
    throw new Error(
      "create_expense must require an explicit date and deductible choice without marking the expense paid",
    );
  }
  if (
    typeof byName.get("create_expense")?.description !== "string" ||
    !/explicit (?:expense )?date/i.test(byName.get("create_expense")!.description as string) ||
    !/tax-deductible choice/i.test(byName.get("create_expense")!.description as string)
  ) {
    throw new Error("create_expense must disclose its explicit accounting choices");
  }
  const createExpenseConfirm = reviewedInputFieldSchema(
    byName.get("create_expense"),
    "confirm",
  );
  if (
    !createExpenseConfirm
    || typeof createExpenseConfirm.description !== "string"
    || !/separate step[^.!?]*may persist[^.!?]*expense write fails/i.test(
      createExpenseConfirm.description,
    )
  ) {
    throw new Error(
      "create_expense confirmation must disclose the separate vendor-write residual",
    );
  }

  const updateExpenseInput = byName.get("update_expense")?.inputSchema;
  const updateExpenseProperties =
    updateExpenseInput &&
    !Array.isArray(updateExpenseInput) &&
    typeof updateExpenseInput === "object" &&
    updateExpenseInput.properties &&
    !Array.isArray(updateExpenseInput.properties) &&
    typeof updateExpenseInput.properties === "object"
      ? updateExpenseInput.properties
      : undefined;
  if (!updateExpenseProperties || "vendor" in updateExpenseProperties) {
    throw new Error("update_expense must not expose a supplier-name change without vendor identity re-resolution");
  }
  if (
    !("date" in updateExpenseProperties) ||
    !("taxDeductible" in updateExpenseProperties)
  ) {
    throw new Error("update_expense must retain its reviewed date and deductible controls");
  }

  if (actual.prompts.length !== 0 || actual.resources.length !== 0) {
    throw new Error(
      `OpenAI review surface must expose 0 prompts and 0 resources; got ${actual.prompts.length} prompts and ${actual.resources.length} resources`,
    );
  }

  const sensitivePaths = [...schemaSensitivePaths(actual.tools)];
  if (sensitivePaths.length > 0) {
    throw new Error(
      `Sensitive schema fields are forbidden in the OpenAI review surface: ${sensitivePaths.join(", ")}`,
    );
  }

  const expectedSensitivePaths = [...schemaSensitivePaths(expected.tools)];
  if (expectedSensitivePaths.length > 0) {
    throw new Error(
      `Reviewed OpenAI snapshot contains sensitive schema fields: ${expectedSensitivePaths.join(", ")}`,
    );
  }

  const reviewedText = JSON.stringify(actual.tools);
  const forbiddenText = [
    /\btaxId\b/u,
    /\bModelos?\s+\d+/iu,
    /quarterly\s+tax/iu,
    /gestor[ií]a/iu,
    /recurring\s+invoices?/iu,
    /webhook\s+(?:configuration|administration)/iu,
  ].find((pattern) => pattern.test(reviewedText));
  if (forbiddenText) {
    throw new Error(
      `Reviewed descriptor contains excluded-surface prose: ${forbiddenText.source}`,
    );
  }

  const canonicalExpected = canonicalizeOpenAIReviewContract(expected);
  const canonicalActual = canonicalizeOpenAIReviewContract(actual);
  const difference = firstDifference(
    canonicalExpected as unknown as JsonValue,
    canonicalActual as unknown as JsonValue,
  );
  if (difference) {
    throw new Error(
      `OpenAI review descriptor drift at ${difference.path}: expected ${preview(difference.expected)}, got ${preview(difference.actual)}`,
    );
  }
}
