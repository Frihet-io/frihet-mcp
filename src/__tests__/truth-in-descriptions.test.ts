/**
 * Truth-in-descriptions + confirm-guard coverage regression tests.
 *
 * Pins the three defects found by the MCP audit (GAP-04, GAP-12, GAP-13, C38):
 *
 *   GAP-04 — four irreversible / third-party-visible tools (delete_invoice,
 *            delete_quote, refund_deposit, send_invoice) carried NO confirm
 *            guard while eight less consequential tools did. The old C43 sweep
 *            checked `confirm-declared ⊆ confirm-enforced` and never asked
 *            `confirm-needed ⊆ confirm-declared`.
 *   GAP-12 — delete_invoice/delete_quote promised "Permanently delete … cannot
 *            be undone" while the backend soft-CANCELS any non-draft document
 *            (VeriFactu hash chain) and signals it with HTTP 200 + a body; the
 *            client typed the call `Promise<void>` and threw the body away.
 *   GAP-13 — period_close/period_reopen described a freeze + idempotency the
 *            backend does not implement (POST /v1/periods/close → HTTP 501).
 *   C38    — the "Expenses (with OCR)" group blurb advertised a capability with
 *            no tool behind it (`grep -rni ocr src/` = the blurb itself, once).
 *
 * Run: npm test (after build). Node built-in runner, no framework.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { IFrihetClient } from "../client-interface.js";
import { registerAllTools } from "../tools/register-all.js";
import { applyToolExposureProfile, GROUPS } from "../tool-exposure.js";

/* ------------------------------------------------------------------ */
/*  Stub server + recording client                                     */
/* ------------------------------------------------------------------ */

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

  registerTool(name: string, config: ToolConfig, handler: ToolHandler): void {
    this.tools.set(name, { name, config, handler });
  }
  registerPrompt(): void {}
  registerResource(): void {}
}

const asMcp = (s: StubMcpServer) =>
  s as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

/**
 * Client proxy that RECORDS every method invoked. `calls` staying empty is the
 * load-bearing assertion for the confirm guards: `isError` alone is not proof,
 * because withToolLogging turns a thrown client error into isError=true too.
 */
function makeRecordingClient(overrides: Record<string, unknown> = {}): {
  client: IFrihetClient;
  calls: string[];
} {
  const calls: string[] = [];
  const client = new Proxy(
    {},
    {
      get: (_target, prop) => {
        const name = String(prop);
        return async (..._args: unknown[]) => {
          calls.push(name);
          if (Object.prototype.hasOwnProperty.call(overrides, name)) {
            const value = overrides[name];
            return typeof value === "function" ? (value as () => unknown)() : value;
          }
          return { data: [], total: 0, limit: 10, offset: 0 };
        };
      },
    },
  ) as IFrihetClient;
  return { client, calls };
}

function makeServer(overrides: Record<string, unknown> = {}): {
  server: StubMcpServer;
  calls: string[];
} {
  const { client, calls } = makeRecordingClient(overrides);
  const server = new StubMcpServer();
  registerAllTools(asMcp(server), client);
  return { server, calls };
}

function makeGroupedServer(): StubMcpServer {
  const { client } = makeRecordingClient();
  const server = new StubMcpServer();
  applyToolExposureProfile(server);
  registerAllTools(asMcp(server), client);
  return server;
}

/** zod-version-agnostic "is this field required?" probe. */
function isRequired(schemaField: unknown): boolean {
  const parser = schemaField as { safeParse?: (v: unknown) => { success: boolean } };
  if (typeof parser?.safeParse !== "function") return false;
  return parser.safeParse(undefined).success === false;
}

/* ------------------------------------------------------------------ */
/*  GAP-04 — confirm-guard COVERAGE (confirm-needed ⊆ confirm-declared) */
/* ------------------------------------------------------------------ */

/**
 * The four tools this lane adds guards to. Each entry names a word the refusal
 * message must contain, so the test pins "states the consequence", not merely
 * "refuses".
 */
const NEWLY_GUARDED: Array<{ tool: string; consequence: RegExp }> = [
  { tool: "delete_invoice", consequence: /cancel/i },
  { tool: "delete_quote", consequence: /cancel/i },
  { tool: "refund_deposit", consequence: /refund/i },
  { tool: "send_invoice", consequence: /email/i },
];

describe("GAP-04 — irreversible tools declare a required confirm", () => {
  for (const { tool } of NEWLY_GUARDED) {
    test(`${tool} declares confirm as a REQUIRED boolean`, () => {
      const { server } = makeServer();
      const entry = server.tools.get(tool);
      assert.ok(entry, `${tool} must be registered`);
      const shape = entry.config.inputSchema ?? {};
      assert.ok(
        Object.prototype.hasOwnProperty.call(shape, "confirm"),
        `${tool} must declare a confirm field`,
      );
      assert.equal(
        isRequired(shape["confirm"]),
        true,
        `${tool}.confirm must be required (not .optional()) so omitting it fails schema validation`,
      );
    });
  }

  for (const { tool, consequence } of NEWLY_GUARDED) {
    test(`${tool} refuses confirm=false, states the consequence, calls no API`, async () => {
      const { server, calls } = makeServer();
      const entry = server.tools.get(tool)!;
      const result = await entry.handler({
        id: "test_id_1",
        transactionId: "test_id_1",
        confirm: false,
      });

      assert.equal(result.isError, true, `${tool} must return isError with confirm=false`);
      const text = result.content[0]!.text;
      assert.ok(text.includes("confirm=true"), `${tool} refusal must name confirm=true`);
      assert.match(
        text,
        consequence,
        `${tool} refusal must state what would happen (expected ${consequence})`,
      );
      assert.deepEqual(
        calls,
        [],
        `${tool} must not touch the API when confirm=false (called: ${calls.join(",")})`,
      );
    });
  }
});

describe("GAP-04/C43 — every tool that DECLARES confirm also ENFORCES it", () => {
  test("no confirm field is decorative", async () => {
    const { server } = makeServer();
    const declared = [...server.tools.values()].filter((t) =>
      Object.prototype.hasOwnProperty.call(t.config.inputSchema ?? {}, "confirm"),
    );
    // 8 pre-existing guards + the 4 this lane adds.
    assert.equal(declared.length, 12, "expected 12 confirm-gated tools");

    for (const entry of declared) {
      const { server: fresh, calls } = makeServer();
      const tool = fresh.tools.get(entry.name)!;
      const result = await tool.handler({
        id: "test_id_1",
        transactionId: "test_id_1",
        periodId: "test_id_1",
        memberId: "test_id_1",
        invoiceId: "test_id_1",
        type: "quarterly",
        reason: "test",
        confirm: false,
      });
      assert.equal(result.isError, true, `${entry.name} ignored confirm=false`);
      assert.deepEqual(
        calls,
        [],
        `${entry.name} hit the API despite confirm=false (called: ${calls.join(",")})`,
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/*  GAP-12 — delete tells the truth about soft-cancel                   */
/* ------------------------------------------------------------------ */

const SOFT_CANCEL_BODY = {
  id: "inv_123",
  status: "cancelled",
  previousStatus: "sent",
  cancelledVia: "api",
};

describe("GAP-12 — delete_invoice distinguishes cancel from destroy", () => {
  test("description no longer promises a permanent, irreversible delete", () => {
    const { server } = makeServer();
    const desc = server.tools.get("delete_invoice")!.config.description;
    assert.doesNotMatch(desc, /permanently delete an invoice/i);
    assert.doesNotMatch(desc, /cannot be undone/i);
    assert.match(desc, /cancel/i, "description must say a non-draft invoice is cancelled");
    assert.match(desc, /verifactu/i, "description must name WHY it is cancelled");
  });

  test("HTTP 200 soft-cancel body → reports CANCELLED, not deleted", async () => {
    const { server } = makeServer({ deleteInvoice: () => ({ ...SOFT_CANCEL_BODY }) });
    const result = await server.tools
      .get("delete_invoice")!
      .handler({ id: "inv_123", confirm: true });

    assert.ok(!result.isError);
    const text = result.content[0]!.text;
    assert.match(text, /cancelled/i, "agent-facing text must say cancelled");
    assert.doesNotMatch(text, /deleted successfully/i);
    assert.equal(result.structuredContent!["outcome"], "cancelled");
    assert.equal(result.structuredContent!["status"], "cancelled");
    assert.equal(result.structuredContent!["previousStatus"], "sent");
  });

  test("HTTP 204 empty body → reports a real delete", async () => {
    const { server } = makeServer({ deleteInvoice: () => undefined });
    const result = await server.tools
      .get("delete_invoice")!
      .handler({ id: "inv_draft", confirm: true });

    assert.ok(!result.isError);
    assert.equal(result.structuredContent!["outcome"], "deleted");
    assert.equal(result.structuredContent!["success"], true);
    assert.equal(result.structuredContent!["id"], "inv_draft");
  });
});

describe("GAP-12 — delete_quote distinguishes cancel from destroy", () => {
  test("description no longer promises a permanent, irreversible delete", () => {
    const { server } = makeServer();
    const desc = server.tools.get("delete_quote")!.config.description;
    assert.doesNotMatch(desc, /permanently delete a quote/i);
    assert.doesNotMatch(desc, /cannot be undone/i);
    assert.match(desc, /cancel/i);
  });

  test("HTTP 200 soft-cancel body → reports CANCELLED, not deleted", async () => {
    const { server } = makeServer({
      deleteQuote: () => ({ id: "qt_1", status: "cancelled", previousStatus: "accepted" }),
    });
    const result = await server.tools
      .get("delete_quote")!
      .handler({ id: "qt_1", confirm: true });

    assert.ok(!result.isError);
    assert.match(result.content[0]!.text, /cancelled/i);
    assert.doesNotMatch(result.content[0]!.text, /deleted successfully/i);
    assert.equal(result.structuredContent!["outcome"], "cancelled");
  });

  test("HTTP 204 empty body → reports a real delete", async () => {
    const { server } = makeServer({ deleteQuote: () => undefined });
    const result = await server.tools
      .get("delete_quote")!
      .handler({ id: "qt_draft", confirm: true });

    assert.ok(!result.isError);
    assert.equal(result.structuredContent!["outcome"], "deleted");
  });
});

/* ------------------------------------------------------------------ */
/*  GAP-13 — period_close / period_reopen are honest about the 501      */
/* ------------------------------------------------------------------ */

describe("GAP-13 — period tools describe what the code does today", () => {
  test("period_close does not claim a freeze or idempotency it cannot deliver", () => {
    const { server } = makeServer();
    const desc = server.tools.get("period_close")!.config.description;
    assert.match(desc, /501/, "description must state the backend answers HTTP 501");
    assert.doesNotMatch(desc, /Idempotent: re-closing/i);
    assert.doesNotMatch(desc, /Freezes invoices, expenses, journal entries/i);
    assert.doesNotMatch(desc, /Congela facturas/i);
  });

  test("period_reopen does not claim a reopen mechanism it cannot deliver", () => {
    const { server } = makeServer();
    const desc = server.tools.get("period_reopen")!.config.description;
    assert.match(desc, /501/, "description must state the backend answers HTTP 501");
    assert.doesNotMatch(desc, /Reopening allows backdated edits to invoices\/expenses/i);
  });

  test("the confirm guards on both period tools survive the rewrite", async () => {
    const { server, calls } = makeServer();
    for (const name of ["period_close", "period_reopen"]) {
      const result = await server.tools
        .get(name)!
        .handler({ type: "quarterly", periodId: "p_1", reason: "x", confirm: false });
      assert.equal(result.isError, true, `${name} lost its confirm guard`);
    }
    assert.deepEqual(calls, []);
  });
});

/* ------------------------------------------------------------------ */
/*  C38 — no group blurb advertises a capability search cannot find     */
/* ------------------------------------------------------------------ */

describe("C38 — group blurbs only claim capabilities that have tools", () => {
  test("every ALL-CAPS capability token in a group blurb is findable", async () => {
    const server = makeGroupedServer();
    const search = server.tools.get("search_tools")!;
    const failures: string[] = [];

    for (const [groupId, meta] of Object.entries(GROUPS)) {
      const tokens = [...new Set(meta.blurb.match(/\b[A-Z]{2,}\b/g) ?? [])];
      for (const token of tokens) {
        const res = await search.handler({ query: token, limit: 200 });
        const payload = JSON.parse(res.content[0]!.text) as { count: number };
        if (payload.count === 0) failures.push(`${groupId}: "${token}" → 0 tools`);
      }
    }

    assert.deepEqual(
      failures,
      [],
      `group blurbs advertise capabilities no tool implements:\n  ${failures.join("\n  ")}`,
    );
  });

  test("no surface claims OCR while no tool does OCR", async () => {
    const server = makeGroupedServer();
    const res = await server.tools.get("search_tools")!.handler({ query: "ocr", limit: 200 });
    const payload = JSON.parse(res.content[0]!.text) as { count: number };
    if (payload.count === 0) {
      for (const [groupId, meta] of Object.entries(GROUPS)) {
        assert.doesNotMatch(
          meta.blurb,
          /\bOCR\b/i,
          `group "${groupId}" advertises OCR but zero tools implement it`,
        );
      }
    }
  });
});
