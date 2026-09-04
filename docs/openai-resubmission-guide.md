# OpenAI reviewed-surface contract

Frihet's ChatGPT deployment is deliberately narrower than the full MCP
catalogue. The independently versioned reviewed-profile candidate recorded in
`workers/remote-mcp/public-openai/releases.json` exposes this public contract:

- MCP endpoint: `https://openai-mcp.frihet.io/mcp`;
- OAuth issuer and protected resource: `https://openai-mcp.frihet.io`;
- sole OAuth scope: `frihet:workspace.manage`;
- exactly 33 reviewed business operations with complete descriptions and no
  discovery meta-tools;
- 0 prompts and 0 resources;
- literal `confirm=true` required and enforced for all 16 business writes;
- closed input objects and recursively closed, non-empty output objects;
- reviewed government-identifier, credential, banking-identifier, and precise-
  address fields removed, with runtime output and telemetry redaction;
- `/openapi.json` and `/openapi.yaml` return 404 on the reviewed host.

The connector does not offer direct email delivery. It also excludes the legacy
monthly summary, raw
documents, invoice lifecycle and credit operations, updates to existing quotes,
client-parent deletion, expense deletion and linked-file erasure, product
deletion, vendor deletion, webhook
administration, payroll/HR, banking, accommodation/POS, signing credentials,
regulated e-invoicing, filing, and export workflows.

Webhook administration being absent does not mean that every write is closed-
world. Ten confirmed operations can deliver full business events to active
endpoints that the workspace owner configured elsewhere. Those deliveries are
outside the reviewed MCP response schema and can include the complete
underlying record, including fields the connector does not expose to ChatGPT.
Logging a call,
meeting, or email can emit `client.updated`; logging a task does not update the
parent client. Creating an invoice or expense can also notify eligible
workspace admins/accountants in-app and through Novu and can award first-use
referral credits. Invoice creation may send minimized activation/usage analytics
to PostHog's EU-hosted analytics service.

Creating an invoice or quote always creates a draft, reserves a document number,
advances the workspace numbering counter, and may create/link a client. Creating
an expense requires an explicit date and deductible choice, may create/link a
vendor, and changes internal accounting/future tax-report inputs. Vendor creation
is a separate backend step, so a new vendor may remain if the later expense write
fails. The date
determines its accounting/reporting period; the reviewed schema cannot mark it
paid or choose a separate cash-basis payment period. Expense updates cannot
change the amount or linked supplier identity. Nothing in this surface
files or amends a tax return.

Selected client contacts and client notes can be permanently deleted after
explicit confirmation. A clean draft quote with no delivery, response,
attachment, or conversion evidence can also be deleted; a protected draft is
refused, and deleting a non-draft quote cancels it.

The canonical evidence is
`src/__tests__/fixtures/openai-review-descriptor.snapshot.json`; the provider
form is generated as `marketplace/openai/chatgpt-app-submission.json`. Verify
both with:

```bash
npm run gate:openai-review-descriptor
npm run gate:openai-submission
npm run gate:public-capability-truth
npm run gate:agent-onboarding
bash scripts/analytics-tripwire.sh
```

The verified portal selections observed on 2026-09-04 are Identity
`Business — Frihet` and Plugin Author `Frihet`. They must match the live
connector privacy/support ownership statement, JSON-LD publisher evidence, and
generated submission description before a draft is submitted. The public
evidence must keep the legal chain explicit: Frihet is the trade name owned and
operated in Spain by `VICTOR BERTHELIUS PATO`. Do not substitute the Individual
identity, rely on the display name alone as ownership evidence, or search for a
nonexistent `Business — VICTOR BERTHELIUS PATO` portal option.

## Historical rejection regression matrix

Every issue cited across the three prior review rounds is a release blocker,
not merely portal copy to complete at submission time:

| Prior review issue | Required evidence before resubmission |
| --- | --- |
| Developer or business identity did not match | Select Identity `Business — Frihet` and Plugin Author `Frihet`; keep the exact legal owner/controller `VICTOR BERTHELIUS PATO` in the generated description and on the live website, connector support, privacy, terms, JSON-LD, agent, and MCP publisher surfaces. |
| App or trademark ownership could not be confirmed | Keep the public chain explicit: the legal person owns and operates the Frihet trade name, and the live Frihet privacy policy and terms identify the same controller and service provider. Do not rely on logo or display-name similarity. |
| `openWorldHint` values were missing or inconsistent | All 33 tools must carry explicit boolean `readOnlyHint`, `openWorldHint`, and `destructiveHint` values, with tool-specific external-effect explanations enforced by the descriptor and submission gates. |
| Test cases were incorrect or inconsistent | Generate exactly five positive and three negative cases from the frozen descriptor, seed deterministic review data, and execute every case successfully in both ChatGPT web and mobile against the release candidate. Record the expected and observed outcomes. |
| Returned user-data categories were not fully disclosed | Keep recursively closed output schemas, runtime redaction, the dedicated connector privacy notice, and explicit disclosures for internal linking/snapshots, notifications, analytics, referrals, and owner-configured webhook deliveries. |
| The app solicited sensitive personal data | Expose no dedicated government-ID, banking, credential, precise-address, raw-document, or regulated-payload fields. Every reviewed user-entered free-text field must warn against credentials, card data, health data, and official identifiers. |
| Submission metadata was incomplete or invalid | Live-smoke the canonical website, connector support URL, connector privacy URL, and support contact; verify the generated five/three test cases contain concrete expected outcomes before uploading the JSON. |

Do not mark a row complete from local source alone. Public identity, URLs,
OAuth behavior, and test outcomes require release-candidate evidence. Portal
submission remains a separate, explicitly confirmed action.

## Controlled OpenAI profile release

The reviewed host is not deployed by the npm/full-profile release workflow.
`.github/workflows/deploy-openai-mcp.yml` is an independent OpenAI-only release
ceremony. It accepts one exact current `origin/main` SHA and binds that SHA to
the workflow at the same commit, its successful required CI check, exact
lockfiles, Wrangler OpenAI configuration, reviewed public assets, and the exact
dry-run bundle. It does not depend on an npm publication, GitHub Release, tag,
or the default/full Worker, and it cannot deploy or probe the full host.

`/health.releaseVersion` identifies the package/runtime version derived from
the exact source. It is intentionally distinct from the reviewed ChatGPT
profile version, whose sole authority is `public-openai/releases.json`. The
workflow records and live-verifies both values and the frozen authority hashes
rather than relabelling either.

The default/full release is currently on explicit source-derived HOLD in
`full-oauth-release-contract.json`: this source has no separately credentialed,
server-derived Full OAuth lifecycle authority. A non-dry-run of
`.github/workflows/release-mcp-npm.yml` therefore fails before build, publish,
or deployment and leaves the existing live Full Worker untouched. Releasing a
future Full source requires a separately reviewed authority and credential,
changing that exact contract to `ready`, and changing the hostile contract
tests. The OpenAI lifecycle credential must never authorize Full provisioning.
Neither this HOLD nor the OpenAI workflow is evidence that a deployment has
occurred.

The current production topology predates the target Durable Object migration
and dedicated OAuth KV binding. Cloudflare rollback does not undo Durable
Object lifecycle migrations or restore connected resources. Therefore
`marketplace/openai/cloudflare-topology-baseline.json` is intentionally
`pending-bootstrap`, and every real functional release fails before mutation.
Complete the separately reviewed bridge procedure in
`docs/openai-topology-bootstrap.md` first. No version-recovery action can be
treated as a way to cross this topology boundary.

After the final-topology baseline receipt has been independently reviewed and
marked `established`, use this ceremony:

1. Create two exact-main-only GitHub environments. `openai-plugin-release` must
   have at least one required independent reviewer with prevent-self-review
   enabled. `openai-plugin-rollback` must have no reviewer, wait timer, or
   custom gate so ordinary post-mutation failures can switch traffic back
   without another human gate. Referencing an absent environment can create it
   without the intended controls; the environment-free preflight uses
   `actions: read`, `checks: read`, and `contents: read` to verify both live
   configurations and the exact current-source CI authority before mutation.
2. In `openai-plugin-rollback`, configure minimum recovery-scoped
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and
   `OPENAI_ROLLBACK_ENV_GUARD`, plus the same one-time
   `OPENAI_CLOUDFLARE_CHANGE_FREEZE_ID` used by the release environment. The
   workflow proves these recovery prerequisites before the release job can
   mutate anything, then reads the 100%-active deployment
   and exact version through the pinned CLI, and compares its real DO/KV/Assets
   binding topology to the independently reviewed immutable bridge anchor.
   That anchor binds the exact Cloudflare account, zone, script/environment,
   route and subdomain policy, active deployment and version, bridge source
   SHA/runtime version, version creation/source/ETag metadata, canonical
   resource topology, target-config digest, and public-health provenance. It is
   historical evidence of the approved topology transition, not a claim that
   those deployment IDs remain active forever. Immediately before every real
   deploy the protected job instead captures two fresh live prestate snapshots,
   records each trusted start before its first provider read, records completion
   only after every read, keeps the first-start-to-deploy window within five
   minutes, rejects future or illogically ordered provider timestamps, and
   requires exact equality apart from capture times. A pending anchor,
   migration/binding drift, extra resource, namespace drift, split deployment,
   wrong account/zone/script/route/subdomain, JIT drift, or failed health proof
   stops before mutation; a recomputed hash alone cannot satisfy the gate.
3. On the `frihet-openai-mcp` Cloudflare environment, verify the runtime secret
   names `COOKIE_ENCRYPTION_KEY`, `FIREBASE_PROJECT_ID`, `FRIHET_API_BASE`, and
   `FRIHET_OAUTH_API_KEY` exist. The workflow inventories names only and stops
   before deployment if one is absent; it never reads or prints secret values.
4. While that compatible final-topology baseline is still 100% active, use a
   trusted workstation to launch the pinned MCP Inspector (`npx --yes
   @modelcontextprotocol/inspector@2.5.0`) on its default loopback-only host.
   Configure **Streamable HTTP** at exactly
   `https://openai-mcp.frihet.io/mcp`, complete OAuth with the dedicated
   non-customer reviewer workspace, and copy the newly issued token without
   printing it or saving it to a transcript. In `openai-plugin-release`, set
   `FRIHET_OAUTH_ACCESS_TOKEN`, `OPENAI_TOKEN_BASELINE_VERSION_ID` to the exact
   active baseline version, and `OPENAI_TOKEN_TOPOLOGY_SHA256` to the reviewed
   anchor topology hash, alongside `OPENAI_RELEASE_ENV_GUARD`, a one-time
   64-hex `OPENAI_CLOUDFLARE_CHANGE_FREEZE_ID`, and the scoped Cloudflare
   credentials. Pass the same freeze ID as dispatch `change_freeze_id`; approval
   attests that every other Cloudflare/portal mutation path is frozen for this
   run. Close Inspector. This is an attainable pre-mutation ceremony:
   the workflow validates the attestations and performs authenticated
   `initialize` plus `tools/list` against the compatible baseline before it
   marks the mutation boundary. Never put token values in inputs, logs,
   commands, repository variables, or artifacts.
5. Dispatch from `main` with the exact 40-character current `source_sha`,
   leaving `dry_run=true`. The workflow derives the runtime and reviewed-profile
   versions from that exact source. Retain the sanitized Wrangler artifact and
   its authority hashes proving `--env openai` resolves the dedicated KV,
   Assets and Durable Objects, `FRIHET_OPENAI_MODE=true`, and
   `FRIHET_TOOL_MODE=full`.
6. Re-dispatch the same exact inputs with `dry_run=false`. Independent
   `openai-plugin-release` approval occurs only after every root, Worker,
   descriptor, submission, capability, onboarding, analytics, OpenAPI and
   topology gates, the asserted Wrangler dry-run, baseline capture, token
   attestation, and authenticated readiness. Inside the already approved job,
   immediately before mutation, it re-reads `origin/main`, the 100%-active
   deployment/version, account identity, zone, route/subdomain policy, complete
   resource set and exact public-health provenance twice and requires both JIT
   snapshots to match the approved anchor topology and each other. Cloudflare
   exposes no compare-and-swap deployment primitive: GitHub concurrency blocks
   another copy of this workflow, while the approved one-time freeze attestation
   is the mandatory out-of-band exclusion for every other mutation path. There
   is no environment approval after deploy:
   authenticated exact-descriptor compose runs automatically in the same
   protected job immediately after the deployment command.
7. Require the uploaded production evidence: exact `/health` SHA/version
   provenance, 33 reviewed tools, 0 discovery meta-tools, 0 resources, 0
   prompts, exact OAuth scope and host, legal pages returning 200, OpenAPI GET
   and HEAD returning non-cacheable 404, unauthenticated MCP returning 401, and
   the authenticated descriptor compose matching the frozen snapshot. The
   compose artifact contains boolean invariants only, never response bodies,
   JSON-RPC errors, session IDs, tokens, or business data.
8. If the deploy, immediate authenticated compose, or public readback fails
   after the mutation boundary, the non-blocking recovery job uses pinned
   tooling to select the exact version ID from this run's account-bound JIT
   prestate at 100% traffic. Immediately before that mutation it rejects any
   deployment ID/version not created by this run, re-reads the recovery
   version's source/version/ETag and complete topology, and refuses
   latest/positional or preapproval-state selection. It then revalidates 100%
   traffic, the exact prestate public-health projection and unauthenticated
   401. This is a compatible version roll-forward within the exact JIT topology,
   not a lifecycle rollback.
9. GitHub does not guarantee that `always()` recovery runs after a force-cancel
   or infrastructure termination. If a run is force-cancelled after mutation,
   **STOP: production recovery is the only task**. From an authenticated trusted
   workstation, inspect the Cloudflare deployment status and version-resource
   JSON with the pinned CLI, run the topology gate against the reviewed receipt,
   and follow the private incident-recovery runbook only for the previously
   captured compatible version. The exact reviewed recovery semantics remain
   executable in `.github/workflows/deploy-openai-mcp.yml`; do not copy commands
   or credentials into this public submission guide. Repeat topology, health,
   and 401 readbacks and attach sanitized evidence. Never cross a migration or
   KV/DO drift in recovery.

The workflow does not submit the connector to OpenAI. A production-green
workflow is necessary release evidence, not permission to mutate the provider
portal. Complete the five positive and three negative cases in both ChatGPT web
and mobile, record observed outcomes, and obtain explicit submission authority
after the evidence has been reviewed.

## Submission-time hard stops

- Sign in to the **same OpenAI organization and project** where the verified
  portal selections are Identity `Business — Frihet` and Plugin Author
  `Frihet`. Before creating or editing the draft, confirm both selections are
  visible and that the operator has Apps Management / `api.apps.write`.
  Historical review messages delivered to an old account such as
  `marketing@rewinder.eco`, or the legal name appearing in app copy, do not
  prove that the active portal identity is correct. **STOP before
  creating the draft** if organization, project, Identity, Plugin Author, or
  permission differs. Record a screenshot of the selected identity and project
  as review evidence; the frame must also show the Plugin Author selection.
  Redact tokens, credentials, and personal session details.
- In that exact project, confirm visually that data residency is **Global**.
  OpenAI does not permit MCP plugin submission from a project with EU data
  residency. **STOP before creating or editing the draft** if the selected
  project is EU-resident; switch only to an approved Global-residency project
  in the same verified organization. Record redacted visual evidence of the
  exact project and its Global data-residency setting. Re-check this eligibility
  against the current [OpenAI app-review requirements](https://developers.openai.com/plugins/deploy/app-review/)
  at submission time.
- Provision one dedicated, non-customer reviewer workspace and credentials
  outside the repository. Before opening the submission action, prove that the
  reviewer can sign in and complete all five positive and three negative cases
  without MFA, SMS, email confirmation, a private network, or assistance from
  the Frihet team. If any case is not independently reproducible, **STOP before
  the portal**. Never commit, paste into workflow inputs, or upload the reviewer
  credential values as evidence.
- This connector does not declare a workspace-domain restriction. Its sole
  OAuth scope remains `frihet:workspace.manage`; do not add or imply UserInfo,
  `openid`, or `email` support. Those identity claims are needed only if a
  future, separately reviewed draft actually declares domain restriction.
- Verify domain ownership inside the current portal draft. The live verification
  endpoint may still return a historical challenge token, which is not evidence
  that a new draft or app version accepts it. If the draft already shows the
  domain as verified, preserve the endpoint and record that portal evidence. If
  the portal issues a different challenge, **STOP before Scan Tools** and make a
  bounded one-token endpoint change, review, and controlled deployment first.
  Never publish or retain multiple verification tokens, and never hardcode a new
  token without the current draft's exact challenge.

The submission JSON schema does not carry starter prompts, release notes, or
regional availability. Enter these portal-only values exactly in the current
draft:

**Starter prompts**

1. `Give me an overview of my current Frihet business context.`
2. `Show me my draft invoices.`
3. `Show me my active products and services.`

These prompts are intentionally read-only and map to reviewed tools. Do not use
a starter prompt that requests a write or attempts to bypass explicit
confirmation.

**Release notes**

> Fourth resubmission: Frihet now exposes only 33 reviewed business tools with complete schemas and explicit action hints; removes discovery tools, prompts, resources, OpenAPI, regulated workflows, raw documents, and dedicated sensitive-identifier fields; aligns the verified Identity `Business — Frihet` and Plugin Author `Frihet`, OAuth scope, privacy disclosures, and five positive plus three negative review cases.

**Availability**

Select `Spain` only. Do not select another jurisdiction until its commercial,
legal, authentication, and support availability is documented and separately
reviewed.

## Deployment compatibility

The principal-bound MCP session envelope is intentionally not compatible with
raw `mcp-session-id` values issued before this release. Existing clients on the
full MCP host must start a new MCP session after deployment; the Worker rejects
an old raw id instead of trusting an unbound session. The reviewed OpenAI host
must not be submitted until its candidate deployment has exercised this
reconnect path and the coordinated OAuth grant/API-key retirement plan has
removed credentials created before host/profile binding was recorded.

Provider credentials, reviewer accounts, verification material, deployment
commands, and review correspondence remain outside this public repository.
