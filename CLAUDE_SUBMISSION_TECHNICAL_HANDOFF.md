# Claude Submission Technical Handoff (`io.frihet/erp` · `frihet-erp`)

> **Truth boundary:** This document separates source/SDK verification (`probado`), pending cloud operator actions (`pendiente`), and hard dependencies that block hosted live acceptance (`bloqueado`). Do **not** submit the hosted connector to Anthropic as live/available until the three cloud bootstrap items in Section 5 are executed and `node scripts/check-claude-hosted-release.mjs` exits `0` without `--source-only`.

---

## 1. Real Status of Every Technical Requirement

| Requirement | Surface | Status | Literal Evidence |
| :--- | :--- | :--- | :--- |
| **Claude candidate catalog & profile isolation (125 canonical operations, 4 fiscal aliases, 1 remote resource, 2 prompts)** | `src/claude-profile.ts`, `src/__tests__/fixtures/claude-candidate-contract.json` | **`probado` (en código y CI)** | `npm run gate:claude-candidate` passes (`12/12` tests): `156 - 8 unavailable - 8 deferred - 15 other exclusions = 125` canonical operations (`129` full tool names, `132` grouped tool names with 3 discovery tools). |
| **Claude output privacy & redaction boundary** | `src/claude-output-privacy.ts`, `src/__tests__/claude-output-privacy.test.ts` | **`probado` (en código y CI)** | Strips sensitive fields (`taxId`, `nif`, `cif`, `iban`, `bic`, `bankAccount`, `documentNumber`, `verifactuHash`, secrets/tokens), sanitizes `structuredContent` and JSON resources, and excludes `get_invoice_pdf` and `get_invoice_einvoice`. |
| **Claude Worker source topology & OpenAI Worker isolation** | `workers/remote-mcp/wrangler.claude.toml`, `scripts/check-claude-hosted-release.mjs` | **`probado` (en código y dry-run)** | `npm run gate:claude-hosted-source` and `npx wrangler deploy --config wrangler.claude.toml --dry-run` pass (`3650.07 KiB / gzip: 659.33 KiB`). Dedicated Worker name (`frihet-claude-mcp`), custom domain (`claude-mcp.frihet.io`), `FRIHET_OPENAI_MODE="false"`, `FRIHET_CLAUDE_MODE="true"`, `FRIHET_TOOL_MODE="grouped"`, and zero shared Durable Object or KV namespace IDs with `workers/remote-mcp/wrangler.toml`. |
| **Audited OAuth provider localhost callback patch for Claude Code** | `scripts/prepare-claude-oauth-provider.mjs`, `scripts/__tests__/claude-oauth-provider.test.mjs` | **`probado` (en código y CI)** | Single-line build-time patch over locked `@cloudflare/workers-oauth-provider@0.3.0` (`sourceSha256: 54384c198541571c7fac691afad31f51f9914debbca9571fa4dcde3af9f1133c` -> `patchedSha256: 61da741102e458a42150f7945af91dbe2cc11b4bb331a93d36574e9ef5ec9bf0`) allowing `http://localhost:<port>` callbacks for Claude Code while preserving exact `https://claude.ai/api/mcp/auth_callback` matching and stock SDK behavior for OpenAI/full Workers. |
| **OAuth 2.1 + PKCE + DCR + Firebase identity + QA allowlist + durable grant replacement (`#204`, `#205`, `#221`)** | `workers/remote-mcp/src/auth-handler.ts`, `workers/remote-mcp/src/oauth-state-store.ts`, `workers/remote-mcp/src/oauth-token-family.ts` | **`probado` (en harness de rutas e integración local)** | `npm test --prefix workers/remote-mcp` passes (`260/260` tests). Includes `#204` Wrangler topology/mutation guards (`22196c1`), `#205` durable grant-replacement outbox (`176de12`), and `#221` fail-closed double-commit-response-loss (`M1`), concurrent callback (`L1`), `>64` grant truncation (`L3`), and deterministic harness clock (`L4`/`L5`) pins. |
| **OpenAI frozen 33-tool connector isolation** | `src/openai-profile.ts`, `src/__tests__/fixtures/openai-review-descriptor.snapshot.json` | **`probado` (en código y CI)** | `npm run gate:openai-review-descriptor` and `npm run gate:openai-submission` pass with zero diff against the frozen 33-tool descriptor and schema `aa7d1bd554e6c615d411c03e5b73bb464816be603461eb5813bb589645550304`. |
| **Claude plugin package (`plugins/claude/frihet-erp`)** | `.claude-plugin/plugin.json`, `plugins/claude/frihet-erp/**`, `skills/**`, `skill/**` | **`probado` (en código y CI)** | `node --test scripts/__tests__/claude-plugin-package.test.mjs` and `node scripts/sync-claude-plugin.mjs --check` pass (`0` drift between root `.claude-plugin` + `skills/` + `skill/` and `plugins/claude/frihet-erp`). |
| **Public URLs referenced by plugin manifest** | `documentationUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`, `supportUrl` | **`probado` (3/4 live HTTP 200) / `bloqueado` (`supportUrl` awaiting Worker deploy)** | `https://docs.frihet.io/desarrolladores/mcp-server` (`200`), `https://www.frihet.io/es/privacy` (`200`), and `https://www.frihet.io/es/terms` (`200`) are live. `https://claude-mcp.frihet.io/support` is served by `claudePublicSurface` inside `frihet-claude-mcp` and will resolve once the Worker is deployed. |
| **ERP Claude write-route ceiling artifact (`berthelius/Frihet-ERP`)** | `Frihet-ERP` commit `9093fcd53` (`#2654`), `scripts/claude-publicapi-source-release.json` | **`pendiente` (aprobación y deploy Firebase prod)** | CI build proof exists (`runId: 39029744215`, `artifactId: 12099932896`, `replacementArchiveSha256: 02bb8a6e0980f14cbace9b42ff35f162fdee44418762b3abd0748cba17796c73`), but `approved: false` and `candidateSourceSha256: null` until the production Firebase function deploy for `publicApi` + `claudeOAuthApiKeyProvisioning` is executed. |
| **Cloudflare `OAUTH_KV` namespace & Worker secrets for `frihet-claude-mcp`** | `workers/remote-mcp/wrangler.claude.toml` | **`pendiente` (bootstrap de operador Cloud)** | `wrangler.claude.toml` currently holds dry-run placeholder `id = "00000000000000000000000000000000"` and awaits provisioning of a dedicated `OAUTH_KV` namespace plus secrets `COOKIE_ENCRYPTION_KEY`, `FRIHET_CLAUDE_OAUTH_API_KEY`, and `FRIHET_CLAUDE_QA_UIDS`. |
| **Live DNS & HTTPS endpoint `https://claude-mcp.frihet.io/mcp`** | Cloudflare Custom Domain (`claude-mcp.frihet.io`) | **`bloqueado` (depende de los 2 pasos anteriores)** | Live DNS probe (`dig +short claude-mcp.frihet.io`) currently returns empty (`NXDOMAIN`) because Cloudflare Custom Domains attach when `frihet-claude-mcp` is deployed. |

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
  - `FRIHET_CLAUDE_MODE = "true"`
  - `FRIHET_OPENAI_MODE = "false"`
  - `FRIHET_TOOL_MODE = "grouped"` (125 canonical operations + 4 fiscal aliases + 3 discovery meta-tools = **132 tool names**, **1 remote resource** `frihet://config/currencies`, **2 prompts** `overdue-followup` and `invoice-aging-review`)
- **Versions & Commit Anchors:**
  - `@frihet/mcp-server` package version: `1.18.0`
  - `@frihet/remote-mcp-server` Worker version: `1.1.0`
  - Claude Plugin (`plugins/claude/frihet-erp/.claude-plugin/plugin.json`) name & version: `frihet-erp` · `1.18.0-preview.2`
  - Base `main` commit SHA: `02cd0b95494dc73193475139f3dae1340b702583`
  - ERP Contract Hardening PR (approved, ready to merge): [PR #227](https://github.com/Frihet-io/frihet-mcp/pull/227) (`40e7f30afedbf054bef841a9e6089aa9363c5204`)
  - Claude P0 Readiness & `#221` OAuth Follow-up Closure branch: `fix/claude-p0-hosted-and-plugin-readiness`

---

## 3. OAuth & Hosted Worker Evidence

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
  - `npx wrangler deploy --config wrangler.claude.toml --dry-run` (from `workers/remote-mcp`) compiles cleanly (`Total Upload: 3650.07 KiB / gzip: 659.33 KiB`) with bindings `MCP_OBJECT (FrihetMCP)`, `OAUTH_STATE (OAuthStateStore)`, `OAUTH_KV`, `FRIHET_OPENAI_MODE="false"`, `FRIHET_CLAUDE_MODE="true"`, `FRIHET_TOOL_MODE="grouped"`, and `FIREBASE_PROJECT_ID="gen-lang-client-0335716041"`.

### 3.2 Live Hosted Status (`bloqueado` / `pendiente`)
- Live DNS lookup for `claude-mcp.frihet.io` currently returns `NXDOMAIN`.
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

Only **three infrastructure operator actions** remain before `https://claude-mcp.frihet.io/mcp` is live and `npm --prefix workers/remote-mcp run deploy:claude` succeeds end-to-end:

### Blocker 1 — Production Firebase Deploy of the ERP Claude Provisioning & Write-Route Ceiling (`berthelius/Frihet-ERP`)
- **Current state:** `Frihet-ERP` `main` (`9093fcd53`) contains the Claude write-route ceiling (`functions/src/claudeWriteRoutes.ts`) and build receipt (`scripts/claude-publicapi-source-release.json`, `runId: 39029744215`, `artifactId: 12099932896`), but `approved` is `false` and `candidateSourceSha256` is `null`.
- **Action required:**
  1. Deploy the approved `publicApi` and `claudeOAuthApiKeyProvisioning` Cloud Functions from `berthelius/Frihet-ERP` to Firebase production (`gen-lang-client-0335716041`, `europe-west1`).
  2. Update `/Users/brthls/Documents/Frihet-ERP/scripts/claude-publicapi-source-release.json` with `"approved": true` and the verified `"candidateSourceSha256"` (matching `functions/src/index.ts`, `functions/src/publicApi.ts`, and `functions/src/claudeWriteRoutes.ts`), so `node scripts/verify-claude-erp-source-release.mjs` in `frihet-mcp` exits `0`.

### Blocker 2 — Dedicated Cloudflare `OAUTH_KV` Namespace & Worker Secret Bootstrap
- **Current state:** `workers/remote-mcp/wrangler.claude.toml` uses placeholder `id = "00000000000000000000000000000000"` for `OAUTH_KV`.
- **Action required:**
  1. Create a dedicated Cloudflare KV namespace for `frihet-claude-mcp` (distinct from OpenAI's `9598d7ffe6ca4622b1be48efbd17aa13` and full MCP's `d06262c53b734592b69aafb6fd9abfb0`) and write its real 32-hex ID into `workers/remote-mcp/wrangler.claude.toml` (updating its hash in `scripts/check-no-analytics-emitters.mjs`).
  2. Provision the three required Worker secrets on `frihet-claude-mcp` (distinct from OpenAI's secrets) and verify them with `node scripts/check-claude-bootstrap-secrets.mjs`:
     - `COOKIE_ENCRYPTION_KEY` (64 lowercase hex chars / 32 random bytes, distinct from OpenAI)
     - `FRIHET_CLAUDE_OAUTH_API_KEY` (matches the ERP `claudeOAuthApiKeyProvisioning` service secret, distinct from `FRIHET_OAUTH_API_KEY`)
     - `FRIHET_CLAUDE_QA_UIDS` (JSON array of ERP-safe Firebase UIDs authorized for the Anthropic review/QA pilot)

### Blocker 3 — Deploy `frihet-claude-mcp` & Execute Hosted Smoke Verification
- **Current state:** `claude-mcp.frihet.io` is not yet deployed (`NXDOMAIN`).
- **Action required:**
  1. Run the guarded deploy command:
     ```bash
     npm --prefix workers/remote-mcp run deploy:claude
     ```
     (This automatically executes `gate:analytics`, `gate:claude-candidate`, `gate:openai-review-descriptor`, `node ../../scripts/check-claude-hosted-release.mjs`, and `wrangler deploy --config wrangler.claude.toml`.)
  2. Verify live public routes (`GET https://claude-mcp.frihet.io/`, `/.well-known/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`, `/privacy`, `/support`, and unauthenticated `POST /mcp` -> `401` with `WWW-Authenticate` challenge) and complete one real QA OAuth login + `/mcp` tool call before marking the connector live in the Anthropic portal.
