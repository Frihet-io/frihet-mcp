# Changelog

All notable changes to `@frihet/mcp-server` are documented here.

## [Unreleased]

## [1.18.0] — 2026-09-02

### Added

- **`global_search` — cross-resource read-only fan-out across the canonical surface (#168).** The single new MCP tool wraps `GET /v1/search/global` (server-side at `publicApi.ts:4555`) with strict Zod input: `q` 1-200 chars (defensive JSON-Schema `trim()` round-trip), `types` ∈ `{invoices, expenses, vendors, clients, products}` (the 5 canonical kinds), `limit` ≤ 50 mirroring the ERP cap, `offset` ≤ 1000. Workspace isolation is preserved by the server's existing `users/{userId}/...` Firestore subcollection paths — no new auth boundary, no fiscal surface, no mutation surface. OpenAI subset is intentionally NOT touched (canonical-search tools stay full-only). File-group `intelligence` + name-prefix rule `global_search → intelligence`. 10 new tests in `src/__tests__/search-tools.test.ts` pin registration, happy-path, param forwarding, defensive trim, schema shape, and 4xx propagation.
- **End-to-end provenance release workflow (#171).** `.github/workflows/release-mcp-npm.yml` is a 9-stage pipeline (`preflight` → `gates` → `build-pack` → `publish-npm` → `verify-npm` → `deploy-worker` → `verify-worker` → `release-github` → `cascade`) with explicit `needs:` edges between every stage. Every stage is fail-closed; the npm byte read and the Worker `/health.releaseSha` prove the bytes on the registry, the Worker, and the GitHub Release tag all name the same commit. New `workers/remote-mcp/src/release-meta.ts` reads `RELEASE_SOURCE_SHA` from `wrangler deploy --var ...` and surfaces it on `/health` (whitelist 40-hex-lowercase, fallback `unknown` for day-to-day deploys that don't pass the var). 11 executable contract tests in `scripts/__tests__/release-workflow-contract.test.test.mjs` pin the 9 hostile failure classes (stale source SHA, npm partial publication, Worker failure after npm, Worker wrong release SHA, wrong tag target, GitHub Release before Worker convergence, missing protected environment, token fallback, rerun after partial success) against the actual workflow control code, not prose. Wired into `npm test`.

### Fixed

- **Cross-surface contract authority V2 (#166).** `scripts/cross-surface-authority.mjs` is now offline, deterministic, and fail-closed. The previous live-HTTP check (`contract-fetch.mjs`) was a graceful network skip — a producer PR that breaks a consumer contract could pass the gate when the network was unreachable. V2 reads the committed `workers/remote-mcp/public/openapi.json` projection against `scripts/cross-surface-authority.required.json` (consumer-specific operation-by-operation expectation) and exits 1 on any missing security / response code / schema field. `gate:cross-surface-authority` runs in CI on every PR and the workflow run order is locked.
- **Cross-surface P0 client truth (non-OAuth, non-fiscal) (#167).** Several non-Trust-Area client signatures drifted away from the live ERP. Brought back into lockstep without expanding the OAuth or fiscal surface: `validateApiKey` response-key pin (`VALID|INVALID|UNAVAILABLE` only), `banking` and `crm` use the canonical ERP contract keys, `pagination-cursor-param` pins the canonical shape, `mutation-unwrap-and-schema-regression` and `mutation-unwrap-and-schema` are paired on every mutation tool, `einvoice` export/submit contracts are aligned.
- **OAuth A' permissions pinned (#164 → #170 mirror).** `OAUTH_PROVISIONING_CONTRACT.permissionsByProfile` is the canonical mirror between ERP (`functions/src/oauthApiKey.ts`) and MCP (`workers/remote-mcp/src/oauth-provisioning.ts`). OpenAI candidates carry `['read', 'write']` (NO einvoice authority); full candidates carry `['read', 'write', 'einvoice:*']` (matches the full MCP surface). The cross-repo golden test (`workers/remote-mcp/src/__tests__/oauth-url.test.ts`) pins byte-for-byte deepEqual against the contract matrix.
- **`search-tools.test.ts` 10 tests cover the new `global_search` tool.**
- **`search` capability pin in the generated public-capability-contract.** `scripts/generate-public-capability-contract.mjs` now reflects the new tool; `gate:public-capability-truth` enforces.
- **`scripts/check-no-analytics-emitters.mjs` re-snapshots `workers/remote-mcp/src/index.ts`.** The new `release-meta.ts` import + 3-field /health emission are non-network, non-analytics; the source-file hash is re-pinned with an inline comment naming the change scope.

### Changed

- **`package.json#version`: 1.17.1 → 1.18.0.** Capability count in description: `157 → 158` canonical operations (the `global_search` P1 surface).
- **`server.json` version: 1.17.1 → 1.18.0** (both root `.version` and `.packages[0].version`). `gate:agent-onboarding` and `audit:mcp-refs --repo frihet-mcp` re-checked.
- **`package-lock.json` version: 1.17.1 → 1.18.0** (no other lockfile change — the package.json deps are unchanged; the lockfile version header follows the package version by convention).
- **No capability contract change beyond `global_search` addition.** `src/__tests__/fixtures/public-capability-contract.json` regenerates to `canonicalOperations: 158`, `aliasNames: 5`, `discoveryNames: 3`.

### Capability counts (this release)

| Surface | Count | Source of truth |
|---|---:|---|
| Canonical business operations | **158** | `src/__tests__/fixtures/public-capability-contract.json#catalogue.canonicalOperations` |
| Alias names (fiscal modelo) | 5 | `src/fiscal-aliases.ts` |
| Discovery names (grouped mode meta) | 3 | `src/tool-exposure.ts#GROUPED_META_TOOL_COUNT` |
| `localFull` profile tools | 163 | generated contract |
| `openai` profile tools | 33 | curated in `src/openai-profile.ts` (unchanged this release) |
| Resources (static + API-backed) | 9 | `src/resources/register-all.ts` (`MCP_STATIC_RESOURCE_COUNT`) |
| Prompts | 10 | `src/prompts/register-all.ts` (`MCP_PROMPT_COUNT`) |

### Release notes

#### For `@frihet/mcp-server` consumers

`global_search` is the only public surface change: agents that previously had to chain `list_invoices` / `list_clients` / `list_vendors` / `list_products` / `list_expenses` + filter on the client side can now call one read-only tool with `q` and a `types` filter. Output shape is the canonical envelope `{data, total, limit, offset, hasMore, query, types, truncated?}` — the same envelope every other list tool already returns. Workspace-scoped, single-tenant, no fiscal / mutation / OpenAI-surface exposure.

The release pipeline itself is new: prior releases were a hand-rolled `npm publish` with no byte readback. 1.18.0 is the first release that can be re-derived from a single source-commit on main via the new workflow at `.github/workflows/release-mcp-npm.yml` (dispatch input `version`, protected `npm-release` environment, OIDC trusted publisher, byte-readback on npm, `/health.releaseSha` assertion on the Worker). Release-prep is mechanical; publication remains a manual `gh workflow run` from a Viktor-reviewed source commit.

OAuth A' ships the long-promised profile-scoped permission matrix; nothing changes for already-provisioned 1.17.x candidate keys (legacy 1.16.x compatibility still gated by exact byte shape `{ uid }` no service header — retirement requires telemetry = 0 uses for 30 days across both public Worker hosts).

#### For MCP Registry + Smithery submitters

`server.json` is in sync. `npm install @frihet/mcp-server@1.18.0` after the release workflow fires the GitHub Release at `v1.18.0`.

#### NOT in this release

- **No package.json dep change** (dependency surface is the same).
- **No Worker runtime change** beyond the `/health` field additions and the `release-meta.ts` read of the wrangler var.
- **No new outbound network sinks** (analytics tripwire passes; `check-no-analytics-emitters.mjs` reports 26 approved sinks — unchanged).
- **No npm publish, no Worker deploy, no environment mutation.** This PR is release-PREP only. The release workflow (now landed on main via #171) is what actually publishes 1.18.0.

## [1.17.1] — 2026-08-30

### Fixed

- **npm provenance anchor restored and future ambiguous publishes blocked.** `1.17.0` was published from a Git worktree and npm 10 omitted the packument `gitHead`, leaving the fail-closed published-artifact drift gate unable to anchor the otherwise verified tarball to repository history. The publish-time guard now requires a clean full Git clone at the exact `origin/main` commit and rejects any pre-existing ignored `dist/` tree before the build, so npm records the release commit and cannot pack stale generated bytes; runtime behavior is unchanged apart from release metadata.

## [1.17.0] — 2026-08-30

### Added

- **Agent-native onboarding through the MCP protocol and a generated descriptor (#152).** `initialize.instructions` now gives an agent the authentication, capability-discovery, draft-first, human-authority, and failure-recovery contract without operator-specific setup or drift-prone surface counts. `docs/agent-onboarding.json` is generated through the real MCP SDK from the registered surface, included in the package allowlist, and byte-compared by `gate:agent-onboarding`; the documented Claude Code and Codex installation paths were also verified against their real configuration formats before being published in the repository.
- **Published-artifact drift detection and a clean-tree publish anchor (#154, #155).** `scripts/published-artifact-drift.mjs` compares repository, npm, and MCP Registry state using npm `gitHead`, classifies measurable divergence, and treats unavailable evidence as unverifiable rather than green. The scheduled detector deliberately remains outside pull-request blocking, while `scripts/assert-publish-anchor.mjs` runs first in `prepublishOnly` and refuses a dirty publish tree, including untracked files that npm would pack.
- **Official external MCP conformance baseline for the current v1 server (#1578 Phase 0).** The first time an external process has spoken the MCP wire protocol to this server and scored it against the spec — PR #148's canary links a client over `InMemoryTransport` in-process (`"harnessMode": "in-process-sdk-client"`, `"protocolVersion": null`) and never runs the Inspector it pins. `@modelcontextprotocol/conformance@0.1.16` speaks Streamable HTTP only, so `scripts/conformance/http-bridge.mjs` relays JSON-RPC verbatim to the stdio server; everything the relay implements itself is classified `bridge-under-test` and can never be scored as a server pass. `@modelcontextprotocol/inspector@2.3.0` runs separately over native stdio and covers what the conformance fixtures structurally cannot: real Frihet resource URIs, real prompts, and a real read-only tool call. Result: **5 of 32 official scenarios reach a verdict about this server**, 0 defects, 27 not applicable — and two scenarios the harness scored SUCCESS (`tools-call-simple-text`, `tools-call-error`) are recorded as NOT_APPLICABLE because the transcript shows it was calling `test_simple_text` / `test_error_handling`, tools this server has never exposed, and the not-found error satisfied the assertion. Baseline, evidence and the coverage the suite does *not* give us: `docs/conformance/PHASE0-BASELINE.md`. Evidence/test-only: no runtime code changed.
- **A generated, schema-validated submission contract for the official ChatGPT connector (#157).** The repository freezes an exact surface of 33 fully described business tools with no discovery tools, prompts, resources, or parallel REST/OpenAPI contract; five positive and three negative review cases, legal/support ownership, OAuth metadata, capability truth, and the marketplace submission are generated or structurally checked in CI. This is repository and release-candidate evidence only: it does not claim that the connector has been submitted, approved, or deployed.

### Fixed

- **OAuth state, token rotation, and replay cleanup now fail closed at the durable authority (#157).** Authorization state is single-use in a Durable Object, carries an exact ten-minute `expiresAtMs`, checks expiry inside the serialized consume operation, rejects the exact boundary, and remains correct when an alarm is delayed. Validated authorization-code and refresh-token families are serialized by user/grant identity; concurrent or spent-token reuse atomically writes a tombstone, cleanup intent, and retry alarm before an `invalid_grant` response can escape. Cleanup pre-arms its next attempt, persists partial acknowledgements across restarts, retries grant and bound backend-key revocation with bounded backoff without abandoning the outbox, and keeps the tombstone until family expiry. Every already-issued access token is rechecked against that durable family before it can reach an MCP session, so stale OAuth KV cannot reactivate a tombstoned grant.
- **The Phase 0 conformance gate compares results rather than a capture commit (#153).** `versions.serverSha` is the single frozen provenance-only field masked during comparison; SDK/protocol/harness versions, tarball hashes, package version, capabilities, inventories, and the complete 32-scenario matrix remain byte-compared. Mutation coverage proves real result drift still turns the gate red.
- **Reviewed webhook, CRM activity, and client-tax-ID contracts now match current ERP truth (#139).** Webhook reads use one unpaginated GET, expose the current name/status/metadata/hasSecret shape, normalize the raw Firestore delivery timestamp, and fail closed on stored-secret leakage while preserving the caller-supplied create secret only once. CRM activity logging no longer accepts the rejected `date` input and now declares server-stamped `timestamp`/`createdBy` output. The official ChatGPT resubmission now freezes a narrower surface of exactly 33 fully described business tools with no discovery meta-tools, removes `clientTaxId` from invoice/quote mutation inputs, and redacts both camel/snake variants; direct MCP keeps its existing input contract.
- **HR/payroll/period reads now match the live ERP DTOs (#138).** `overtime_report`, `payroll_export`, `payroll_checklist`, and `period_close_status` unwrap one standard `{ data, meta }` envelope and expose the exact current read shapes. Fabricated quarterly/cost/file/status fields and the unsupported payroll label were removed; the backwards-compatible `periodId` input is now restricted to a `YYYY` fiscal-year label. Real-client and real-SDK tests pin one GET, output validation, demo parity, and legacy-shape rejection without changing fiscal close/reopen behavior.
- **`get_invoice_pdf` / `get_invoice_einvoice` died on real document bodies (#1393).** The generic client JSON-parsed raw PDF/XML success bodies. Document reads now perform one fetch per successful attempt, keep timeout and cancellation active through a bounded stream, and preserve 429/error handling without an unbounded body read. Invoice PDFs return request identity plus base64 bytes; stored e-invoices dispatch honestly between strict UTF-8 XML (5 MiB cap) and Factur-X PDF (25 MiB cap), including `Content-Disposition` filenames. Unexpected MIME, malformed bytes, and empty artifacts fail closed. The generic JSON request path is unchanged. Schemas, interface signatures, descriptions, demo fixtures, and adversarial transport tests are aligned with the live ERP response contract.

### Changed

- **The full-host OpenAPI artifact is regenerated from the direct canonical API origin at 84 paths (#157).** The committed `workers/remote-mcp/public/openapi.json` matches the `publicApi` Cloud Function response rather than an edge cache or hand-maintained copy. The Worker release command is fail-closed and ordered as analytics audit → committed/canonical OpenAPI check → `wrangler deploy` → live readback. This release candidate does not assert that any Worker or public alias already serves those bytes; deployment and post-deploy readback remain separate authorized operations.
- **The analytics tripwire is parser-backed and freezes the executable egress surface (#157).** Source, built artifacts, package lifecycle/configuration, embedded resources, Worker entrypoints, and every approved network sink are inventoried with exact counts and hashes; disclosure prose remains legal, while new SDKs, emitter shapes, dynamic loaders, executable HTML, or unreviewed sinks fail CI and `prepublishOnly`.
- **`PUBLISHED_SURFACE` includes `docs/agent-onboarding.json`.** The generated descriptor is part of the package allowlist, so published-artifact drift must cover its bytes; the frozen surface widened by exactly that one path rather than treating all of `docs/` as runtime surface.

## [1.16.6] — 2026-08-06

### Fixed

- **Every MCP-originated request is now attributable.** The client sends two source markers (#115): `X-Frihet-Source: mcp` (explicit, survives direct Cloud Function access) and a `frihet-mcp/<version>` `User-Agent` (survives the `api.frihet.io` edge proxy, whose request-header allowlist forwards `user-agent` but strips `x-frihet-source`). The backend classifier (`detectApiInvoiceSource`) tags these creates as `source: 'mcp'` instead of `'api'`, making MCP adoption measurable in analytics. Pinned by `src/__tests__/source-header-contract.test.ts`.
- `package-lock.json` refreshed — it had drifted to 1.16.0 while `package.json` advanced to 1.16.5 (#116).

## [1.16.5] — 2026-07-29

### Fixed

- **`create_credit_note` failed 100% of the time.** The API client never sent an `Idempotency-Key` header — `grep -ri idempotency src/` returned 0 hits, and the same grep over the previously published tarball returned 0 too (positive control: `X-API-Key` → 1 hit). `POST /v1/invoices/:id/credit-note` requires the header, so every call from every agent (Claude · ChatGPT · Cursor · Cline · the `mcp.frihet.io` Worker, which bundles this same client) came back `400 · IDEMPOTENCY_KEY_REQUIRED` with 0 drafts created. Reproduced against `api.frihet.io`, not inferred: with the header the same request reaches the handler (`404 · INVOICE_NOT_FOUND` on a non-existent invoice).
- **The 429 retry re-POSTed the mutation with no key at all** — precisely the duplicate an idempotency key exists to prevent. Retries now replay the *same* key rather than minting a new one.
- Two docs promised the mechanism and no line implemented it (`AGENTS.md` "API client must respect `Idempotency-Key`", `CLAUDE.md` "every mutating tool MUST support `Idempotency-Key`. Test it."). Pinned by `src/__tests__/idempotency-key-contract.test.ts` — 5 of its 6 assertions fail if the header is removed.

### Changed

- Every mutating request (`POST`/`PUT`/`PATCH`/`DELETE`) now carries a freshly minted `Idempotency-Key`; reads never do. `create_credit_note` accepts an optional `idempotencyKey` input so a caller-driven retry replays the stored `201` instead of creating a second draft.
- **`create_credit_note` description corrected to the contract the server actually implements.** It said the tool "generates VeriFactu-compliant R1-R5 rectificativa"; it creates a **draft** — no fiscal number, no hash, not submitted to VeriFactu — always by differences (`TipoRectificativa = I`), with the R-type derived from `reason` (only R1 and R4 are reachable), for the full amount only, behind the `pro` plan. The `fullCredit` description was inverted: it claimed `true` = tipo S substitution / `false` = tipo I partial, when `false` is rejected with `400 PARTIAL_CREDIT_NOT_IMPLEMENTED` and the method is always I.
- Demo-mode fixture (`FRIHET_DEMO=1`) now mirrors the live 201 body (`status: "draft"`, `rectificationMethod: "I"`, `totalCredited`) and derives the R-type from `reason` instead of hardcoding `R4`.

## [1.16.4] — 2026-07-21

### Fixed

- **postinstall banner** printed a hardcoded stale version (`v1.5.2`) and a 404 docs link (`docs.frihet.io/mcp`) on every install — now reads the version from `package.json` at runtime (can't re-drift) and links the working `docs.frihet.io/desarrolladores/mcp-server`.
- **Worker `/health`** queried the legacy `us-central1` Cloud Functions region (which 404s) and reported the dependency as `ok` because the check accepted any status `< 500`. Now queries the canonical `europe-west1` region and only counts a 2xx as healthy.
- **Tool-count drift** in the Worker's JSON-LD / discovery payloads: two surfaces still advertised `94 MCP tools` and the JSON-LD `featureList` said `151` (real count is 157). Root-caused rather than patched — see below.

### Changed

- **Drift root-cause eliminated with SoT + gate**, not manual replacements: the `audit:mcp-refs` gate now (1) matches `N MCP tools` (the intervening word let `151/94 MCP tools` slip past the tighter `N tools` pattern), (2) scans `scripts/postinstall.js` and `workers/remote-mcp/src/server-meta.ts`, and (3) asserts the Worker's `FULL_TOOL_COUNT` constant equals the counted SoT. `--fix` auto-syncs `N MCP tools` occurrences.
- **New `gate:no-legacy-region`** (wired into `prepublishOnly`) fails the build if the legacy Cloud Functions host prefix reappears anywhere — the region confusion is recurring, so it's now blocked at the gate. CSP `connect-src` in the OpenAI profile moved to `europe-west1`.
- **Tarball slimmed**: `dist/__tests__` and sourcemaps excluded from the published package; only `scripts/postinstall.js` ships from `scripts/`.

### Fixed (assets)

- Demo GIF: re-framed the Dashboard scene so the pan stops above a buggy `Antigüedad de Cobros` widget that rendered `NaNd cobro medio` (an upstream ERP display defect). Asset-only, raw-served (shipped earlier as a hotfix).

## [1.16.3] — 2026-07-21

### Changed

- Reworked the README product demo into a 3-surface tour — Dashboard (natural-language "Pregúntale a Frihet" ask) → Facturas split view (line items, IGIC, Pagada) → Analytics chart — framed in a browser-chrome mockup with Ken-Burns motion and crossfades. Replaces the flatter two-surface v1. No tool changes; GIF served via raw-GitHub URL, excluded from the npm tarball.

## [1.16.2] — 2026-07-21

### Added

- Animated product demo in the README — Dashboard → Facturas tour (rounded window, no tool changes).

## [1.16.1] — 2026-07-21

### Fixed

- Worker zod-alias regression restoring `tools/list` param descriptions (#84).

### Docs

- Corrected banner tool count (35 → 157), documented Kitchen/Restaurant tools, labeled `ksef_submit` as a pending stub, shortened npm description, canonical Smithery/Glama/OpenAPI links.

## [1.16.0] — 2026-07-18

### Added

- outputSchema coverage 138 → 160/160.

### Changed

- Honest OAuth consent-scope disclosure (#82).

## [1.15.3] — 2026-07-18

### Added

- **`FRIHET_DEMO` mode** — fixture-backed demo, no API key required, nothing persisted. Set `FRIHET_DEMO=1` to serve realistic PII-safe example data (invoices with IVA/IGIC, expenses, clients, products, banking) with zero network calls; writes are simulated and fiscal/e-invoice/payroll actions return a labeled simulation, never a real submission. Lets an agent evaluate the full tool surface via `npx -y @frihet/mcp-server` without signup.

## [1.15.2] — 2026-07-18

### Fixed

- **List pagination no longer loops on page 1** (#71): the client sent the pagination token as `after`, but the API reads `req.query.cursor`. Every `list_*` tool now pages correctly with `cursor`; a regression test pins the parameter name (`pagination-cursor-param.test.ts`).

## [1.15.1] — 2026-07-12

### Changed

- Metadata-only release — no code changes vs 1.15.0. README/npm claims aligned with verified public facts (pricing tiers 9/29/Premium, 139 supported country tax profiles, honest data-residency wording); `server.json` synced (audit-server-version gate); README tool-count line refreshed (157 tools).

## [1.15.0] — 2026-07-11

### Fixed

- **Invoices (and every other resource) were inoperable through MCP mutations** (#64, #65): the Frihet API wraps responses in a `{data, meta}` envelope, but the client returned it raw. Single-object `get_*` reads (#64) and **all mutations** (#65) now unwrap the envelope, so `create_invoice`, `update_invoice`, `pay_invoice`, etc. return the actual resource instead of an envelope that broke downstream tool chains.
- **Over-strict output schemas relaxed** (#65): mutation `outputSchema`s rejected valid API responses, making agents treat successful calls as failures. Schemas are now permissive where the API is; an anti-envelope tripwire test guards the whole surface (`schema-envelope-guard.test.ts`).
- **`verifactu_status` returns honest 404 semantics** (#65): a missing VeriFactu record now reads as "not submitted" instead of a hard error.
- **OAuth key provisioning hits the CF origin, not `api.frihet.io`** (#56): fixes remote-MCP key exchange behind the same-zone Worker.

### Added

- **Cursor plugin marketplace manifest** (#54) and ChatGPT/marketplace submission kit refresh with UTM attribution + `llms-install.md` (#52).
- **Projectable field selection opt-in** on supported reads (#65).

### Security / Public surface

- ChatGPT (OpenAI) profile hardening: submission metadata (#57), resources hidden from the profile (#58), sensitive OpenAPI schema variants stripped (#59).
- Public MCP surface scrubbed of competitor comparison + business-secret material (#60); public tool list trimmed of roadmap/internal-leak signals (#53).

## [1.14.5] — 2026-06-23

### Added

- **`create_invoice` / `update_invoice` expose the full ES fiscal field set the API already accepts.** The schemas previously only allowed `clientName/items/issueDate/dueDate/status/notes/taxRate`, so agents could not set `irpfRate` (retención IRPF — critical for Spanish autónomos), `equivalenceSurchargeRate`, `clientId`, `clientTaxId`, `clientAddress`, `clientLocation`, `prepayment`, `discountRate`, `seriesId`, `documentNumber`, `poNumber`, or `operationType`. The backend accepted all of these — the MCP Zod was just too narrow. No client/transport change (the HTTP client already passes fields through).
- **`create_quote` / `update_quote` gain `clientId`, `clientTaxId`, `clientAddress`, `issueDate`, `dueDate`, `taxRate`, `irpfRate`, `equivalenceSurchargeRate`, `clientLocation`** for parity with the invoice subset the API supports on quotes.

## [1.14.4] — 2026-06-22

### Fixed

- **`duplicate_invoice` no longer 400s on paid/sent invoices** (#47): it fetched the full raw stored invoice and spread it into the strict create schema, which rejects unknown keys (`payments`, `verifactu`, `operationType`, `poNumber`, …). Now it allowlist-picks only writable fields. Every paid/sent/cancelled/e-invoiced invoice was affected; a fresh draft duplicated fine.

### Security (Trust)

- **Langfuse traces no longer leak PII/credentials** (#46): the tracer captured raw tool output before the OpenAI redaction wrapper ran, so `taxId`/NIF/CIF, IBAN, webhook secrets, and auth tokens reached the external Langfuse service in every profile mode. Redaction now happens inside observability (shared `src/redaction.ts`) before the trace is built.
- **OpenAI `outputSchema` no longer declares `taxId`/`secret`** (#46): the descriptor advertised government IDs/credentials even though runtime redacted the values; now stripped at every depth.
- **OAuth callback fingerprints uid/email in logs** (#46), honoring "No PII logged".
- **Worker version + tool count single-sourced** from `package.json` (#46) so root/health/metadata surfaces can no longer drift apart; `audit:mcp-refs` now scans `auth-handler.ts`.

## [1.14.3] — 2026-06-21

### Fixed

- **Killed 5 fabricated-compliance-identifier stubs** (#45, compliance/Trust Area): the einvoice tools no longer mint fake registration identifiers (`RCF_stub*`, `TBAI-stub*`, fabricated `qrUrl`, fake `"accepted"`/`"submitted"` status) when the backend transport is unavailable. They now return an honest `unavailable` result so an agent never reports a phantom AEAT/TicketBAI confirmation it can act on. 4 tool descriptions corrected to stop advertising stub behaviour as live.
- **Version drift killed structurally**: the server version now reads from `package.json` at runtime (`PKG_VERSION` in `src/index.ts`) instead of three hardcoded literals that repeatedly desynced (`server.json` / `index.ts` / startup console). `npm version` is now the single place the version lives. `audit:mcp-refs` (run in `prepublishOnly`) stays as the cross-repo backstop.

## [1.14.2] — 2026-06-20

### Fixed

- **MCP↔CF contract integrity** (#42): `modeloCode` alignment, Firestore `Timestamp` serialize seam, pagination `offset`, and `/quarterly-draft` fix so MCP tool output matches what the Cloud Function actually returns.
- **Honest stub accounting** (#43, compliance): tools no longer fabricate success when the backend returns 404. A missing/unwired endpoint now surfaces an explicit error instead of a fake-OK — critical for Trust Area (agents must not act on phantom confirmations).

## [1.14.1] — 2026-06-15

### Changed

- **Banking tools un-staled** (#40, #41): banking surface wired to the live Cloud Function (#848) + E2E smoke. einvoice tools wired al CF vivo.

## [1.14.0] — 2026-06-16

### Added

- **6 Kitchen KDS tools** (Wave 6, #36): `list_kitchen_tickets`, `get_kitchen_ticket`, `update_kitchen_ticket`, `list_kitchen_stations`, `kitchen_flow_summary` + station/menu-item surface over `/v1/kitchen/*`. Brings the catalog to **157 tools**.

### Changed

- **`update_kitchen_ticket` status is now a strict enum** (#37): `on_hold | queued | preparing | ready | served | voided` instead of `z.string()`. Rejects ambiguous status input at the schema boundary rather than forwarding a typo to the KDS backend.

## [1.13.1] — 2026-06-15

### Changed

- **Grouped tool-exposure now LIVE on the remote agent endpoint** (`mcp.frihet.io`). The Cloudflare Worker is deployed with `FRIHET_TOOL_MODE=grouped`, so agents connecting to the remote endpoint get progressive disclosure (terse summaries + 3 discovery meta-tools) instead of a flat 151-tool wall. The npm package stays `full` by default — local clients (Claude Code, Cursor) manage their own context. All tool names, schemas and handlers unchanged; every tool stays invocable by name.
- **Typed `inputSchema` on the discovery meta-tools.** `search_tools` now advertises `{ query, group, limit }` and `describe_tool` advertises `{ name }` as real Zod schemas, so MCP clients receive typed argument hints in `tools/list` instead of an empty schema. `list_tool_groups` stays argument-free. No handler behaviour change (handlers already read args defensively).

## [1.13.0] — 2026-06-15

### Added

- **Opt-in grouped tool-exposure mode** (`FRIHET_TOOL_MODE=grouped`) — progressive disclosure for agents. Three meta-tools (`list_tool_groups`, `search_tools`, `describe_tool`) surface the 151-tool catalogue on demand by domain (invoicing, fiscal/compliance, banking, CRM, HR/payroll, stay, POS, intelligence…) instead of a flat wall of descriptions, taming context-rot while keeping full fiscal depth available. Default (`full`/unset) is **byte-identical** — existing clients unaffected; all tool names, schemas, annotations and handlers unchanged, every tool stays invocable. Wired into both stdio and the remote Cloudflare Worker. See `docs/tool-exposure-modes.md`.

### Changed

- README resources corrected from 8 to 11 (added Currencies, Countries, Plan Limits resources) and prompts corrected from 7 to 10 (added year-end-close, cash-flow-forecast, invoice-aging-review).
- `glama.json` description corrected from 152 to 151 tools.
- `skill/SKILL.md` metadata version corrected from 1.9.0-beta.1 to 1.13.0.
- Worker `schema.org` metadata: `softwareVersion` corrected from 1.9.0-beta.1 to 1.13.0; feature list updated to reflect 151 tools + full compliance surface.
- `workers/remote-mcp/public/releases.json`: added 1.13.0 entry; `mcp_server.version` corrected to 1.13.0.
- `server.json` description updated to lead with fiscal compliance depth (VeriFactu/TicketBAI/Facturae) rather than brittle tool count.
- Marketplace submissions (`cursor/SUBMISSION.md`, `anthropic/SUBMISSION.md`, `marketplace/README.md`) updated to 1.13.0 with correct tool/resource/prompt counts.

### Distribution

- Added `marketplace/anthropic/connector/` — DXT/MCPB manifest bundle scaffold for the Anthropic Claude Connectors Directory.

## [1.12.0] — 2026-06-10

### Changed

- Stable release — promotes the beta build below to npm `latest`, shipping all 151 tools and matching the remote endpoint (`mcp.frihet.io`).
- README distribution footnote updated (beta note removed); startup banner and server metadata report `1.12.0`.

## [1.12.0-beta.1] — 2026-05-16

### Added

- **D4-B megasprint — HR / Payroll / Onboarding / Permissions / Period close (19 new tools across 5 new files + 1 webhook test)**: wraps D1+D2 Frihet-ERP features previously absent from MCP surface (D3-T6 audit finding).
  - **HR (9 tools, `src/tools/hr.ts`)**: `leave_request_create`, `leave_approve`, `leave_reject`, `leave_cancel`, `leave_list`, `attendance_clock_in`, `attendance_clock_out`, `overtime_report`, `anomaly_list`. Wraps REST `/v1/leaves`, `/v1/time-entries`, `/v1/anomalies`.
  - **Webhook trust (1 tool, extended `src/tools/webhooks.ts`)**: `test_webhook` — fire synthetic event to verify endpoint reachability + signature validation. REST `POST /v1/webhooks/:id/test`.
  - **Payroll (2 tools, `src/tools/payroll.ts`)**: `payroll_export` (normalized employee data with an echoed A3/Contasol/Sage/SILTRA destination label, not a generated provider file), `payroll_checklist` (employee readiness per payroll month). REST `/v1/payroll/prep/export`, `/v1/payroll/prep/employees`. Frihet stages data → gestoria processes payroll.
  - **Onboarding (2 tools, `src/tools/onboarding.ts`)**: `onboarding_status`, `onboarding_persona_set` (autonomo/empresa/agencia/gestoria). REST `/v1/onboarding/status`, `/v1/onboarding/persona`.
  - **Permissions (2 tools, `src/tools/permissions.ts`)**: `permissions_matrix`, `permissions_me`. REST `/v1/permissions/matrix`, `/v1/permissions/me`.
  - **Period close (3 tools, `src/tools/accountingClose.ts`)**: `period_close_status`, `period_close` (TRUST AREA: `confirm=true` gate), `period_reopen` (TRUST AREA: `confirm=true` + reason required). REST `/v1/periods/current`, `/v1/periods/close`, `/v1/periods/:id/reopen`.
- 12 new output schemas in `shared.ts`: `leaveRequestItemOutput`, `attendanceEntryItemOutput`, `overtimeReportOutput`, `anomalyItemOutput`, `webhookTestResultOutput`, `payrollExportOutput`, `payrollChecklistOutput`, `onboardingStatusOutput`, `onboardingPersonaResultOutput`, `permissionsMatrixOutput`, `permissionsMeOutput`, `periodStatusOutput`.
- 19 new `IFrihetClient` methods + HTTP implementations in `FrihetClient`.
- `d4b-hr-payroll-onboarding-tools.test.ts` — 41 new tests covering registration counts, happy paths, trust-area `confirm=false` gates, and 404 error propagation.

### Changed

- Total tool count: **133 → 152 tools**.
- Bumped `package.json` version to `1.12.0-beta.1`.
- `register-all.ts` updated to register 5 new tool modules; comment reflects 152 tools.
- Test script includes new `d4b-hr-payroll-onboarding-tools.test.js`.

### Notes

- At this beta's release, the ERP endpoints were still planned for a parallel D4-A wave and surfaced 404 as `isError=true`. The payroll routes now return normalized JSON with an echoed destination label; the former provider-file/extension TODOs did not become shipped capabilities.
- `period_close` and `period_reopen` follow the Trust Area `confirm=true` gate pattern (same as `match_transaction_to_invoice`).
- Npm publish deferred to D15 batch.

## [1.11.0-beta.1] — 2026-05-13

### Added

- **Day 4 Wave — E-Invoicing REST tools (6 tools)**: per-invoice endpoints wrapping Frihet-ERP PR #414, FACe PR #411, and TicketBAI PR #356.
  - `einvoice_export` — export an invoice as XML in a specific format (Facturae/XRechnung-CII/XRechnung-UBL/Factur-X/FatturaPA/PEPPOL-BIS-3/UBL/CII). `signed=true` returns XAdES-enveloped Facturae for FACe/AEAT. REST: `POST /v1/invoices/:id/einvoice/export`.
  - `face_submit` — submit a Facturae invoice to the Spanish FACe B2G portal (mock/sandbox/production modes, requires DIR3 codes on recipient). REST: `POST /v1/invoices/:id/face/submit`.
  - `face_status` — poll the FACe submission status by invoice ID (status codes: 1200=Registrada, 1300=Contabilizándose, 1400=Contabilizada, 2400=Anulada, 3100=Rechazada). REST: `GET /v1/invoices/:id/face/status`.
  - `ticketbai_submit` — submit to the Basque Country TicketBAI system (territory auto-routed: Bizkaia→BATUZ/LROE, Gipuzkoa, Álava; sandbox flag; returns TBAI identifier + QR URL). REST: `POST /v1/invoices/:id/ticketbai/submit`.
  - `ticketbai_status` — poll hacienda foral acknowledgement status for a TicketBAI submission. REST: `GET /v1/invoices/:id/ticketbai/status`.
  - `ksef_submit` — **stub only** — forward-compatible stub for Poland KSeF national e-invoicing. Returns `_notImplemented=true` with activation guidance until Frihet-ERP PR #417 merges to main. REST planned: `POST /v1/invoices/:id/ksef/submit`.
- 6 new output schemas in `einvoice.ts`: `einvoiceExportOutput`, `faceSubmitOutput`, `faceStatusOutput`, `ticketbaiSubmitOutput`, `ticketbaiStatusOutput`, `kSeFSubmitOutput`.
- 5 new Day 4 interface methods in `IFrihetClient` + HTTP implementations in `FrihetClient` (`exportEInvoice`, `faceSubmit`, `faceStatus`, `ticketbaiSubmit`, `ticketbaiStatus`).
- `einvoice-day4-tools.test.ts` — 35 new tests covering registration, 404-fallback stubs, live client success paths, 403 error handling, and KSeF always-stub behavior.

### Changed

- Total tool count: **127 → 133 tools**.
- Bumped `package.json` version to `1.11.0-beta.1`.
- Updated `package.json` description to include FACe, TicketBAI, and KSeF coverage.
- `register-all.ts` comment updated to reflect 133 tools.
- `einvoice-tools.test.ts` updated to expect 10 einvoice tools (4 original + 6 Day 4).
- Test script includes new `einvoice-day4-tools.test.js`.

### Notes

- All 5 live tools (`einvoice_export`, `face_{submit,status}`, `ticketbai_{submit,status}`) include 404-fallback stubs so the server remains usable while CF endpoints are deploying.
- `ksef_submit` is intentionally always-stub to future-proof the API surface — activation requires only removing the stub block when PR #417 merges.
- 404-fallback pattern mirrors existing Day 3 einvoice tools for consistency.

---

## [1.10.0-beta.3] — 2026-05-11

### Added

- **Wave Fase 1 — Gestoria (5 tools)**: surface accountant workflows to AI assistants.
  - `gestoria_message_send` — send a message in a contextual thread between gestor and client (parent: documentRequest, filingItem, or obligation).
  - `gestoria_messages_list` — paginate a thread newest-first using `before` cursor; returns `hasMore` flag.
  - `gestoria_template_create` — create a reusable document request template (title, description, due-date offset, attachment requirement, variables).
  - `gestoria_template_bulk_send` — bulk send a template to up to 500 client workspaces; honours `allowGestoriaCommunications=false` opt-out (RGPD). Maps to Frihet-ERP callable `gestoriaBulkSendRequests` (PR #383).
  - `gestoria_aging_consolidated` — cross-client AR aging report with totals by bucket (current / 30-60 / 60-90 / 90+), per-workspace breakdown, and top overdue invoices. Defaults to authenticated gestor.
- 6 new output schemas in `shared.ts`: `gestoriaMessageItemOutput`, `gestoriaMessageSendResultOutput`, `gestoriaTemplateItemOutput`, `gestoriaTemplateCreateResultOutput`, `gestoriaBulkSendResultOutput`, `gestoriaAgingConsolidatedOutput`.
- 5 new interface methods in `IFrihetClient` + HTTP implementations in `FrihetClient`.

### Changed

- Total tool count: 106 → **111 tools**.
- Bumped `package.json` version to `1.10.0-beta.3`; aligned `server.json` description and version.
- Updated README badge, hero copy, and tools section with new Gestoria family.

### Notes

- ERP backend REST routes `/v1/gestoria/*` are planned and will proxy the corresponding Firebase callables (eu-west1) + Firestore reads. Tools are wired now and will surface 404 errors until the REST shell ships in Frihet-ERP Wave Fase 1 closure (PRs #383 merged, #384 + #385 pending).
- App Check is required (mcp.frihet.io worker is App Check enforced).
- No new tests in this beta — REST surface arrives with Wave Fase 1; unit-level coverage will land alongside the test suite that mocks the new endpoints (parity with team / recurring families).

---

## [1.9.0-beta.1] — 2026-05-10

### Added

- **Wave 6 — Banking (5 tools)**: `list_bank_accounts`, `get_bank_account`, `list_transactions`, `categorize_transaction`, `match_transaction_to_invoice` (Trust Area: requires `confirm=true`). REST surface: `/v1/banking/*`.
- **Wave 6 — Fiscal (8 tools)**: `get_modelo_303_summary` (IVA quarterly), `get_modelo_130_summary` (IRPF estimated), `get_modelo_390_summary` (IVA annual), `get_modelo_180_summary` (IRPF rentals annual), `get_modelo_347_summary` (operations >€3,005 recap), `verifactu_status`, `verifactu_resubmit` (Trust Area + audit trail: requires `confirm=true`), `ticketbai_status` (Basque Country, province field). REST surface: `/v1/fiscal/*`.
- **Wave 6 — Time Tracking (4 tools)**: `list_time_entries`, `create_time_entry`, `update_time_entry`, `delete_time_entry` (soft-delete, Trust Area: requires `confirm=true`). REST surface: `/v1/time/entries`.
- **Wave 6 — Recurring Invoices (2 tools)**: `list_recurring_invoices`, `run_recurring_now` (manual trigger, `draftOnly` flag). REST surface: `/v1/recurring/invoices`.
- 7 new output schemas added to `shared.ts`: `BankAccount`, `BankTransaction`, `FiscalModeloSummary`, `VeriFactuStatus`, `TicketBaiStatus`, `TimeEntry`, `RecurringInvoice`.
- 19 new interface methods in `IFrihetClient` and HTTP implementations in `FrihetClient`.
- 4 new test files: `banking-tools.test.ts`, `fiscal-tools.test.ts`, `time-tools.test.ts`, `recurring-tools.test.ts` (~35 new tests).

### Changed

- Total tool count: 75 → **94 tools**.
- Updated package description, README badge, and `register-all.ts` to wire all 4 new families.

### Notes

- ERP backend endpoints `/v1/banking/*`, `/v1/fiscal/*`, `/v1/time/*`, `/v1/recurring/*` are planned. Tools are wired now and will surface 404 errors until the backend ships.
- Trust Area tools (`match_transaction_to_invoice`, `verifactu_resubmit`, `delete_time_entry`) require explicit `confirm=true` and fail-open with clear error messages.

---

## [1.8.0-beta.1] — 2026-05-10

### Added
- **Wave 4 — Stay v1 (5 tools)**: `list_reservations`, `get_reservation`, `create_reservation`, `list_properties`, `sync_channel`. Full vacation rental management surface exposed to AI assistants.
- **Wave 5 — POS v1 (4 tools)**: `list_terminals`, `get_sale`, `list_sales`, `refund_sale`. Point-of-sale tools with Trust Area confirmation gate on `refund_sale` (requires `confirm=true`).
- Output schemas for Stay and POS added to `shared.ts`: `reservationItemOutput`, `propertyItemOutput`, `posTerminalItemOutput`, `posSaleItemOutput`.
- New client interface methods and HTTP client implementations for `/v1/stay/*` and `/v1/pos/*` endpoints.

### Changed
- Total tool count: 66 → **75 tools**.
- Updated package description and README badge to reflect 75-tool count.
- `register-all.ts` updated to wire Stay + POS tool families.

### Notes
- ERP backend endpoints `/v1/stay/*` and `/v1/pos/*` land in Frihet-ERP S2 sprint. Tools are wired and will surface 404 errors until the backend ships.

---

## [1.5.3] — 2026-03-28

### Added
- **Tool #53 — `create_credit_note`**: Create credit notes linked to existing invoices with full line-item control. _(Correction, 1.16.5: "full line-item control" was never true. The endpoint has no line-level or partial credit — `fullCredit: false` returns `400 PARTIAL_CREDIT_NOT_IMPLEMENTED`. Left in place rather than rewritten, since this entry is a released record.)_
- **Tool #54 — `get_invoice_einvoice`**: Retrieve the EN16931-compliant e-invoice (XML/UBL) for any issued invoice.
- **Tool #55 — `apply_late_fee`**: Apply a late payment fee to an overdue invoice, with configurable rate and description.

### Changed
- Total tool count: 52 → **55 tools**.
- Updated package description to reflect 55-tool count.

---

## [1.5.2] — 2026-03-24

### Added
- 52 tools covering invoicing, expenses, clients, products, quotes, CRM, webhooks, VeriFactu, accounting, and AI-powered reports.
- Smart alerts, purchase orders, and AI cash-flow forecast tools.

---

## [1.5.0] — 2026-03-21

### Added
- Initial public release with 52 tools.
- Full MCP protocol compliance.
- Works with Claude Desktop, Cursor, Windsurf, Cline, and any MCP-compatible client.
