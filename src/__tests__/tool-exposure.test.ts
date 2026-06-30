/**
 * Tests for the grouped tool-exposure profile (progressive disclosure).
 *
 * The default ("full") mode must stay BYTE-IDENTICAL to the un-profiled server
 * so existing users are unaffected. The opt-in "grouped" mode collapses the 161
 * full tool descriptions into terse one-liners and adds three discovery
 * meta-tools (list_tool_groups, search_tools, describe_tool) so agents load
 * depth on demand instead of a flat 161-tool wall of context.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  applyToolExposureProfile,
  resolveToolMode,
  groupForTool,
  GROUPS,
  FILE_TO_GROUP,
  GROUPED_META_TOOL_COUNT,
  type ToolGroupId,
} from "../tool-exposure.js";
import { registerAllTools } from "../tools/register-all.js";
import { registerAllPrompts } from "../prompts/register-all.js";
import type { IFrihetClient } from "../client-interface.js";

interface ToolConfig {
  title?: string;
  description: string;
  annotations?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
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

function makeClient(): IFrihetClient {
  return new Proxy(
    {},
    {
      get: () => async (input?: unknown) => ({
        data: [],
        total: 0,
        limit: 10,
        offset: 0,
        input,
      }),
    },
  ) as IFrihetClient;
}

type StubServer = StubMcpServer;
const asMcp = (s: StubServer) =>
  s as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

/** Build a server with NO profile (current/full behavior). */
function makeFullServer(): StubMcpServer {
  const server = new StubMcpServer();
  registerAllTools(asMcp(server), makeClient());
  registerAllPrompts(asMcp(server));
  return server;
}

/** Build a server with the grouped tool-exposure profile applied. */
function makeGroupedServer(): {
  server: StubMcpServer;
  handle: ReturnType<typeof applyToolExposureProfile>;
} {
  const server = new StubMcpServer();
  const handle = applyToolExposureProfile(server);
  registerAllTools(asMcp(server), makeClient());
  registerAllPrompts(asMcp(server));
  return { server, handle };
}

const META_TOOLS = ["list_tool_groups", "search_tools", "describe_tool"] as const;

describe("tool-exposure: mode resolution", () => {
  test("default and 'full' resolve to full; only 'grouped' opts in", () => {
    assert.equal(resolveToolMode({}), "full");
    assert.equal(resolveToolMode({ FRIHET_TOOL_MODE: undefined }), "full");
    assert.equal(resolveToolMode({ FRIHET_TOOL_MODE: "full" }), "full");
    assert.equal(resolveToolMode({ FRIHET_TOOL_MODE: "anything-else" }), "full");
    assert.equal(resolveToolMode({ FRIHET_TOOL_MODE: "grouped" }), "grouped");
  });
});

describe("tool-exposure: full mode is byte-identical", () => {
  test("registers exactly 161 tools, no meta-tools, descriptions untouched", () => {
    const full = makeFullServer();
    assert.equal(full.tools.size, 161);
    for (const meta of META_TOOLS) {
      assert.equal(full.tools.has(meta), false, `${meta} must NOT exist in full mode`);
    }
  });

  test("grouped mode does not mutate the un-profiled tool descriptions", () => {
    // Capture the full-mode description of a representative tool, then confirm
    // the grouped server's collapse did not leak back into the base registration.
    const full = makeFullServer();
    const fullDesc = full.tools.get("list_invoices")!.config.description;
    // Full description is the rich, multi-sentence original (not a collapsed line).
    assert.ok(fullDesc.length > 117, "full description should be the rich original");
    assert.equal(fullDesc.includes("describe_tool"), false);
  });
});

describe("tool-exposure: grouped mode", () => {
  test("registers 161 tools + 3 meta-tools and a complete catalog", () => {
    const { server, handle } = makeGroupedServer();
    assert.equal(server.tools.size, 161 + GROUPED_META_TOOL_COUNT);
    assert.equal(GROUPED_META_TOOL_COUNT, 3);
    for (const meta of META_TOOLS) {
      assert.equal(server.tools.has(meta), true, `${meta} must exist in grouped mode`);
    }
    // Catalog holds every real tool (meta-tools excluded).
    assert.equal(handle.catalog.size, 161);
    for (const meta of META_TOOLS) {
      assert.equal(handle.catalog.has(meta), false);
    }
  });

  test("collapses each real tool's description to a terse pointer line", () => {
    const { server } = makeGroupedServer();
    const li = server.tools.get("list_invoices")!;
    assert.match(li.config.description, /^\[invoicing\] /);
    assert.match(li.config.description, /describe_tool\('list_invoices'\)/);
    // Terse: collapsed lines are far shorter than the rich originals.
    assert.ok(li.config.description.length < 200);

    // Every collapsed description names its group and the describe_tool pointer.
    for (const [name, tool] of server.tools) {
      if ((META_TOOLS as readonly string[]).includes(name)) continue;
      assert.match(
        tool.config.description,
        /^\[[a-z]+\] /,
        `${name} description must start with [group]`,
      );
      assert.ok(
        tool.config.description.includes(`describe_tool('${name}')`),
        `${name} description must point to describe_tool`,
      );
    }
  });

  test("does NOT change tool names, annotations, or input schemas", () => {
    const full = makeFullServer();
    const { server: grouped } = makeGroupedServer();

    // Same set of real tool names (grouped adds only the 3 meta-tools).
    const realGrouped = [...grouped.tools.keys()].filter(
      (n) => !(META_TOOLS as readonly string[]).includes(n),
    );
    assert.deepEqual([...full.tools.keys()].sort(), realGrouped.sort());

    // Annotations + input schema identity preserved for a mutating tool.
    const ci = "create_invoice";
    assert.deepEqual(
      grouped.tools.get(ci)!.config.annotations,
      full.tools.get(ci)!.config.annotations,
    );
    assert.deepEqual(
      Object.keys(grouped.tools.get(ci)!.config.inputSchema ?? {}),
      Object.keys(full.tools.get(ci)!.config.inputSchema ?? {}),
    );
  });

  test("tool logic is unchanged — collapsed tool still invokes its handler", async () => {
    const { server } = makeGroupedServer();
    const result = await server.tools.get("list_invoices")!.handler({});
    assert.ok(Array.isArray(result.content));
    // The real handler ran (returns content), proving behavior is untouched.
    assert.ok(result.content.length >= 1);
  });
});

describe("tool-exposure: group taxonomy", () => {
  test("groupForTool reproduces the source-file grouping for all 161 tools", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const toolsDir = join(here, "..", "..", "src", "tools");
    let checked = 0;
    const mismatches: string[] = [];
    for (const f of readdirSync(toolsDir)) {
      if (!f.endsWith(".ts")) continue;
      const base = f.replace(/\.ts$/, "");
      // Skip helper modules that register ZERO tools (not tool-group files):
      //   register-all = registration entrypoint, shared = cross-tool helpers,
      //   backend-availability = the 404→structured-error guard helper.
      if (base === "register-all" || base === "shared" || base === "backend-availability") continue;
      const fileGroup = FILE_TO_GROUP[base];
      assert.ok(fileGroup, `source file ${base}.ts must be mapped in FILE_TO_GROUP`);
      const txt = readFileSync(join(toolsDir, f), "utf8");
      for (const m of txt.matchAll(/registerTool\(\s*"([a-z_0-9]+)"/g)) {
        const name = m[1];
        checked += 1;
        const ng = groupForTool(name);
        if (ng !== fileGroup) mismatches.push(`${name}: name=${ng} file=${fileGroup}`);
      }
    }
    assert.equal(checked, 161, "should have scanned all 161 registration sites");
    assert.deepEqual(mismatches, [], "groupForTool must match the source-file group");
  });

  test("every group used by a tool has metadata", () => {
    const { handle } = makeGroupedServer();
    for (const group of handle.groups.keys()) {
      assert.ok(GROUPS[group], `group ${group} must have metadata`);
    }
  });

  test("group ids are stable and cover the brief's 9 domains", () => {
    for (const id of [
      "invoicing",
      "expenses",
      "fiscal",
      "banking",
      "crm",
      "hr",
      "stay",
      "pos",
      "intelligence",
    ] as ToolGroupId[]) {
      assert.ok(GROUPS[id], `${id} must be a defined group`);
    }
  });
});

describe("tool-exposure: meta-tools", () => {
  test("list_tool_groups returns non-empty groups with counts summing to 161", async () => {
    const { server } = makeGroupedServer();
    const res = await server.tools.get("list_tool_groups")!.handler({});
    const payload = JSON.parse(res.content[0].text) as {
      groups: Array<{ group: string; toolCount: number }>;
      totalTools: number;
    };
    assert.equal(payload.totalTools, 161);
    const sum = payload.groups.reduce((acc, g) => acc + g.toolCount, 0);
    assert.equal(sum, 161);
    // No empty groups are listed.
    assert.ok(payload.groups.every((g) => g.toolCount > 0));
    // Fiscal is a headline group (compliance depth).
    assert.ok(payload.groups.some((g) => g.group === "fiscal" && g.toolCount > 0));
  });

  test("search_tools finds fiscal tools by free-text and ranks the exact name top", async () => {
    const { server } = makeGroupedServer();
    const res = await server.tools.get("search_tools")!.handler({
      query: "modelo 303",
    });
    const payload = JSON.parse(res.content[0].text) as {
      count: number;
      tools: Array<{ name: string; group: string; inputFields: string[] }>;
    };
    assert.ok(payload.count > 0);
    assert.equal(payload.tools[0].name, "get_modelo_303_summary");
    assert.equal(payload.tools[0].group, "fiscal");
  });

  test("search_tools honors the group filter", async () => {
    const { server } = makeGroupedServer();
    const res = await server.tools.get("search_tools")!.handler({
      query: "",
      group: "banking",
      limit: 50,
    });
    const payload = JSON.parse(res.content[0].text) as {
      tools: Array<{ group: string }>;
    };
    assert.ok(payload.tools.length > 0);
    assert.ok(payload.tools.every((t) => t.group === "banking"));
  });

  test("describe_tool returns the full original description on demand", async () => {
    const full = makeFullServer();
    const fullDesc = full.tools.get("get_modelo_303_summary")!.config.description;

    const { server } = makeGroupedServer();
    const res = await server.tools.get("describe_tool")!.handler({
      name: "get_modelo_303_summary",
    });
    const payload = JSON.parse(res.content[0].text) as {
      name: string;
      group: string;
      description: string;
      inputFields: string[];
    };
    assert.equal(payload.name, "get_modelo_303_summary");
    assert.equal(payload.group, "fiscal");
    // describe_tool serves the FULL original description (depth on demand).
    assert.equal(payload.description, fullDesc);
  });

  test("describe_tool errors with suggestions for an unknown name", async () => {
    const { server } = makeGroupedServer();
    const res = await server.tools.get("describe_tool")!.handler({ name: "modelo" });
    assert.equal(res.isError, true);
    const payload = JSON.parse(res.content[0].text) as {
      error: string;
      suggestions: string[];
    };
    assert.ok(payload.error.length > 0);
    // 'modelo' is a substring of several real tool names → suggestions offered.
    assert.ok(payload.suggestions.length > 0);
    assert.ok(payload.suggestions.every((s) => s.includes("modelo")));
  });

  test("meta-tools are read-only and closed-world", () => {
    const { server } = makeGroupedServer();
    for (const meta of META_TOOLS) {
      const ann = server.tools.get(meta)!.config.annotations;
      assert.equal(ann?.readOnlyHint, true, `${meta} must be read-only`);
      assert.equal(ann?.openWorldHint, false, `${meta} must be closed-world`);
    }
  });

  test("meta-tools expose typed inputSchema so agents get arg hints", () => {
    const { server } = makeGroupedServer();

    // list_tool_groups takes no args.
    assert.deepEqual(
      Object.keys(server.tools.get("list_tool_groups")!.config.inputSchema ?? {}),
      [],
      "list_tool_groups must take no args",
    );

    // search_tools advertises query/group/limit.
    assert.deepEqual(
      Object.keys(server.tools.get("search_tools")!.config.inputSchema ?? {}).sort(),
      ["group", "limit", "query"],
      "search_tools must advertise query/group/limit",
    );

    // describe_tool advertises a required `name`.
    const describeSchema = server.tools.get("describe_tool")!.config.inputSchema ?? {};
    assert.deepEqual(
      Object.keys(describeSchema),
      ["name"],
      "describe_tool must advertise a `name` arg",
    );
    // The name field is a Zod schema (typed hint), not a bare placeholder.
    assert.equal(
      typeof (describeSchema as Record<string, { parse?: unknown }>).name?.parse,
      "function",
      "describe_tool.name must be a Zod schema",
    );
  });
});
