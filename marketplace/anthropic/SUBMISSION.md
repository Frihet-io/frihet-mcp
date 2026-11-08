# Frihet for Claude — Directory submission

**Connector and plugin submitted on 22 October 2026; both are in review. Neither is published.**

The hosted connector is `https://claude-mcp.frihet.io/mcp`, under the name
**Frihet** and the official black-circle icon. Its submitted source is
`d6258b42481a0dfb33708848f6409f81a8f894bf`: 132 tool names, 2 prompts and 1 resource.
The plugin submission uses `plugins/claude/frihet-erp`, version
`1.18.0-preview.4`, with 8 skills and 1 remote MCP. Its security scan passed;
publication remains a separate action and automatic publication is disabled.

Review access is restricted to dedicated synthetic accounts. General customer
admission is not enabled. Submission and a passing scan do not establish
Anthropic approval, public availability, or successful business execution of
every tool. Review credentials and private operational receipts are not part
of this repository.

The existing full MCP service at [mcp.frihet.io](https://mcp.frihet.io/) and
[GitHub MCP Registry entry](https://github.com/mcp/io.frihet/erp) are real,
separate distribution surfaces. The live full catalogue has been queried; that
does not prove a fresh OAuth login, every backing API operation, or approval in
the Claude Directory. This document does not claim that existing full OAuth is
broken. The local candidate below is also distinct from the frozen 33-tool
OpenAI connector and does not change that hosted profile.

## Local candidate

```sh
npm run build
FRIHET_CLAUDE_MODE=true FRIHET_DEMO=1 node dist/index.js
# Optional progressive discovery:
FRIHET_CLAUDE_MODE=true FRIHET_TOOL_MODE=grouped FRIHET_DEMO=1 node dist/index.js
```

For real local work, replace demo mode with a user-managed `FRIHET_API_KEY`.
Demo fixtures do not establish live acceptance. Setting both `FRIHET_CLAUDE_MODE=true` and
`FRIHET_OPENAI_MODE=true` fails before registration.

The explicit candidate inventory starts with 156 canonical operations at source
`176de12`: **156 − 8 unavailable − 8 deferred − 15 other exclusions = 125**. Five exclusions
(`einvoice_export`, `face_*`, `ticketbai_*`) need an einvoice scope that the Claude pilot
credential does not carry (M2, ERP #2477); `send_einvoice`, `get_einvoice_status`,
`validate_einvoice_xml` and `export_datev` call `/einvoice/*` paths that have no ERP route (404).
It retains tax, invoice email, payroll and banking families, subject
to each operation's workspace/API availability and declared external effects.
A profile is not evidence that every endpoint works for every tenant.

| Composition | Canonical operations | Fiscal aliases | Discovery names | Total tool names | Resources | Prompts |
|---|---:|---:|---:|---:|---:|---:|
| Local full candidate | 125 | 4 | 0 | 129 | 1 | 2 |
| Local grouped candidate | 125 | 4 | 3 | 132 | 1 | 2 |
| Reusable remote full composition | 125 | 4 | 0 | 129 | 1 | 2 |
| Reusable remote grouped composition | 125 | 4 | 3 | 132 | 1 | 2 |

Remote rows also match the submitted hosted catalogue. SDK composition tests
remain separate from authenticated operation coverage.
Filtering happens before SDK registration and discovery indexing; future
canonical names are denied until explicitly reviewed. Aliases reference only
permitted canonical handlers. Group/search counts count operations, not aliases.
The retained aliases are `frihet_modelo_303_summary`,
`frihet_modelo_130_summary`, `frihet_modelo_390_summary` and
`frihet_modelo_347_summary`. `frihet_modelo_180_summary` is denied with its target.

## Excluded operations and reasons

| Exact names | Reason |
|---|---|
| `ksef_submit`, `get_modelo_180_summary`, `frihet_modelo_415_summary`, `frihet_modelo_418_summary`, `frihet_modelo_425_summary`, `frihet_aiem_calculate`, `frihet_modelo_200_summary`, `frihet_modelo_202_summary` | Eight operations marked unavailable; no deployed backing ERP route in the reviewed contract. |
| `period_close`, `period_reopen`, `gestoria_message_send`, `gestoria_messages_list`, `gestoria_template_bulk_send`, `gestoria_aging_consolidated`, `create_reservation`, `sync_channel` | Eight operations whose handlers explicitly defer execution. |
| `einvoice_export`, `face_status`, `face_submit`, `ticketbai_status`, `ticketbai_submit` | The Claude pilot credential carries no einvoice scope (M2, ERP #2477); the ERP returns 403 for these routes. |
| `send_einvoice` | No deployed backing ERP route: `POST /einvoice/send` is unavailable in the ERP (404). |
| `get_einvoice_status`, `validate_einvoice_xml`, `export_datev` | No deployed backing ERP route: `GET /einvoice/status/:id`, `POST /einvoice/validate` and `POST /einvoice/export-datev` are unavailable in the ERP (404). |
| `refund_sale` | Executes a Stripe money transfer; excluded under Anthropic Directory policy §4.A. Confirmation alone does not change this effect. |
| `delete_client` | Linked contacts, notes and activities can remain stored but unreachable. |
| `delete_expense` | Linked attachment metadata/object cleanup is not established. |
| `send_quote` | Previewed recipient is not atomically bound; delivery is not retry-safe. |
| `get_invoice_pdf`, `get_invoice_einvoice` | Raw invoice PDF, e-invoice XML and Factur-X PDF artifacts can contain sensitive values; the Claude field-redaction boundary cannot safely sanitize these documents. |

`refund_deposit` is retained after correcting its contract: optional amount-only
bookkeeping, with no transfer of money. Its backend read/update concurrency and
rounding to cents still need live validation; candidate inclusion is not a
claim of concurrent or monetary-precision safety. `run_recurring_now` now
requires `confirm=true` in both exposure modes and discloses configured fiscal
issuance/submission and webhook effects. These are operation-specific facts,
not a blanket prohibition on accounting, taxes, email or payroll.

## Resources and prompts

Retained in both local and remote compositions: `frihet://config/currencies`,
display formatting examples and historical codes, not payment precision or FX
authority. Business and plan context use `get_business_context`; monthly data
uses `get_monthly_summary`. Use paginated `list_invoices` and `get_invoice` for
receivables. The former local-only business-profile, monthly-snapshot,
overdue-invoices and plan-limits resources are excluded so both compositions
have the same bounded context.

| Excluded resource | Content-review reason |
|---|---|
| `frihet://api/schema` | Advertises excluded deletion operations; not a profile-specific contract. |
| `frihet://tax/rates` | Simplified/unverified rates and blanket treatment claims need source review. |
| `frihet://tax/calendar` | Generalized deadlines are not a verified current filing calendar. |
| `frihet://config/expense-categories` | Deductibility and amortization claims need source review. |
| `frihet://config/countries` | Country defaults cannot establish a transaction's tax treatment. |
| `frihet://config/invoice-statuses` | Conflates sent with delivered and credit notes with money refunds. |

Retained prompts: `overdue-followup` and `invoice-aging-review`. Shared content
now requires pagination, partial-payment balances, separation by currency and
as-of date, not-yet-due versus overdue separation, disclosure of missing data,
and user approval before actions. It does not assign collectible probabilities
or automatically impose fees, write off debt or stop work.

| Deferred prompt | Content-review reason |
|---|---|
| `monthly-close` | Deferred tax/calendar dependency and incomplete balance assumptions. |
| `onboard-client` | Deferred tax/rates dependency and location-only tax treatment. |
| `quarterly-tax-prep` | Deferred tax/calendar and simplified tax calculations. |
| `new-client-invoice` | Deferred tax/rates dependency for location-based selection. |
| `expense-report` | Deferred expense-categories and unverified amortization thresholds. |
| `year-end-close` | Deferred expense-categories and tax/calendar dependencies. |
| `cash-flow-forecast` | Deferred expense-categories/tax/calendar and arbitrary collection probabilities. |
| `expense-batch` | Deferred expense-categories and blanket deduction/receipt thresholds. |

These are content defects/dependencies, not policy bans on those workflows.

## Source and hosted status

This source includes reusable remote composition and a dedicated Claude Worker
configuration with Claude mode. It requires isolated storage, separate OAuth
authority, QA-only authorization and a verified ERP write-ceiling release receipt.
The isolated hosted Claude endpoint above was exercised with synthetic accounts
before submission. Accumulated coverage invokes all 132 tool names; 102 have
a successful response within their tested scope and 30 do not yet have a
positive business result. This is not a complete populated acceptance run of
every operation on one source revision. Existing full-host discovery does not
establish a fresh Claude OAuth login.
The OpenAI profile and its frozen descriptor remain separate and unchanged.

The Claude output boundary removes shared sensitive-field categories from
structured results, output schemas and JSON resources, and rebuilds display text
from the sanitized data. This includes `documentNumber` and `verifactuHash`;
they must not be advertised as retained. Opaque content blocks and arbitrary
response metadata are withheld; known authentication/outcome/retry flags remain.
The boundary does not classify every identifier embedded in arbitrary free text.
It does not change tool inputs, confirmation requirements or write retry behavior.

The local stdio package is not a hosted Directory listing. Provider approval
and publication are not established by the SDK checks or demo fixtures.

The generic `connector/manifest.json` describes `io.frihet/erp` at
`mcp.frihet.io` and the npm package; it is not the Claude submission manifest.
Do not repoint it to the isolated Claude service or change OpenAI metadata to
record this submission. Improvements to shared code require a separate release;
they do not alter the submitted source automatically.

## Reproducible local checks

```sh
npm run gate:claude-candidate
npm run gate:public-capability-truth
npm run gate:agent-onboarding
npm run gate:openai-review-descriptor
node --test dist/__tests__/claude-output-privacy.test.js
```

Regenerate intentional changes with `npm run generate:claude-candidate`,
`npm run generate:public-capability-truth` and
`npm run generate:agent-onboarding`; inspect each resulting diff.
The exact descriptor/manifest is
`src/__tests__/fixtures/claude-candidate-contract.json`. Tests use the real SDK
wire across four compositions, denied direct/alias calls, discovery, retained
resources/prompts and a real stdio process with an injected environment map.

## References

- [Anthropic Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy)
- [Connector authentication](https://claude.com/docs/connectors/building/authentication)
- [Directory submission](https://claude.com/docs/connectors/building/submission)
- [Hosted directory preparation](../../docs/directory-readiness.md)

The generated contract retains `status: local-candidate-only` intentionally:
its generator proves source composition, not deployment or provider status.
The dated submission status above comes from the Directory portal; do not
change that generated status to manufacture release acceptance.
