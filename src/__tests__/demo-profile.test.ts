/**
 * Tests for the demo profile (FRIHET_DEMO=1) server-side guardrail.
 *
 * The guardrail is: EVERY tool response — success OR error, business tool OR
 * discovery meta-tool, in full OR grouped mode — carries the `_demo: true`
 * marker + the demo banner. These tests pin the pieces the review found holes
 * in:
 *   1. Composition order: applyDemoProfile MUST run before
 *      applyToolExposureProfile so the eagerly-registered grouped meta-tools
 *      (list_tool_groups / search_tools / describe_tool) inherit the banner.
 *   2. Error path (handler throws/rejects) still carries the banner.
 *   3. SDK-generated error results (createToolError — input-schema validation)
 *      still carry the banner.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  applyDemoProfile,
  stampResult,
  stampError,
  DEMO_BANNER,
} from "../demo/demo-profile.js";
import { applyToolExposureProfile } from "../tool-exposure.js";

/* ------------------------------------------------------------------ */
/*  Minimal stub server                                                */
/* ------------------------------------------------------------------ */

type ToolHandler = (args?: unknown, extra?: unknown) => unknown;
interface RegisteredTool {
  name: string;
  config: Record<string, unknown>;
  handler: ToolHandler;
}

class StubMcpServer {
  tools = new Map<string, RegisteredTool>();
  registerTool(name: string, config: Record<string, unknown>, handler: ToolHandler): void {
    this.tools.set(name, { name, config, handler });
  }
  /** Mirrors the MCP SDK's own error-result shape (server/mcp.js). */
  createToolError(message: string): unknown {
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asMcp = (s: StubMcpServer) => s as any;

interface StampedResult {
  content?: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function invoke(server: StubMcpServer, name: string): Promise<StampedResult> {
  const tool = server.tools.get(name);
  assert.ok(tool, `tool ${name} must be registered`);
  return (await tool!.handler({}, {})) as StampedResult;
}

function assertBanner(res: StampedResult, label: string): void {
  assert.equal(res.structuredContent?._demo, true, `${label}: structuredContent._demo === true`);
  assert.equal(
    res.structuredContent?._demoNotice,
    DEMO_BANNER,
    `${label}: _demoNotice is the exact banner`,
  );
  const firstText = res.content?.[0]?.text ?? "";
  assert.ok(firstText.includes("DEMO MODE"), `${label}: first content block carries the DEMO MODE banner`);
}

const META_TOOLS = ["list_tool_groups", "search_tools", "describe_tool"] as const;

/* ------------------------------------------------------------------ */
/*  stampResult / stampError                                           */
/* ------------------------------------------------------------------ */

describe("demo-profile: stampResult", () => {
  test("adds _demo + notice to structuredContent and prepends the banner", () => {
    const res = stampResult({
      content: [{ type: "text", text: "hello" }],
      structuredContent: { data: [1, 2, 3] },
    }) as StampedResult;
    assert.equal(res.structuredContent?._demo, true);
    assert.equal(res.structuredContent?._demoNotice, DEMO_BANNER);
    assert.deepEqual(res.structuredContent?.data, [1, 2, 3]);
    assert.equal(res.content?.length, 2);
    assert.ok(res.content?.[0]?.text?.includes("DEMO MODE"));
    assert.equal(res.content?.[1]?.text, "hello");
  });

  test("creates structuredContent when the tool returned none", () => {
    const res = stampResult({ content: [{ type: "text", text: "x" }] }) as StampedResult;
    assert.equal(res.structuredContent?._demo, true);
  });

  test("wraps a non-object result in a banner-bearing envelope", () => {
    const res = stampResult("raw string") as StampedResult;
    assert.equal(res.structuredContent?._demo, true);
    assert.equal(res.structuredContent?.value, "raw string");
  });
});

describe("demo-profile: stampError", () => {
  test("produces an isError result that carries the banner + message", () => {
    const res = stampError(new Error("boom")) as StampedResult;
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?._demo, true);
    assert.equal(res.structuredContent?.error, "boom");
    assert.ok(res.content?.[0]?.text?.includes("DEMO MODE"));
    assert.equal(res.content?.[1]?.text, "boom");
  });
});

/* ------------------------------------------------------------------ */
/*  applyDemoProfile — happy + error paths                             */
/* ------------------------------------------------------------------ */

describe("demo-profile: applyDemoProfile stamps tool responses", () => {
  test("business-tool success result carries the banner", async () => {
    const server = new StubMcpServer();
    applyDemoProfile(asMcp(server));
    server.registerTool("list_things", {}, async () => ({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { data: [] },
    }));
    assertBanner(await invoke(server, "list_things"), "list_things");
  });

  test("a handler that THROWS still returns a stamped error result (P1.4)", async () => {
    const server = new StubMcpServer();
    applyDemoProfile(asMcp(server));
    server.registerTool("kaboom", {}, async () => {
      throw new Error("handler exploded");
    });
    const res = await invoke(server, "kaboom");
    assert.equal(res.isError, true, "throwing handler yields isError:true");
    assertBanner(res, "kaboom (throw)");
    assert.equal(res.structuredContent?.error, "handler exploded");
  });

  test("a handler that REJECTS still returns a stamped error result (P1.4)", async () => {
    const server = new StubMcpServer();
    applyDemoProfile(asMcp(server));
    server.registerTool("nope", {}, () => Promise.reject(new Error("rejected")));
    const res = await invoke(server, "nope");
    assert.equal(res.isError, true);
    assertBanner(res, "nope (reject)");
    assert.equal(res.structuredContent?.error, "rejected");
  });

  test("createToolError (SDK validation errors) is stamped with the banner (P1.5)", () => {
    const server = new StubMcpServer();
    applyDemoProfile(asMcp(server));
    // Simulate the SDK's CallTool catch block funnelling an input-schema
    // validation failure through server.createToolError.
    const res = server.createToolError(
      "Input validation error: Invalid arguments for tool describe_tool",
    ) as StampedResult;
    assert.equal(res.isError, true, "createToolError result stays isError:true");
    assert.equal(res.structuredContent?._demo, true, "validation error carries _demo");
    assert.ok(res.content?.[0]?.text?.includes("DEMO MODE"), "validation error carries banner");
    assert.ok(
      res.content?.some((c) => c.text.includes("Input validation error")),
      "original validation message preserved",
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Composition order — the primary review finding                     */
/* ------------------------------------------------------------------ */

describe("demo-profile x tool-exposure composition order", () => {
  test("demo BEFORE grouped → the 3 meta-tools carry the banner (the fix)", async () => {
    const server = new StubMcpServer();
    applyDemoProfile(asMcp(server)); // FIRST — matches index.ts wiring
    applyToolExposureProfile(asMcp(server)); // SECOND — captures the demo wrapper
    // Register a couple of real-ish tools so the catalog is non-empty.
    server.registerTool(
      "list_invoices",
      { description: "List invoices / Lista facturas", annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: "text", text: "[]" }], structuredContent: { data: [] } }),
    );

    for (const meta of META_TOOLS) {
      assertBanner(await invoke(server, meta), `${meta} (demo→grouped)`);
    }
    // A regular tool in the composed setup also carries the banner.
    assertBanner(await invoke(server, "list_invoices"), "list_invoices (composed)");
  });

  test("grouped BEFORE demo → meta-tools MISS the banner (documents why order matters)", async () => {
    const server = new StubMcpServer();
    applyToolExposureProfile(asMcp(server)); // WRONG order (the original bug)
    applyDemoProfile(asMcp(server));

    for (const meta of META_TOOLS) {
      const res = await invoke(server, meta);
      assert.notEqual(
        res.structuredContent?._demo,
        true,
        `${meta}: with the wrong order the meta-tool bypasses the demo stamper`,
      );
    }
  });
});
