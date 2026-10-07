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
if `wrangler.toml` drifts from the reviewed target in the baseline file, but only
for canonical-format drift: the parse is regex-based, so non-canonical TOML can
slip past until a follow-up replaces it with Wrangler's own config reader. CI runs
`scripts/__tests__/release-workflow-contract.test.mjs`, which pins the job
wiring (ordering, no `if:`, no `continue-on-error`) and the checker's behavior.

## Scope of the guard

The guard covers the CI release path only. It runs in the `preflight` job (so
a pending baseline stops the release before any npm version is published) and
again in `deploy-worker`. `npm run deploy` in `workers/remote-mcp`, and direct
Wrangler, API or dashboard changes, are unguarded local paths: they would apply
migration `v2` without consulting the baseline. Wrangler is pointed explicitly
at `wrangler.toml` in CI so it cannot resolve a different config than the
checker reads.

## Who decides

The repository owner alone decides when to apply `v2`. Moving the status to
`established` is a separately reviewed change that records the live topology
captured after that first, owner-approved deployment. Neither the checker nor
the workflow performs the bootstrap deployment.
