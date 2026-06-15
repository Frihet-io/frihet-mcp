# DECISION SPEC — OpenAI × grouped tool-exposure composition

**Status:** implemented, gated on Viktor's prod flip + OpenAI app re-review. **NOT deployed.**
**Surface affected:** `openai-mcp.frihet.io` only (`env.openai`). `mcp.frihet.io` and the npm package are unchanged.
**Trust Area:** the OpenAI surface is the one the ChatGPT app review covers.

---

## 1. Problem

`openai-mcp.frihet.io` ran `FRIHET_TOOL_MODE=full`: the OpenAI-safe profile alone, exposing a flat
list of 53 reviewed tools, each with a multi-paragraph bilingual description. That is exactly the
context-rot problem the grouped progressive-disclosure profile solves on `mcp.frihet.io`.

The two interceptors did **not** compose. Both wrap `server.registerTool`, and naively layering them
broke three ways:
- the OpenAI allow-list dropped the grouped meta-tools, so the collapsed summaries pointed at a
  `describe_tool()` that no longer existed;
- the grouped collapse stripped the per-tool `openWorldHint` rationale that OpenAI app review
  requires on every tool;
- the OpenAI `descriptionOverrides` (8 tools) overwrote the collapse, un-collapsing them.

## 2. Three invariants the composition must satisfy

1. **Meta-tools present** — `search_tools`, `describe_tool`, `list_tool_groups` are in `tools/list`
   in OpenAI mode. Live surface = **53 reviewed business tools + 3 meta-tools = 56**.
2. **Collapsed + open-world rationale on all 53** — each reviewed tool has a terse
   `[group] summary — full schema via describe_tool('name').` description **and** still carries the
   `[openWorldHint: true|false — …]` rationale marker. Annotation `openWorldHint` stays an explicit
   boolean.
3. **Catalog is allow-list-only** — what `search_tools` / `describe_tool` / `list_tool_groups`
   surface or accept is **exactly** the 53 reviewed tools. A tool outside the reviewed set can never
   be returned, described, suggested, or counted.

## 3. Design

Both profiles wrap `registerTool`. Wrapper applied **last** is the **outermost** (runs first on a
call). The composition pins a deliberate order:

```
applyToolExposureProfile(server, { allowlist: OPENAI_REVIEWED_TOOL_ALLOWLIST }); // 1. INNER
applyOpenAIProfile(server);                                                       // 2. OUTER
registerAllTools(server, client);
```

Per business-tool registration the flow is: **OpenAI (outer) → grouped (inner) → real server**:
1. **OpenAI (outer)** gates by the allow-list (drops the ~98 non-reviewed tools), merges annotation
   overrides (e.g. `send_invoice.openWorldHint = true`), applies `descriptionOverrides`, injects the
   `openWorldHint` rationale into the description, strips gov-ID / credential input fields, and wraps
   the handler with output redaction.
2. **grouped (inner)** catalogs the tool (only if in the allow-list) and **collapses** the
   description — making the terse line the final description — and **re-derives the `openWorldHint`
   rationale** from the now-correct `annotations.openWorldHint` and appends it to the collapsed line.
   The handler it forwards is OpenAI's redaction-wrapped handler, so redaction survives.

**Meta-tools bypass the OpenAI gate.** Because grouped is applied **first**, its
`originalRegisterTool` is the **real** `server.registerTool`. `registerMetaTools` uses that real fn,
so the 3 meta-tools register straight onto the server and never hit the OpenAI allow-list. This keeps
invariant (1) without adding the meta-tool names to `PROFILE.includeTools` — so
`OPENAI_ALLOWED_TOOL_COUNT` stays **53** and every "53 reviewed tools" doc string remains correct.

**Allow-list pins the catalog.** `applyToolExposureProfile` gained an optional
`{ allowlist?: ReadonlySet<string> }`. When set, only allow-list members are catalogued + collapsed;
anything else is passed through untouched and never enters the catalog. So `search_tools` /
`describe_tool` / `list_tool_groups` (which read only the catalog) can only ever surface the 53.
In the openai-mcp wiring the OpenAI gate already dropped non-reviewed tools before they reach grouped;
the allow-list is the **defence-in-depth** that guarantees the catalog is reviewed-only even if the
upstream gate ever changes.

### Meta-tool annotations
The 3 meta-tools are closed-world catalog lookups — read-only, no external API. They carry
`{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }` and their
descriptions embed `[openWorldHint: false — reads the in-process tool catalog only.]`. `openWorldHint:
true` is reserved for the 4 business tools that contact an entity outside Frihet (`send_invoice`,
`send_quote`, `create_webhook`, `update_webhook`).

## 4. Surface change: 53 → 56

| | before (full) | after (grouped) |
|---|---|---|
| reviewed business tools in `tools/list` | 53 | 53 |
| discovery meta-tools | 0 | 3 |
| **total `tools/list` entries** | **53** | **56** |
| each business tool description | full bilingual blob | collapsed 1-liner + openWorldHint rationale |
| advertised "reviewed tools" count (`OPENAI_ALLOWED_TOOL_COUNT`, static docs) | 53 | 53 (unchanged) |

The 3 meta-tools are discovery **plumbing**, not business capability, so the advertised reviewed-tool
count and all static-doc surfaces (`llms.txt`, `agents.json`, `/.well-known/mcp`, scoped
`openapi.json`) intentionally still say **53**.

## 5. Why it is compliant

- **No new data collection / capability.** Meta-tools are read-only, closed-world catalog lookups
  over the in-process catalog. No new external call, no new field, no new business action.
- **openWorldHint rationale preserved on every reviewed tool** (invariant 2) — the exact annotation
  OpenAI app review requires, now also on the collapsed surface.
- **Progressive disclosure cannot widen the surface** (invariant 3) — the catalog is pinned to the
  reviewed allow-list; `search_tools` / `describe_tool` / `list_tool_groups` provably never surface a
  regulated tool (fiscal / Stay / POS / HR / payroll), even by group filter or fuzzy query.
- **Gov-ID / credential redaction + input-strip unchanged** — OpenAI runs first; the grouped collapse
  forwards OpenAI's redaction-wrapped handler untouched.

## 6. ⚠️ Required before going live

This is a **53 → 56 tools/list change on the ChatGPT-reviewed surface.** It MUST NOT ship silently.

1. **Viktor's explicit prod flip.** `wrangler deploy --env openai` (with `FRIHET_TOOL_MODE=grouped`).
2. **OpenAI app re-review.** The ChatGPT connector tool list changes (3 new tools, all descriptions
   restated). Submit for re-review per
   `https://developers.openai.com/apps-sdk/app-submission-guidelines` before enabling for users.
3. **Live smoke after deploy:** `node scripts/test-openai-grouped-compose.mjs --key fri_*` (it asserts
   the 56-tool surface + the 3 invariants against `https://openai-mcp.frihet.io/mcp`). DO NOT run
   before deploy — it will fail on the meta-tool checks against the current "full" surface.

**Rollback:** set `env.openai.vars.FRIHET_TOOL_MODE` back to `"full"` and redeploy. Code paths for
openai-only and grouped-only are unchanged, so the rollback is a pure config flip.

## 7. Test wiring (merge note)

`src/__tests__/openai-grouped-compose.test.ts` covers all three invariants (12 assertions). It runs
clean via `node --test dist/__tests__/openai-grouped-compose.test.js`.

It is **not yet added to `package.json`'s `test` script** because that file currently has an
unrelated uncommitted edit from a sibling task (the `server.json` version gate adding
`audit-server-version.test.js`). To avoid a same-line merge conflict, append
`dist/__tests__/openai-grouped-compose.test.js` to the `test` script's file list **at merge time**,
alongside the sibling change. Until then, the gate runs it explicitly.

## 8. Files changed

- `src/tool-exposure.ts` — optional `{ allowlist }` param; allow-list filters catalog/collapse; collapse re-derives + appends the openWorldHint rationale in allow-list mode.
- `src/openai-profile.ts` — export `OPENAI_REVIEWED_TOOL_ALLOWLIST` (the 53-tool `PROFILE.includeTools`).
- `src/index.ts` (npm/stdio) — compose grouped-first / openai-second; pass allow-list when both on.
- `workers/remote-mcp/src/index.ts` — same composition wiring for the Worker.
- `workers/remote-mcp/wrangler.toml` — `env.openai` `FRIHET_TOOL_MODE` `"full"` → `"grouped"` + rationale + compliance note.
- `src/__tests__/openai-grouped-compose.test.ts` — new composition test (invariants 1/2/3).
- `scripts/test-openai-grouped-compose.mjs` — new live smoke (write-only; run after deploy).
- `DECISION_SPEC.md` — this file.
