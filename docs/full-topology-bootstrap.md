# Full-profile Worker topology bootstrap

Companion to [`openai-topology-bootstrap.md`](./openai-topology-bootstrap.md),
which explains why Cloudflare cannot roll a Worker back across a Durable Object
class lifecycle change. That reasoning applies unchanged to the full-profile
Worker (`mcp.frihet.io`); it is not repeated here.

## What is irreversible

`workers/remote-mcp/wrangler.toml` declares migration `v2`, which creates the
`OAuthStateStore` Durable Object class. The live full-profile Worker predates
`v2`. The first deployment of a build that contains `v2` applies it, and from
then on recovery is forward-only: a failure is fixed by deploying a newer
reviewed commit, never by returning to the previous version.

## Guard

`workers/remote-mcp/full-topology-baseline.json` is the reviewed target
topology plus a baseline status.

- `pending-bootstrap` (current): the `deploy-worker` job in
  `.github/workflows/release-mcp-npm.yml` stops before any Cloudflare call.
- `established`: the job additionally reads the 100%-active Cloudflare version
  just in time and refuses to deploy unless its full topology equals the
  recorded baseline, including the migration tag.

`scripts/check-full-worker-topology.mjs` implements both checks. It also fails
if `wrangler.toml` drifts from the reviewed target in the baseline file. The file
is parsed with the Worker-locked Wrangler's own offline reader
(`experimental_readRawConfig`, resolved only from `workers/remote-mcp/node_modules`),
so indented or quoted keys and commented table headers are read with Wrangler's own
TOML semantics (the reader runs on a copy of the file; which file Wrangler reads at
deploy time is pinned separately by `--config wrangler.toml` and a test that no
redirect config exists). If that Wrangler is not installed, or the invocation path
cannot be resolved, the gate blocks. Only the listed top-level keys and tables are
accepted; `[alias]`, `[observability]` and `[dev]` must equal the reviewed content
exactly (an alias redirects modules inside the production bundle).

`scripts/__tests__/release-workflow-contract.test.mjs` derives, from the workflow
text, every job that runs the checker or the contract test itself (`npm test`
included) and fails unless `npm ci --prefix workers/remote-mcp --ignore-scripts`
(same `if:`) precedes it in that job; in the release workflow a SHA-pinned
`setup-node` must precede the install too. Today the release jobs are `preflight`,
`gates` and `deploy-worker`; `ci.yml` and `deploy-openai-mcp.yml` pass the install-order check. The test also pins the job wiring (ordering, no `if:`, no
`continue-on-error`).

## Scope of the guard

The guard covers the CI release path only. It runs in the `preflight` job (so
a pending baseline stops the release before any npm version is published) and
again in `deploy-worker`. `npm run deploy` in `workers/remote-mcp`, and direct
Wrangler, API or dashboard changes, are unguarded local paths: they would apply
migration `v2` without consulting the baseline. Wrangler is pointed explicitly
at `wrangler.toml` in CI so it cannot resolve a different config than the
checker reads.

The same test runs a fail-closed lexical scan of every workflow, every script in
the root and `workers/*` manifests, and the repository scripts reachable from them:
any `wrangler` occurrence that is not read-only, a dry-run, `--env openai` or a
reviewed line is reported, as are unresolvable subcommands. It does not see a
command whose name is assembled at run time, code fetched from outside the
repository, or files under `__tests__`; review owns those.

## Who decides

The repository owner alone decides when to apply `v2`. Moving the status to
`established` is a separately reviewed change that records the live topology
captured after that first, owner-approved deployment. Neither the checker nor
the workflow performs the bootstrap deployment.
