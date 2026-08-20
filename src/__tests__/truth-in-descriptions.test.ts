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
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { IFrihetClient } from "../client-interface.js";
import { registerAllTools } from "../tools/register-all.js";
import { applyToolExposureProfile, GROUPS } from "../tool-exposure.js";
import { applyOpenAIReviewProfiles } from "../openai-profile.js";

/** dist/__tests__/x.test.js → repo root. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readRepoFile = (rel: string): string =>
  readFileSync(resolve(REPO_ROOT, rel), "utf8");

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

/** The composed ChatGPT surface: grouped exposure + OpenAI review profile. */
function makeOpenAIServer(): StubMcpServer {
  const { client } = makeRecordingClient();
  const server = new StubMcpServer();
  applyOpenAIReviewProfiles(server);
  registerAllTools(asMcp(server), client);
  return server;
}

/** zod-version-agnostic "is this field required?" probe. */
function isRequired(schemaField: unknown): boolean {
  const parser = schemaField as { safeParse?: (v: unknown) => { success: boolean } };
  if (typeof parser?.safeParse !== "function") return false;
  return parser.safeParse(undefined).success === false;
}

/** Does this tool declare `confirm` as a REQUIRED input? */
function declaresRequiredConfirm(t: RegisteredTool): boolean {
  const shape = t.config.inputSchema ?? {};
  return (
    Object.prototype.hasOwnProperty.call(shape, "confirm") && isRequired(shape["confirm"])
  );
}

/* ------------------------------------------------------------------ */
/*  GAP-04 (a) — BEHAVIOUR of the four guards this lane wrote           */
/* ------------------------------------------------------------------ */

/**
 * The four tools this lane adds guards to. Each entry names a word the refusal
 * message must contain, so the test pins "states the consequence", not merely
 * "refuses".
 *
 * ⚠️ This list is NOT the coverage gate and must never be mistaken for one — an
 * enumeration of the tools the author happened to fix is exactly the mistake
 * GAP-04 identified. The coverage gate is the derived risk predicate in
 * "GAP-04 — confirm COVERAGE over the whole registry" below; these tests only
 * assert the WORDING of the four refusals written here.
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

/* ------------------------------------------------------------------ */
/*  GAP-04 — the actual COVERAGE gate (derived risk predicate)          */
/* ------------------------------------------------------------------ */

/**
 * The RISK predicate. Derived from what the tool IS, never from a list of tools
 * someone remembered to update — that enumeration-instead-of-risk mistake is
 * literally what GAP-04 named as the root cause of the original miss.
 *
 * A tool is risky when it is annotated destructive, or when its name declares an
 * irreversible / third-party-visible verb.
 */
const RISKY_NAME_PREFIX = /^(delete|refund|send|void|cancel)_/;

function isRisky(t: RegisteredTool): boolean {
  const destructive = (t.config.annotations ?? {})["destructiveHint"] === true;
  return destructive || RISKY_NAME_PREFIX.test(t.name);
}

/**
 * DEBT REGISTER — risky tools that ship WITHOUT a confirm guard as of this
 * commit. This is not an exemption policy and not a whitelist of "safe" tools:
 * every entry is a known, accepted gap, deliberately made visible.
 *
 * Rules enforced by the two tests below:
 *   • It may only SHRINK. Gating a tool means DELETING its line here, in the
 *     same diff — the register is asserted exact, so a stale entry fails.
 *   • A NEW risky tool may never be added here to make CI green. Adding a
 *     destructive tool without confirm turns this suite red, which is the whole
 *     point of the gate; the fix is the guard, not the register.
 *
 * Out of scope for the truth-in-descriptions lane (which gated the four highest-
 * stakes tools: delete_invoice, delete_quote, refund_deposit, send_invoice).
 * Tracked as follow-up work.
 */
const UNGATED_RISK_DEBT: ReadonlySet<string> = new Set([
  // destructiveHint: true, hard delete, no confirm
  "delete_client",
  "delete_client_contact",
  "delete_client_note",
  "delete_deposit",
  "delete_expense",
  "delete_product",
  "delete_vendor",
  "delete_webhook",
  "frihet_portal_domain_remove",
  // third-party dispatch, no confirm
  "send_einvoice",
  "send_quote",
]);

describe("GAP-04 — confirm COVERAGE over the whole registry", () => {
  test("no risky tool ships ungated outside the debt register", (t) => {
    const { server } = makeServer();
    const all = [...server.tools.values()];
    const risky = all.filter(isRisky);
    const ungated = risky.filter((x) => !declaresRequiredConfirm(x)).map((x) => x.name);
    const undeclaredDebt = ungated.filter((n) => !UNGATED_RISK_DEBT.has(n)).sort();

    t.diagnostic(
      `scan scope: ${all.length} registered tools; ${risky.length} matched the risk ` +
        `predicate (annotations.destructiveHint === true OR name ~ ${RISKY_NAME_PREFIX}); ` +
        `${risky.length - ungated.length} confirm-gated, ${ungated.length} ungated ` +
        `(all ${UNGATED_RISK_DEBT.size} accounted for in UNGATED_RISK_DEBT).`,
    );

    assert.deepEqual(
      undeclaredDebt,
      [],
      `risky tools with NO required confirm and NO entry in UNGATED_RISK_DEBT: ` +
        `${undeclaredDebt.join(", ")}. Scanned ${all.length} tools, ${risky.length} risky. ` +
        `Add the confirm guard — do NOT add the tool to UNGATED_RISK_DEBT to go green.`,
    );
  });

  test("the debt register is EXACT — no stale entry, no phantom entry", () => {
    const { server } = makeServer();
    const stale: string[] = [];
    const phantom: string[] = [];
    const notRisky: string[] = [];

    for (const name of UNGATED_RISK_DEBT) {
      const entry = server.tools.get(name);
      if (!entry) {
        phantom.push(name);
        continue;
      }
      if (!isRisky(entry)) notRisky.push(name);
      if (declaresRequiredConfirm(entry)) stale.push(name);
    }

    assert.deepEqual(
      phantom,
      [],
      `UNGATED_RISK_DEBT names tools that no longer exist: ${phantom.join(", ")}`,
    );
    assert.deepEqual(
      notRisky,
      [],
      `UNGATED_RISK_DEBT names tools the risk predicate no longer matches: ${notRisky.join(", ")}`,
    );
    assert.deepEqual(
      stale,
      [],
      `these tools are confirm-gated now — delete them from UNGATED_RISK_DEBT: ${stale.join(", ")}`,
    );
  });
});

/* ------------------------------------------------------------------ */
/*  GAP-04 — the confirm requirement must SURVIVE description collapse  */
/* ------------------------------------------------------------------ */

/**
 * A required `confirm` that the loaded description never mentions is a schema
 * contradicting its own prose: the model calls the tool, the SDK rejects the
 * arguments, and there is no prose basis to recover. Both live surfaces collapse
 * descriptions (grouped mode keeps only the first sentence), and the ChatGPT
 * surface additionally REPLACES some descriptions via descriptionOverrides — so
 * the invariant is asserted on the composed output, not on the source string.
 */
function assertConfirmAnnouncedOn(server: StubMcpServer, surface: string): void {
  const gated = [...server.tools.values()].filter(declaresRequiredConfirm);
  assert.ok(gated.length > 0, `${surface}: found no confirm-gated tool — probe is broken`);
  const silent = gated
    .filter((x) => !/confirm/i.test(x.config.description))
    .map((x) => `${x.name} → ${JSON.stringify(x.config.description.slice(0, 120))}`);
  assert.deepEqual(
    silent,
    [],
    `${surface}: ${gated.length} tools REQUIRE confirm but their loaded description ` +
      `never says so:\n  ${silent.join("\n  ")}`,
  );
}

describe("GAP-04 — every confirm-gated tool announces confirm where the agent reads it", () => {
  test("open grouped surface (mcp.frihet.io)", (t) => {
    const server = makeGroupedServer();
    const n = [...server.tools.values()].filter(declaresRequiredConfirm).length;
    t.diagnostic(`scan scope: grouped surface, ${server.tools.size} tools, ${n} confirm-gated.`);
    assertConfirmAnnouncedOn(server, "grouped surface");
  });

  test("describe_tool on the open surface does not drop the confirm requirement", async (t) => {
    const server = makeGroupedServer();
    const describe_ = server.tools.get("describe_tool")!;
    const gated = [...server.tools.values()].filter(declaresRequiredConfirm);
    assert.ok(gated.length > 0, "found no confirm-gated tool on the open surface — probe is broken");
    t.diagnostic(`scan scope: describe_tool() for all ${gated.length} confirm-gated tools.`);
    const silent: string[] = [];

    for (const entry of gated) {
      const res = await describe_.handler({ name: entry.name });
      const payload = JSON.parse(res.content[0]!.text) as {
        description?: string;
        inputFields?: string[];
      };
      assert.ok(
        payload.inputFields?.includes("confirm"),
        `describe_tool('${entry.name}') omits confirm from inputFields`,
      );
      if (!/confirm/i.test(payload.description ?? "")) silent.push(entry.name);
    }

    assert.deepEqual(
      silent,
      [],
      `describe_tool returns a description that never names confirm for: ${silent.join(", ")}. ` +
        `A descriptionOverride in openai-profile.ts REPLACES the source description — ` +
        `the override must carry the confirm requirement too.`,
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Frozen-descriptor DIVERGENCE — the reviewed ChatGPT surface         */
/* ------------------------------------------------------------------ */

/**
 * The reviewed ChatGPT descriptor is frozen mid-review
 * (docs/openai-review-descriptor-freeze.md). Adding a required `confirm` and
 * rewriting the delete prose would have drifted it, so on the OpenAI surface —
 * and ONLY there — `confirm` is stripped from the advertised schema and supplied
 * by `impliedInputValues`, while the first sentence of each description is
 * pinned byte-identical to the approved text.
 *
 * That divergence is load-bearing and silent: nothing about it is visible in the
 * base tool files. These tests are what stop it from rotting.
 */
const FROZEN_DIVERGENCE = {
  delete_invoice: /cancel/i,
  delete_quote: /cancel/i,
  send_invoice: /recall/i,
} as const;

interface FrozenDescriptor {
  tools: Array<{
    name: string;
    description: string;
    inputSchema: { properties?: Record<string, unknown>; required?: string[] };
  }>;
}

describe("frozen-descriptor divergence — reviewed ChatGPT surface stays byte-identical", () => {
  test("the divergence set is exactly the tools that need it", (t) => {
    const { server: base } = makeServer();
    const openai = makeOpenAIServer();

    // DERIVED: base requires confirm AND the tool is on the reviewed surface.
    const needDivergence = [...base.tools.values()]
      .filter(declaresRequiredConfirm)
      .filter((x) => openai.tools.has(x.name))
      .map((x) => x.name)
      .sort();

    t.diagnostic(
      `scan scope: ${base.tools.size} base tools ∩ ${openai.tools.size} reviewed tools; ` +
        `${needDivergence.length} require confirm on the base surface.`,
    );
    assert.deepEqual(
      needDivergence,
      Object.keys(FROZEN_DIVERGENCE).sort(),
      `a confirm-gated tool entered/left the reviewed OpenAI surface. Every such tool ` +
        `needs a stripInputFields + impliedInputValues + descriptionOverride entry in ` +
        `openai-profile.ts, or the frozen descriptor drifts and CI goes red.`,
    );
  });

  test("tools/list description is byte-identical to the frozen fixture", () => {
    const frozen = JSON.parse(
      readRepoFile("src/__tests__/fixtures/openai-review-descriptor.snapshot.json"),
    ) as FrozenDescriptor;
    const openai = makeOpenAIServer();

    for (const name of Object.keys(FROZEN_DIVERGENCE)) {
      const pinned = frozen.tools.find((x) => x.name === name);
      assert.ok(pinned, `${name} missing from the frozen fixture`);
      assert.equal(
        openai.tools.get(name)!.config.description,
        pinned.description,
        `${name}: the composed ChatGPT description drifted from the frozen fixture. The ` +
          `FIRST SENTENCE of its descriptionOverride is a byte contract — corrections go ` +
          `in the sentences AFTER it (those reach describe_tool, which is not frozen).`,
      );
    }
  });

  test("confirm is absent from the reviewed schema but REQUIRED on the base surface", () => {
    const { server: base } = makeServer();
    const openai = makeOpenAIServer();

    for (const name of Object.keys(FROZEN_DIVERGENCE)) {
      assert.equal(
        declaresRequiredConfirm(base.tools.get(name)!),
        true,
        `${name} lost its confirm guard on the base surface — the divergence is supposed ` +
          `to hide confirm from ChatGPT only, never to remove the protection`,
      );
      assert.ok(
        !Object.prototype.hasOwnProperty.call(
          openai.tools.get(name)!.config.inputSchema ?? {},
          "confirm",
        ),
        `${name} advertises confirm on the reviewed surface — that drifts the frozen descriptor`,
      );
    }
  });

  test("a reviewed tool whose confirm was stripped still WORKS (implied confirm)", async () => {
    for (const name of Object.keys(FROZEN_DIVERGENCE)) {
      const { client, calls } = makeRecordingClient();
      const server = new StubMcpServer();
      applyOpenAIReviewProfiles(server);
      registerAllTools(asMcp(server), client);

      // Exactly what ChatGPT can send: the advertised schema, nothing more.
      const result = await server.tools.get(name)!.handler({ id: "test_id_1" });

      assert.notEqual(
        result.isError,
        true,
        `${name} refuses every ChatGPT call: confirm was stripped from the schema without a ` +
          `matching impliedInputValues entry, so the guard can never be satisfied there.`,
      );
      assert.equal(
        calls.length,
        1,
        `${name} never reached the API on the reviewed surface (called: ${calls.join(",")})`,
      );
    }
  });

  test("describe_tool carries the correction the frozen first sentence cannot", async () => {
    const openai = makeOpenAIServer();
    const describe_ = openai.tools.get("describe_tool")!;

    for (const [name, mustSay] of Object.entries(FROZEN_DIVERGENCE)) {
      const payload = JSON.parse(
        (await describe_.handler({ name })).content[0]!.text,
      ) as { description?: string };
      assert.match(
        payload.description ?? "",
        mustSay,
        `describe_tool('${name}') is the ONLY place the reviewed surface can tell the truth ` +
          `(tools/list is frozen). Its description must match ${mustSay}.`,
      );
    }
  });
});

describe("GAP-04/C43 — every tool that DECLARES confirm also ENFORCES it", () => {
  test("no confirm field is decorative", async (t) => {
    const { server } = makeServer();
    const declared = [...server.tools.values()].filter((x) =>
      Object.prototype.hasOwnProperty.call(x.config.inputSchema ?? {}, "confirm"),
    );
    t.diagnostic(
      `scan scope: ${server.tools.size} registered tools, ${declared.length} declare confirm; ` +
        `each is invoked with confirm=false and must refuse WITHOUT touching the client.`,
    );

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
/*  GAP-12 — the same claim on every PUBLISHED surface, not just the    */
/*           tool description                                           */
/* ------------------------------------------------------------------ */

/**
 * Fixing the tool description while four published copies of the identical
 * sentence stay live is not "truth in descriptions" — it just moves the lie.
 * These are every in-repo surface that restates what delete_invoice /
 * delete_quote do, including the two that leave this machine:
 * README.md ships inside the npm tarball (package.json `files`) and the
 * marketplace JSON is what OpenAI app review reads.
 */
const PUBLISHED_PROSE_SURFACES = [
  "README.md",
  "docs/openai-tool-justifications.md",
  "skill/references/api-patterns.md",
  "skills/frihet-mcp/references/api-patterns.md",
];

/** The two tools whose backend soft-CANCELS instead of destroying (GAP-12). */
const SOFT_CANCEL_TOOLS = ["delete_invoice", "delete_quote"];

/** Delete tools that really do destroy the row — their prose must NOT be watered down. */
const TRUE_HARD_DELETE_TOOLS = [
  "delete_expense",
  "delete_client",
  "delete_client_contact",
  "delete_client_note",
  "delete_product",
  "delete_vendor",
  "delete_webhook",
];

const PERMANENCE_CLAIM = /permanently delete|cannot be undone|permanent(ly)? (removed|destroy)/i;

describe("GAP-12 — no published surface still promises a permanent delete", () => {
  test("prose surfaces: no line about the soft-cancel tools claims permanence", (t) => {
    const offenders: string[] = [];
    for (const rel of PUBLISHED_PROSE_SURFACES) {
      const lines = readRepoFile(rel).split("\n");
      lines.forEach((line, i) => {
        if (!SOFT_CANCEL_TOOLS.some((name) => line.includes(name))) return;
        if (PERMANENCE_CLAIM.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    t.diagnostic(
      `scan scope: ${PUBLISHED_PROSE_SURFACES.length} files ` +
        `(${PUBLISHED_PROSE_SURFACES.join(", ")}), every line naming ` +
        `${SOFT_CANCEL_TOOLS.join(" or ")}, matched against ${PERMANENCE_CLAIM}.`,
    );
    assert.deepEqual(
      offenders,
      [],
      `published surfaces still promise a permanent delete for a tool that soft-cancels:\n  ${offenders.join("\n  ")}`,
    );
  });

  test("prose surfaces: the truthful cancel wording is actually present", () => {
    const missing: string[] = [];
    for (const rel of PUBLISHED_PROSE_SURFACES) {
      const text = readRepoFile(rel);
      for (const name of SOFT_CANCEL_TOOLS) {
        if (!text.includes(name)) continue;
        // Every file that documents the tool must say somewhere that a non-draft
        // document is cancelled, not destroyed.
        if (!/cancel/i.test(text)) missing.push(`${rel} documents ${name} but never says "cancel"`);
      }
    }
    assert.deepEqual(missing, [], missing.join("\n  "));
  });

  test("skill parameter tables list confirm for the confirm-gated tools", () => {
    const { server } = makeServer();
    const gapRows: string[] = [];
    for (const rel of ["skill/references/api-patterns.md", "skills/frihet-mcp/references/api-patterns.md"]) {
      const lines = readRepoFile(rel).split("\n");
      lines.forEach((line, i) => {
        if (!line.trim().startsWith("| `")) return;
        const m = line.match(/^\|\s*`([a-z0-9_]+)`/);
        if (!m) return;
        const entry = server.tools.get(m[1]!);
        if (!entry || !declaresRequiredConfirm(entry)) return;
        if (!/confirm/i.test(line)) gapRows.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(
      gapRows,
      [],
      `these skill-reference parameter rows document a confirm-gated tool without naming ` +
        `confirm — an agent primed by the skill will call it and get an input-validation ` +
        `error:\n  ${gapRows.join("\n  ")}`,
    );
  });

  test("OpenAI submission JSON: fiscal-document deletes tell the truth", (t) => {
    const submission = JSON.parse(
      readRepoFile("marketplace/openai/chatgpt-app-submission.json"),
    ) as { tools: Record<string, { justifications?: Record<string, string> }> };

    t.diagnostic(
      `scan scope: ${Object.keys(submission.tools).length} tools in the submission; ` +
        `${SOFT_CANCEL_TOOLS.length} asserted truthful, ` +
        `${TRUE_HARD_DELETE_TOOLS.length} asserted UNCHANGED (they really are hard deletes).`,
    );

    for (const name of SOFT_CANCEL_TOOLS) {
      const j = submission.tools[name]?.justifications ?? {};
      for (const [field, value] of Object.entries(j)) {
        assert.doesNotMatch(
          value,
          PERMANENCE_CLAIM,
          `${name}.${field} still claims permanence: ${JSON.stringify(value)}`,
        );
      }
      assert.match(
        j["destructive_justification"] ?? "",
        /cancel/i,
        `${name}.destructive_justification must say a non-draft document is CANCELLED`,
      );
    }

    // Guard against over-correction: the seven genuine hard deletes must KEEP
    // their accurate irreversibility warning.
    for (const name of TRUE_HARD_DELETE_TOOLS) {
      assert.match(
        submission.tools[name]?.justifications?.["destructive_justification"] ?? "",
        /cannot be undone/i,
        `${name} really is a hard delete — its warning must not be softened`,
      );
    }
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
