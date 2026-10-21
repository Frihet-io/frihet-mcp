# Claude operational product and release boundary

This candidate makes the Claude integration useful for running a Frihet business:
record detail and search, context and summaries, authorized document/expense/CRM
changes, banking reconciliation and the supported operational modules. A
six-list consultation surface cannot complete those customer tasks.

Product scope is independent of pilot admission. The intended destination is
customer distribution through the Claude connector and plugin directories.
The existing admission control remains in force while the complete candidate is
accepted. Installing a package never grants workspace access.

The public product is for every eligible Frihet user connecting their own
workspace under its existing plan and permissions. The Anthropic publisher
account identifies the submission owner; it is not a synthetic Frihet identity.
Keep the owner's real businesses outside QA admission, fixtures and writes.
Tests use only the two independently prepared synthetic identities/workspaces.

## Exact product surface

- Plugin: `frihet-erp`, version `1.18.0-preview.4`.
- Public display name: **Frihet**. The existing `frihet-erp` package identifier
  and submission path remain compatible with the saved Directory draft.
- 125 canonical business operations, four fiscal aliases, three discovery tools:
  132 tool names in grouped mode. Discovery describes operations; it does not
  hide a second executable catalogue or execute arbitrary methods.
- One formatting resource and two receivables prompts in both compositions.
- Eight task skills: core Frihet, documents, receivables, expenses, treasury,
  clients, monthly review and operations.
- Claude source: `plugins/claude/operational`; submission package:
  `plugins/claude/frihet-erp`. The shared general skills stay independent.

| Domain | Canonical operations |
| --- | ---: |
| Invoicing & receivables / Facturación y cobros | 30 |
| Expenses & vendors / Gastos y proveedores | 9 |
| Fiscal & compliance / Fiscal y cumplimiento | 12 |
| Banking / Banca | 7 |
| CRM & clients / CRM y clientes | 12 |
| HR & payroll / RRHH y nóminas | 23 |
| Stay / PMS / Alojamientos | 3 |
| POS / TPV | 9 |
| Intelligence / Inteligencia | 6 |
| Products / Productos | 5 |
| Platform / Plataforma | 9 |

The authoritative names, schemas, exclusions and hints are captured from the
real SDK in `src/__tests__/fixtures/claude-candidate-contract.json`. New operations
remain excluded until reviewed. The 31 explicit exclusions concern deferred or
unavailable handlers, unsupported credential scopes, money transfer, cleanup or
recipient/retry guarantees, and opaque artifacts that cannot be redacted. They
are not an arbitrary limit chosen to reduce the testing workload.

## Existing Frihet identity

The plugin uses Frihet's existing black circular mark (`#171717`), consistent
with the ERP asset `apps/erp/public/brand/frihet-mark-ink.svg`. Its packaged icon
is `.claude-plugin/icon.png`, with SHA-256
`2a8fbc5984c81fbaf1901b1049ce75483660f80ae2b2871590e22ed27416624c`.
The generated submission package contains the same bytes. Do not introduce a
lettermark or replace the established identity. A Directory page's fallback
initial is not evidence that the icon was imported or displayed; verify the
actual listing separately before submission.

## Experience to accept

1. Understand the workspace and fetch only relevant pages/details. Reports show
   record IDs, currencies, coverage and unknown values.
2. Prepare a concrete proposal or execute the exact action already authorized.
   Do not ask again when authorization and inputs are complete. A review alone
   never authorizes a write. Respect actual currency and fiscal input limits.
3. Verify saved records and describe the result clearly. A timeout is an unknown
   outcome; correlate before retrying. No duplicated invoice, invented payment,
   inferred fiscal treatment or simulated delivery.

The six authored model scenarios include an authorized expense write as well as
receivables, incomplete pagination, missing tax treatment, unknown-write recovery
and ambiguous reconciliation. Mock schema checks and unit tests are not model-run
results or hosted acceptance. Real MCP servers must remain disabled during those
model scenarios; use the approved publisher account for model runs.

All 65 write operations carry `destructiveHint: true` in Claude, including
creation and invitation tools, as required by the Directory review criteria.
The shared general/OpenAI annotations and every execution handler stay unchanged.
Claude's permission prompt is separate from the conversation: the skills must
still avoid asking the user to repeat a complete, specific instruction.

Claude never returns backend search indexes. In the four client-record tools
(`get_client`, `create_client`, `update_client`, `list_clients`), only the direct
record's `id` and `name` may retain an index token reproduced from that same
canonical name. This prevents an ordinary indexed name from corrupting record
identity. Index copies remain hidden in notes, nested fields and serialized JSON;
known sensitive fields take precedence, including normalized identifier forms.
Malformed indexes or an incomplete sensitive-source scan disable this exception.
An opaque string placed both in the public canonical name and solely in its
derived index cannot be distinguished from a legitimate name by this boundary;
the public name is not a safe place to store a secret. Other tool/resource
contracts and the shared OpenAI/general redaction policy retain their behavior.

## Isolation and rollback

This consolidated source candidate also prepares explicit Claude customer admission
using the existing policy field; see [the admission and rollback contract](claude-customer-admission.md).
It does not activate customer access. IAM, secrets, KV and Durable Object bindings,
OpenAI's frozen descriptor, the general tool registry and cloud resources remain unchanged.

The write-route test dispatches the operational Claude handlers through the real
HTTP client against a loopback server. Its write set must equal the existing ERP
credential ceiling, whose route digest remains
`bcf2185915523c60468afc380d1e2456a5c0da5cb2ca4b4820e74886b06b928f`.
Loopback responses prove method/path wiring, not backend behavior.

Before merge, rollback is closing the candidate PR. After merge but before a
release, revert the scoped candidate commit and re-run its source gates. A future
pilot release must capture its own previous Worker deployment/version and rollback
receipt; this document does not claim a cloud rollback that has never been tested.

## Remaining release evidence

Local build, complete package tests, Worker tests/typecheck, exact SDK candidate,
OpenAI descriptor/submission parity, public catalogue parity, plugin validation
and source-isolation gates provide source evidence. The release must additionally:

- Pin green CI and the eventual deployed SHA, retaining the existing isolated
  Claude resource and admission configuration.
- Exercise every advertised operation with valid inputs and meaningful populated
  synthetic data, using MCP Inspector and the Claude custom connector as required
  by the current review criteria. Retain per-tool receipts; no descriptor-only
  or empty-list substitution. Reuse applicable auth/isolation evidence when its
  bindings remain valid instead of repeating an unrelated IAM audit.
- Test external-effect operations only where their controlled synthetic setup
  is established. Do not send real customer messages, bill, transfer money or
  submit real tax records to satisfy a test. If a required proof has no safe
  fixture, record the exact missing proof and stop that release.
- Verify model behavior and reconnect/disconnect in the approved publisher account.
  A narrow product CRUD harness or historical nine-tool receipt cannot establish
  acceptance of the broad catalogue.
- Update and revalidate the existing connector and plugin drafts against the
  accepted source commit. Submit them as paired entries; skills are bundled in
  the plugin, not a separate directory submission. Customer access must be
  verified as its own launch step, not implied by a pilot or draft.

No full-catalogue acceptance, deployment, submission or public availability is
claimed by this candidate. The source is prepared for review; release GO depends
on those concrete receipts, not a promise that all tools are already proven.

## Primary documentation

- [Connector submission](https://claude.com/docs/connectors/building/submission)
- [Connector review criteria](https://claude.com/docs/connectors/building/review-criteria)
- [Plugin submission](https://claude.com/docs/plugins/submit)
