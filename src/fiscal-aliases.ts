/**
 * Fiscal `modelo` tool naming aliases — prefix-drift fix (issue #50).
 *
 * ── Problem ──────────────────────────────────────────────────────────────
 * The `modelo` fiscal tools split 5/5 on naming prefix: the mainland AEAT
 * models (`fiscal.ts`) use `get_modelo_*`, while the Canary IGIC + Impuesto
 * Sociedades models (`igic.ts`, `impuesto_sociedades.ts`) use the house
 * `frihet_*` convention. An agent that learns the `frihet_modelo_NNN_summary`
 * pattern from IGIC/IS will guess `frihet_modelo_303_summary` for VAT and get
 * tool-not-found — 303/130/347 are the most-used models.
 *
 * ── Fix ──────────────────────────────────────────────────────────────────
 * Register thin NAME ALIASES that resolve to the exact same registered tool
 * (same handler, same schema, same annotations — zero semantic divergence),
 * WITHOUT calling `registerTool()` a second time. The MCP SDK's `McpServer`
 * resolves `tools/call` by looking up `this._registeredTools[name]`
 * (mcp.js: `setToolRequestHandlers` -> `CallToolRequestSchema` handler), so
 * pointing an alias key at the SAME registered-tool object makes it callable
 * with zero duplication and zero drift risk.
 *
 * This intentionally does NOT touch `src/tools/*.ts` (where the 157-tool
 * audit / pin tests count literal `registerTool(` call sites) and is applied
 * to the REAL `McpServer` instance only, AFTER `registerAllTools()` — the
 * `tool-exposure.test.ts` / `openai-*.test.ts` suites exercise
 * `registerAllTools()` against a bare `StubMcpServer` and never call
 * `applyFiscalAliases`, so the 157-tool pins are untouched by design.
 *
 * KNOWN LIMITATION: this relies on the SDK's internal (unprefixed-by-type,
 * but underscore-private) `_registeredTools` field. It is FAIL-OPEN — if a
 * future SDK release renames/removes that field, `applyFiscalAliases` is a
 * silent no-op (the canonical `get_modelo_*` names keep working; only the
 * alias convenience is lost). Pinned by `fiscal-aliases.test.ts`.
 */

/** alias name -> canonical registered tool name. */
export const FISCAL_MODELO_ALIASES: Readonly<Record<string, string>> = {
  frihet_modelo_303_summary: "get_modelo_303_summary",
  frihet_modelo_130_summary: "get_modelo_130_summary",
  frihet_modelo_390_summary: "get_modelo_390_summary",
  frihet_modelo_180_summary: "get_modelo_180_summary",
  frihet_modelo_347_summary: "get_modelo_347_summary",
};

/** Shape of the McpServer internals this module reaches into. */
interface McpServerInternals {
  _registeredTools?: Record<string, unknown>;
}

/**
 * Apply the fiscal `modelo` aliases to a live `McpServer` instance. Call this
 * AFTER `registerAllTools()` so every canonical tool already exists.
 *
 * Fail-open: if the SDK's internal registry is missing or reshaped, this is a
 * silent no-op — it never throws, and never blocks server startup.
 */
export function applyFiscalAliases(server: unknown): void {
  const registry = (server as McpServerInternals)._registeredTools;
  if (!registry || typeof registry !== "object") return;

  for (const [alias, canonical] of Object.entries(FISCAL_MODELO_ALIASES)) {
    const target = registry[canonical];
    if (!target) continue; // Canonical tool not registered in this profile (e.g. an allow-listed mode) — skip, no divergence.
    if (registry[alias]) continue; // Never overwrite an existing registration.
    registry[alias] = target; // Same object reference as the canonical tool — zero semantic divergence.
  }
}
