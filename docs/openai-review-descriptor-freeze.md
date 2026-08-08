# OpenAI review descriptor freeze

The ChatGPT connector is frozen while OpenAI review is active. Its approved
surface is exactly 53 business tools plus the three discovery tools
`describe_tool`, `list_tool_groups`, and `search_tools`. It exposes zero MCP
prompts and zero MCP resources.

## What the gate freezes

`src/__tests__/fixtures/openai-review-descriptor.snapshot.json` is the canonical
semantic contract. It is captured through a real MCP `tools/list` request after
the production composition order:

1. grouped exposure with `OPENAI_REVIEWED_TOOL_ALLOWLIST`;
2. the OpenAI profile;
3. `registerAllTools`, `registerAllResources`, and `registerAllPrompts`.

The snapshot stores every field actually emitted for each tool, including its
name, title, description, input schema, output schema, annotations, execution
metadata, and any future security metadata. The gate canonicalizes only JSON
object-key order and `tools/list` ordering. Schema arrays and all semantic values
remain exact.

The same snapshot also freezes the Worker OAuth authorization-server discovery,
protected-resource metadata, resolved OAuth provider package version, and the
`WWW-Authenticate` `resource_metadata` URL. The pure OAuth builder consumes the
same options object spread into the real Worker provider.

Run the fail-closed gate with:

```bash
npm run gate:openai-review-descriptor
```

The repository CI runs this gate on every pull request and every push to
`main`; the freeze is therefore a blocking contract, not an optional local
check.

Run the positive capture and mutation selftests with:

```bash
npm run test:openai-review-descriptor
```

The selftests prove that removal, rename, description drift, annotation drift,
a newly required input, a newly introduced sensitive field, a hidden-tool leak,
prompt/resource registration, OAuth issuer/resource drift, and challenge URL
drift each fail the gate.

## Refresh policy

Do not refresh this snapshot for ordinary implementation changes, dependency
updates, formatting, or to make CI green. There is deliberately no `--update`
mode.

A refresh is allowed only after the owner approves a new OpenAI app review and
the proposed surface is documented in that review. Then:

1. Merge current `origin/main` and obtain explicit approval for the new review
   descriptor.
2. Build and print the candidate without overwriting the canonical fixture:

   ```bash
   npm run build
   node scripts/check-openai-review-descriptor.mjs --print-current > /tmp/openai-review-descriptor.candidate.json
   diff -u src/__tests__/fixtures/openai-review-descriptor.snapshot.json /tmp/openai-review-descriptor.candidate.json
   ```

3. Review every semantic difference. Confirm names, descriptions, schemas,
   annotations, security metadata, tool counts, zero prompts/resources, and all
   OAuth URLs against the newly approved submission.
4. Only after that review, replace the fixture deliberately and inspect the Git
   diff before staging it.
5. Run all positive, negative, boundary, and authentication evaluations:

   ```bash
   npm run build
   npm test
   npm run test:openai-review-descriptor
   npm run gate:openai-review-descriptor
   cd workers/remote-mcp && npm test && npm run typecheck
   ```

6. Run the live read-only smoke against the reviewed Worker. It lists tools and
   calls only the three in-process discovery tools; it performs no ERP mutation:

   ```bash
   FRIHET_API_KEY=fri_xxx node scripts/test-openai-grouped-compose.mjs
   ```

7. Attach the complete local diff and live-smoke evidence to the new review.

Never deploy, publish, bump versions, change live OAuth metadata, or refresh the
snapshot as part of the gate itself.

## Deliberate divergence — truth-in-descriptions (2026-08-08)

**This is not a refresh. The fixture was not touched and the gate is green.**

An audit (GAP-04, GAP-12) found that `delete_invoice` and `delete_quote`
promised *"Permanently delete … This action cannot be undone"* while the backend
only destroys a **draft**; anything already issued is **cancelled**
(`status=cancelled`) because VeriFactu forbids breaking the invoice hash chain.
The same audit found `delete_invoice`, `delete_quote`, `refund_deposit` and
`send_invoice` shipping with no confirmation guard.

Fixing that on the base tools changes the description *and* adds a required
`confirm` input. All three of the reviewed tools
(`delete_invoice` = `$.tools[15]`, `delete_quote` = `$.tools[17]`,
`send_invoice` = `$.tools[47]`) sit inside the frozen descriptor, and an app
review has been in flight since July. Refreshing the snapshot needs owner
approval; shipping nothing leaves the false prose live on every surface.

The resolution keeps both invariants:

| Surface | Description | `confirm` |
|---------|-------------|-----------|
| Direct MCP (Claude, Cursor, Cline, npm, `mcp.frihet.io`) | corrected | **required** |
| Reviewed ChatGPT (`tools/list`) | byte-identical to the fixture | absent from the schema |
| Reviewed ChatGPT (`describe_tool`) | **corrected** | n/a |

How it works — all in `src/openai-profile.ts`:

1. **`descriptionOverrides`** for the three tools pin the **first sentence**
   byte-identical to the approved text. In grouped mode `tools/list` emits only
   `[group] firstSentence(description) — full schema via describe_tool(…)`, so
   everything after that first sentence never reaches the frozen surface. The
   correction lives in those later sentences and is served by `describe_tool`,
   which the model calls before invoking and which the freeze does not cover.
2. **`stripInputFields`** removes `confirm` from the three reviewed schemas.
3. **`impliedInputValues`** supplies `confirm: true` to the handler on the
   reviewed surface. Without it, stripping a *required* field would make each
   tool a permanent input-validation error in ChatGPT.
4. **`outputSchemaOverrides`** holds `delete_invoice` / `delete_quote` at the
   approved `deleteResultOutput` shape; the base tools widened to
   `documentDeleteResultOutput` (which carries `outcome: deleted | cancelled`).

Why the reviewed surface is not left unprotected: `delete_invoice` and
`delete_quote` carry `destructiveHint: true`, so ChatGPT prompts the user before
invoking them. `confirm` exists for direct MCP clients, which have no such UI.

### Still open after this divergence

- **`send_invoice` has `destructiveHint: false` and `openWorldHint: true`.**
  ChatGPT does **not** prompt for it, and `confirm` is stripped there, so on the
  reviewed surface a send can be triggered with no confirmation at any layer.
  Correcting the annotation would itself drift the frozen descriptor. This gap
  is **not** closed by this divergence.
- Eleven other risky tools ship with no confirm guard; six of them are inside
  the frozen descriptor. They are enumerated in `UNGATED_RISK_DEBT` in
  `src/__tests__/truth-in-descriptions.test.ts`, which fails if the list grows.

### Closing conditions

When the current review completes, the owner should approve a delta that folds
the corrected prose and the `confirm` input into the reviewed descriptor, then
delete all four mechanisms above along with `FROZEN_DIVERGENCE` in
`src/__tests__/truth-in-descriptions.test.ts`. Until then the divergence is
pinned by that test block: the composed description is compared to the fixture,
`confirm` is asserted required on the base surface and absent on the reviewed
one, and the reviewed tools are invoked with only their advertised inputs to
prove `impliedInputValues` keeps them working.

## Approved resubmission delta — 2026-08-03

The owner approved preparing a new OpenAI review after the previous submission
was rejected. The current portal scan also flagged the optional `fields`
argument as unclear on seven reviewed tools. The approved candidate removes
that argument from `list_invoices`, `search_invoices`, `list_expenses`,
`list_clients`, `list_products`, `list_quotes`, and `list_vendors` in OpenAI
mode only. Direct MCP clients retain the existing comma-delimited projection.

This is a subtractive input-schema change: tool names, counts, annotations,
handlers, outputs, OAuth metadata, prompts, and resources remain unchanged.

## Approved final-submission delta — 2026-08-03

Before the third review, the owner requested a no-warning submission. The
candidate replaces the permissive empty-object output schemas on
`get_business_context`, `get_monthly_summary`, and `duplicate_invoice` with
concrete schemas derived from the live API implementations.

The same review found that sensitive output-schema stripping inspected Zod
v3's `_def.typeName`, while the tool schemas use Zod v4. Runtime values were
redacted, but descriptor declarations such as `taxId` and `secret` survived.
The traversal now uses Zod v4 types, and the contract gate rejects every
sensitive schema path instead of grandfathering paths from an old snapshot.

The only contextual exception is `documentNumber` on create/update invoice
inputs: there it is the business invoice sequence, not a government identity
document. The exception is pinned to those two exact schema paths.
