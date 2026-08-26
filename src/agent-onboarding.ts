/**
 * Agent-native onboarding contract.
 *
 * Two artefacts, one source:
 *
 *   1. `AGENT_SERVER_INSTRUCTIONS` — the MCP `instructions` string returned by
 *      `initialize`. Every MCP client hands this to the model before the first
 *      tool call, so it is the only onboarding channel that costs the human
 *      zero configuration. It deliberately contains NO counts: a number in a
 *      per-session prompt is a number that drifts. It teaches the *mechanism*
 *      for finding the current numbers instead.
 *
 *   2. `captureAgentOnboardingDescriptor()` — the machine-readable descriptor
 *      written to `docs/agent-onboarding.json` by
 *      `scripts/generate-agent-onboarding.mjs`. It is captured through the real
 *      MCP SDK against the real registration path, so the tool lists in it
 *      cannot drift from the server: `npm run gate:agent-onboarding` re-captures
 *      and byte-compares.
 *
 * Nothing here registers a tool, a resource or a prompt. The surface counts the
 * conformance baseline and the public capability contract already pin are
 * unchanged by this module, on purpose.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { CAPABILITY_META_KEY, type PublicCapabilityTruth } from "./capability-truth.js";
import type { IFrihetClient } from "./client-interface.js";
import {
  localMcpSurfaceComposition,
  registerMcpSurface,
} from "./server-composition.js";

export const AGENT_ONBOARDING_CONTRACT_VERSION = 1;

/** Where an API key actually comes from — a deep link, not a navigation
 *  instruction, so the human has one click instead of a hunt.
 *
 *  Verified against the ERP: `settingsSectionToPath` renders `/settings/<id>`
 *  and `api` is in `ALL_SETTINGS_SECTIONS`, so this URL resolves to the
 *  ApiKeysSettings panel. The old index.ts wording ("Settings > Developers >
 *  API Keys") pointed at a section that does not exist. */
export const API_KEY_LOCATION = "https://app.frihet.io/settings/api";

/* ------------------------------------------------------------------ */
/*  1. initialize.instructions                                         */
/* ------------------------------------------------------------------ */

export const AGENT_SERVER_INSTRUCTIONS = `Frihet ERP — real business and fiscal records. Read freely, propose before you mutate.

AUTH
- Local (stdio): FRIHET_API_KEY=fri_... — create one at ${API_KEY_LOCATION}.
- No key yet: FRIHET_DEMO=1 serves example fixtures. No network call, nothing persisted, demo_-prefixed IDs, fiscal actions simulated.
- Hosted: https://mcp.frihet.io/mcp — OAuth 2.1 + PKCE, or Authorization: Bearer fri_...

ORIENT BEFORE ACTING (read-only)
- get_business_context — fiscal zone, currency, IRPF/IVA defaults, plan limits. Call this first; the correct tax treatment depends on it.
- Resources frihet://tax/rates and frihet://tax/calendar carry the Spanish rate table (IVA / IGIC / IPSI) and the filing deadlines. Read them instead of recalling a rate.

CAPABILITY DISCOVERY
- Every tool in tools/list carries _meta["${CAPABILITY_META_KEY}"] = {callability, writesFrihet, externalInteraction, externalSideEffects}. Read it before you call.
- callability is a conservative fact, not a promise: api_dependent | runtime_checked | deferred | unavailable | local. Registration does NOT mean the backing API is enabled for this workspace; deferred and unavailable tools will refuse.
- Large surface: set FRIHET_TOOL_MODE=grouped for progressive disclosure (list_tool_groups, search_tools, describe_tool) instead of loading every schema.

THE SAFE WORKFLOW — draft, show, stop
- create_invoice defaults to status=draft: no fiscal number, no hash, nothing submitted to a tax authority. create_quote and create_credit_note are drafts too.
- Build the draft, read it back, present it to the human, and stop there. Issuing is a separate, human-authorised step.

HUMAN AUTHORITY — do not call unprompted
- Any tool whose capability shows a non-empty externalSideEffects reaches outside Frihet — email to a client, webhook delivery, money movement, or a submission to AEAT / VeriFactu / TicketBAI / FACe. You cannot undo those.
- Several also take confirm=true. That flag records the human's decision. Never set it to satisfy your own plan; ask, then pass what you were told.
- delete_invoice does not always delete: an issued invoice is CANCELLED (status=cancelled) because VeriFactu forbids breaking the hash chain. Same for quotes.

WHEN A CALL FAILS
- Errors carry sanitized remediation text — read it, do not guess. 401 = key; 403 = scope or plan; 429 = wait Retry-After seconds.
- After 409 IDEMPOTENCY_REQUEST_IN_PROGRESS, do NOT retry with a fresh Idempotency-Key. Read the resource back and decide from its actual state; a new key would create a second fiscal document.

Machine-readable version of this contract: https://github.com/Frihet-io/frihet-mcp/blob/main/docs/agent-onboarding.json`;

/* ------------------------------------------------------------------ */
/*  2. docs/agent-onboarding.json                                      */
/* ------------------------------------------------------------------ */

export interface AgentOnboardingDescriptor {
  onboardingContractVersion: number;
  server: {
    mcpName: string;
    npmPackage: string;
    remoteEndpoint: string;
    transport: readonly string[];
  };
  auth: {
    envVar: string;
    keyFormat: string;
    obtainAt: string;
    remoteMethods: readonly string[];
    noAuthTrial: { env: Record<string, string>; persists: false; network: false };
  };
  /** One verified command per client. Every `command` here was executed against
   *  the real binary in an isolated HOME before being written down. */
  quickstart: Record<
    string,
    {
      steps: readonly string[];
      configFormat: string;
      verify: string;
    }
  >;
  capabilityDiscovery: {
    metaKey: string;
    callabilityValues: readonly string[];
    groupedModeEnv: Record<string, string>;
    counts: {
      toolNames: number;
      readOnly: number;
      writesFrihet: number;
      externalInteraction: number;
      destructive: number;
      resources: number;
      prompts: number;
    };
  };
  safeWorkflow: {
    description: string;
    steps: readonly { call: string; kind: string; note: string }[];
  };
  humanAuthority: {
    rule: string;
    confirmRequired: readonly string[];
    externalSideEffects: readonly { tool: string; effects: readonly string[] }[];
  };
  errors: readonly { condition: string; meaning: string; agentAction: string }[];
}

interface CapturedTool {
  name: string;
  annotations: Record<string, boolean>;
  capability?: PublicCapabilityTruth;
  hasConfirm: boolean;
}

function makeRegistrationClient(): IFrihetClient {
  return new Proxy(
    {},
    { get: () => async () => ({ data: [], total: 0, limit: 0, offset: 0 }) },
  ) as IFrihetClient;
}

/** True when the tool's JSON Schema declares a top-level `confirm` property.
 *  Derived, never hand-listed — a new confirm guard shows up in the descriptor
 *  on the next generate, and the gate fails until it is committed. */
function declaresConfirm(inputSchema: unknown): boolean {
  if (typeof inputSchema !== "object" || inputSchema === null) return false;
  const properties = (inputSchema as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) return false;
  return Object.hasOwn(properties, "confirm");
}

async function captureLocalFullSurface(): Promise<{
  tools: CapturedTool[];
  resources: number;
  prompts: number;
}> {
  const server = new McpServer({
    name: "agent-onboarding-capture",
    version: "1.0.0",
  });
  registerMcpSurface(
    server,
    makeRegistrationClient(),
    localMcpSurfaceComposition(false, false),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "agent-onboarding-capture-client", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const listed = await client.listTools();
    const tools: CapturedTool[] = listed.tools
      .map((tool) => {
        const meta = tool._meta as Record<string, unknown> | undefined;
        const capability = meta?.[CAPABILITY_META_KEY] as
          | PublicCapabilityTruth
          | undefined;
        return {
          name: tool.name,
          annotations: (tool.annotations ?? {}) as Record<string, boolean>,
          ...(capability ? { capability } : {}),
          hasConfirm: declaresConfirm(tool.inputSchema),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    const [resources, prompts] = await Promise.all([
      client.listResources(),
      client.listPrompts(),
    ]);
    return {
      tools,
      resources: resources.resources.length,
      prompts: prompts.prompts.length,
    };
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

export async function captureAgentOnboardingDescriptor(): Promise<AgentOnboardingDescriptor> {
  const { tools, resources, prompts } = await captureLocalFullSurface();

  const confirmRequired = tools
    .filter((tool) => tool.hasConfirm)
    .map((tool) => tool.name);

  const externalSideEffects = tools
    .filter((tool) => (tool.capability?.externalSideEffects.length ?? 0) > 0)
    .map((tool) => ({
      tool: tool.name,
      effects: [...(tool.capability?.externalSideEffects ?? [])],
    }));

  return {
    onboardingContractVersion: AGENT_ONBOARDING_CONTRACT_VERSION,
    server: {
      mcpName: "io.frihet/erp",
      npmPackage: "@frihet/mcp-server",
      remoteEndpoint: "https://mcp.frihet.io/mcp",
      transport: ["stdio", "streamable-http"],
    },
    auth: {
      envVar: "FRIHET_API_KEY",
      keyFormat: "fri_<key>",
      obtainAt: API_KEY_LOCATION,
      remoteMethods: ["oauth2.1-pkce", "bearer"],
      noAuthTrial: {
        env: { FRIHET_DEMO: "1" },
        persists: false,
        network: false,
      },
    },
    quickstart: {
      "claude-code": {
        steps: [
          "claude mcp add frihet -s user -e FRIHET_API_KEY=fri_... -- npx -y @frihet/mcp-server",
        ],
        configFormat: "managed by the CLI (user scope writes ~/.claude.json)",
        verify: "claude mcp list",
      },
      codex: {
        steps: [
          "codex mcp add frihet --env FRIHET_API_KEY=fri_... -- npx -y @frihet/mcp-server",
        ],
        configFormat: "toml (~/.codex/config.toml — JSON in this file is a parse error)",
        verify: "codex mcp list",
      },
      "generic-mcp-client-stdio": {
        steps: [
          'mcpServers.frihet = { "command": "npx", "args": ["-y", "@frihet/mcp-server"], "env": { "FRIHET_API_KEY": "fri_..." } }',
        ],
        configFormat: "json",
        verify: "initialize → tools/list returns a non-empty catalogue",
      },
      "generic-mcp-client-http": {
        steps: [
          'mcpServers.frihet = { "type": "streamable-http", "url": "https://mcp.frihet.io/mcp", "headers": { "Authorization": "Bearer fri_..." } }',
        ],
        configFormat: "json",
        verify: "initialize → tools/list returns a non-empty catalogue",
      },
    },
    capabilityDiscovery: {
      metaKey: CAPABILITY_META_KEY,
      callabilityValues: [
        "api_dependent",
        "runtime_checked",
        "deferred",
        "unavailable",
        "local",
      ],
      groupedModeEnv: { FRIHET_TOOL_MODE: "grouped" },
      counts: {
        toolNames: tools.length,
        readOnly: tools.filter((tool) => tool.annotations.readOnlyHint === true)
          .length,
        writesFrihet: tools.filter(
          (tool) => tool.capability?.writesFrihet === true,
        ).length,
        externalInteraction: externalSideEffects.length,
        destructive: tools.filter(
          (tool) => tool.annotations.destructiveHint === true,
        ).length,
        resources,
        prompts,
      },
    },
    safeWorkflow: {
      description:
        "Discover → orient → retrieve → draft → hand back. No step issues a document or reaches a third party.",
      steps: [
        {
          call: "get_business_context",
          kind: "read",
          note: "Fiscal zone, currency and defaults. Everything downstream depends on it.",
        },
        {
          call: "resources/read frihet://tax/rates",
          kind: "read",
          note: "Authoritative IVA / IGIC / IPSI table. Do not recall a rate from memory.",
        },
        {
          call: "list_clients",
          kind: "read",
          note: "Resolve the client by name before referencing an id.",
        },
        {
          call: "create_invoice",
          kind: "draft",
          note: "Defaults to status=draft — no fiscal number, no hash, no AEAT submission.",
        },
        {
          call: "get_invoice",
          kind: "read",
          note: "Read the draft back and present the computed totals to the human.",
        },
        {
          call: "STOP",
          kind: "handoff",
          note: "Issuing and sending are human-authorised. Report the draft id and the exact next action; do not take it.",
        },
      ],
    },
    humanAuthority: {
      rule: "Do not call a tool with non-empty externalSideEffects, and do not set confirm=true, without an explicit human instruction for that specific action.",
      confirmRequired,
      externalSideEffects,
    },
    errors: [
      {
        condition: "startup exits 1 with code FRIHET_API_KEY_MISSING",
        meaning: "No credential in the environment.",
        agentAction:
          "Ask the human for a key from " +
          API_KEY_LOCATION +
          ", or re-launch with FRIHET_DEMO=1 to explore without one.",
      },
      {
        condition: "HTTP 401",
        meaning: "Key missing, malformed or revoked.",
        agentAction: "Stop and ask for a new key. Do not retry.",
      },
      {
        condition: "HTTP 403",
        meaning: "The key is valid but lacks the scope, or the plan excludes it.",
        agentAction:
          "Report which operation was refused. Do not try a different tool to route around it.",
      },
      {
        condition: "HTTP 429",
        meaning: "Rate limited.",
        agentAction: "Wait the Retry-After seconds, then retry once.",
      },
      {
        condition: "HTTP 409 IDEMPOTENCY_REQUEST_IN_PROGRESS",
        meaning:
          "The first attempt's outcome could not be recorded; the server refuses to execute twice.",
        agentAction:
          "Read the resource back and reconcile from its actual state. Never retry with a fresh Idempotency-Key.",
      },
      {
        condition: "capability.callability is deferred or unavailable",
        meaning: "The tool is registered but the backing API is not serving it.",
        agentAction:
          "Do not call it. Tell the human the capability is not live for this workspace.",
      },
    ],
  };
}

export function serializeAgentOnboardingDescriptor(
  descriptor: AgentOnboardingDescriptor,
): string {
  return JSON.stringify(descriptor, null, 2) + "\n";
}
