# Catalog-level availability metadata — design note (C29)

**Status: PROPOSAL ONLY. Nothing in this note is implemented.** It exists so the
product owner can decide with numbers instead of re-deriving them. Written
2026-08-08 alongside the GAP-04/GAP-12/GAP-13/C38 truth-in-descriptions fix,
which deliberately did **not** touch this surface.

## The problem, stated precisely

Availability is modelled today as a **runtime error condition**, never as
**catalog data**. `src/tools/backend-availability.ts` builds an explicit "the
backend for X is not available yet — this is NOT an empty result" error, but it
can only fire *after* the agent has already chosen the tool, planned around it
and (in grouped mode) spent a `describe_tool` round-trip. Two consequences:

1. **Discovery lies by omission.** `search_tools` rows
   (`tool-exposure.ts`, the `.map(({ e, score }) => …)` in the `search_tools`
   handler) and the `describe_tool` payload emit `name/group/title/summary/
   readOnly/inputFields/description`. An unbacked tool is byte-identical to a
   working one. `list_tool_groups` reports a raw `toolCount` that includes them.
2. **The guard cannot fire at all for 501 routes.** `isBackendNotFound()` matches
   `statusCode === 404` / `status === 404` only. `period_close`,
   `period_reopen` and the gestoría write routes answer **501**, so they fall
   through to the generic error path. (This lane fixed the *prose* for the two
   period tools; the *metadata* gap is what this note is about.)

## What it would take

### 1. Where the truth would live

New file `src/tools/tool-availability.ts` — a single hand-maintained table, no
network, no inference:

```ts
export type Availability = "available" | "disabled" | "planned" | "permission_required";

export interface AvailabilityEntry {
  status: Availability;
  /** Agent-readable, present tense: what happens if you call it today. */
  reason: string;
  /** Only for permission_required. */
  requiredScope?: string;
  requiredPlan?: string;
}

export const TOOL_AVAILABILITY: Record<string, AvailabilityEntry> = { /* … */ };
```

Seeded from what the audit actually verified: the IGIC 415/425/418 family, AIEM,
Modelo 200/202/180, `onboarding_status`, `gestoria_aging_consolidated` (404s),
plus `period_close` / `period_reopen` and the gestoría template / bulk-send /
messages write routes (501s). Anything absent from the table defaults to
`"available"` — the table lists exceptions, not the whole 157-tool surface.

### 2. Fields, and who consumes each one

| Field | Consumer | Why it must exist there |
| --- | --- | --- |
| `status` | `search_tools` rows, `describe_tool` payload | the two discovery surfaces an agent reads *before* committing to a tool |
| `reason` | `describe_tool` payload, collapsed description suffix | the agent has to be able to tell the user *why*, not just *no* |
| `requiredScope` / `requiredPlan` | `describe_tool` payload | distinguishes "we did not build it" from "your key cannot reach it" — different user action |
| the same `status`, aggregated | `list_tool_groups` | `toolCount` should split into e.g. `toolCount` / `availableCount` instead of advertising dead tools in a single number |

### 3. The load-bearing half is NOT the catalog

`resolveToolMode()` returns `"grouped"` **only** when
`FRIHET_TOOL_MODE === "grouped"`; every other value, including unset, resolves to
`"full"`. In full mode `applyToolExposureProfile` never runs, so `CatalogEntry`,
`search_tools` and `describe_tool` **do not exist**. A catalog-only fix therefore
covers zero users on the default surface.

Order of work, by actual coverage:

1. **Registration-time description suffix** — append
   `" [NOT AVAILABLE YET — <reason>]"` to the tool's own registered
   `description` when the table says so. This is the only step that reaches
   default (full) mode, and it needs a hook in `src/tools/register-all.ts` or a
   wrapper around `server.registerTool`.
2. **Catalog field** — add `availability` + `availabilityReason` to
   `CatalogEntry`, populate at the entry-construction site defaulting to
   `"available"`, emit in the `search_tools` row map and the `describe_tool`
   payload.
3. **Group-level honesty** — the fiscal blurb positively advertises
   `200/202/415/425/418` and `IGIC/AIEM`; and `src/index.ts` ships a server-level
   instructions string claiming "full Spanish tax compliance (IVA, IGIC, IPSI)"
   to **every** client in **both** modes. No per-tool field touches either one.

### 4. Gates it would need

- A **drift guard**: every key in `TOOL_AVAILABILITY` must exist in the
  registered tool set, so a rename cannot silently orphan an entry.
- A **501/404 parity test**: every tool whose backend route is known-unimplemented
  carries `status !== "available"` *and* a description containing no present-tense
  capability assertion.
- The table is hand-maintained, so **it will rot**. Without the drift guard plus
  a periodic live probe it becomes another stale-status ghost — the failure mode
  it is meant to cure.

## Cost and the decision the owner actually faces

Roughly one file plus four edit sites plus three tests — mechanical, no handler,
schema or ERP change. The real cost is not the code:

**Every one of these tools is inside the versioned OpenAI review descriptor or
adjacent to it.** Appending `[NOT AVAILABLE YET]` to a registered description is
exactly the "description drift" the contract gate is built to reject
(`docs/openai-review-descriptor-freeze.md`). So step 1 — the only step that
covers the default mode — cannot ship without an approved new review descriptor.

The genuine fork, and it is a product call, not an engineering one:

- **(A) Label them.** Honest discovery, but the connector advertises its own
  holes to every ChatGPT user, and it costs an OpenAI re-review.
- **(B) Unregister them** behind a flag until the backend lands. Nothing to
  label, nothing to rot; the surface shrinks and the published tool count moves.
- **(C) Leave it.** The call-time 404 guard stays the only signal, 501 routes
  stay silent, and discovery keeps presenting dead tools as live.

This note takes no position between them.
