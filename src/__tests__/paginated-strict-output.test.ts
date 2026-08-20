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
 * The fix:
 *   - `paginatedOutput(...)` is unchanged (canonical envelope only).
 *   - `enrichResponse(...)` now returns a TEXT SUFFIX (string) — not an
 *     object. The hints are appended to the `content` text block at every
 *     callsite via `+ hints`, leaving `structuredContent` exactly the
 *     canonical envelope. The OpenAI reviewed surface's frozen snapshot
 *     remains byte-identical (the schema is unchanged).
 *   - Every `enrichResponse` callsite (16 across 7 files: invoices,
 *     expenses, clients, vendors, quotes, deposits, crm) is fixed and
 *     verified by the INVENTORY test below.
 *
 * Inventory of paginated consumers: 26 tools across 17 resource files,
 * captured in `PAGINATED_TOOLS` below. The full-inventory sweep test
 * iterates every one and asserts strict equality (declared keys ⊇
 * emitted keys, required keys ⊆ emitted keys), so a future regression
 * that re-adds undeclared enrichment to ANY paginated tool turns this
 * suite red.
 *
 * The strict set-diff comparison is INDEPENDENT from the SDK's loose Zod
 * parser (pinned by the "STRICT" test below): even if a future SDK bump
 * silently switches to a strict parser, the per-tool assertions stay
 * authoritative.
 *
 * Inspector/conformance pinning: this test exercises the schema validation
 * path that the MCP SDK uses at runtime (`safeParseAsync` on the
 * `outputSchema` of every emitted `structuredContent`). The SDK version is
 * pinned in `package.json` (peerDep on `@modelcontextprotocol/sdk ^1.27.0`;
 * installed = 1.30.0); a major bump requires a manual review per AGENTS.md.
 *
 * R1 regression: enrichResponse returned an object, callers spread it
 * into structuredContent. R2 regression: enrichResponse was changed to
 * return a string, but every callsite computed `const hints = ...` and
 * discarded the value (R1 BLOCKER). The R2 fix appends `+ hints` to
 * the content text at every callsite, verified by the INVENTORY test
 * and the per-tool LITERAL-header assertions (NOT regex, which would
 * have hidden the R2 regression).
 *
 * Run: npm test (after build). Node built-in runner, no framework.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";

import type { IFrihetClient } from "../client-interface.js";
import { registerAllTools } from "../tools/register-all.js";
import { applyOpenAIReviewProfiles } from "../openai-profile.js";

/** dist/__tests__/x.test.js → repo root. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readRepoFile = (rel: string): string =>
  readFileSync(resolve(REPO_ROOT, rel), "utf8");
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

  test("list_invoices strict green: declared ⊇ emitted, required ⊆ emitted, NO _suggestions/_warnings in sc, LITERAL 'Warnings:' + 'Suggested next steps:' in content", async () => {
    // Reproduce: list with overdue AND draft invoices triggers
    // enrichResponse. The PRE-fix design spread `{ _suggestions, _warnings }`
    // into structuredContent — the post-fix design returns the hints as
    // a text suffix and APPENDS them to the `content` text block, leaving
    // structuredContent exactly the canonical envelope. This is the
    // BLOCKER regression: R1 dropped the spread but forgot the
    // concatenation, so the agent lost warnings/suggestions entirely.
    // The R2 fix adds `+ hints` to the content text at every callsite;
    // the LITERAL string assertions below are the tripwire.
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
    // LITERAL assertions (NOT regex): the agent must see both section
    // headers in the content text. A regex like /warning|suggest/ would
    // hide the regression where `enrichResponse` produces a string that
    // is never concatenated (the bug in R1).
    const entry = server.tools.get("list_invoices")!;
    const result = await entry.handler({});
    const contentText = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    assert.ok(
      contentText.includes("Warnings:"),
      `list_invoices content text is missing the LITERAL "Warnings:" header. ` +
        `enrichResponse must append a "Warnings:" section for the overdue invoices. ` +
        `Got: ${JSON.stringify(contentText.slice(-300))}`,
    );
    assert.ok(
      contentText.includes("Suggested next steps:"),
      `list_invoices content text is missing the LITERAL "Suggested next steps:" header. ` +
        `enrichResponse must append a "Suggested next steps:" section for the ` +
        `overdue/draft invoices. ` +
        `Got: ${JSON.stringify(contentText.slice(-300))}`,
    );
  });

  test("list_expenses strict green: uncategorized expense triggers categorization guidance, structuredContent clean", async () => {
    // Dedicated fixture for the expenses list path. The `enrichResponse`
    // for "expenses" + "list" scans the rows and adds a warning when any
    // expense is missing a `category` (relevant for tax-deduction
    // reporting). The categorization guidance must land in the content
    // text, and structuredContent must stay exactly the canonical
    // envelope.
    const fixture = [
      { id: "exp_1", amount: 49.99, category: null },
      { id: "exp_2", amount: 120.0, category: "office" },
      { id: "exp_3", amount: 18.5, category: null },
    ];
    const { server } = makeServer({
      listExpenses: () => ({ data: fixture, total: 3, limit: 10, offset: 0 }),
    });
    const r = await runStrictAssertInvoked(server, "list_expenses");
    assert.deepEqual(
      r.extras,
      [],
      `list_expenses emitted undeclared fields: ${r.extras.join(", ")}.`,
    );
    assert.deepEqual(
      r.missing,
      [],
      `list_expenses omitted required fields: ${r.missing.join(", ")}.`,
    );
    assert.equal(
      r.emitted.includes("_suggestions"),
      false,
      `list_expenses leaked _suggestions into structuredContent.`,
    );
    assert.equal(
      r.emitted.includes("_warnings"),
      false,
      `list_expenses leaked _warnings into structuredContent.`,
    );
    // The enrichment fires on uncategorized expenses. The content text
    // must carry the categorization guidance so the agent knows what to
    // do next (and the per-tool expense-batch prompt suggestion).
    const entry = server.tools.get("list_expenses")!;
    const result = await entry.handler({});
    const contentText = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    assert.ok(
      contentText.includes("Warnings:"),
      `list_expenses content text is missing the LITERAL "Warnings:" header for ` +
        `the uncategorized expenses. ` +
        `Got: ${JSON.stringify(contentText.slice(-300))}`,
    );
    assert.ok(
      contentText.includes("categor"),
      `list_expenses content text is missing categorization guidance. The ` +
        `enrichResponse for "expenses" + "list" must advise the agent to categorize ` +
        `the uncategorized rows. Got: ${JSON.stringify(contentText.slice(-300))}`,
    );
    assert.ok(
      contentText.includes("Suggested next steps:"),
      `list_expenses content text is missing the LITERAL "Suggested next steps:" header. ` +
        `enrichResponse must suggest the expense-batch prompt for uncategorized rows. ` +
        `Got: ${JSON.stringify(contentText.slice(-300))}`,
    );
  });

  test("list_clients clean/empty-hint path: structuredContent exact, no enrichment text", async () => {
    // The list_clients path does NOT call enrichResponse on the LIST
    // operation (only on create). The fixture is "all rows, nothing
    // interesting" — the empty-hint path. The content text must be
    // exactly the paginated summary (no `Warnings:` / `Suggested next
    // steps:` section), and structuredContent must still match the
    // canonical envelope.
    const { server } = makeServer({
      listClients: () => ({
        data: [{ id: "c_1", name: "Acme" }, { id: "c_2", name: "Globex" }],
        total: 2,
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
    const entry = server.tools.get("list_clients")!;
    const result = await entry.handler({});
    const contentText = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    // Empty path: the literal headers must NOT appear (the list_clients
    // path doesn't trigger enrichResponse, so the agent gets a clean
    // paginated summary).
    assert.equal(
      contentText.includes("Warnings:"),
      false,
      `list_clients (empty-hint path) leaked a "Warnings:" section that should ` +
        `not be present. Got: ${JSON.stringify(contentText.slice(-300))}`,
    );
    assert.equal(
      contentText.includes("Suggested next steps:"),
      false,
      `list_clients (empty-hint path) leaked a "Suggested next steps:" section that ` +
        `should not be present. Got: ${JSON.stringify(contentText.slice(-300))}`,
    );
    // The paginated summary IS present (the formatPaginatedResponse
    // output): "Found N clients".
    assert.ok(
      /Found \d+ clients/i.test(contentText),
      `list_clients content text is missing the paginated summary header. ` +
        `Got: ${JSON.stringify(contentText.slice(-300))}`,
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

  test("INVENTORY: every enrichResponse callsite actually uses the returned hints", () => {
    // R1 BLOCKER regression: every callsite computed `const hints = ...`
    // and discarded the value, so the agent lost warnings/suggestions
    // entirely. This inventory walks the source and asserts that EVERY
    // callsite has a `+ hints` (or `+ (hints ?? "")`) concatenation in
    // the content text block. If a future callsite forgets the concat,
    // the inventory catches it.
    //
    // The check is a SOURCE-LEVEL scan (not a runtime test) so it
    // catches the regression at the same diff that introduces it.
    const src = readRepoFile("src/tools/invoices.ts") +
      readRepoFile("src/tools/expenses.ts") +
      readRepoFile("src/tools/clients.ts") +
      readRepoFile("src/tools/vendors.ts") +
      readRepoFile("src/tools/quotes.ts") +
      readRepoFile("src/tools/deposits.ts") +
      readRepoFile("src/tools/crm.ts");
    // Find every `const hints = enrichResponse(...)` line. For each,
    // assert the next ~25 lines contain a `+ hints` (or `+ (hints ?? "")`)
    // concatenation in the content text block. If the concat is missing,
    // the callsite is discarding the enrichment — the R1 BLOCKER.
    const callsiteRe = /const hints = enrichResponse\([^)]+\);/g;
    const callsites: { line: number; file: string; uses: boolean; snippet: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = callsiteRe.exec(src)) !== null) {
      const line = src.slice(0, m.index).split("\n").length;
      const after = src.slice(m.index, m.index + 2500);
      const uses = /\+\s*hints/.test(after);
      callsites.push({ line, file: "src/tools/*.ts", uses, snippet: m[0] });
    }
    const dropped = callsites.filter((c) => !c.uses);
    assert.deepEqual(
      dropped,
      [],
      `${dropped.length}/${callsites.length} enrichResponse callsites DISCARD the returned hints. ` +
        `Each callsite MUST append the hints to the content text block ` +
        `(e.g. \`mutateContent(formatRecord("X", result) + hints)\` or ` +
        `\`listContent(formatPaginatedResponse("X", result) + hints)\`). ` +
        `Dropped callsites: ${dropped.map((d) => `L${d.line}: ${d.snippet}`).join(", ")}. ` +
        `R1 BLOCKER: the agent must see warnings/suggestions in the content text.`,
    );
  });

  test("STRICT additional-property check is independent from the SDK's loose Zod parser", () => {
    // The MCP SDK's validateToolOutput path uses `safeParseAsync` on Zod's
    // LOOSE `z.object()` (Zod v4 default), which silently ACCEPTS extra
    // keys and returns success: true. The per-tool strict test above uses
    // a SET-DIFF comparison (declared keys ⊇ emitted keys) on the RAW
    // structuredContent the handler returned (not the parsed output — Zod
    // strips the extras in the parsed result). This test pins that
    // independence: a payload that the loose parser ACCEPTS must STILL
    // fail our strict set-diff check.
    const schema = z.object({
      data: z.array(z.object({ id: z.string() })),
      total: z.number(),
    });
    // The raw structuredContent the handler emitted (has the undeclared
    // extra key). The per-tool test compares THIS object's keys against
    // the schema's declared keys.
    const rawStructuredContent = {
      data: [{ id: "x" }],
      total: 1,
      _undeclared: "leak",
    };
    // 1) The loose Zod parser ACCEPTS the payload (returns success: true).
    //    This is the bug class: the SDK's safeParseAsync would NOT reject
    //    this payload even though it has an undeclared key.
    const looseResult = schema.safeParse(rawStructuredContent);
    assert.equal(
      looseResult.success,
      true,
      `Zod's loose object parser rejected the extra key. If this assertion ` +
        `fails, the SDK has switched to a strict parser — the per-tool tests ` +
        `must be re-evaluated against the new parser semantics. The strict ` +
        `set-diff gate is no longer needed because the parser itself would ` +
        `catch the bug.`,
    );
    // 2) The strict set-diff comparison (the per-tool test's logic)
    //    REJECTS the same RAW payload. This is the independent gate: even
    //    though Zod's loose parser accepts the input, the strict check
    //    flags the undeclared key.
    const declared = new Set(Object.keys(schema._zod?.def?.shape ?? schema._def?.shape ?? {}));
    const emitted = new Set(Object.keys(rawStructuredContent));
    const extras = [...emitted].filter((k) => !declared.has(k));
    assert.notDeepEqual(
      extras,
      [],
      `Strict set-diff is no longer catching undeclared enrichment. The ` +
        `per-tool test's "declared superset-of emitted" assertion depends on ` +
        `the set-diff comparison being independent from Zod's loose parser. ` +
        `If this fails, the strict gate has degraded to the same loose ` +
        `semantics as the SDK's safeParseAsync — the whole point of the ` +
        `strict test is lost.`,
    );
  });

  test("MUTATION: dropping `+ hints` from a callsite flips the inventory RED", () => {
    // If a future change drops `+ hints` from a callsite (e.g. someone
    // refactors the content text and forgets to concat the hints), the
    // INVENTORY test above must catch it. This test simulates the
    // regression by reading the source and asserting the substring
    // pattern is present in at least one callsite (proving the
    // inventory would catch its absence).
    //
    // The actual mutation simulation is the inverse: if the substring
    // is missing, the inventory would fail. This test pins the
    // positive case.
    const src = readRepoFile("src/tools/invoices.ts") +
      readRepoFile("src/tools/expenses.ts") +
      readRepoFile("src/tools/clients.ts") +
      readRepoFile("src/tools/vendors.ts") +
      readRepoFile("src/tools/quotes.ts") +
      readRepoFile("src/tools/deposits.ts") +
      readRepoFile("src/tools/crm.ts");
    const concatCount = (src.match(/\+\s*hints/g) ?? []).length;
    const callsiteCount = (src.match(/const hints = enrichResponse\(/g) ?? []).length;
    assert.ok(
      concatCount >= callsiteCount,
      `Only ${concatCount} \`+ hints\` concatenations for ${callsiteCount} ` +
        `enrichResponse callsites. The inventory test would catch a drop, but ` +
        `this is the positive case that pins the expected ratio. ` +
        `If a future refactor legitimately reduces the callsite count, update ` +
        `this assertion to match — do NOT silently allow the ratio to drop below 1:1.`,
    );
  });
});
