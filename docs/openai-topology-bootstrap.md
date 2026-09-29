# OpenAI Worker topology bootstrap

This runbook is a hard boundary between the current production topology and
functional OpenAI-profile releases. It does not authorize a deployment.

The current production version uses the original Durable Object migration and
the historical OAuth KV topology. The target configuration adds
`OAuthStateStore` through migration `v2` and selects the dedicated OpenAI OAuth
KV namespace. Cloudflare version rollback does not undo Durable Object
lifecycle migrations and does not restore connected resources. The active
production Worker version also lacks an authenticated exact-source receipt, so
this repository cannot safely manufacture a behavior-preserving bridge from
the currently available evidence.

Consequently `marketplace/openai/cloudflare-topology-baseline.json` remains
`pending-bootstrap`. `.github/workflows/deploy-openai-mcp.yml` executes
the established-baseline topology gate against the actual 100%-active
Cloudflare version and must fail before mutation until this procedure is
completed in separately reviewed changes.

## Owner decision: the reviewed `main` commit is the bridge

For this bootstrap the owner waives step 1 of the required bridge release and
satisfies step 2 as described here. The exact source of the active production
version cannot be recovered, so no behavior-preserving bridge is built. The
bridge is a reviewed commit of `main`, called `<S>` below. It introduces the
final topology and the reviewed 33-tool surface in one change. Step 2 allows
that only because `<S>` as a whole, surface switch included, receives exact-SHA
review. Steps 3 to 9 still apply, except that step 5 verifies the reviewed
surface described below instead of an unchanged one. The first deployment of
`<S>` is manual, because the release workflow refuses to mutate while the
receipt is `pending-bootstrap`.

**IRREVERSIBLE.** Deploying `<S>` applies migration `v2`, which creates the
`OAuthStateStore` Durable Object class. Cloudflare does not allow a rollback to
any version deployed before a Durable Object class lifecycle change
([Cloudflare documentation](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/#durable-object-class-lifecycle-changes)).
From that deployment on, recovery is forward-only: a failure is fixed by
deploying a newer reviewed commit, never by returning to the current version.

**Current sessions end.** The reviewed host moves to its dedicated `OAUTH_KV`
namespace. Every OAuth client registration, grant and token it issued before
the deployment stops resolving, so every connected client, including the
ChatGPT draft and any test connector, must register and authorize again. The
full host at `mcp.frihet.io` is not changed by this procedure.

**Surface change.** Clients see the reviewed surface as soon as the deployment
is live, and a submitted OpenAI draft needs a new scan.

### Before the window

1. Privacy date. The reviewed host's privacy notice
   (`workers/remote-mcp/src/index.ts`) shows a "Last updated" date. If the
   deployment happens after that date, first merge a change that sets it to the
   deployment date, so the notice does not claim to have applied before users
   could read it. The change touches a file whose hash the analytics integrity
   gate pins, so refresh that pin in the same change and use the resulting
   `main` commit as `<S>`.
2. The Frihet API-key provisioning endpoint called by
   `workers/remote-mcp/src/oauth-provisioning.ts` is deployed with its service
   credential bound. It answers 405 to a GET. A DELETE that carries the
   Worker's service header with a deliberately wrong value is rejected before
   any request body is read: 401 with code `OAUTH_SERVICE_UNAUTHORIZED` means
   the credential is bound, and 503 with `OAUTH_SERVICE_UNAVAILABLE` means it
   is missing or shorter than 32 bytes. A POST cannot tell these apart, because
   it checks the Firebase token first. Without the endpoint, the OAuth callback
   answers 502.
3. `FRIHET_OAUTH_API_KEY` exists once in Frihet's secret manager. The Worker
   later receives exactly the same bytes: at least 32 bytes and no trailing
   newline.
4. `<S>` is the current `main`, its `Build · Test · Drift audit` check
   succeeded, and its exact-SHA review receipt exists.
5. Two non-customer reviewer workspaces exist, the second one only for the
   cross-workspace check.
6. Every other Cloudflare and portal change is frozen for the window.

### Owner sequence

1. Dispatch `deploy-openai-mcp.yml` from `main` with `source_sha=<S>` and
   `dry_run=true`. It asserts the dedicated KV, both Durable Object bindings,
   the Assets binding and the reviewed vars without deploying. Keep its
   artifact, which records the digest of the bundled `index.js`.
2. In a clean checkout of `<S>`, install both lockfiles exactly as CI does and
   run the workflow's Wrangler dry run for the `openai` environment with the
   same two release vars. The `index.js` digest must equal the artifact's;
   otherwise stop.
3. **IRREVERSIBLE.** Deploy `<S>` with the invocation of the workflow's
   deploy step: the `openai` environment, the explicit Worker name
   `frihet-openai-mcp`, `RELEASE_SOURCE_SHA` set to `<S>` and
   `RELEASE_VERSION` set to the `package.json` version of `<S>`, and a message
   that names `<S>`. The deploy command uses an explicit name as given. Until
   step 4 completes, the OAuth callback answers 503.
4. Add `FRIHET_OAUTH_API_KEY` to the Worker by piping it from Frihet's secret
   manager into Wrangler's single-secret `put` subcommand, so the value is
   never displayed or written to a file. Select the Worker with `--env openai`
   only. The Wrangler version locked in `workers/remote-mcp/package-lock.json`
   has no deploy option that uploads secret values, so this is a separate
   step, and it creates and deploys a new version. **Never add `--name` to a
   Worker-secret command:** with `--env openai`, Wrangler's secret commands
   turn `--name frihet-openai-mcp` into the Worker `frihet-openai-mcp-openai`.
   Listing then fails, but the `put` subcommand, when the value is piped,
   creates that Worker without asking and stores the credential there, while
   the reviewed host keeps answering 503.
   `scripts/__tests__/openai-wrangler-resolution.test.mjs` pins this behavior
   against the locked Wrangler.
5. Remove `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`
   from the Worker the same way; each removal deploys another version. The
   reviewed host never reads them: it passes an empty Langfuse configuration
   (`workers/remote-mcp/src/index.ts`), and its privacy notice says it sends no
   tool telemetry to Langfuse. The topology gate and the release workflow
   require exactly the four secret names in
   `marketplace/openai/cloudflare-topology-baseline.json`:
   `COOKIE_ENCRYPTION_KEY`, `FIREBASE_PROJECT_ID`, `FRIHET_API_BASE` and
   `FRIHET_OAUTH_API_KEY`. Any Langfuse name left behind stops every later
   release before mutation.
6. Run the verification below after the last change. Any failure stops the
   procedure; recovery is forward-only.
7. Capture the receipt for step 7 of the required bridge release. Then
   configure the release environments described in
   `docs/openai-resubmission-guide.md`: `OPENAI_TOKEN_TOPOLOGY_SHA256` is the
   receipt's `baseline.topologySha256`, and `OPENAI_TOKEN_BASELINE_VERSION_ID`
   is the version that is active when each release is dispatched. Later
   releases go through the workflow.

### Verification after the last change

1. Public `/health` reports `releaseSha` equal to `<S>`, `releaseVersion` equal
   to the package version of `<S>`, and `releaseSource=wrangler-var`. This also
   proves that the versions created in steps 4 and 5 kept the release vars.
2. Exactly one deployment serves 100% of traffic. Its version has migration tag
   `v2`, the dedicated `OAUTH_KV` namespace, `MCP_OBJECT:FrihetMCP` and
   `OAUTH_STATE:OAuthStateStore`, and exactly the four secret names. No Worker
   named `frihet-openai-mcp-openai` exists in the account.
3. `scripts/check-openai-worker-topology.mjs --require-compatible` passes
   against the captured deployment and version documents with the expected
   source SHA and version.
4. `npm run check:openai-public-surface` passes. `/mcp` without a token answers
   401 with `resource_metadata` pointing at
   `/.well-known/oauth-protected-resource/mcp`, and that document answers 200
   with `resource` equal to `https://openai-mcp.frihet.io/mcp`. `/support` and
   `/privacy` answer 200, and `/openapi.json` answers 404.
5. MCP Inspector over Streamable HTTP at `https://openai-mcp.frihet.io/mcp`
   completes OAuth with the first reviewer workspace and lists 33 tools, 0
   resources and 0 prompts. `scripts/test-openai-full-compose.mjs` passes with
   that access token, read from a hidden prompt and never printed.
6. The same access token sent to `https://mcp.frihet.io/mcp` answers 401. A
   record ID from the second reviewer workspace is not readable with the first
   workspace's token.
7. Both directory connectors work: a custom connector in Claude at
   `https://openai-mcp.frihet.io/mcp` completes OAuth, lists the 33 tools and
   answers three example prompts, and the ChatGPT draft reconnects.

## Required bridge release

1. Recover and authenticate the exact source of the active production version,
   or independently prove byte-level and public-surface equivalence. If neither
   is possible, stop; do not infer a bridge from a package version string.
2. In a separate PR, build a compatibility bridge that preserves the explicitly
   reviewed live behavior while introducing the final target topology:
   migration `v2`, `MCP_OBJECT:FrihetMCP`,
   `OAUTH_STATE:OAuthStateStore`, the dedicated `OAUTH_KV` namespace, and the
   OpenAI Assets binding. Do not include the functional 33-tool surface switch
   unless that exact change is independently reviewed as part of the bridge.
3. Freeze the bridge commit, obtain exact-SHA review, and run all release,
   Worker, OAuth, descriptor, analytics, OpenAPI, and Wrangler dry-run gates.
4. Only with explicit production authority, deploy the one-time bridge. This
   topology bootstrap is irreversible through Wrangler lifecycle rollback.
5. Prove one Cloudflare deployment and version is active at 100% using scoped,
   authenticated account access. The evidence must bind the exact Cloudflare
   account ID, `frihet-openai-mcp` script, `openai` configuration environment,
   active deployment ID, active version ID, bridge source SHA and runtime
   version. Public `/health` must return non-null `releaseSha`,
   `releaseVersion`, and `releaseSource=wrangler-var` values matching that
   bridge. Verify OAuth and the approved unchanged surface, then mint a
   reviewer-workspace OAuth token without recording its value.
6. Use the repository topology gate to canonicalize the complete live resource
   set. It must contain exactly the reviewed compatibility date/flags, `fetch`
   handler, migration tag, DO namespaces, dedicated KV namespace, Assets
   binding, four public release/profile vars, and the four approved secret
   names—no additional bindings. Independently prove the configured route is
   only `openai-mcp.frihet.io/*`, Assets directory is `./public-openai`, and
   `run_worker_first` is exactly `/openapi.json`. Classic Worker-version detail
   exposes the live Assets binding but not the local Assets directory or
   `run_worker_first`; those two fields are therefore anchored to the exact
   source `wrangler.toml`/target-config digest, with the public 404 readback as
   the behavioral proof. Do not claim they were read back from the version API.
7. In a second exact-SHA-reviewed PR, set the baseline receipt to `established`.
   Store the account/zone/script/environment, exact route and subdomain policy,
   active deployment/version identity and timestamps/source/strategy, version
   creation/source/ETag metadata, bridge SHA/runtime version, canonical topology
   object and digest, exact target-config digest, public-health provenance
   projection, and UTC capture instant. This immutable anchor proves the
   independently reviewed bridge transition; it is not refreshed to pretend an
   old deployment is current. No secret values or raw Worker responses belong
   in it.
8. Before every functional release, re-read the live 100%-active deployment,
   exact version resource, account/zone, routes, subdomain policy and public
   health twice inside the already approved job. Seal each trusted snapshot
   start time before its first Cloudflare read and its completion time only
   after every read. The first-start-to-deploy window and each capture duration
   must remain within five minutes; version creation must not be in the future,
   and version creation, deployment creation, and observation must be logically
   ordered (allowing only bounded clock skew). Each JIT snapshot must match the
   established anchor's canonical topology and target-config digest, and equal
   the other snapshot byte-for-byte except for its two capture times. Any DO class/binding/namespace, KV namespace,
   Assets binding, vars, secret-name set, migration tag, account, zone, script,
   environment, route/subdomain, source/ETag provenance, deployment split,
   stale timestamp, or JIT mismatch is a stop.
9. Cloudflare exposes no deployment compare-and-swap primitive. Configure a
   unique 64-hex change-freeze ID in the protected release and rollback
   environments, pass the same ID at dispatch, and approve only while every
   other Cloudflare/portal mutation path is frozen. GitHub workflow concurrency
   excludes another copy of this workflow; it does not exclude direct Wrangler,
   API, dashboard, or unrelated-workflow changes. Missing or mismatched freeze
   attestation is a hard stop before mutation.

## Recovery boundary

After the baseline is established, functional releases may switch traffic only
among versions whose full resource topology independently equals the reviewed
anchor and whose exact identity/source/version/ETag/topology was captured in
this run's fresh JIT prestate; a matching recalculable digest alone is not
evidence.
Use only the non-interactive compatible-version recovery encoded in the
reviewed workflow, and verify 100% traffic, topology, health, OAuth 401, and
authenticated compose. Never claim recovery across the migration or
connected-resource boundary.

Automatic recovery is best effort. A GitHub force-cancel or runner failure can
prevent an `always()` job from starting. In that case, freeze all portal work,
inspect Cloudflare from an authenticated trusted workstation, and invoke the
private incident-recovery procedure using the exact reviewed workflow semantics.
Keep commands, credentials, tokens, and raw responses out of this public file;
retain only sanitized evidence and the independent review receipt.
