/**
 * Agent-onboarding truth gate.
 *
 * The onboarding contract is a promise made to a machine that cannot argue
 * back, so every claim in it is checked against the live registered surface:
 *
 *   - no phantom tools: every tool name mentioned in the instructions string or
 *     in the descriptor exists in tools/list;
 *   - no phantom safety: every tool the safe workflow calls "read" is actually
 *     readOnlyHint, and every tool it calls "draft" actually defaults to draft;
 *   - no hand-maintained lists: confirmRequired and externalSideEffects are
 *     re-derived here and compared to the committed descriptor;
 *   - no drifting numbers: the instructions string carries no surface counts,
 *     because a count in a per-session prompt is a count nobody regenerates.
 *
 * Run: npm test (after build).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  AGENT_ONBOARDING_CONTRACT_VERSION,
  AGENT_SERVER_INSTRUCTIONS,
  API_KEY_LOCATION,
  captureAgentOnboardingDescriptor,
  serializeAgentOnboardingDescriptor,
} from "../agent-onboarding.js";
import type { IFrihetClient } from "../client-interface.js";
import {
  localMcpSurfaceComposition,
  registerMcpSurface,
} from "../server-composition.js";

/** dist/__tests__/x.test.js → repo root. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readRepoFile = (rel: string): string =>
  readFileSync(resolve(REPO_ROOT, rel), "utf8");

function makeRegistrationClient(): IFrihetClient {
  return new Proxy(
    {},
    { get: () => async () => ({ data: [], total: 0, limit: 0, offset: 0 }) },
  ) as IFrihetClient;
}

interface LiveTool {
  name: string;
  description: string;
  annotations: Record<string, boolean>;
  hasConfirm: boolean;
  externalSideEffects: string[];
}

async function liveSurface(): Promise<LiveTool[]> {
  const server = new McpServer({ name: "onboarding-test", version: "1.0.0" });
  registerMcpSurface(
    server,
    makeRegistrationClient(),
    localMcpSurfaceComposition(false, false),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "onboarding-test-client", version: "1.0.0" }, { capabilities: {} });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    return listed.tools.map((tool) => {
      const meta = tool._meta as Record<string, unknown> | undefined;
      const capability = meta?.["io.frihet/capability"] as
        | { externalSideEffects?: string[] }
        | undefined;
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)
        ?.properties;
      return {
        name: tool.name,
        description: tool.description ?? "",
        annotations: (tool.annotations ?? {}) as Record<string, boolean>,
        hasConfirm: Boolean(properties && Object.hasOwn(properties, "confirm")),
        externalSideEffects: capability?.externalSideEffects ?? [],
      };
    });
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

async function groupedToolNames(): Promise<string[]> {
  const server = new McpServer({ name: "onboarding-test-grouped", version: "1.0.0" });
  registerMcpSurface(
    server,
    makeRegistrationClient(),
    localMcpSurfaceComposition(false, true),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "onboarding-test-grouped-client", version: "1.0.0" }, { capabilities: {} });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

describe("agent onboarding — initialize.instructions", () => {
  test("the server actually passes the instructions to the MCP SDK", () => {
    // Anti-phantom: a doc that promises onboarding text while index.ts never
    // wires it would pass every other assertion in this file.
    const index = readRepoFile("src/index.ts");
    assert.match(index, /instructions:\s*AGENT_SERVER_INSTRUCTIONS/);
  });

  test("initialize surfaces the instructions to a client", async () => {
    const server = new McpServer(
      { name: "instructions-test", version: "1.0.0" },
      { instructions: AGENT_SERVER_INSTRUCTIONS },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "1.0.0" }, { capabilities: {} });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      assert.equal(client.getInstructions(), AGENT_SERVER_INSTRUCTIONS);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  test("every tool named in the instructions exists on some real surface", async () => {
    // The instructions mention full-mode tools and the three grouped-mode
    // discovery tools, so both surfaces count. Callability enum values are
    // snake_case too — they are excluded from the descriptor's own list, not
    // from a hardcoded one, so a renamed enum still trips this test.
    const full = new Set((await liveSurface()).map((tool) => tool.name));
    const grouped = new Set(await groupedToolNames());
    const descriptor = await captureAgentOnboardingDescriptor();
    const vocabulary = new Set<string>(descriptor.capabilityDiscovery.callabilityValues);

    const mentioned = [...AGENT_SERVER_INSTRUCTIONS.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)]
      .map((match) => match[1]!)
      .filter((candidate) => !vocabulary.has(candidate));
    const phantom = mentioned.filter(
      (candidate) => !full.has(candidate) && !grouped.has(candidate),
    );
    assert.deepEqual(phantom, [], `instructions name tools that do not exist: ${phantom.join(", ")}`);
  });

  test("instructions carry no surface count that could drift", () => {
    // "157 canonical operations" in a per-session prompt is a number nobody
    // regenerates. Counts live in docs/agent-onboarding.json, which is gated.
    assert.doesNotMatch(
      AGENT_SERVER_INSTRUCTIONS,
      /\b\d+\s+(tools?|operations?|resources?|prompts?)\b/i,
    );
  });

  test("instructions point at the API-key screen that exists", () => {
    assert.ok(AGENT_SERVER_INSTRUCTIONS.includes(API_KEY_LOCATION));
    // The ERP settings sidebar has no "Developers" section — sending an agent
    // there is an unrecoverable instruction.
    assert.doesNotMatch(readRepoFile("src/index.ts"), /Settings\s*>\s*Developers/);
  });
});

describe("agent onboarding — docs/agent-onboarding.json", () => {
  test("the committed descriptor matches the live surface byte for byte", async () => {
    const captured = serializeAgentOnboardingDescriptor(await captureAgentOnboardingDescriptor());
    assert.equal(
      readRepoFile("docs/agent-onboarding.json"),
      captured,
      "run: npm run generate:agent-onboarding",
    );
  });

  test("confirmRequired is exactly the set of tools declaring a confirm input", async () => {
    const tools = await liveSurface();
    const derived = tools.filter((tool) => tool.hasConfirm).map((tool) => tool.name).sort();
    const descriptor = await captureAgentOnboardingDescriptor();
    assert.deepEqual([...descriptor.humanAuthority.confirmRequired].sort(), derived);
    assert.ok(derived.length > 0, "no confirm guard found — the guard sweep is broken");
  });

  test("externalSideEffects is exactly the set of tools that reach outside Frihet", async () => {
    const tools = await liveSurface();
    const derived = tools
      .filter((tool) => tool.externalSideEffects.length > 0)
      .map((tool) => tool.name)
      .sort();
    const descriptor = await captureAgentOnboardingDescriptor();
    assert.deepEqual(
      descriptor.humanAuthority.externalSideEffects.map((entry) => entry.tool).sort(),
      derived,
    );
  });

  test("the fiscal submission tools are on the human-authority list", async () => {
    // Named explicitly: these are the ones whose absence would be silent and
    // expensive. A refactor that drops their side-effect classification fails here.
    const descriptor = await captureAgentOnboardingDescriptor();
    const listed = new Set(descriptor.humanAuthority.externalSideEffects.map((entry) => entry.tool));
    for (const tool of ["send_einvoice", "face_submit", "ticketbai_submit", "verifactu_resubmit"]) {
      assert.ok(listed.has(tool), `${tool} lost its external-side-effect classification`);
    }
  });

  test("the safe workflow only calls tools that are read-only or draft-defaulting", async () => {
    const tools = new Map((await liveSurface()).map((tool) => [tool.name, tool]));
    const descriptor = await captureAgentOnboardingDescriptor();
    for (const step of descriptor.safeWorkflow.steps) {
      if (step.kind === "handoff") continue;
      const name = step.call.startsWith("resources/read")
        ? null
        : step.call;
      if (name === null) continue;
      const tool = tools.get(name);
      assert.ok(tool, `safe workflow calls a tool that does not exist: ${name}`);
      if (step.kind === "read") {
        assert.equal(tool.annotations.readOnlyHint, true, `${name} is not read-only`);
      } else {
        // A "draft" step must not reach a third party, and the tool's own
        // description must say it defaults to draft.
        assert.deepEqual(tool.externalSideEffects, [], `${name} has external side effects`);
        assert.match(
          tool.description,
          /[Dd]efaults? to draft|as a DRAFT/,
          `${name} no longer documents a draft default`,
        );
      }
    }
  });

  test("the safe workflow never issues, sends or submits", async () => {
    const descriptor = await captureAgentOnboardingDescriptor();
    for (const step of descriptor.safeWorkflow.steps) {
      assert.doesNotMatch(step.call, /^(send_|face_|ticketbai_|ksef_|verifactu_|refund_|delete_)/);
    }
  });

  test("the quickstart records Codex as TOML, not JSON", async () => {
    // A JSON block written into ~/.codex/config.toml is a TOML parse error that
    // takes the operator's whole Codex config down, not just this server.
    const descriptor = await captureAgentOnboardingDescriptor();
    assert.match(descriptor.quickstart["codex"]!.configFormat, /toml/i);
    assert.match(descriptor.quickstart["codex"]!.steps[0]!, /^codex mcp add /);
  });

  test("the quickstart uses the Claude Code CLI rather than a hand-written path", async () => {
    const descriptor = await captureAgentOnboardingDescriptor();
    assert.match(descriptor.quickstart["claude-code"]!.steps[0]!, /^claude mcp add /);
    // ~/.claude/mcp.json is not read by Claude Code; user scope is ~/.claude.json.
    assert.doesNotMatch(descriptor.quickstart["claude-code"]!.configFormat, /\.claude\/mcp\.json/);
  });

  test("contract version is pinned", async () => {
    const descriptor = await captureAgentOnboardingDescriptor();
    assert.equal(descriptor.onboardingContractVersion, AGENT_ONBOARDING_CONTRACT_VERSION);
  });
});
