# OpenAI review descriptor freeze

The ChatGPT connector contract is exactly 53 reviewed business operations plus
three read-only discovery operations, with zero MCP prompts and zero MCP
resources.

`src/__tests__/fixtures/openai-review-descriptor.snapshot.json` is the canonical
semantic artifact. It is captured through the production composition path and
stores the complete `tools/list` descriptor plus the reviewed OAuth discovery
contract. CI fails closed on tool, schema, annotation, sensitive-field,
prompt/resource, or OAuth drift. The checker deliberately has no automatic
update mode.

The reviewed profile is subtractive. It removes unsupported projection inputs,
government tax identifiers such as `clientTaxId`, credential fields, and other
sensitive declarations/values from reviewed mode while preserving direct MCP
behavior. Webhook and CRM descriptors follow the current API contract. The
business invoice `documentNumber` exception remains limited to its exact
reviewed invoice input paths.

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
2. Build, print the candidate via the checker's print mode (no overwrite of the
   canonical fixture), and diff against the snapshot.
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
   calls only the three in-process discovery tools; it performs no ERP mutation.
   The exact invocations are kept out of this public document on purpose.
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

The resolution keeps both invariants, with a hard rule that the reviewed surface
MUST NOT manufacture user authorization:

| Surface | Description | `confirm` | Behaviour on invocation |
|---------|-------------|-----------|------------------------|
| Direct MCP (Claude, Cursor, Cline, npm, `mcp.frihet.io`) | corrected | **required** | enforced by tool handler |
| Reviewed ChatGPT (`tools/list`) | byte-identical to the fixture (first sentence) | absent from the schema | n/a |
| Reviewed ChatGPT (`describe_tool`) | corrected + temporary-disposition note | n/a | n/a |
| Reviewed ChatGPT (call) | n/a | absent | **FAIL CLOSED** — isError unless explicit `confirm: true` |

How it works — all in `src/openai-profile.ts`:

1. **`descriptionOverrides`** for the three tools pin the **first sentence**
   byte-identical to the approved text. In grouped mode `tools/list` emits only
   `[group] firstSentence(description) — full schema via describe_tool(…)`, so
   everything after that first sentence never reaches the frozen surface. The
   correction lives in those later sentences and is served by `describe_tool`,
   which the model calls before invoking and which the freeze does not cover.
2. **`stripInputFields`** removes `confirm` from the three reviewed schemas.
3. **`failClosedTools`** lists the three reviewed tools whose `confirm` was
   stripped. The wrapped handler refuses any call without an explicit
   `confirm: true` BEFORE the side-effecting handler runs, returning isError
   with a message that names the operation as "temporarily unavailable on this
   surface pending the ongoing OpenAI app review". The agent has a prose basis
   to recover (or to suggest the Frihet app / a direct MCP client).
4. **`outputSchemaOverrides`** holds `delete_invoice` / `delete_quote` at the
   approved `deleteResultOutput` shape; the base tools widened to
   `documentDeleteResultOutput` (which carries `outcome: deleted | cancelled`).

The fail-closed gate replaces the earlier `impliedInputValues: { confirm: true }`
bridge. That mechanism manufactured user authorization — the agent never
confirmed, the tool never prompted (especially for `send_invoice`, which carries
`destructiveHint: false / openWorldHint: true` and so does NOT trigger a
ChatGPT destructive-action prompt), and the call went through. Manufacturing
consent is a hard rule violation. Temporary unavailability is the honest
alternative: refuse the call, tell the agent why, and let the user pick a
surface where `confirm` is enforceable (Frihet app, direct MCP).

Direct MCP clients are unaffected: the `confirm` field is not stripped there
(it stays required and enforced by the tool handler). The change is scoped to
the OpenAI profile.

### Still open after this divergence

- Eleven other risky tools ship with no confirm guard; six of them are inside
  the frozen descriptor. They are enumerated in `UNGATED_RISK_DEBT` in
  `src/__tests__/truth-in-descriptions.test.ts`, which fails if the list grows.
  Of those, the ones exposed on the reviewed ChatGPT surface (delete_client,
  delete_client_contact, delete_client_note, delete_product, delete_vendor,
  delete_webhook, frihet_portal_domain_remove, send_quote, send_einvoice) are
  also fail-closed candidates for a future remediation: the same manufacturing-
  consent concern applies if a future change adds a required `confirm` to their
  base schemas. They are out of scope for this lane.
- `send_invoice` is now fail-closed on the reviewed surface (not just an open
  gap). The previous "ChatGPT does not prompt for confirmation" concern is
  resolved by the gate; the temporary disposition is documented in
  `describe_tool` and in the isError message.

### Closing conditions

When the current review completes, the owner should approve a delta that folds
the corrected prose and the `confirm` input into the reviewed descriptor, then
remove `failClosedTools` and the fail-closed branch from the wrapped handler,
restore the `confirm` field on the reviewed schemas, and delete
`FROZEN_DIVERGENCE` in `src/__tests__/truth-in-descriptions.test.ts`. Until then
the divergence is pinned by that test block: the composed description is
compared to the fixture, `confirm` is asserted required on the base surface and
absent on the reviewed one, and the reviewed tools are invoked with only their
advertised inputs to prove the fail-closed gate refuses them without
explicit `confirm: true`.

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

Any semantic fixture change requires an explicit owner decision and independent
review of the complete candidate difference. Updating the fixture does not
authorize deployment, provider changes, OAuth scope changes, fiscal sends, or a
release. Operational review and release procedures are maintained outside this
public repository.
