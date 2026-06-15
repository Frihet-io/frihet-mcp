# Tool exposure modes — depth served on demand

> Status: implemented, opt-in. Default behavior is unchanged.
> Env flag: `FRIHET_TOOL_MODE` (`full` | `grouped`). Default `full`.

## The problem

The Frihet MCP server ships a wide surface: full ES/EU fiscal coverage plus
native compliance (VeriFactu, TicketBAI, Facturae/FACe/KSeF), banking, CRM,
HR/payroll, stay/PMS and POS. That depth is the moat — it's what makes an agent
able to actually run a Spanish business end to end.

But exposing every tool, with its full description and schema, in a single flat
`tools/list` is the 2026 **context-rot** problem. A large flat tool list:

- consumes a big slice of the agent's context window before any work starts;
- degrades tool *selection* (more near-duplicates to disambiguate);
- scales badly as the surface keeps growing.

The fix is not to cut the depth. The fix is to **serve depth on demand**:
progressive disclosure.

## The mechanism

`FRIHET_TOOL_MODE` selects the exposure strategy. It is purely an **exposure
layer** — it never changes a tool's name, input schema, annotations or handler
logic.

### `full` (default)

All tools are registered exactly as before, with their full bilingual
descriptions and schemas. **Byte-identical to previous releases.** Existing
clients are unaffected; no opt-out needed.

### `grouped` (opt-in)

A single interceptor (`src/tool-exposure.ts`, mirroring the
`src/openai-profile.ts` pattern) wraps `registerTool` and, for every real tool:

1. records it into an in-memory **catalog** (`name → group, title, summary,
   full description, input fields`);
2. registers it unchanged **except** its description, which collapses to one
   terse line:
   `[group] <one-sentence summary> — full schema via describe_tool('name').`

Then it adds **three discovery meta-tools** as the entry point:

| Meta-tool | Returns |
|-----------|---------|
| `list_tool_groups()` | The 11-domain map (invoicing, expenses, fiscal/compliance, banking, CRM, HR/payroll, stay/PMS, POS, intelligence, products, platform) with a one-line blurb + tool count each. |
| `search_tools(query, group?, limit?)` | Tools matching a free-text query across name/title/summary/group, with their group, summary, read-only flag and input fields. Ranked, with the exact-name match on top. |
| `describe_tool(name)` | The **full original description** and input fields for one tool, on demand. |

The agent now loads three meta-tool descriptions plus ~151 terse one-liners
instead of 151 multi-paragraph bilingual blobs, and pulls full depth only for
the handful of tools it actually needs.

```
agent → list_tool_groups()          # "what domains exist?"
agent → search_tools("modelo 303")  # "find the IVA quarterly tool"
agent → describe_tool(              # "load its full schema"
          "get_modelo_303_summary")
agent → get_modelo_303_summary(...) # call the real tool, unchanged
```

## Group taxonomy

Groups are derived from the tool name via `groupForTool(name)`, which
reproduces the source-file grouping (`FILE_TO_GROUP`) exactly for all current
tools — a unit test asserts the two never drift. New tools added to an existing
tool file inherit the right group automatically.

| Group | Source files |
|-------|--------------|
| `invoicing` | invoices, quotes, recurring, deposits |
| `expenses` | expenses, vendors |
| `fiscal` | fiscal, igic, impuesto_sociedades, einvoice, audit_gl, accountingClose, onboard_vies |
| `banking` | banking, bank_rules |
| `crm` | clients, crm |
| `hr` | hr, payroll, time, team, onboarding, permissions |
| `stay` | stay |
| `pos` | pos |
| `intelligence` | intelligence, gestoria |
| `catalog` | products |
| `platform` | webhooks, portal_domain |

A few tools whose *name* prefix differs from their *domain* (e.g. e-invoicing
tools that say "invoice" but belong to fiscal/compliance) are pinned via a small
`NAME_OVERRIDES` table.

## Guarantees

- **`full` is unchanged.** Default path applies no interceptor.
- **No behavior change in `grouped`.** Names, input schemas, annotations and
  handlers are untouched; only the *description string* the agent loads up front
  is collapsed. The real tools stay fully invocable.
- **Audited tool count stays 151.** The exposure layer lives in `src/`, not
  `src/tools/*.ts`, so `npm run audit:mcp-refs` still counts 151 ERP tools. The
  three meta-tools are discovery helpers, not ERP tools, and are added only in
  grouped mode.
- **Composes with `FRIHET_OPENAI_MODE`.** If both are set, the OpenAI allowlist
  runs first and grouped mode collapses whatever survives.

## Positioning

Lead with the capability, not the count: *full ES/EU fiscal + native compliance
(VeriFactu / TicketBAI / Facturae) served on demand* — grouped mode is how that
depth stays usable inside an agent's context budget as the surface grows.

## Tests

`src/__tests__/tool-exposure.test.ts` covers: mode resolution; full mode is
byte-identical (151 tools, no meta-tools, descriptions untouched); grouped mode
adds 3 meta-tools + a 151-entry catalog and collapses descriptions; names,
annotations, schemas and handler behavior are preserved; `groupForTool`
reproduces `FILE_TO_GROUP` for all 151 tools; and each meta-tool's runtime
behavior (`list_tool_groups`, `search_tools` with group filter, `describe_tool`
including the unknown-name error path).
