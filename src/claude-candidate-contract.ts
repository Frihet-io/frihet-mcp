/** Exact candidate descriptors from the real SDK; no hosted auth or API claims. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IFrihetClient } from "./client-interface.js";
import {
  CLAUDE_CANDIDATE_INSTRUCTIONS,
  CLAUDE_EXCLUDED_TOOLS,
  CLAUDE_EXCLUDED_RESOURCES,
  CLAUDE_EXCLUDED_PROMPTS,
} from "./claude-profile.js";
import { FISCAL_MODELO_ALIASES } from "./fiscal-aliases.js";
import { localMcpSurfaceComposition, remoteMcpSurfaceComposition, registerMcpSurface } from "./server-composition.js";

async function captureSurface(local: boolean, grouped: boolean) {
  const server = new McpServer({ name: "claude-candidate-capture", version: "1.0.0" }, {
    instructions: CLAUDE_CANDIDATE_INSTRUCTIONS,
  });
  const api = new Proxy({}, { get: () => () => { throw new Error("Descriptor capture must not call the API"); } }) as IFrihetClient;
  registerMcpSurface(server, api, (local ? localMcpSurfaceComposition : remoteMcpSurfaceComposition)(false, grouped, true));
  const client = new Client({ name: "claude-candidate-capture-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = (await client.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name));
    const resources = (await client.listResources()).resources.sort((a, b) => a.uri.localeCompare(b.uri));
    const prompts = (await client.listPrompts()).prompts.sort((a, b) => a.name.localeCompare(b.name));
    const promptContent = await Promise.all(prompts.map(async ({ name }) => ({ name, result: await client.getPrompt({ name }) })));
    const currencies = await client.readResource({ uri: "frihet://config/currencies" });
    const groups = grouped ? (await client.callTool({ name: "list_tool_groups", arguments: {} })).structuredContent : undefined;
    return { tools, resources, prompts, promptContent, currencies, ...(groups ? { groups } : {}) };
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

type CapturedSurface = Awaited<ReturnType<typeof captureSurface>>;

export function assertClaudeCandidateCaptureParity({ localFull, localGrouped, remoteFull, remoteGrouped }: {
  localFull: CapturedSurface;
  localGrouped: CapturedSurface;
  remoteFull: CapturedSurface;
  remoteGrouped: CapturedSurface;
}): void {
  const comparisons: Array<[string, unknown, unknown]> = [
    ["full tools", localFull.tools, remoteFull.tools],
    ["grouped tools", localGrouped.tools, remoteGrouped.tools],
    ["local resources", localFull.resources, localGrouped.resources],
    ["remote resources", remoteFull.resources, remoteGrouped.resources],
    ["grouped discovery", remoteGrouped.groups, localGrouped.groups],
  ];
  for (const [name, surface] of Object.entries({ localGrouped, remoteFull, remoteGrouped })) {
    for (const key of ["prompts", "promptContent", "currencies"] as const) {
      comparisons.push([`${name} ${key}`, localFull[key], surface[key]]);
    }
  }
  for (const [label, expected, actual] of comparisons) {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error(`Claude candidate capture diverged: ${label}`);
    }
  }
}

export async function captureClaudeCandidateContract() {
  const localFull = await captureSurface(true, false);
  const localGrouped = await captureSurface(true, true);
  const remoteFull = await captureSurface(false, false);
  const remoteGrouped = await captureSurface(false, true);
  assertClaudeCandidateCaptureParity({ localFull, localGrouped, remoteFull, remoteGrouped });
  const aliases = Object.fromEntries(Object.entries(FISCAL_MODELO_ALIASES).filter(
    ([alias]) => localFull.tools.some((tool) => tool.name === alias),
  ));
  return {
    contractVersion: 1,
    status: "local-candidate-only",
    inventorySource: "3852413",
    instructions: CLAUDE_CANDIDATE_INSTRUCTIONS,
    catalogue: {
      canonicalOperations: localFull.tools.length - Object.keys(aliases).length,
      aliases,
      discoveryNames: ["list_tool_groups", "search_tools", "describe_tool"],
    },
    exclusions: { tools: CLAUDE_EXCLUDED_TOOLS, resources: CLAUDE_EXCLUDED_RESOURCES, prompts: CLAUDE_EXCLUDED_PROMPTS },
    // Capture all four compositions, store each identical descriptor only once.
    tools: { full: localFull.tools, grouped: localGrouped.tools },
    resources: { local: localFull.resources, remote: remoteFull.resources },
    prompts: localFull.prompts,
    promptContent: localFull.promptContent,
    currencies: localFull.currencies,
    groups: remoteGrouped.groups,
    surfaces: {
      localFull: { tools: "full", resources: "local", toolNames: localFull.tools.length },
      localGrouped: { tools: "grouped", resources: "local", toolNames: localGrouped.tools.length },
      remoteFull: { tools: "full", resources: "remote", toolNames: remoteFull.tools.length },
      remoteGrouped: { tools: "grouped", resources: "remote", toolNames: remoteGrouped.tools.length },
    },
  };
}

export function serializeClaudeCandidateContract(contract: Awaited<ReturnType<typeof captureClaudeCandidateContract>>): string {
  return `${JSON.stringify(contract, null, 2)}\n`;
}
