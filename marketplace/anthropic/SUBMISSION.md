# Claude Directory candidate

**Local candidate implemented; hosted candidate integration and Directory submission are not complete.**

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

The explicit candidate inventory starts with 158 canonical operations at source
`3852413`: **158 − 8 unavailable − 8 deferred − 6 other exclusions = 136**.
It retains tax/e-invoicing, invoice email, payroll and banking families, subject
to each operation's workspace/API availability and declared external effects.
A profile is not evidence that every endpoint works for every tenant.

| Composition | Canonical operations | Fiscal aliases | Discovery names | Total tool names | Resources | Prompts |
|---|---:|---:|---:|---:|---:|---:|
| Local full candidate | 136 | 4 | 0 | 140 | 5 | 2 |
| Local grouped candidate | 136 | 4 | 3 | 143 | 5 | 2 |
| Reusable remote full composition | 136 | 4 | 0 | 140 | 1 | 2 |
| Reusable remote grouped composition | 136 | 4 | 3 | 143 | 1 | 2 |

Remote rows describe SDK composition tests, **not a deployed Claude endpoint**.
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
| `onboarding_status`, `onboarding_persona_set` | Backend onboarding lifecycle unresolved ([Frihet-io/frihet-mcp#124](https://github.com/Frihet-io/frihet-mcp/issues/124)). |
| `refund_sale` | Executes a Stripe money transfer; excluded under Anthropic Directory policy §4.A. Confirmation alone does not change this effect. |
| `delete_client` | Linked contacts, notes and activities can remain stored but unreachable. |
| `delete_expense` | Linked attachment metadata/object cleanup is not established. |
| `send_quote` | Previewed recipient is not atomically bound; delivery is not retry-safe. |

`refund_deposit` is retained after correcting its contract: optional amount-only
bookkeeping, with no transfer of money. Its backend read/update concurrency and
rounding to cents still need live validation; candidate inclusion is not a
claim of concurrent or monetary-precision safety. `run_recurring_now` now
requires `confirm=true` in both exposure modes and discloses configured fiscal
issuance/submission and webhook effects. These are operation-specific facts,
not a blanket prohibition on accounting, taxes, email or payroll.

## Resources and prompts

Retained shared resource: `frihet://config/currencies`, display formatting
examples and historical codes, not payment precision or FX authority. Local
only: `frihet://business-profile`, `frihet://monthly-snapshot`,
`frihet://overdue-invoices`, `frihet://status/plan-limits`. The dynamic resources
return the authenticated API's records/plan fields, without new fiscal rules.
The overdue resource is explicitly a bounded, status-filtered first page; it
does not derive unpaid balances or days overdue and is not a complete ledger.

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

This source includes reusable remote composition, but no hosted Claude-profile
endpoint is established. The current provisioning contract supports the OpenAI
candidate binding only. Existing full-host discovery does not establish a fresh
OAuth login or live acceptance of the Claude selection. No Worker flag, host,
namespace, OAuth binding or deployment has been added by this local candidate.
The OpenAI profile and its frozen descriptor remain separate and unchanged.

The local stdio package is not a hosted Directory listing. Provider review and
publication are not established by the SDK checks or demo fixtures.

## Reproducible local checks

```sh
npm run gate:claude-candidate
npm run gate:public-capability-truth
npm run gate:agent-onboarding
npm run gate:openai-review-descriptor
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
