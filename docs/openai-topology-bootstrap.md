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
