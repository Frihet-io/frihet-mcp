/**
 * Directory-policy invariants for the reviewed connector (openai-mcp.frihet.io),
 * which is the surface submitted to both the ChatGPT app directory and the
 * Claude connectors directory.
 *
 * Anthropic Software Directory Policy (15 Apr 2026,
 * https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy):
 *   4.A  no transfers of money or execution of financial transactions;
 *   5.C  tool names at most 64 characters;
 *   5.E  every tool carries title, readOnlyHint and destructiveHint.
 *
 * The surface is captured through the production composition path
 * (registerMcpSurface + remoteMcpSurfaceComposition(true, false)) over a real
 * MCP client/server pair, so these assertions hold for what a directory client
 * actually receives, not for the profile tables alone. Forced draft status on
 * create_invoice is pinned separately in openai-profile.test.ts.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  buildPublicCapabilityTruth,
  type ExternalSideEffect,
} from "../capability-truth.js";
import type { IFrihetClient } from "../client-interface.js";
import {
  OPENAI_ALLOWED_TOOL_COUNT,
  OPENAI_REVIEWED_TOOL_ALLOWLIST,
} from "../openai-profile.js";
import {
  registerMcpSurface,
  remoteMcpSurfaceComposition,
} from "../server-composition.js";
import { registerAllTools } from "../tools/register-all.js";

type ToolAnnotations = Record<string, unknown> | undefined;

/** Side effects a directory submission must not reach. */
const DIRECTORY_EXCLUDED_EFFECTS: readonly ExternalSideEffect[] = [
  "money_movement",
  "email_or_invitation",
  "fiscal_or_einvoice_submission",
];

/**
 * create_invoice is classified with a possible fiscal submission on the full
 * catalogue. The reviewed profile forces status=draft, which stays outside
 * issuance, hashing and filing (openai-profile.test.ts pins the forced value).
 */
const FORCED_DRAFT_EXCEPTIONS = new Set(["create_invoice"]);

/** Full-catalogue operations the directory brief names explicitly. */
const NAMED_EXCLUSIONS = [
  "refund_sale",
  "refund_deposit",
  "send_invoice",
  "send_quote",
  "send_einvoice",
  "ticketbai_submit",
  "verifactu_resubmit",
  "payroll_export",
  "create_webhook",
  "list_tool_groups",
  "search_tools",
  "describe_tool",
];

/** Input names that would let one tool dispatch another operation. */
const DISPATCH_INPUT_NAMES = new Set([
  "tool",
  "tool_name",
  "toolName",
  "operation",
  "operationId",
  "method",
  "path",
  "endpoint",
  "url",
  "request",
]);

function recordingClient(calls: string[]): IFrihetClient {
  return new Proxy(
    {},
    {
      get: (_target, prop) => async () => {
        calls.push(String(prop));
        return { data: [], total: 0, limit: 10, offset: 0 };
      },
    },
  ) as IFrihetClient;
}

function fullCatalogue(): Map<string, ToolAnnotations> {
  const tools = new Map<string, ToolAnnotations>();
  const stub = {
    registerTool(name: string, config: { annotations?: ToolAnnotations }) {
      tools.set(name, config.annotations);
    },
  };
  registerAllTools(stub as unknown as McpServer, recordingClient([]));
  return tools;
}

async function connectReviewedSurface(calls: string[]) {
  const server = new McpServer({ name: "frihet-directory-policy", version: "1.0.0" });
  registerMcpSurface(server, recordingClient(calls), remoteMcpSurfaceComposition(true, false));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "directory-policy-client", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe("reviewed connector satisfies the directory policy on the real MCP wire", () => {
  test("tools/list is exactly the reviewed allowlist, with no resources, prompts or meta-tools", async () => {
    const { server, client } = await connectReviewedSurface([]);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      assert.equal(names.length, OPENAI_ALLOWED_TOOL_COUNT);
      assert.deepEqual(names, [...OPENAI_REVIEWED_TOOL_ALLOWLIST].sort());
      const capabilities = client.getServerCapabilities();
      assert.equal(capabilities?.resources, undefined);
      assert.equal(capabilities?.prompts, undefined);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("every tool carries title, readOnlyHint and destructiveHint and a name of at most 64 characters", async () => {
    const { server, client } = await connectReviewedSurface([]);
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        assert.match(tool.name, /^[A-Za-z0-9_-]{1,64}$/u, tool.name);
        assert.equal(typeof tool.title, "string", `${tool.name} title`);
        assert.ok(tool.title!.trim().length > 0, `${tool.name} title is empty`);
        assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} readOnlyHint`);
        assert.equal(typeof tool.annotations?.destructiveHint, "boolean", `${tool.name} destructiveHint`);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("no money-movement, email or fiscal-submission operation reaches the reviewed wire", async () => {
    const catalogue = fullCatalogue();
    const excluded = [...catalogue]
      .filter(([name, annotations]) =>
        !FORCED_DRAFT_EXCEPTIONS.has(name)
        && buildPublicCapabilityTruth(name, annotations as Parameters<typeof buildPublicCapabilityTruth>[1]).externalSideEffects
          .some((effect) => DIRECTORY_EXCLUDED_EFFECTS.includes(effect)))
      .map(([name]) => name);
    // Non-vacuous: the full catalogue really contains the operations at stake.
    for (const name of ["refund_sale", "send_invoice", "send_quote", "ticketbai_submit"]) {
      assert.ok(excluded.includes(name), `${name} must be classified as directory-excluded`);
    }
    for (const name of ["refund_sale", "refund_deposit"]) {
      assert.ok(catalogue.has(name), `${name} must exist in the full catalogue`);
    }

    const { server, client } = await connectReviewedSurface([]);
    try {
      const wire = new Set((await client.listTools()).tools.map((tool) => tool.name));
      for (const name of [...excluded, ...NAMED_EXCLUSIONS]) {
        assert.equal(wire.has(name), false, `${name} leaked into the reviewed surface`);
      }
      for (const name of wire) {
        const effects = buildPublicCapabilityTruth(name, undefined).externalSideEffects;
        assert.equal(effects.includes("money_movement"), false, name);
        assert.equal(effects.includes("email_or_invitation"), false, name);
        if (!FORCED_DRAFT_EXCEPTIONS.has(name)) {
          assert.equal(effects.includes("fiscal_or_einvoice_submission"), false, name);
        }
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("excluded operations cannot be called by name and never reach the backend client", async () => {
    const calls: string[] = [];
    const { server, client } = await connectReviewedSurface(calls);
    try {
      for (const name of NAMED_EXCLUSIONS) {
        let rejected = false;
        try {
          const result = await client.callTool(
            { name, arguments: { id: "dir_policy_probe", confirm: true } },
            CallToolResultSchema,
          );
          rejected = result.isError === true;
        } catch {
          rejected = true;
        }
        assert.equal(rejected, true, `${name} was callable on the reviewed surface`);
      }
      assert.deepEqual(calls, [], "no excluded call may reach the Frihet API client");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("no reviewed tool accepts open input or a parameter that selects another operation", async () => {
    const { server, client } = await connectReviewedSurface([]);
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        const schema = tool.inputSchema as {
          type?: string;
          additionalProperties?: unknown;
          properties?: Record<string, unknown>;
        };
        assert.equal(schema.type, "object", tool.name);
        assert.equal(schema.additionalProperties, false, `${tool.name} input is open`);
        for (const property of Object.keys(schema.properties ?? {})) {
          assert.equal(
            DISPATCH_INPUT_NAMES.has(property),
            false,
            `${tool.name}.${property} could dispatch another operation`,
          );
        }
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
