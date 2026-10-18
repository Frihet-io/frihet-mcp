# Claude Submission Technical Handoff (`io.frihet/erp` · `frihet-erp`)

> **Truth boundary:** This document separates source/SDK verification (`probado`), pending cloud operator actions (`pendiente`), and hard dependencies that block hosted live acceptance (`bloqueado`). Do **not** submit the hosted connector to Anthropic as live/available until the three cloud bootstrap items in Section 5 are executed and `node scripts/check-claude-hosted-release.mjs` exits `0` without `--source-only`.

---

## 1. Real Status of Every Technical Requirement

| Requirement | Surface | Status | Literal Evidence |
| :--- | :--- | :--- | :--- |
| **Claude candidate catalog & profile isolation (125 canonical operations, 4 fiscal aliases, 1 remote resource, 2 prompts)** | `src/claude-profile.ts`, `src/__tests__/fixtures/claude-candidate-contract.json` | **`probado` (en código y CI)** | `npm run gate:claude-candidate` passes (`12/12` tests): `156 - 8 unavailable - 8 deferred - 15 other exclusions = 125` canonical operations (`129` full tool names, `132` grouped tool names with 3 discovery tools). |
| **Claude output privacy & redaction boundary** | `src/claude-output-privacy.ts`, `src/__tests__/claude-output-privacy.test.ts` | **`probado` (en código y CI)** | Strips sensitive fields (`taxId`, `nif`, `cif`, `iban`, `bic`, `bankAccount`, `documentNumber`, `verifactuHash`, secrets/tokens), sanitizes `structuredContent` and JSON resources, and excludes `get_invoice_pdf` and `get_invoice_einvoice`. |
| **Claude Worker source topology, KV namespace isolation, & OpenAI Worker isolation** | `workers/remote-mcp/wrangler.claude.toml`, `scripts/check-claude-hosted-release.mjs` | **`probado` (en Cloudflare, código y dry-run)** | `npm run gate:claude-hosted-source` and `npx wrangler deploy --config wrangler.claude.toml --dry-run` pass (`3650.07 KiB / gzip: 659.33 KiB`). Dedicated Worker name (`frihet-claude-mcp`), locked Worker Route (`routes = [{ pattern = "claude-mcp.frihet.io/*", zone_name = "frihet.io" }]`), dedicated Cloudflare KV namespace `274c7aaa85a04d44b4dc77f5f1dd7ca2` (`claude-frihet-claude-oauth`), `FRIHET_OPENAI_MODE="false"`, `FRIHET_CLAUDE_MODE="true"`, `FRIHET_TOOL_MODE="grouped"`, and zero shared Durable Object or KV namespace IDs with `workers/remote-mcp/wrangler.toml` (`9207b98598f849109139ad11f3b0ac51` / `7df4e387eee243268669425594aae45e`). |
| **Audited OAuth provider localhost callback patch for Claude Code** | `scripts/prepare-claude-oauth-provider.mjs`, `scripts/__tests__/claude-oauth-provider.test.mjs` | **`probado` (en código y CI)** | Single-line build-time patch over locked `@cloudflare/workers-oauth-provider@0.3.0` (`sourceSha256: 54384c198541571c7fac691afad31f51f9914debbca9571fa4dcde3af9f1133c` -> `patchedSha256: 61da741102e458a42150f7945af91dbe2cc11b4bb331a93d36574e9ef5ec9bf0`) allowing `http://localhost:<port>` callbacks for Claude Code while preserving exact `https://claude.ai/api/mcp/auth_callback` matching and stock SDK behavior for OpenAI/full Workers. |
| **OAuth 2.1 + PKCE + DCR + Firebase identity + QA allowlist + durable grant replacement (`#204`, `#205`, `#221` — open issues reconciled below)** | `workers/remote-mcp/src/auth-handler.ts`, `workers/remote-mcp/src/oauth-state-store.ts`, `workers/remote-mcp/src/oauth-token-family.ts` | **`probado` (en harness de rutas e integración local; `M1`/`L1` acotados por tests y sujetos a aceptación expresa del propietario)** | `npm test --prefix workers/remote-mcp` passes (`260/260` tests). Includes `#204` Wrangler topology/mutation guards (`22196c1`, `Refs #204`), `#205` durable grant-replacement outbox (`176de12`), and `#221` (`Refs #221`) fixes for `L3` (`>64` grant truncation test + docstring), `L4` (dead harness scaffolding removal), and `L5` (deterministic frozen harness clock), plus route tests pinning `M1` (`S2`) and `L1` (`S1`) as known pilot behaviors requiring explicit owner sign-off. |
| **OpenAI frozen 33-tool connector isolation** | `src/openai-profile.ts`, `src/__tests__/fixtures/openai-review-descriptor.snapshot.json` | **`probado` (en código y CI)** | `npm run gate:openai-review-descriptor` and `npm run gate:openai-submission` pass with zero diff against the frozen 33-tool descriptor and schema `aa7d1bd554e6c615d411c03e5b73bb464816be603461eb5813bb589645550304`. |
| **Claude plugin package (`plugins/claude/frihet-erp`)** | `.claude-plugin/plugin.json`, `plugins/claude/frihet-erp/**`, `skills/**`, `skill/**` | **`probado` (en código y CI)** | `node --test scripts/__tests__/claude-plugin-package.test.mjs` and `node scripts/sync-claude-plugin.mjs --check` pass (`0` drift between root `.claude-plugin` + `skills/` + `skill/` and `plugins/claude/frihet-erp`). |
| **Public URLs referenced by plugin manifest** | `documentationUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`, `supportUrl` | **`probado` (3/4 live HTTP 200) / `bloqueado` (`supportUrl` awaiting Worker deploy)** | `https://docs.frihet.io/desarrolladores/mcp-server` (`200`), `https://www.frihet.io/es/privacy` (`200`), and `https://www.frihet.io/es/terms` (`200`) are live. `https://claude-mcp.frihet.io/support` is served by `claudePublicSurface` inside `frihet-claude-mcp` and will resolve once the DNS record and Worker are deployed. |
| **ERP `publicApi` Claude write-route ceiling & `claudeOAuthApiKeyProvisioning` Cloud Function (`berthelius/Frihet-ERP`)** | `Frihet-ERP` `main` (`3d30fc7339ba32c3e6fdaf533f9b6550210c61bf`, includes `#2654` / `9093fcd53`), `scripts/claude-publicapi-source-release.json` | **`pendiente` (deploy Firebase prod + recibo de release)** | `claude-publicapi-source-release.json` has CI build proof (`runId: 39029744215`, `artifactId: 12099932896`, `replacementArchiveSha256: 02bb8a6e0980f14cbace9b42ff35f162fdee44418762b3abd0748cba17796c73`), but `approved: false`, `candidateSourceSha256: null`, and only covers `target: "publicApi"`. Furthermore, `GET https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/claudeOAuthApiKeyProvisioning` currently returns HTTP `404` (expected `405` when deployed). Both `publicApi` and `claudeOAuthApiKeyProvisioning` must be deployed and verified in Firebase prod. |
| **Cloudflare `OAUTH_KV` namespace (`CF-1`) & Worker secrets (`CF-2`) for `frihet-claude-mcp`** | `workers/remote-mcp/wrangler.claude.toml` | **`probado` (`CF-1` KV namespace `274c7aaa85a04d44b4dc77f5f1dd7ca2`) / `pendiente` (`CF-2` secretos)** | `CF-1` is complete: dedicated namespace `274c7aaa85a04d44b4dc77f5f1dd7ca2` (`claude-frihet-claude-oauth`) is created in Cloudflare and bound in `wrangler.claude.toml`. `CF-2` (`COOKIE_ENCRYPTION_KEY`, `FRIHET_CLAUDE_OAUTH_API_KEY`, `FRIHET_CLAUDE_QA_UIDS`) is held until ERP verification and combined `main` merge so no intermediate Worker version is implicitly deployed. |
| **Live proxied DNS record & HTTPS endpoint `https://claude-mcp.frihet.io/mcp`** | Cloudflare Zone `frihet.io` DNS + Worker Route `claude-mcp.frihet.io/*` | **`bloqueado` (requiere registro DNS proxied + deploy de Worker)** | `wrangler.claude.toml` uses a Worker Route (`routes = [{ pattern = "claude-mcp.frihet.io/*", zone_name = "frihet.io" }]`), matching `mcp.frihet.io` and `openai-mcp.frihet.io`. Unlike a Custom Domain, a Worker Route does **not** auto-create DNS on deploy: it requires creating a proxied originless record (`AAAA claude-mcp.frihet.io -> 100::`, `proxied: true`) in zone `frihet.io` alongside deploying `frihet-claude-mcp`. |

---

## 2. Exact MCP URL, Profile, Version, and Source References

- **Hosted Remote MCP Endpoint (Claude Connector & Plugin `.mcp.json`):**
  - MCP Streamable HTTP URL: `https://claude-mcp.frihet.io/mcp`
  - OAuth Origin / Issuer: `https://claude-mcp.frihet.io`
  - OAuth Protected Resource Metadata (RFC 9728 root & path-inserted):
    - `https://claude-mcp.frihet.io/.well-known/oauth-protected-resource`
    - `https://claude-mcp.frihet.io/.well-known/oauth-protected-resource/mcp`
  - OAuth Authorization Server Metadata (RFC 8414): `https://claude-mcp.frihet.io/.well-known/oauth-authorization-server`
  - OpenID Connect Discovery: `https://claude-mcp.frihet.io/.well-known/openid-configuration`
  - OAuth Endpoints:
    - Dynamic Client Registration: `https://claude-mcp.frihet.io/register`
    - Authorization: `https://claude-mcp.frihet.io/authorize`
    - Callback: `https://claude-mcp.frihet.io/callback`
    - Token Exchange / Refresh / Revocation: `https://claude-mcp.frihet.io/token`
    - UserInfo: `https://claude-mcp.frihet.io/userinfo`
  - Public Legal & Support Routes on Worker Host:
    - Privacy: `https://claude-mcp.frihet.io/privacy`
    - Support: `https://claude-mcp.frihet.io/support`
  - Accepted OAuth Scopes: `["openid", "email", "frihet:connector"]`
  - Accepted OAuth Resource Indicator: `["https://claude-mcp.frihet.io/mcp"]` (origin alias is rejected fail-closed on `/authorize` and `/token`)
  - Accepted Redirect URIs: `https://claude.ai/api/mcp/auth_callback` (web/desktop) and `http://localhost:<port>/...` (Claude Code loopback)
- **Worker Runtime Profile (`workers/remote-mcp/wrangler.claude.toml`):**
  - Worker Name: `frihet-claude-mcp`
  - Worker Route: `routes = [{ pattern = "claude-mcp.frihet.io/*", zone_name = "frihet.io" }]` (locked by `scripts/check-claude-hosted-release.mjs`; paired with a proxied `AAAA 100::` DNS record in zone `frihet.io`, identical to `mcp.frihet.io` and `openai-mcp.frihet.io`)
  - Dedicated KV Namespace (`OAUTH_KV`): `274c7aaa85a04d44b4dc77f5f1dd7ca2` (`claude-frihet-claude-oauth`)
  - `FRIHET_CLAUDE_MODE = "true"`
  - `FRIHET_OPENAI_MODE = "false"`
  - `FRIHET_TOOL_MODE = "grouped"` (125 canonical operations + 4 fiscal aliases + 3 discovery meta-tools = **132 tool names**, **1 remote resource** `frihet://config/currencies`, **2 prompts** `overdue-followup` and `invoice-aging-review`)
- **Versions & Commit Anchors:**
  - `@frihet/mcp-server` package version: `1.18.0`
  - `@frihet/remote-mcp-server` Worker version: `1.1.0`
  - Claude Plugin (`plugins/claude/frihet-erp/.claude-plugin/plugin.json`) name & version: `frihet-erp` · `1.18.0-preview.2`
  - Base `frihet-mcp` `main` commit SHA: `02cd0b95494dc73193475139f3dae1340b702583`
  - Current `berthelius/Frihet-ERP` `main` commit SHA: `3d30fc7339ba32c3e6fdaf533f9b6550210c61bf` (includes `#2654` / `9093fcd53` and `#2655`)
  - ERP Contract Hardening PR (approved, ready to merge): [PR #227](https://github.com/Frihet-io/frihet-mcp/pull/227) (`40e7f30afedbf054bef841a9e6089aa9363c5204`)
  - Claude P0 Readiness & `#221` OAuth Follow-ups PR (`Refs #221`): [PR #229](https://github.com/Frihet-io/frihet-mcp/pull/229) (`fix/claude-p0-hosted-and-plugin-readiness`)

---

## 3. OAuth, Open-Issue Reconciliation (`#204`, `#205`, `#221`), & Hosted Worker Evidence

### 3.1 Verified in Local Route & SDK Integration (`probado`)
All 260 tests in `workers/remote-mcp` (`npm test --prefix workers/remote-mcp`) and all 1,215 server tests (`npm test`) pass, including:
- **`workers/remote-mcp/src/__tests__/claude-oauth-route.test.ts`:**
  - Full end-to-end route execution (`/register -> /authorize -> /callback -> claudeOAuthApiKeyProvisioning -> completeAuthorization -> /token -> /mcp`) using the locked `@cloudflare/workers-oauth-provider@0.3.0` bundle with the audited Claude localhost patch.
  - Verifies fail-closed rejection (HTTP `403`, zero DO arming, zero ERP provisioning calls, zero KV grants) when `FRIHET_CLAUDE_QA_UIDS` is missing, malformed, empty, or does not contain the verified Firebase UID.
  - Verifies immediate withdrawal of access (`401` on `GET`/`POST /mcp` and `400 invalid_grant` on refresh) when a UID is removed from `FRIHET_CLAUDE_QA_UIDS`, while preserving `DELETE /mcp` session cleanup, token revocation, and durable ERP key revocation.
  - Verifies strict cross-surface isolation: tokens minted for `https://claude-mcp.frihet.io/mcp` are rejected (`401`) by `https://openai-mcp.frihet.io/mcp` and vice versa; missing `FRIHET_CLAUDE_OAUTH_API_KEY` fails closed (`503`) and never falls back to `FRIHET_OAUTH_API_KEY`.
- **`workers/remote-mcp/src/__tests__/oauth-callback-route.test.ts` & `oauth-state-store.test.ts` (`#204`, `#205`, `#221`):**
  - Verifies durable grant replacement outbox on reconnect (`#205`), fail-closed zero-key settlement when a commit lands in storage but two consecutive DO commit responses are lost (`#221 M1`), concurrent callback behavior (`#221 L1`), and `MAX_REPLACED_GRANT_IDS = 64` outbox truncation (`#221 L3`).
- **Wrangler Bundle Dry-Run:**
  - `npx wrangler deploy --config wrangler.claude.toml --dry-run` (from `workers/remote-mcp`) compiles cleanly (`Total Upload: 3650.07 KiB / gzip: 659.33 KiB`) with bindings `MCP_OBJECT (FrihetMCP)`, `OAUTH_STATE (OAuthStateStore)`, `OAUTH_KV (274c7aaa85a04d44b4dc77f5f1dd7ca2)`, `FRIHET_OPENAI_MODE="false"`, `FRIHET_CLAUDE_MODE="true"`, `FRIHET_TOOL_MODE="grouped"`, and `FIREBASE_PROJECT_ID="gen-lang-client-0335716041"`.

### 3.2 Literal Reconciliation of Open GitHub Issues `#204`, `#205`, and `#221`
All three issues remain `OPEN` on GitHub. Their exact code state and pilot impact are:

| Issue | GitHub State | Implemented in Code | Why It Remains Open & Pilot Risk Disposition |
| :--- | :--- | :--- | :--- |
| **[#204](https://github.com/Frihet-io/frihet-mcp/issues/204)** | `OPEN` | PR #222 (`22196c1`, `Refs #204`) replaced regex TOML parsing in `scripts/check-full-worker-topology.mjs` with Wrangler's `experimental_readRawConfig` and hardened the mutation scanner. | Remains open until the full-Worker (`mcp.frihet.io`) topology baseline transitions from `pending-bootstrap` to `established`. **Non-blocking for Claude:** `wrangler.claude.toml` is independently guarded via Wrangler's `unstable_readConfig` in `scripts/check-claude-hosted-release.mjs`. |
| **[#205](https://github.com/Frihet-io/frihet-mcp/issues/205)** | `OPEN` | PR #216 (`176de12`) implemented item 1 (durable DO-backed grant-replacement outbox on `/commit` that revokes superseded grants and their ERP keys), the `/attempt` expiry log from item 2, and item 4 (analytics-tripwire comments). | Remains open for two low-severity backlog items: enforcing a `<30 s` TTL floor inside `/reserve` (`oauth-state-store.ts`) and route-level simulation of ERP key-pool rotation / uid-mismatch `403`. **Non-blocking for the QA-allowlisted Claude pilot.** |
| **[#221](https://github.com/Frihet-io/frihet-mcp/issues/221)** | `OPEN` (`Refs #221` in [PR #229](https://github.com/Frihet-io/frihet-mcp/pull/229)) | PR #229 fixes `L3` (docstring + 64-grant truncation test), `L4` (removes dead self-only `keysPerUid`/`oidMismatch` harness scaffolding), and `L5` (deterministic frozen harness clock), and adds route tests `S2` and `S1` pinning the exact runtime behavior of `M1` and `L1`. | Remains open because `M1` and `L1` are **known risks bounded by route tests, not functionally redesigned**, and require **explicit owner acceptance** if the pilot proceeds with them:<ul><li>**`M1` (known risk — pending owner sign-off for pilot):** If `/commit` persists in DO storage (arming the replacement outbox) and two consecutive DO HTTP responses are lost (`commit_unavailable`), `/callback` fails closed (`503`), revokes the newly provisioned ERP key, and the replacement outbox revokes the prior grant/key—leaving `0` active keys until the user reauthorizes.</li><li>**`L1` (known risk — pending owner sign-off for pilot):** Two concurrent `/callback` requests for the same user+client that both list existing grants before either completes authorization leave `2` active grants and `2` bound ERP keys (neither is orphaned; both are revoked on the next sequential reconnect, explicit revocation, or TTL expiry).</li></ul> |

### 3.3 Live Hosted Status (`bloqueado` / `pendiente`)
- Live DNS lookup for `claude-mcp.frihet.io` currently returns `NXDOMAIN` (no DNS record exists yet in Cloudflare zone `frihet.io`).
- Live probe `GET https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/claudeOAuthApiKeyProvisioning` currently returns HTTP `404` (`claudeOAuthApiKeyProvisioning` is not yet deployed in Firebase production).
- `https://claude-mcp.frihet.io` is **not** live yet. Do not claim hosted availability in the Anthropic portal until Section 5 is completed.

---

## 4. Tests & Artifacts Ready for Codex Portal Submission

Codex can reference and attach the following verified repository paths and reproducible checks:

1. **Self-Contained Claude Plugin Package Directory:**
   - Path: `plugins/claude/frihet-erp/`
   - Manifest: `plugins/claude/frihet-erp/.claude-plugin/plugin.json` (`name: "frihet-erp"`, `version: "1.18.0-preview.2"`, `icon: "./.claude-plugin/icon.png"`)
   - Remote MCP Configuration: `plugins/claude/frihet-erp/.mcp.json` (`https://claude-mcp.frihet.io/mcp`)
   - Included Skills (4):
     - `plugins/claude/frihet-erp/skills/frihet-mcp/SKILL.md` (+ `references/api-patterns.md`, `references/tax-guide.md`, `references/workflows.md`)
     - `plugins/claude/frihet-erp/skills/cobros/SKILL.md`
     - `plugins/claude/frihet-erp/skills/documentos/SKILL.md`
     - `plugins/claude/frihet-erp/skills/revision-mensual/SKILL.md`
   - Offline Behavioral Evals Suite (4 synthetic cases: `receivables`, `missing-tax`, `unknown-write`, `incomplete-month`):
     - Path: `plugins/claude/frihet-erp/evals/`
     - Command:
       ```bash
       claude plugin eval plugins/claude/frihet-erp --runs 3 --ablation none --concurrency 1 --mocks record --allow-tools 'mcp__plugin_frihet-erp_frihet__*' --trust-plugin --no-publish --output-dir /tmp/frihet-claude-plugin-evals
       ```
2. **Machine-Readable Candidate Contract & Exclusion Documentation:**
   - Frozen Claude Candidate Contract JSON: `src/__tests__/fixtures/claude-candidate-contract.json`
   - Anthropic Directory Candidate Technical Brief & Exclusion Matrix: `marketplace/anthropic/SUBMISSION.md`
   - Public Capability Contract JSON: `src/__tests__/fixtures/public-capability-contract.json`
   - Agent Onboarding Surface Projection: `docs/agent-onboarding.json`
3. **Reproducible Verification Commands:**
   ```bash
   npm run gate:analytics
   npm run gate:claude-candidate
   npm run gate:claude-hosted-source
   npm run gate:openai-review-descriptor
   npm run gate:public-capability-truth
   npm run gate:agent-onboarding
   npm test --prefix workers/remote-mcp
   npm test
   ```

---

## 5. Remaining Blockers & Exact Operator Actions to Close Them

With **`CF-1` completed** (isolated KV namespace `274c7aaa85a04d44b4dc77f5f1dd7ca2` created in Cloudflare and bound in `workers/remote-mcp/wrangler.claude.toml`), the remaining steps before `https://claude-mcp.frihet.io/mcp` is live are:

### Blocker 1 — Production Firebase Deploy of Both `publicApi` and `claudeOAuthApiKeyProvisioning` (`berthelius/Frihet-ERP`)
- **Current state:**
  - `berthelius/Frihet-ERP` `main` is at `3d30fc7339ba32c3e6fdaf533f9b6550210c61bf` (which includes `#2654` / `9093fcd53` and `#2655`).
  - `/Users/brthls/Documents/Frihet-ERP/scripts/claude-publicapi-source-release.json` has `"approved": false`, `"candidateSourceSha256": null`, and **only covers `target: "publicApi"`** (`functions/src/index.ts`, `functions/src/publicApi.ts`, `functions/src/claudeWriteRoutes.ts`).
  - `GET https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/claudeOAuthApiKeyProvisioning` currently returns HTTP `404` (whereas a deployed function returns HTTP `405 Method not allowed` on `GET /`).
- **Action required (by the ERP operator/session — `frihet-mcp` never modifies `Frihet-ERP`):**
  1. Provision/verify the GCP Secret Manager secrets required by `claudeOAuthApiKeyProvisioning` in project `gen-lang-client-0335716041` (`FRIHET_CLAUDE_OAUTH_API_KEY` and `FRIHET_CLAUDE_QA_UIDS`, including the Firebase UID of the Anthropic review/QA test account coordinated with Codex) and verify service account `frihet-claude-oauth-runtime@gen-lang-client-0335716041.iam.gserviceaccount.com`.
  2. Deploy **both** `publicApi` (with the Claude write-route ceiling) and `claudeOAuthApiKeyProvisioning` from `berthelius/Frihet-ERP` to Firebase production (`gen-lang-client-0335716041`, `europe-west1`).
  3. Verify separately that `GET https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/claudeOAuthApiKeyProvisioning` returns HTTP `405` (not `404`) and update `/Users/brthls/Documents/Frihet-ERP/scripts/claude-publicapi-source-release.json` with `"approved": true` and the verified `"candidateSourceSha256"` so `node scripts/verify-claude-erp-source-release.mjs` in `frihet-mcp` exits `0`.

### Blocker 2 — Merge `#227` and `#229` & Certify Combined `main`
- **Action required:**
  1. After human review and merge of [PR #227](https://github.com/Frihet-io/frihet-mcp/pull/227) and [PR #229](https://github.com/Frihet-io/frihet-mcp/pull/229) into `main`, run the full verification suite (`npm test`, `npm test --prefix workers/remote-mcp`, `npm run gate:analytics`, `npm run gate:claude-candidate`, `npm run gate:claude-hosted-source`, `npm run gate:openai-review-descriptor`) on the combined `main` HEAD before any Worker deployment.

### Blocker 3 — Controlled Single-Activation Secret & Worker Rollout (`CF-2` + `CF-3`)
- **Why `wrangler secret put` is NOT run three times ahead of launch:** Cloudflare documents that each `wrangler secret put` immediately creates and deploys a new active Worker version. To avoid three implicit partial deployments before the backend and combined `main` are certified, `CF-2` and `CF-3` execute in a single controlled rollout while `claude-mcp.frihet.io` remains dark (`NXDOMAIN`, `workers_dev = false`, `preview_urls = false`), and the DNS record is activated last:
  1. **Validate secrets locally without printing or persisting values:** Validate `COOKIE_ENCRYPTION_KEY`, `FRIHET_CLAUDE_OAUTH_API_KEY`, and `FRIHET_CLAUDE_QA_UIDS` in memory via `node scripts/check-claude-bootstrap-secrets.mjs`.
  2. **Deploy Worker code while `claude-mcp.frihet.io` is still `NXDOMAIN` (zero public reachability because `workers_dev = false` and `preview_urls = false`):**
     ```bash
     npm --prefix workers/remote-mcp run deploy:claude
     ```
     (Runs `gate:analytics`, `gate:claude-candidate`, `gate:openai-review-descriptor`, `node ../../scripts/check-claude-hosted-release.mjs` against the ERP release receipt, and initializes the Worker + Durable Object migrations `v1`/`v2`.)
  3. **Attach all three secrets in one unactivated candidate version, then activate that single version (or upload all three atomically in one bulk revision):**
     - Upload all 3 secrets together into a single candidate version (`wrangler versions secret bulk` with an ephemeral `0600` FIFO/stdin JSON payload containing `COOKIE_ENCRYPTION_KEY`, `FRIHET_CLAUDE_OAUTH_API_KEY`, and `FRIHET_CLAUDE_QA_UIDS`), verify the candidate version ID, and promote it in a single step (`wrangler versions deploy <VERSION_ID>@100% --yes`).
  4. **Activate public routing by creating the proxied originless DNS record in Cloudflare zone `frihet.io`:**
     - Create `type: "AAAA"`, `name: "claude-mcp.frihet.io"`, `content: "100::"`, `proxied: true`, `ttl: 1` so `https://claude-mcp.frihet.io/mcp` becomes publicly reachable only after the Worker and all three secrets are active.
  5. **Execute live hosted smoke verification:**
     - Verify `GET https://claude-mcp.frihet.io/`, `/.well-known/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`, `/privacy`, `/support`, unauthenticated `POST /mcp` -> `401` (`WWW-Authenticate`), and one real QA OAuth login + `/mcp` tool call with the allowlisted QA account before Codex submits the connector as live.
