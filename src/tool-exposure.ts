/**
 * Tool-exposure profile for the Frihet MCP server — progressive disclosure.
 *
 * Activated by FRIHET_TOOL_MODE=grouped (env var or Worker binding).
 * Default (unset, or FRIHET_TOOL_MODE=full) leaves the server BYTE-IDENTICAL
 * to today: all 157 tools registered with their full descriptions/schemas.
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * Context rot is the 2026 problem: a flat list of 157 tool descriptions,
 * each a multi-paragraph bilingual blob, eats the agent's context window and
 * degrades tool selection before any work begins. Leaders cut flat lists.
 *
 * Frihet's differentiator is DEPTH (full ES/EU fiscal + native compliance —
 * VeriFactu / TicketBAI / Facturae — plus banking, CRM, HR/payroll, stay/PMS,
 * POS) — but depth should be SERVED ON DEMAND, not dumped up front.
 *
 * ── How ──────────────────────────────────────────────────────────────────
 * In `grouped` mode this module intercepts `registerTool` (reusing the exact
 * pattern of `openai-profile.ts`) and:
 *
 *   1. Records every tool into an in-memory CATALOG (name → group, title,
 *      one-line summary, full description, input field list) before it reaches
 *      the server.
 *   2. Still registers every tool so it stays INVOCABLE (nothing breaks; tool
 *      logic, names and behavior are untouched) — but COLLAPSES its registered
 *      description to a single terse "[group] summary — full schema via
 *      describe_tool('name')" line. That is the context saving.
 *   3. Adds three lightweight META-TOOLS as the entry point for discovery:
 *        • list_tool_groups()      — the 9-domain map with per-group counts
 *        • search_tools(query)     — fuzzy match → matching tool summaries
 *        • describe_tool(name)     — full original description + input fields
 *
 * The agent loads ~3 meta-tool descriptions + 157 terse one-liners instead of
 * 157 full bilingual blobs, then pulls full depth only for the handful of
 * tools it actually needs. Progressive disclosure, zero behavior change.
 *
 * IMPORTANT: this is purely an EXPOSURE layer. It does NOT live in
 * src/tools/*.ts, so the audited tool count stays 157 (+ meta). The meta-tools
 * are added only in grouped mode and are NOT counted as ERP tools.
 *
 * @see ./openai-profile.ts — the sibling interceptor this mirrors.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";

/* ------------------------------------------------------------------ */
/*  Group taxonomy                                                     */
/* ------------------------------------------------------------------ */

/** Stable domain identifiers used by the group router. */
export type ToolGroupId =
  | "invoicing"
  | "expenses"
  | "fiscal"
  | "banking"
  | "crm"
  | "hr"
  | "stay"
  | "pos"
  | "intelligence"
  | "catalog"
  | "platform";

interface GroupMeta {
  /** Human label, bilingual. */
  label: string;
  /** One-line domain blurb shown in list_tool_groups. */
  blurb: string;
}

/**
 * Domain metadata. Keep these terse — they are the only group-level prose the
 * agent loads up front. Depth lives in the per-tool descriptions, fetched via
 * describe_tool / search_tools.
 */
export const GROUPS: Record<ToolGroupId, GroupMeta> = {
  invoicing: {
    label: "Invoicing & receivables / Facturación y cobros",
    blurb:
      "Invoices, credit notes, quotes, recurring invoices, deposits — create, send, pay, PDF.",
  },
  expenses: {
    label: "Expenses & vendors / Gastos y proveedores",
    blurb: "Expenses (with OCR) and vendor/supplier records.",
  },
  fiscal: {
    label: "Fiscal & compliance / Fiscal y cumplimiento",
    blurb:
      "Spanish/EU fiscal depth served on demand: Modelo 303/130/390/180/347/200/202/415/425/418, " +
      "VeriFactu, TicketBAI, Facturae/FACe/KSeF e-invoicing, IGIC/AIEM, GL audit, period close, VIES.",
  },
  banking: {
    label: "Banking / Banca",
    blurb: "Bank accounts, transactions, categorization, reconciliation, bank rules.",
  },
  crm: {
    label: "CRM & clients / CRM y clientes",
    blurb: "Clients/customers plus contacts, activities and notes.",
  },
  hr: {
    label: "HR & payroll / RRHH y nóminas",
    blurb:
      "Leave, attendance, overtime, time tracking, payroll export, team, onboarding, permissions.",
  },
  stay: {
    label: "Stay / PMS / Alojamientos",
    blurb: "Vacation-rental reservations, properties and channel sync.",
  },
  pos: {
    label: "POS / TPV",
    blurb: "Point-of-sale terminals, sales and refunds.",
  },
  intelligence: {
    label: "Intelligence / Inteligencia",
    blurb:
      "Business context, monthly/quarterly summaries and gestoría collaboration — call first in a session.",
  },
  catalog: {
    label: "Products / Productos",
    blurb: "Product/service catalog with pricing.",
  },
  platform: {
    label: "Platform / Plataforma",
    blurb: "Webhooks and white-label portal domain configuration.",
  },
};

/**
 * Map a tool's source file (basename, no extension) to its domain group.
 *
 * Driving the mapping off the SOURCE FILE — not a hand-maintained per-tool
 * list — means new tools added to an existing file inherit the right group
 * automatically, so the taxonomy never drifts from the registration sites.
 */
export const FILE_TO_GROUP: Record<string, ToolGroupId> = {
  invoices: "invoicing",
  quotes: "invoicing",
  recurring: "invoicing",
  deposits: "invoicing",

  expenses: "expenses",
  vendors: "expenses",

  fiscal: "fiscal",
  igic: "fiscal",
  impuesto_sociedades: "fiscal",
  einvoice: "fiscal",
  audit_gl: "fiscal",
  accountingClose: "fiscal",
  onboard_vies: "fiscal",

  banking: "banking",
  bank_rules: "banking",

  clients: "crm",
  crm: "crm",

  hr: "hr",
  payroll: "hr",
  time: "hr",
  team: "hr",
  onboarding: "hr",
  permissions: "hr",

  stay: "stay",

  pos: "pos",
  kitchen: "pos",

  intelligence: "intelligence",
  gestoria: "intelligence",

  products: "catalog",

  webhooks: "platform",
  portal_domain: "platform",
};

/**
 * Per-tool overrides where the source FILE places a tool in a different group
 * than a naive name match would (verified against the 157 registration sites).
 * These eight names live in a file whose domain differs from their name prefix
 * (e.g. e-invoicing tools say "invoice" but belong to fiscal/compliance).
 */
const NAME_OVERRIDES: Record<string, ToolGroupId> = {
  send_einvoice: "fiscal",
  get_einvoice_status: "fiscal",
  validate_einvoice_xml: "fiscal",
  einvoice_export: "fiscal",
  export_datev: "fiscal",
  match_transaction_to_invoice: "banking",
  get_quarterly_taxes: "intelligence",
  duplicate_invoice: "intelligence",
  frihet_portal_onboard_link_generate: "fiscal",
  // Lives in invoices.ts (an invoice action that returns its e-invoice XML),
  // so it stays in the "invoicing" group with its sibling invoice tools.
  get_invoice_einvoice: "invoicing",
};

/**
 * Assign a group by tool NAME. The name-based mapping reproduces the
 * source-file grouping exactly for all 157 current tools (verified), with the
 * eight cross-file cases pinned via NAME_OVERRIDES. Driven off the name (not a
 * hand-kept list) so a future tool lands somewhere sensible automatically.
 *
 * Order matters: e-invoicing ("einvoice") is checked before generic "invoice".
 */
export function groupForTool(name: string): ToolGroupId {
  if (NAME_OVERRIDES[name]) return NAME_OVERRIDES[name];
  const n = name.toLowerCase();
  // Fiscal/compliance FIRST so "einvoice"/"modelo" never fall into invoicing.
  if (/(modelo|verifactu|ticketbai|einvoice|datev|face_|ksef|igic|aiem|gl_entry|period_close|period_reopen|vies|portal_onboard)/.test(n))
    return "fiscal";
  if (/(invoice|quote|credit_note|late_fee|recurring|deposit)/.test(n)) return "invoicing";
  if (/(expense|vendor)/.test(n)) return "expenses";
  if (/(bank|transaction)/.test(n)) return "banking";
  if (/(client|contact|activit|note)/.test(n)) return "crm";
  if (/(leave|attendance|overtime|anomaly|payroll|time_entr|time_summary|team|onboarding|permission)/.test(n))
    return "hr";
  if (/(reservation|propert|channel)/.test(n)) return "stay";
  if (/(terminal|sale)/.test(n)) return "pos";
  if (/(kitchen|menu_item)/.test(n)) return "pos";
  if (/(business_context|monthly_summary|gestoria)/.test(n)) return "intelligence";
  if (/(product)/.test(n)) return "catalog";
  if (/(webhook|portal_domain)/.test(n)) return "platform";
  return "platform";
}

/* ------------------------------------------------------------------ */
/*  Catalog entry                                                      */
/* ------------------------------------------------------------------ */

interface CatalogEntry {
  name: string;
  group: ToolGroupId;
  title: string;
  /** First sentence of the description, single line (for terse listings). */
  summary: string;
  /** Full original description (served by describe_tool). */
  description: string;
  /** Whether the tool mutates state (from annotations.readOnlyHint). */
  readOnly: boolean;
  /** Input field names, for quick schema shape without dumping zod. */
  inputFields: string[];
}

/** Collapse a long bilingual description to its first English sentence. */
function firstSentence(desc: string): string {
  if (!desc) return "";
  // English half comes before the " / " language separator the repo uses.
  const englishHalf = desc.split(" / ")[0];
  // First sentence: up to the first ". " that ends a clause.
  const match = englishHalf.match(/^(.*?[.!?])(\s|$)/);
  const sentence = (match ? match[1] : englishHalf).trim();
  // Hard cap so a runaway description can't reintroduce context bloat.
  return sentence.length > 160 ? sentence.slice(0, 157).trimEnd() + "…" : sentence;
}

/* ------------------------------------------------------------------ */
/*  Profile applicator                                                 */
/* ------------------------------------------------------------------ */

/** Returned for visibility/tests; the live catalog after registration. */
export interface ToolExposureHandle {
  /** All registered tools, keyed by name. */
  catalog: Map<string, CatalogEntry>;
  /** Group → tool names. */
  groups: Map<ToolGroupId, string[]>;
}

/**
 * Read process.env without referencing the `process` global type — keeps this
 * module compilable in environments without @types/node (e.g. the Cloudflare
 * Worker build, which passes its own env bag explicitly instead).
 */
function defaultEnv(): Record<string, string | undefined> {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env ?? {};
}

/**
 * Resolve the active tool mode from an env-like bag.
 * Default is "full" — current behavior, untouched.
 */
export function resolveToolMode(
  env: Record<string, string | undefined> = defaultEnv(),
): "full" | "grouped" {
  return env.FRIHET_TOOL_MODE === "grouped" ? "grouped" : "full";
}

/**
 * Apply the grouped tool-exposure profile to an MCP server.
 *
 * Must be called BEFORE registerAllTools(). Intercepts registerTool to record
 * a catalog + collapse descriptions, then (after tools are registered) adds the
 * meta-tools. Because registration is synchronous and ordered, the caller wires
 * it as:
 *
 * ```ts
 * if (resolveToolMode() === "grouped") applyToolExposureProfile(server);
 * registerAllTools(server, client);   // tools recorded + collapsed here
 * // applyToolExposureProfile already queued the meta-tools to register last
 * ```
 *
 * The meta-tools are registered immediately (eagerly) so they appear in
 * tools/list; they read from the catalog object, which is populated lazily as
 * the real tools register. This is safe: tool HANDLERS run long after all
 * registration completes.
 *
 * @param server  The McpServer (typed loosely to match the openai-profile shim).
 * @param options.allowlist  When provided, ONLY tools whose name is in this set
 *   are catalogued + collapsed; any other tool is passed through untouched.
 *   This is the OpenAI-composition path: it pins the grouped catalog (and the
 *   tools search_tools / describe_tool / list_tool_groups surface) to EXACTLY
 *   the reviewed allow-list, so progressive disclosure can never reveal or
 *   describe a tool outside the 53-tool ChatGPT-reviewed surface. Omit (default)
 *   for the open mcp.frihet.io surface, which catalogs every registered tool.
 *
 *   COMPOSITION ORDERING (openai-mcp): apply this profile FIRST so its
 *   originalRegisterTool is the REAL server.registerTool — the three meta-tools
 *   are then registered straight onto the real server and BYPASS the OpenAI
 *   allow-list gate entirely (so they always materialise without polluting the
 *   OpenAI includeTools set / its advertised 53-tool count). Apply
 *   applyOpenAIProfile() SECOND (outermost) so a business-tool registration is
 *   first redacted + annotated + openWorldHint-justified by OpenAI, and only
 *   THEN collapsed here — making the terse line the final description while the
 *   OpenAI redaction wrapper around the handler survives intact.
 * @returns a handle exposing the live catalog (useful for tests/logging).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyToolExposureProfile(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server: any,
  options?: { allowlist?: ReadonlySet<string> },
): ToolExposureHandle {
  const catalog = new Map<string, CatalogEntry>();
  const groups = new Map<ToolGroupId, string[]>();
  const handle: ToolExposureHandle = { catalog, groups };
  const allowlist = options?.allowlist;

  const originalRegisterTool = server.registerTool.bind(server);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerTool = (name: string, config: any, handler: any) => {
    // Never re-process our own meta-tools (they are registered via the original
    // bound fn below, so they won't hit this interceptor — but guard anyway).
    if (META_TOOL_NAMES.has(name)) {
      return originalRegisterTool(name, config, handler);
    }

    // Allow-list mode (OpenAI composition): only catalogue + collapse reviewed
    // tools. Anything outside the allow-list is passed through untouched so it
    // never enters the catalogue that search_tools / describe_tool expose. (In
    // the openai-mcp wiring the OpenAI profile already dropped non-reviewed
    // tools before they reach here; this is the defence-in-depth that GUARANTEES
    // the catalog is allow-list-only even if the upstream gate ever changes.)
    if (allowlist && !allowlist.has(name)) {
      return originalRegisterTool(name, config, handler);
    }

    const group: ToolGroupId = groupForTool(name);

    const fullDescription: string =
      typeof config?.description === "string" ? config.description : "";
    const inputFields: string[] = config?.inputSchema
      ? Object.keys(config.inputSchema)
      : [];
    const readOnly = config?.annotations?.readOnlyHint === true;

    const entry: CatalogEntry = {
      name,
      group,
      title: typeof config?.title === "string" ? config.title : name,
      summary: firstSentence(fullDescription),
      description: fullDescription,
      readOnly,
      inputFields,
    };
    catalog.set(name, entry);
    const list = groups.get(group);
    if (list) list.push(name);
    else groups.set(group, [name]);

    // Collapse the registered description to a single terse pointer line. The
    // tool stays fully invocable with its original handler, schema, and
    // annotations — only the description string the agent loads is trimmed.
    //
    // openWorldHint rationale MUST survive the collapse (OpenAI app review needs
    // a per-tool open-world justification on EVERY reviewed tool). When composed
    // with the OpenAI profile, that profile runs first (outermost) and has
    // already set the correct annotations.openWorldHint (e.g. true for
    // send_invoice / send_quote / create_webhook / update_webhook). We re-derive
    // the one-line rationale here from the (now-correct) annotation so the terse
    // collapsed description carries it — instead of letting the OpenAI-injected
    // rationale be lost when we overwrite config.description. Only appended in
    // allow-list (composition) mode; the open mcp.frihet.io surface keeps its
    // pure terse line (no OpenAI review constraint there).
    let collapsed =
      `[${group}] ${entry.summary} ` +
      `— full schema via describe_tool('${name}').`;
    if (allowlist) {
      const ow = config?.annotations?.openWorldHint;
      collapsed +=
        ow === true
          ? " [openWorldHint: true — contacts an entity outside Frihet (an email recipient or an external webhook URL).]"
          : " [openWorldHint: false — operates only against the Frihet API (api.frihet.io); no third-party/external calls.]";
    }
    config.description = collapsed;

    return originalRegisterTool(name, config, handler);
  };

  // Register the meta-tools eagerly. Their handlers close over `catalog`/`groups`
  // which finish populating as the real tools register right after this call.
  registerMetaTools(originalRegisterTool, handle);

  return handle;
}

/* ------------------------------------------------------------------ */
/*  Meta-tools                                                         */
/* ------------------------------------------------------------------ */

const META_TOOL_NAMES = new Set([
  "list_tool_groups",
  "search_tools",
  "describe_tool",
]);

/** Closed-world read annotation for the meta-tools. */
const META_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function textResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

/**
 * Register the three progressive-disclosure meta-tools against the ORIGINAL
 * (un-intercepted) registerTool so they don't get collapsed/catalogued.
 */
function registerMetaTools(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  originalRegisterTool: (name: string, config: any, handler: any) => unknown,
  handle: ToolExposureHandle,
): void {
  const { catalog, groups } = handle;

  // -- list_tool_groups --
  originalRegisterTool(
    "list_tool_groups",
    {
      title: "List tool groups",
      description:
        "List the Frihet ERP tool domains (invoicing, expenses, fiscal/compliance, banking, CRM, " +
        "HR/payroll, stay/PMS, POS, intelligence, products, platform) with a one-line blurb and tool " +
        "count for each. Start here, then use search_tools(query) to find tools and describe_tool(name) " +
        "for a tool's full schema. Frihet serves deep ES/EU fiscal + native compliance on demand. " +
        "[openWorldHint: false — reads the in-process tool catalog only.] " +
        "/ Lista los dominios de herramientas de Frihet ERP con descripción y recuento. Empieza aquí.",
      annotations: META_ANNOTATIONS,
      inputSchema: {},
    },
    async () => {
      const out = (Object.keys(GROUPS) as ToolGroupId[])
        .map((id) => ({
          group: id,
          label: GROUPS[id].label,
          blurb: GROUPS[id].blurb,
          toolCount: groups.get(id)?.length ?? 0,
        }))
        .filter((g) => g.toolCount > 0);
      return textResult({
        groups: out,
        totalGroups: out.length,
        totalTools: catalog.size,
        next: "search_tools(query) to find tools; describe_tool(name) for full schema.",
      });
    },
  );

  // -- search_tools --
  originalRegisterTool(
    "search_tools",
    {
      title: "Search tools",
      description:
        "Find Frihet ERP tools by free-text query (matches tool name, title, summary and group). " +
        "Returns matching tools with their group, one-line summary, read-only flag and input field names — " +
        "progressive disclosure so you load only what you need. Optionally filter by group. " +
        "Then call describe_tool(name) for a tool's full description and call it by its real name. " +
        "[openWorldHint: false — reads the in-process tool catalog only.] " +
        "/ Busca herramientas por texto libre. Devuelve coincidencias con grupo, resumen y campos.",
      annotations: META_ANNOTATIONS,
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Free-text query — matches tool name, title, summary and group. " +
              "Omit to browse a whole group. / Texto libre; omitir para listar un grupo entero.",
          ),
        group: z
          .enum(TOOL_GROUP_IDS as [ToolGroupId, ...ToolGroupId[]])
          .optional()
          .describe("Restrict results to one tool domain / Filtrar por dominio."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max results (default 25) / Máximo de resultados (por defecto 25)."),
      },
    },
    // The SDK passes parsed args; we read defensively to stay schema-light.
    async (args: { query?: unknown; group?: unknown; limit?: unknown } = {}) => {
      const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      const groupFilter =
        typeof args.group === "string" ? (args.group as ToolGroupId) : undefined;
      const limit =
        typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 25;

      const terms = query.split(/\s+/).filter(Boolean);

      const scored = [...catalog.values()]
        .filter((e) => !groupFilter || e.group === groupFilter)
        .map((e) => {
          const haystack = `${e.name} ${e.title} ${e.summary} ${e.group}`.toLowerCase();
          // Score = number of query terms present; name/title hits weighted up.
          let score = 0;
          for (const t of terms) {
            if (!haystack.includes(t)) continue;
            score += 1;
            if (e.name.toLowerCase().includes(t)) score += 2;
            if (e.title.toLowerCase().includes(t)) score += 1;
          }
          return { e, score };
        })
        // With no terms, return everything (lets agents browse a group).
        .filter(({ score }) => terms.length === 0 || score > 0)
        .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name))
        .slice(0, limit)
        .map(({ e, score }) => ({
          name: e.name,
          group: e.group,
          title: e.title,
          summary: e.summary,
          readOnly: e.readOnly,
          inputFields: e.inputFields,
          score,
        }));

      return textResult({
        query: query || null,
        group: groupFilter ?? null,
        count: scored.length,
        tools: scored,
        next: "describe_tool(name) for full schema, then call the tool by its real name.",
      });
    },
  );

  // -- describe_tool --
  originalRegisterTool(
    "describe_tool",
    {
      title: "Describe tool",
      description:
        "Return the full original description, group, read-only flag and input field names for a specific " +
        "Frihet ERP tool by its exact name (as returned by search_tools). Use this to load a tool's full " +
        "depth on demand before calling it. " +
        "[openWorldHint: false — reads the in-process tool catalog only.] " +
        "/ Devuelve la descripción completa de una herramienta por su nombre exacto.",
      annotations: META_ANNOTATIONS,
      inputSchema: {
        name: z
          .string()
          .describe(
            "Exact tool name as returned by search_tools (e.g. 'create_invoice') / " +
              "Nombre exacto de la herramienta devuelto por search_tools.",
          ),
      },
    },
    async (args: { name?: unknown } = {}) => {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const entry = catalog.get(name);
      if (!entry) {
        // Suggest near matches to keep the agent unstuck.
        const suggestions = [...catalog.keys()]
          .filter((k) => name && k.includes(name.toLowerCase()))
          .slice(0, 5);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: name
                    ? `No tool named '${name}'.`
                    : "Provide { name } — the exact tool name from search_tools.",
                  suggestions,
                  next: "Call search_tools(query) to find the right name.",
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
      return textResult({
        name: entry.name,
        group: entry.group,
        title: entry.title,
        readOnly: entry.readOnly,
        inputFields: entry.inputFields,
        description: entry.description,
      });
    },
  );
}

/** Number of meta-tools added in grouped mode (for logging). */
export const GROUPED_META_TOOL_COUNT = META_TOOL_NAMES.size;

/** Exposed for logging/tests. */
export const TOOL_GROUP_IDS = Object.keys(GROUPS) as ToolGroupId[];
