/**
 * Fail-closed contract capture for the ChatGPT-reviewed MCP surface.
 *
 * This intentionally uses a real McpServer, real Client, in-memory MCP
 * transport, and the production registration path. It therefore freezes what
 * tools/list serializes, not an approximation of registration config objects.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IFrihetClient } from "./client-interface.js";
import {
  applyOpenAIReviewProfiles,
  OPENAI_COMMERCIAL_DOCUMENT_NUMBER_TOOLS,
  OPENAI_REVIEWED_TOOL_ALLOWLIST,
} from "./openai-profile.js";
import { SENSITIVE_FIELD_NAMES } from "./redaction.js";
import { registerAllPrompts } from "./prompts/register-all.js";
import { registerAllResources } from "./resources/register-all.js";
import { registerAllTools } from "./tools/register-all.js";

export const OPENAI_REVIEW_CONTRACT_VERSION = 1;
export const OPENAI_REVIEW_BUSINESS_TOOL_COUNT = 53;
export const OPENAI_REVIEW_DISCOVERY_TOOLS = [
  "describe_tool",
  "list_tool_groups",
  "search_tools",
] as const;
export const OPENAI_REVIEW_TOTAL_TOOL_COUNT = 56;

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

/** Capture the exact OpenAI grouped surface over a real tools/list request. */
export async function captureOpenAIReviewMcpSurface(): Promise<OpenAIReviewMcpSurface> {
  const server = new McpServer({
    name: "frihet-openai-review-freeze",
    version: "1.0.0",
  });
  applyOpenAIReviewProfiles(server);
  registerAllTools(server, makeRegistrationClient());
  registerAllResources(server);
  registerAllPrompts(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "frihet-openai-review-freeze-client", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const tools: OpenAIReviewTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...(page.tools as unknown as OpenAIReviewTool[]));
      cursor = page.nextCursor;
    } while (cursor);

    const [prompts, resources] = await Promise.all([
      listPromptsOrEmpty(client),
      listResourcesOrEmpty(client),
    ]);

    return { tools, prompts, resources };
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
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
  const sensitive = new Set(SENSITIVE_FIELD_NAMES.map((field) => field.toLowerCase()));
  const paths = new Set<string>();

  const visit = (
    value: JsonValue | undefined,
    path: string,
    allowed: ReadonlySet<string>,
  ): void => {
    if (value === undefined || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${path}[${index}]`, allowed));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      const normalizedKey = key.toLowerCase();
      if (sensitive.has(normalizedKey) && !allowed.has(normalizedKey)) paths.add(childPath);
      visit(child, childPath, allowed);
    }
  };

  for (const tool of tools) {
    visit(tool.inputSchema, `${tool.name}.inputSchema`, new Set());
    const allowedOutputFields = OPENAI_COMMERCIAL_DOCUMENT_NUMBER_TOOLS.has(tool.name)
      ? new Set(["documentnumber"])
      : new Set<string>();
    visit(tool.outputSchema, `${tool.name}.outputSchema`, allowedOutputFields);
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
  const discovery = new Set<string>(OPENAI_REVIEW_DISCOVERY_TOOLS);
  const businessNames = names.filter((name) => !discovery.has(name));
  if (businessNames.length !== OPENAI_REVIEW_BUSINESS_TOOL_COUNT) {
    throw new Error(
      `OpenAI review surface must expose exactly ${OPENAI_REVIEW_BUSINESS_TOOL_COUNT} business tools; got ${businessNames.length}`,
    );
  }
  const missingDiscovery = OPENAI_REVIEW_DISCOVERY_TOOLS.filter(
    (name) => !names.includes(name),
  );
  if (missingDiscovery.length > 0) {
    throw new Error(`Missing discovery tools: ${missingDiscovery.join(", ")}`);
  }
  const leaks = businessNames.filter(
    (name) => !OPENAI_REVIEWED_TOOL_ALLOWLIST.has(name),
  );
  if (leaks.length > 0) {
    throw new Error(`Non-reviewed tools leaked into OpenAI surface: ${leaks.join(", ")}`);
  }
  if (actual.prompts.length !== 0 || actual.resources.length !== 0) {
    throw new Error(
      `OpenAI review surface must expose 0 prompts and 0 resources; got ${actual.prompts.length} prompts and ${actual.resources.length} resources`,
    );
  }

  const expectedSensitivePaths = schemaSensitivePaths(expected.tools);
  const newSensitivePaths = [...schemaSensitivePaths(actual.tools)].filter(
    (path) => !expectedSensitivePaths.has(path),
  );
  if (newSensitivePaths.length > 0) {
    throw new Error(
      `Sensitive schema fields were introduced outside the reviewed snapshot: ${newSensitivePaths.join(", ")}`,
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
