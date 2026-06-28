/**
 * Tests for the OpenAI × grouped tool-exposure COMPOSITION.
 *
 * openai-mcp.frihet.io now runs BOTH profiles: the OpenAI-safe profile
 * (53 reviewed tools, redaction, openWorldHint justification) AND the grouped
 * progressive-disclosure profile (terse descriptions + 3 discovery meta-tools).
 *
 * This is the Trust-Area-critical surface that the ChatGPT app review covers, so
 * the three invariants below are asserted explicitly:
 *
 *   (1) The 3 grouped meta-tools (search_tools, describe_tool, list_tool_groups)
 *       are PRESENT in OpenAI mode — they register against the real server and
 *       bypass the OpenAI allow-list gate. Live surface = 53 + 3 = 56 tools.
 *   (2) Every one of the 53 reviewed tools has a COLLAPSED (terse) description
 *       AND still carries the per-tool openWorldHint rationale marker that OpenAI
 *       app review requires.
 *   (3) The grouped catalog (what search_tools / describe_tool / list_tool_groups
 *       surface) contains ONLY the 53 reviewed tools — a tool outside the reviewed
 *       set is never returned by search_tools and is rejected by describe_tool.
 *
 * Composition order under test mirrors the worker/stdio init wiring:
 *   applyToolExposureProfile(server, { allowlist }) FIRST (innermost),
 *   applyOpenAIProfile(server) SECOND (outermost).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  applyOpenAIProfile,
  OPENAI_REVIEWED_TOOL_ALLOWLIST,
  OPENAI_ALLOWED_TOOL_COUNT,
} from "../openai-profile.js";
import { applyToolExposureProfile, GROUPED_META_TOOL_COUNT } from "../tool-exposure.js";
import { registerAllTools } from "../tools/register-all.js";
import { registerAllPrompts } from "../prompts/register-all.js";
import { registerAllResources } from "../resources/register-all.js";
import type { IFrihetClient } from "../client-interface.js";

interface ToolConfig {
  title?: string;
  description: string;
  annotations?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: unknown;
}

type ToolHandler = (args?: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
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

/** Client that returns a payload carrying sensitive fields (to test redaction). */
function makeClient(): IFrihetClient {
  return new Proxy(
    {},
    {
      get: (_target, prop) => async (input?: unknown) => {
        if (prop === "createClient") {
          return {
            id: "cli_compose",
            name: "Compose Test Corp",
            email: "test@example.com",
            taxId: "B12345678",
            secret: "should-not-leak",
          };
        }
        return { data: [], total: 0, limit: 10, offset: 0, input };
      },
    },
  ) as IFrihetClient;
}

const asMcp = (s: StubMcpServer) =>
  s as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

/**
 * Build a server with BOTH profiles composed in the production order:
 * grouped (allow-list) first, OpenAI second.
 */
function makeComposedServer(): StubMcpServer {
  const server = new StubMcpServer();
  // 1. grouped FIRST (innermost) — meta-tools bypass the OpenAI gate; catalog
  //    pinned to the reviewed allow-list.
  applyToolExposureProfile(asMcp(server), {
    allowlist: OPENAI_REVIEWED_TOOL_ALLOWLIST,
  });
  // 2. OpenAI SECOND (outermost) — gate/redact/annotate, then collapse.
  applyOpenAIProfile(asMcp(server));
  registerAllTools(asMcp(server), makeClient());
  registerAllResources(asMcp(server));
  registerAllPrompts(asMcp(server));
  return server;
}

const META_TOOLS = ["list_tool_groups", "search_tools", "describe_tool"] as const;

/** Tools that exist on the full server but must NEVER surface in the composed one. */
const NON_REVIEWED_TOOLS = [
  "get_quarterly_taxes",
  "get_invoice_einvoice",
  "send_einvoice",
  "validate_einvoice_xml",
  "create_reservation",
  "payroll_export",
  "invite_team_member",
  "get_modelo_303_summary",
] as const;

describe("openai × grouped composition: invariant (1) — meta-tools present, 53+3 surface", () => {
  test("registers exactly 53 reviewed tools + 3 meta-tools (56 total)", () => {
    const server = makeComposedServer();

    assert.equal(GROUPED_META_TOOL_COUNT, 3);
    assert.equal(OPENAI_ALLOWED_TOOL_COUNT, 53, "advertised reviewed count stays 53");
    assert.equal(
      server.tools.size,
      OPENAI_ALLOWED_TOOL_COUNT + GROUPED_META_TOOL_COUNT,
      "live surface must be the 53 reviewed tools + 3 meta-tools",
    );
    assert.equal(server.tools.size, 56);

    // Prompts still hidden in OpenAI mode.
    assert.equal(server.prompts.length, 0);
    // Resources are hidden too: full-server static fiscal/compliance resources
    // are outside the reviewed ChatGPT app surface.
    assert.equal(server.resources.length, 0);
  });

  test("all 3 discovery meta-tools materialise by name despite the OpenAI allow-list", () => {
    const server = makeComposedServer();
    for (const meta of META_TOOLS) {
      assert.equal(
        server.tools.has(meta),
        true,
        `${meta} must survive OpenAI filtering in the composed surface`,
      );
    }
  });

  test("non-reviewed tools are dropped entirely (defence: openai gate)", () => {
    const server = makeComposedServer();
    for (const name of NON_REVIEWED_TOOLS) {
      assert.equal(
        server.tools.has(name),
        false,
        `${name} must NOT be exposed in the composed OpenAI surface`,
      );
    }
  });

  test("meta-tools are read-only, closed-world catalog lookups (NOT openWorldHint)", () => {
    const server = makeComposedServer();
    for (const meta of META_TOOLS) {
      const ann = server.tools.get(meta)!.config.annotations;
      assert.equal(ann?.readOnlyHint, true, `${meta} must be read-only`);
      assert.equal(ann?.openWorldHint, false, `${meta} must be closed-world`);
      // Their descriptions carry an explicit closed-world rationale already (so
      // the OpenAI rationale-injector does not double-append).
      assert.match(
        server.tools.get(meta)!.config.description,
        /openWorldHint: false/,
        `${meta} description must state the closed-world rationale`,
      );
    }
  });
});

describe("openai × grouped composition: invariant (2) — collapsed + openWorldHint on all 53", () => {
  test("every reviewed tool is collapsed AND carries an openWorldHint rationale", () => {
    const server = makeComposedServer();
    let reviewedCount = 0;

    for (const [name, tool] of server.tools) {
      if ((META_TOOLS as readonly string[]).includes(name)) continue;
      reviewedCount += 1;
      const desc = tool.config.description;

      // Collapsed: terse "[group] summary — full schema via describe_tool('name')."
      assert.match(
        desc,
        /^\[[a-z]+\] /,
        `${name} description must start with the [group] collapsed prefix`,
      );
      assert.ok(
        desc.includes(`describe_tool('${name}')`),
        `${name} description must point to describe_tool`,
      );
      // Terse: collapsed line is short, NOT a multi-paragraph bilingual blob.
      assert.ok(
        desc.length < 400,
        `${name} description must be collapsed (terse), got length ${desc.length}`,
      );

      // openWorldHint rationale marker survives the collapse.
      assert.ok(
        desc.includes("openWorldHint"),
        `${name} collapsed description must still carry an openWorldHint rationale`,
      );
      // Annotation must be an explicit boolean (never null) per OpenAI review.
      assert.equal(
        typeof tool.config.annotations?.["openWorldHint"],
        "boolean",
        `${name} must have an explicit boolean openWorldHint annotation`,
      );
    }

    assert.equal(reviewedCount, OPENAI_ALLOWED_TOOL_COUNT, "must cover all 53 reviewed tools");
  });

  test("open-world tools keep openWorldHint:true rationale; read tools keep false", () => {
    const server = makeComposedServer();

    // The 4 reviewed open-world tools carry the true rationale (and not false).
    for (const name of ["send_invoice", "send_quote", "create_webhook", "update_webhook"]) {
      const tool = server.tools.get(name)!;
      assert.equal(tool.config.annotations?.["openWorldHint"], true, `${name} annotation true`);
      assert.match(
        tool.config.description,
        /openWorldHint: true/,
        `${name} collapsed description must state openWorldHint: true`,
      );
      assert.doesNotMatch(
        tool.config.description,
        /openWorldHint: false/,
        `${name} must not also claim false`,
      );
    }

    // A read-only tool carries the false rationale.
    const li = server.tools.get("list_invoices")!;
    assert.match(li.config.description, /openWorldHint: false/);
    assert.doesNotMatch(li.config.description, /openWorldHint: true/);
  });

  test("collapse does not break OpenAI redaction / input-strip / annotation behavior", async () => {
    const server = makeComposedServer();

    // Government IDs stripped from input schema.
    assert.equal("taxId" in (server.tools.get("create_client")!.config.inputSchema ?? {}), false);
    assert.equal("to" in (server.tools.get("send_invoice")!.config.inputSchema ?? {}), false);
    assert.equal("secret" in (server.tools.get("create_webhook")!.config.inputSchema ?? {}), false);

    // Output redaction wrapper survives the collapse (handler still redacts).
    const result = await server.tools.get("create_client")!.handler({ name: "Compose Test Corp" });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("taxId"), false);
    assert.equal(serialized.includes("B12345678"), false);
    assert.equal(serialized.includes("should-not-leak"), false);
  });
});

describe("openai × grouped composition: invariant (3) — catalog is allow-list-only", () => {
  test("list_tool_groups counts exactly the 53 reviewed tools", async () => {
    const server = makeComposedServer();
    const res = await server.tools.get("list_tool_groups")!.handler({});
    const payload = JSON.parse(res.content[0].text) as {
      groups: Array<{ group: string; toolCount: number }>;
      totalTools: number;
    };
    assert.equal(payload.totalTools, OPENAI_ALLOWED_TOOL_COUNT);
    const sum = payload.groups.reduce((acc, g) => acc + g.toolCount, 0);
    assert.equal(sum, OPENAI_ALLOWED_TOOL_COUNT, "group counts must sum to 53");
    assert.ok(payload.groups.every((g) => g.toolCount > 0), "no empty groups listed");
    // Reviewed surface has no fiscal/stay/pos/hr tools → those groups must be absent.
    for (const forbidden of ["fiscal", "stay", "pos", "hr", "banking"]) {
      assert.ok(
        !payload.groups.some((g) => g.group === forbidden),
        `group ${forbidden} must not appear (no reviewed tools in it)`,
      );
    }
  });

  test("search_tools NEVER returns a tool outside the reviewed allow-list (browse all)", async () => {
    const server = makeComposedServer();
    // Empty query + huge limit = browse the entire catalog.
    const res = await server.tools.get("search_tools")!.handler({ query: "", limit: 500 });
    const payload = JSON.parse(res.content[0].text) as {
      count: number;
      tools: Array<{ name: string }>;
    };
    assert.equal(payload.count, OPENAI_ALLOWED_TOOL_COUNT, "browse-all returns exactly the 53");
    const leaks = payload.tools.filter((t) => !OPENAI_REVIEWED_TOOL_ALLOWLIST.has(t.name));
    assert.deepEqual(leaks, [], "search_tools must not surface any non-reviewed tool");
  });

  test("search_tools for a fiscal term yields nothing (fiscal tools are not in the catalog)", async () => {
    const server = makeComposedServer();
    // 'modelo 303' would top-rank get_modelo_303_summary on the full grouped
    // server. Here that tool is NOT in the catalog, so it must not appear.
    const res = await server.tools.get("search_tools")!.handler({ query: "modelo 303 verifactu" });
    const payload = JSON.parse(res.content[0].text) as {
      tools: Array<{ name: string }>;
    };
    const leaks = payload.tools.filter((t) => !OPENAI_REVIEWED_TOOL_ALLOWLIST.has(t.name));
    assert.deepEqual(leaks, [], "no fiscal/non-reviewed tool may be returned");
    assert.ok(
      !payload.tools.some((t) => t.name === "get_modelo_303_summary"),
      "get_modelo_303_summary (non-reviewed) must never surface",
    );
  });

  test("search_tools group filter cannot reach a non-reviewed group", async () => {
    const server = makeComposedServer();
    // Even explicitly asking for the fiscal group returns nothing, because no
    // fiscal tool was catalogued.
    const res = await server.tools.get("search_tools")!.handler({
      query: "",
      group: "fiscal",
      limit: 100,
    });
    const payload = JSON.parse(res.content[0].text) as { tools: unknown[] };
    assert.equal(payload.tools.length, 0, "fiscal group is empty in the reviewed catalog");
  });

  test("describe_tool serves reviewed tools but REJECTS any tool outside the 53", async () => {
    const server = makeComposedServer();

    // A reviewed tool resolves.
    const ok = await server.tools.get("describe_tool")!.handler({ name: "list_invoices" });
    const okPayload = JSON.parse(ok.content[0].text) as { name: string; description: string };
    assert.equal(ok.isError, undefined);
    assert.equal(okPayload.name, "list_invoices");

    // Every non-reviewed tool is rejected (not in the catalog).
    for (const name of NON_REVIEWED_TOOLS) {
      const res = await server.tools.get("describe_tool")!.handler({ name });
      assert.equal(res.isError, true, `describe_tool('${name}') must error — not in reviewed catalog`);
      const payload = JSON.parse(res.content[0].text) as {
        error: string;
        suggestions: string[];
      };
      assert.match(payload.error, /No tool named/);
      // Suggestions can only ever be reviewed tools — never a leak.
      for (const s of payload.suggestions) {
        assert.ok(
          OPENAI_REVIEWED_TOOL_ALLOWLIST.has(s),
          `describe_tool suggestion '${s}' must be a reviewed tool, not a leak`,
        );
      }
    }
  });
});
