/**
 * Generated public-surface contract captured through the real MCP SDK.
 *
 * This is the mechanical source for catalogue, alias, discovery, resource, and
 * prompt truth across the npm/full, remote/grouped, and OpenAI/full profiles.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IFrihetClient } from "./client-interface.js";
import {
  CAPABILITY_META_KEY,
  type PublicCapabilityTruth,
} from "./capability-truth.js";
import { FISCAL_MODELO_ALIASES } from "./fiscal-aliases.js";
import { MCP_PROMPT_COUNT } from "./prompts/register-all.js";
import {
  localMcpSurfaceComposition,
  registerMcpSurface,
  remoteMcpSurfaceComposition,
} from "./server-composition.js";
import { GROUPED_META_TOOL_COUNT } from "./tool-exposure.js";

export const PUBLIC_CAPABILITY_CONTRACT_VERSION = 2;

export interface CompactPublicTool {
  name: string;
  annotations?: Record<string, boolean>;
  capability?: PublicCapabilityTruth;
}

export interface CompactPublicSurface {
  tools: CompactPublicTool[];
  resources: string[];
  prompts: string[];
  discovery?: {
    searchTools: CompactPublicTool;
    describeTool: CompactPublicTool;
  };
}

export interface PublicCapabilityContract {
  contractVersion: number;
  catalogue: {
    canonicalOperations: number;
    aliasNames: number;
    discoveryNames: number;
  };
  surfaces: {
    localFull: CompactPublicSurface;
    remoteGrouped: CompactPublicSurface;
    openaiFull: CompactPublicSurface;
  };
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

async function listPromptsOrEmpty(client: Client): Promise<string[]> {
  try {
    const result = await client.listPrompts();
    return result.prompts.map((prompt) => prompt.name).sort();
  } catch (error) {
    if (isMethodNotFound(error)) return [];
    throw error;
  }
}

async function listResourcesOrEmpty(client: Client): Promise<string[]> {
  try {
    const result = await client.listResources();
    return result.resources.map((resource) => resource.uri).sort();
  } catch (error) {
    if (isMethodNotFound(error)) return [];
    throw error;
  }
}

function compactDiscoveryTool(value: unknown): CompactPublicTool {
  if (typeof value !== "object" || value === null) {
    throw new Error("Grouped discovery returned a non-object tool result");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string") {
    throw new Error("Grouped discovery result omitted the tool name");
  }
  return {
    name: record.name,
    ...(record.annotations && typeof record.annotations === "object"
      ? { annotations: record.annotations as Record<string, boolean> }
      : {}),
    ...(record.capability && typeof record.capability === "object"
      ? { capability: record.capability as PublicCapabilityTruth }
      : {}),
  };
}

async function captureDiscoveryTruth(client: Client): Promise<{
  searchTools: CompactPublicTool;
  describeTool: CompactPublicTool;
}> {
  const searched = await client.callTool({
    name: "search_tools",
    arguments: { query: "send_invoice", limit: 1 },
  });
  const searchTools = (
    searched.structuredContent as { tools?: unknown[] } | undefined
  )?.tools;
  if (!Array.isArray(searchTools) || searchTools.length !== 1) {
    throw new Error("search_tools did not return the pinned send_invoice result");
  }

  const described = await client.callTool({
    name: "describe_tool",
    arguments: { name: "send_invoice" },
  });
  return {
    searchTools: compactDiscoveryTool(searchTools[0]),
    describeTool: compactDiscoveryTool(described.structuredContent),
  };
}

async function captureSurface(
  configure: (server: McpServer, client: IFrihetClient) => void,
  captureDiscovery = false,
): Promise<CompactPublicSurface> {
  const server = new McpServer({ name: "public-capability-capture", version: "1.0.0" });
  configure(server, makeRegistrationClient());

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "public-capability-capture-client", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const tools = listed.tools
      .map((tool) => {
        const meta = tool._meta as Record<string, unknown> | undefined;
        const capability = meta?.[CAPABILITY_META_KEY] as PublicCapabilityTruth | undefined;
        return {
          name: tool.name,
          ...(tool.annotations
            ? { annotations: tool.annotations as Record<string, boolean> }
            : {}),
          ...(capability ? { capability } : {}),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    const [resources, prompts] = await Promise.all([
      listResourcesOrEmpty(client),
      listPromptsOrEmpty(client),
    ]);
    const discovery = captureDiscovery
      ? await captureDiscoveryTruth(client)
      : undefined;
    return { tools, resources, prompts, ...(discovery ? { discovery } : {}) };
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

export async function capturePublicCapabilityContract(): Promise<PublicCapabilityContract> {
  const localFull = await captureSurface((server, client) => {
    registerMcpSurface(
      server,
      client,
      localMcpSurfaceComposition(false, false),
    );
  });

  const remoteGrouped = await captureSurface(
    (server, client) => {
      registerMcpSurface(
        server,
        client,
        remoteMcpSurfaceComposition(false, true),
      );
    },
    true,
  );

  const openaiFull = await captureSurface((server, client) => {
    registerMcpSurface(
      server,
      client,
      remoteMcpSurfaceComposition(true, false),
    );
  });

  const aliases = new Set(Object.keys(FISCAL_MODELO_ALIASES));
  const discovery = new Set(["list_tool_groups", "search_tools", "describe_tool"]);
  const canonicalOperations = remoteGrouped.tools.filter(
    (tool) => !aliases.has(tool.name) && !discovery.has(tool.name),
  ).length;

  if (
    localFull.prompts.length !== MCP_PROMPT_COUNT ||
    remoteGrouped.prompts.length !== MCP_PROMPT_COUNT
  ) {
    throw new Error(
      `Prompt count drift: registered ${localFull.prompts.length}/${remoteGrouped.prompts.length}, expected ${MCP_PROMPT_COUNT}`,
    );
  }

  return {
    contractVersion: PUBLIC_CAPABILITY_CONTRACT_VERSION,
    catalogue: {
      canonicalOperations,
      aliasNames: aliases.size,
      discoveryNames: GROUPED_META_TOOL_COUNT,
    },
    surfaces: { localFull, remoteGrouped, openaiFull },
  };
}

function canonicalize(contract: PublicCapabilityContract): PublicCapabilityContract {
  const clone = structuredClone(contract);
  for (const surface of Object.values(clone.surfaces)) {
    surface.tools.sort((left, right) => left.name.localeCompare(right.name));
    surface.resources.sort();
    surface.prompts.sort();
  }
  return clone;
}

export function serializePublicCapabilityContract(
  contract: PublicCapabilityContract,
): string {
  return `${JSON.stringify(canonicalize(contract), null, 2)}\n`;
}

export function assertPublicCapabilityContract(
  actual: PublicCapabilityContract,
  expected: PublicCapabilityContract,
): void {
  if (actual.contractVersion !== PUBLIC_CAPABILITY_CONTRACT_VERSION) {
    throw new Error(`Unsupported public capability contract ${actual.contractVersion}`);
  }

  const fullSurfaces = [actual.surfaces.localFull, actual.surfaces.remoteGrouped];
  for (const surface of fullSurfaces) {
    for (const tool of surface.tools) {
      assertFullToolTruth(tool);
    }
  }

  const serializedActual = serializePublicCapabilityContract(actual);
  const serializedExpected = serializePublicCapabilityContract(expected);
  if (serializedActual !== serializedExpected) {
    throw new Error("Public capability contract drift; regenerate and review the runtime capture");
  }
}

function assertFullToolTruth(tool: CompactPublicTool): void {
  if (!tool.capability) {
    throw new Error(`Full-surface tool ${tool.name} lacks ${CAPABILITY_META_KEY}`);
  }
  if ((tool.capability.callability as string) === "available") {
    throw new Error(`Tool ${tool.name} conflates registration with availability`);
  }
  if (
    tool.capability.externalInteraction &&
    tool.annotations?.openWorldHint !== true
  ) {
    throw new Error(`External tool ${tool.name} must set openWorldHint=true`);
  }
}
