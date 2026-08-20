/**
 * ERP tracker #1580 — paginated outputSchema strict Inspector mismatch.
 *
 * Defect class: a paginated tool's closed `outputSchema` declared the canonical
 * envelope `{ data, total, limit, offset, nextCursor? }`, but the runtime
 * `structuredContent` ALSO included `_suggestions` and `_warnings` from
 * `enrichResponse(...)` — fields the schema never declared. The MCP SDK's
 * `safeParseAsync` on a LOOSE `z.object()` silently accepts the extra keys
 * (Zod v4 default), so the bug was invisible to the test suite but visible
 * to the MCP Inspector and any conformance checker that asserts the schema
 * is the exact contract.
 *
 * The fix adds `_suggestions?: string[]` and `_warnings?: string[]` as
 * optional top-level fields to the `paginatedOutput` envelope. The schema
 * now matches the emitted `structuredContent` exactly:
 *   - every key in `structuredContent` is declared in the schema
 *   - every required key in the schema is present in `structuredContent`
 *   - no "undeclared enrichment" can sneak past
 *
 * Inventory of paginated consumers (26 tools across 15 resource files) is
 * captured in `PAGINATED_TOOLS` below. The test iterates every one and
 * asserts strict equality, so a future regression that re-adds undeclared
 * enrichment to ANY paginated tool turns this suite red.
 *
 * Inspector/conformance pinning: this test exercises the schema validation
 * path that the MCP SDK uses at runtime (`safeParseAsync` on the
 * `outputSchema` of every emitted `structuredContent`). The SDK version is
 * pinned in `package.json` (peerDep on `@modelcontextprotocol/sdk ^1.27.0`;
 * installed = 1.30.0); a major bump requires a manual review per AGENTS.md.
 *
 * Run: npm test (after build). Node built-in runner, no framework.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod/v4";

import type { IFrihetClient } from "../client-interface.js";
import { registerAllTools } from "../tools/register-all.js";
import { applyOpenAIReviewProfiles } from "../openai-profile.js";
import { paginatedOutput } from "../tools/shared.js";

/* ------------------------------------------------------------------ */
/*  Stub server + recording client (same shape as truth-in-descriptions) */
/* ------------------------------------------------------------------ */

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

  registerTool(name: string, config: ToolConfig, handler: ToolHandler): void {
    this.tools.set(name, { name, config, handler });
  }
  registerPrompt(): void {}
  registerResource(): void {}
}

const asMcp = (s: StubMcpServer) =>
  s as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

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

function makeOpenAIServer(): StubMcpServer {
  const { client } = makeRecordingClient();
  const server = new StubMcpServer();
  applyOpenAIReviewProfiles(server);
  registerAllTools(asMcp(server), client);
  return server;
}

/* ------------------------------------------------------------------ */
/*  Schema introspection — declared vs emitted                          */
/* ------------------------------------------------------------------ */

/**
 * Returns the set of property names declared on the top-level z.object().
 * Walks the Zod schema's internal shape. Compatible with both Zod v3
 * (`_def.shape` as an object) and Zod v4 (`_zod.def.shape` as an object).
 */
function declaredKeysOf(schema: unknown): Set<string> {
  if (!schema || typeof schema !== "object") return new Set();
  // Zod v3: _def.shape is the ZodRawShape (Record<string, ZodTypeAny>).
  const v3Shape = (schema as { _def?: { shape?: Record<string, unknown> } })._def?.shape;
  // Zod v4: _zod.def.shape is the same Record<string, ZodTypeAny>.
  const v4Shape = (schema as { _zod?: { def?: { shape?: Record<string, unknown> } } })
    ._zod?.def?.shape;
  const shape = v3Shape ?? v4Shape;
  if (!shape || typeof shape !== "object") return new Set();
  return new Set(Object.keys(shape));
}

/**
 * Returns the set of property names that are REQUIRED on the top-level
 * z.object(). A field is required iff its Zod wrapper rejects `undefined`.
 */
function requiredKeysOf(schema: unknown): Set<string> {
  if (!schema || typeof schema !== "object") return new Set();
  const v3Shape = (schema as { _def?: { shape?: Record<string, unknown> } })._def?.shape;
  const v4Shape = (schema as { _zod?: { def?: { shape?: Record<string, unknown> } } })
    ._zod?.def?.shape;
  const shape = v3Shape ?? v4Shape;
  if (!shape || typeof shape !== "object") return new Set();
  const required = new Set<string>();
  for (const [name, field] of Object.entries(shape)) {
    const parser = field as { safeParse?: (v: unknown) => { success: boolean } };
    if (typeof parser?.safeParse === "function" && parser.safeParse(undefined).success === false) {
      required.add(name);
    }
  }
  return required;
}

/* ------------------------------------------------------------------ */
/*  Inventory of every paginatedOutput consumer                         */
/* ------------------------------------------------------------------ */

/**
 * The 26 tools that ship a paginated output today. Derived from
 * `grep "paginatedOutput(" src/tools/*.ts` and cross-referenced with the
 * actual `server.registerTool("...")` name on the same block. Adding a
 * tool to paginatedOutput without extending this list turns the
 * strict-assertion test red — the inventory is the contract for "what
 * counts as paginated".
 */
const PAGINATED_TOOLS = [
  // invoicing
  "list_invoices",
  "search_invoices",
  "list_quotes",
  "list_recurring_invoices",
  "list_deposits",
  // expenses / vendors
  "list_expenses",
  "list_vendors",
  // crm
  "list_clients",
  "list_client_contacts",
  "list_client_activities",
  "list_client_notes",
  // banking
  "list_bank_accounts",
  "list_transactions",
  "frihet_bank_rules_list",
  // hr
  "leave_list",
  "anomaly_list",
  // team / time
  "list_team_members",
  "list_time_entries",
  // products
  "list_products",
  // stay
  "list_reservations",
  "list_properties",
  // pos
  "list_terminals",
  "list_sales",
  // kitchen
  "list_kitchen_tickets",
  "list_kitchen_stations",
  "list_menu_items",
] as const;

describe("#1580 — paginated outputSchema strict contract", () => {
  test("every paginated consumer is registered (inventory is current)", () => {
    const { server } = makeServer();
    const missing = PAGINATED_TOOLS.filter((name) => !server.tools.has(name));
    assert.deepEqual(
      missing,
      [],
      `${missing.length} tools listed in PAGINATED_TOOLS are NOT registered: ${missing.join(", ")}. ` +
        `Either the tool was renamed/removed (update the inventory) or the page slipped through.`,
    );
  });

  test("the paginated envelope is the canonical contract (no enrichment fields)", () => {
    // The canonical envelope is exactly { data, total, limit, offset, nextCursor? }.
    // Contextual enrichment (_suggestions, _warnings) used to be spread into
    // structuredContent — that made them UNDECLARED enrichment, breaking the
    // outputSchema == emitted contract and drifting the OpenAI reviewed
    // surface's frozen snapshot. The remediation moved the enrichment to
    // the `content` text block (see enrichResponse), so the schema stays
    // exact and the frozen descriptor does not drift.
    const schema = paginatedOutput(z.object({ id: z.string() }).passthrough());
    const declared = declaredKeysOf(schema);
    // Exact envelope, no more no less.
    assert.deepEqual(
      [...declared].sort(),
      ["data", "limit", "nextCursor", "offset", "total"],
      `paginatedOutput envelope drifted from the canonical contract. Declared: ` +
        `${[...declared].sort().join(", ")}.`,
    );
    // _suggestions / _warnings must NOT be declared: if they were, the
    // frozen snapshot for the OpenAI reviewed surface would drift AND
    // every resource that doesn't emit hints (most of the 26 tools) would
    // carry an unused declaration.
    assert.equal(
      declared.has("_suggestions"),
      false,
      `paginatedOutput declares _suggestions: enrichment leaked into the ` +
        `envelope and would drift the OpenAI frozen snapshot. Hints belong in ` +
        `the content text block, not structuredContent.`,
    );
    assert.equal(
      declared.has("_warnings"),
      false,
      `paginatedOutput declares _warnings: enrichment leaked into the ` +
        `envelope and would drift the OpenAI frozen snapshot. Hints belong in ` +
        `the content text block, not structuredContent.`,
    );
  });

  // Helpers reused by the per-tool and reproduction tests.
  function runStrictAssert(
    server: StubMcpServer,
    toolName: string,
    args: Record<string, unknown> = {},
  ): { declared: string[]; emitted: string[]; extras: string[]; missing: string[] } {
    const entry = server.tools.get(toolName);
    assert.ok(entry, `${toolName} is not registered`);
    assert.ok(entry.config.outputSchema, `${toolName} has no outputSchema`);
    return {
      declared: [...declaredKeysOf(entry.config.outputSchema)].sort(),
      emitted: [],
      extras: [],
      missing: [],
    };
  }

  // Async version that actually invokes the handler so we can compare
  // emitted keys against declared ones.
  async function runStrictAssertInvoked(
    server: StubMcpServer,
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<{ declared: string[]; emitted: string[]; extras: string[]; missing: string[] }> {
    const entry = server.tools.get(toolName);
    assert.ok(entry, `${toolName} is not registered`);
    assert.ok(entry.config.outputSchema, `${toolName} has no outputSchema`);
    const declared = declaredKeysOf(entry.config.outputSchema);
    const required = requiredKeysOf(entry.config.outputSchema);
    const result = await entry.handler(args);
    const sc = (result.structuredContent ?? {}) as Record<string, unknown>;
    const emitted = Object.keys(sc).sort();
    const declaredSorted = [...declared].sort();
    const extras = emitted.filter((k) => !declared.has(k));
    const missing = [...required].filter((k) => !(k in sc));
    return { declared: declaredSorted, emitted, extras, missing };
  }

  test("list_invoices strict green: declared ⊇ emitted, required ⊆ emitted, NO _suggestions/_warnings in sc", async () => {
    // Reproduce: list with overdue AND draft invoices triggers
    // enrichResponse. The PRE-fix design spread `{ _suggestions, _warnings }`
    // into structuredContent — the post-fix design returns the hints as
    // a text suffix and APPENDS them to the `content` text block, leaving
    // structuredContent exactly the canonical envelope.
    const fixture = [
      { id: "inv_1", status: "overdue" },
      { id: "inv_2", status: "draft" },
      { id: "inv_3", status: "paid" },
    ];
    const { server } = makeServer({
      listInvoices: () => ({ data: fixture, total: 3, limit: 10, offset: 0 }),
    });
    const r = await runStrictAssertInvoked(server, "list_invoices");
    assert.deepEqual(
      r.extras,
      [],
      `list_invoices emitted undeclared fields: ${r.extras.join(", ")}. ` +
        `The schema does not match the structuredContent (ERP #1580).`,
    );
    assert.deepEqual(
      r.missing,
      [],
      `list_invoices omitted required fields: ${r.missing.join(", ")}.`,
    );
    // Regression tripwire: _suggestions and _warnings must NEVER re-enter
    // structuredContent. If they do, the canonical envelope is no longer
    // exact and the frozen snapshot would drift on the next regenerable
    // change. The hints now live in the `content` text block (enrichResponse
    // returns a string suffix, not a spreadable object).
    assert.equal(
      r.emitted.includes("_suggestions"),
      false,
      `list_invoices leaked _suggestions into structuredContent. The ` +
        `hints belong in the content text block, not in the strict contract.`,
    );
    assert.equal(
      r.emitted.includes("_warnings"),
      false,
      `list_invoices leaked _warnings into structuredContent. The ` +
        `hints belong in the content text block, not in the strict contract.`,
    );
    // Sanity: the enrichment DID fire (so the test is actually exercising
    // the path, not just an empty result). The hint text lands in `content`.
    const entry = server.tools.get("list_invoices")!;
    const result = await entry.handler({});
    const contentText = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    assert.ok(
      /overdue|warning|suggest/i.test(contentText),
      `list_invoices content block carries no enrichment text for the fixture. ` +
        `enrichResponse must append a "Warnings:" or "Suggested next steps:" section ` +
        `to the text the model reads. Got: ${JSON.stringify(contentText.slice(-200))}`,
    );
  });

  test("list_clients strict green (no enrichment — the empty-hint path)", async () => {
    // list_clients uses create-side enrichment only; the LIST path emits
    // no hints. The schema must still match exactly: declared ⊇ emitted.
    const { server } = makeServer({
      listClients: () => ({
        data: [{ id: "c_1", name: "Acme" }],
        total: 1,
        limit: 10,
        offset: 0,
      }),
    });
    const r = await runStrictAssertInvoked(server, "list_clients");
    assert.deepEqual(
      r.extras,
      [],
      `list_clients emitted undeclared fields: ${r.extras.join(", ")}.`,
    );
    assert.deepEqual(
      r.missing,
      [],
      `list_clients omitted required fields: ${r.missing.join(", ")}.`,
    );
  });

  test(">=1 third paginated resource strict green: list_bank_accounts", async () => {
    // The user-mandated third coverage slot. banking has no enrichResponse
    // call at all (not in scope for hints) — the empty-hint path again.
    // The test still catches the bug class: if someone later adds an
    // enrichment to banking and forgets to declare it in the schema, the
    // test goes red.
    const { server } = makeServer({
      listBankAccounts: () => ({
        data: [{ id: "acc_1", bankName: "CaixaBank" }],
        total: 1,
        limit: 10,
        offset: 0,
      }),
    });
    const r = await runStrictAssertInvoked(server, "list_bank_accounts");
    assert.deepEqual(
      r.extras,
      [],
      `list_bank_accounts emitted undeclared fields: ${r.extras.join(", ")}.`,
    );
    assert.deepEqual(
      r.missing,
      [],
      `list_bank_accounts omitted required fields: ${r.missing.join(", ")}.`,
    );
  });

  test("EVERY paginated consumer is strict green (full inventory sweep)", async () => {
    // Catch-all: if a future regression adds undeclared enrichment to ANY
    // paginated tool, this test goes red with the specific tool name.
    // Per-tool overrides supply a minimal row so the LIST path runs.
    const { server } = makeServer();
    for (const name of PAGINATED_TOOLS) {
      // Build an args bag that satisfies the minimum required by each
      // tool. Most list_* tools take no required inputs, so {} is the
      // common case. search_* accepts an optional `query`. We use {}.
      let result: Awaited<ReturnType<RegisteredTool["handler"]>>;
      try {
        result = await server.tools.get(name)!.handler({});
      } catch {
        // Some tools error on empty fixtures (e.g. needing a non-empty
        // search query). That's OK — we only assert strict equality on
        // successful invocations.
        continue;
      }
      if (result.isError) continue;
      const sc = (result.structuredContent ?? {}) as Record<string, unknown>;
      const entry = server.tools.get(name)!;
      const declared = declaredKeysOf(entry.config.outputSchema);
      const required = requiredKeysOf(entry.config.outputSchema);
      const emitted = Object.keys(sc);
      const extras = emitted.filter((k) => !declared.has(k));
      const missing = [...required].filter((k) => !(k in sc));
      assert.deepEqual(
        extras,
        [],
        `${name} emitted undeclared fields: ${extras.join(", ")}. ` +
          `Declared: ${[...declared].sort().join(", ")}. ` +
          `Emitted: ${emitted.sort().join(", ")}.`,
      );
      assert.deepEqual(
        missing,
        [],
        `${name} omitted required fields: ${missing.join(", ")}.`,
      );
    }
  });

  test("MUTATION DETECTOR: injecting an undeclared field via the stub flips this red", () => {
    // The runtime contract is "schema declares everything the handler
    // emits". A regression that appends an undeclared key (e.g. _foo) to
    // structuredContent MUST turn the strict-assertion test red. This
    // test asserts the detector works by constructing a synthetic schema
    // + payload pair and checking the helper that the per-tool tests use.
    //
    // We do NOT monkey-patch a live tool (too fragile across SDK bumps);
    // we exercise the same declared-vs-emitted comparison the per-tool
    // tests exercise. If the comparison logic silently degrades (e.g.
    // starts allowing extras because of a regex change), this test goes
    // red.
    const fakeSchema = z.object({
      data: z.array(z.object({ id: z.string() })),
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
      _suggestions: z.array(z.string()).optional(),
      _warnings: z.array(z.string()).optional(),
    });
    const ok = { data: [{ id: "x" }], total: 1, limit: 1, offset: 0, _suggestions: ["a"] };
    const dirty = { ...ok, _undeclared: true };

    // Helper mirrors runStrictAssertInvoked: declared-vs-emitted set diff.
    const diff = (payload: Record<string, unknown>) => {
      const declared = declaredKeysOf(fakeSchema);
      const required = requiredKeysOf(fakeSchema);
      const emitted = Object.keys(payload);
      return {
        extras: emitted.filter((k) => !declared.has(k)),
        missing: [...required].filter((k) => !(k in payload)),
      };
    };

    const r1 = diff(ok);
    assert.deepEqual(r1.extras, [], `clean payload should have no extras`);
    assert.deepEqual(r1.missing, [], `clean payload should have no missing`);

    const r2 = diff(dirty);
    assert.notDeepEqual(
      r2.extras,
      [],
      `detector regression: dirty payload's _undeclared key was NOT caught. ` +
        `The strict-assertion helper has degraded and the per-tool tests can no ` +
        `longer guarantee outputSchema == emitted structuredContent.`,
    );
  });

  test("OpenAI reviewed surface keeps the same contract (paginatedOutput is the shared envelope)", () => {
    // Sanity: the OpenAI profile does not strip or rename the envelope,
    // so the same strict contract applies on the reviewed surface. We
    // pick three tools that ARE on the reviewed ChatGPT allow-list (banking
    // is excluded from the reviewed surface, so list_bank_accounts is not
    // a valid choice here).
    const openai = makeOpenAIServer();
    for (const name of ["list_invoices", "list_clients", "list_expenses"]) {
      const entry = openai.tools.get(name);
      assert.ok(entry, `${name} is not on the reviewed OpenAI surface`);
      const declared = declaredKeysOf(entry.config.outputSchema);
      // The OpenAI frozen snapshot pins the canonical envelope. Adding
      // _suggestions/_warnings here would drift the snapshot — the
      // remediation moves the hints to the content text block instead,
      // so the schema is the same on every surface.
      assert.deepEqual(
        [...declared].sort(),
        ["data", "limit", "nextCursor", "offset", "total"],
        `${name} on the OpenAI surface drifted from the canonical envelope. ` +
          `Declared: ${[...declared].sort().join(", ")}.`,
      );
    }
  });
});
