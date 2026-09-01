# MCP Release Workflow — Hostile Test Matrix

The release workflow in `.github/workflows/release-mcp-npm.yml` is built
to fail closed on the exact divergence modes that historically caused
release-time bugs. This document is the test design — what each hostile
case proves, what stage catches it, and what the operator sees.

All cases below assume `version=1.18.0` (the just-released version) and
`SOURCE_COMMIT=<expected origin/main HEAD>`. Each case is reproducible
locally by patching the workflow OR by manipulating the inputs / branch /
commit state before dispatch.

---

## 1. Wrong order

### 1a. Worker deploys before npm publish

**Setup:** Force `deploy-worker.needs` to be `publish-npm` instead of `verify-npm`.

**Expected behaviour:** The dependency edge guarantees `verify-npm` (which
asserts registry bytes) succeeds before the Worker deploys. With the
wrong edge, the Worker can ship while the registry tarball is still
empty / corrupt. The release pipeline would green-light a Worker
referencing a non-existent registry version.

**Stage that catches:** `verify-worker` would echo a `releaseSha` whose
corresponding version is NOT on the registry — `npm view` exits non-zero
inside the verify loop, `verify-npm` would have failed first, and the
chain order would prevent `release-github` from running.

### 1b. GitHub Release runs before verify-worker

**Setup:** Drop `verify-worker` from `release-github.needs`.

**Expected behaviour:** A failed Worker health check (Worker crashed,
propagation delay, wrangler rollback) leaves the registry-published
tarball live but the Worker on the wire is stale. The GitHub Release
goes out citing both as `1.18.0`, but only one is real.

**Stage that catches:** `release-github` MUST keep `verify-worker` in
`needs:`. Any PR removing that edge is a release-provenance regression
and must not merge. The hostile case is the regression test.

### 1c. Cascade runs before Release

**Setup:** Drop `release-github` from `cascade.needs`.

**Expected behaviour:** Smithery + glama.json fan out to a version the
world has not yet been told exists via the canonical Release artifact.
Listings lead the tag.

**Stage that catches:** `cascade.if` is `success()`, so a missing
`release-github` step would still gate cascade on Release success — but
the explicit `needs:` makes the order non-derivable.

---

## 2. Stale SHA

### 2a. Dispatched from a non-main branch

**Setup:** Dispatch from `feat/foo` while main is two commits ahead.

**Expected behaviour:** `preflight` rejects — HEAD must be `refs/heads/main`,
AND `HEAD_SHA` must equal `git ls-remote origin refs/heads/main`. The
tag would otherwise point at a commit the world cannot verify.

**Stage that catches:** `preflight` step "Assert publish anchor". The
script (`scripts/assert-publish-anchor.mjs`) requires `headMatchesRemote`,
so a stale HEAD exits 1 with `HEAD <sha> is not the exact origin/main
release commit`.

### 2b. Dispatched from a commit that is not the version bump's commit

**Setup:** Bump version on commit A, merge A to main, then dispatch
`workflow_dispatch` from commit B (a later merge on main).

**Expected behaviour:** `preflight` requires `INPUT_VERSION == package.json#version`.
The package.json on commit B reads the version from commit A — they
match — so preflight passes. The tag points at B (the dispatch HEAD),
NOT A. Anyone running `git checkout v1.18.0` lands on B, where the
version is `1.18.0`, so this is actually the CORRECT tag — the version
bump is the SOURCE of truth, not a side-effect of the version bump's
commit.

**Stage that catches:** This is the hostile case that argues against
"tag the version bump's commit." The workflow correctly tags the dispatch
HEAD because that is where the version bump actually lives. Version
bumps MUST land on the same commit as the code they ship — that is the
invariant `release-engineering-workflow` enforces upstream, not at
dispatch time.

### 2c. Worker /health.releaseSha returns "unknown" (var not injected)

**Setup:** Run a regular `wrangler deploy` (no `--var RELEASE_SOURCE_SHA=...`).

**Expected behaviour:** `release-meta.ts` falls back to `releaseSha: "unknown"`.
`verify-worker` checks `LIVE_SOURCE == "wrangler-var"` and exits 1. The
GitHub Release is blocked.

**Stage that catches:** `verify-worker` "Fetch /health, assert releaseSha
+ version" — the `LIVE_SOURCE != wrangler-var` branch exits with a loud
error message and refuses to release.

---

## 3. Partial publish

### 3a. npm publish exits 0 but registry tarball differs from local pack

**Setup:** A future npm registry bug, a CDN cache issue, or a proxy
rewrite results in the registry tarball having different bytes than
what `npm pack` produced.

**Expected behaviour:** `verify-npm` downloads `dist.tarball`, sha256s it,
compares against the build evidence. Mismatch exits 1.

**Stage that catches:** `verify-npm` "Read tarball + fetch registry
tarball, compare sha256". The two-prong check is byte sha256 + file
manifest sha256 — the second catches a tampered tarball with the same
outer sha (would require a sha256 collision; defence-in-depth).

### 3b. npm publish succeeds but gitHead is absent

**Setup:** npm 10 on a linked worktree, or `gitHead` not stamped for any
reason.

**Expected behaviour:** The anchor chain is broken. `verify-npm` exits 1.

**Stage that catches:** `verify-npm` "Verify npm gitHead == origin/main
HEAD". Empty `gitHead` exits with the error message "The publish-anchor
chain is broken."

### 3c. First stage succeeds, second fails mid-pipeline

**Setup:** Force `verify-npm` to fail by patching the registry URL check.

**Expected behaviour:** `deploy-worker` never runs (depends on
`verify-npm`), `verify-worker` never runs, `release-github` never runs,
`cascade` never runs. The npm tarball is live but no Worker bump, no
Release, no cascade — partial state is contained and visible.

**Stage that catches:** Dependency graph. The next operator sees
`publish-npm` green and `verify-npm` red in the GitHub Actions UI and
knows to investigate before re-dispatching.

---

## 4. Worker failure after npm

### 4a. wrangler deploy exits non-zero

**Setup:** Wrangler auth misconfigured, or the Worker code has a syntax
error.

**Expected behaviour:** `deploy-worker` exits 1. `verify-worker` does not
run. `release-github` does not run. The npm tarball stays published but
unannounced.

**Stage that catches:** `deploy-worker` non-zero exit code → GitHub
Actions marks the job red → `release-github` (which depends on
`deploy-worker` via `verify-worker`) cannot run. Operator manually
investigates and either re-dispatches or runs a follow-up patch.

### 4b. Worker deploys but /health never converges

**Setup:** Cloudflare propagation delay longer than 6 × 10s retries.

**Expected behaviour:** `verify-worker` exits 1 with "Worker /health never
returned a body." The workflow does NOT silently pass.

**Stage that catches:** `verify-worker` "Fetch /health, assert releaseSha
+ version" — the for-loop retries 6 times, then exits 1 if empty.

### 4c. Worker /health returns 200 but releaseSha is from a previous release

**Setup:** A previously-deployed Worker that did NOT redeploy cleanly.
Cloudflare edge cache serving a stale build.

**Expected behaviour:** `verify-worker` asserts `LIVE_SHA == SOURCE_COMMIT`.
A stale build with an older SHA fails the assertion.

**Stage that catches:** `verify-worker` sha mismatch branch — exits 1
with both SHAs in the error message.

---

## 5. Wrong tag target

### 5a. Tag points at a metadata-only follow-up commit

**Setup:** A contributor bumps `package.json` in a `chore(release): prepare
1.18.0` commit, tags that commit as `v1.18.0`, but the code that ships
under 1.18.0 is on an earlier commit.

**Expected behaviour:** This workflow CANNOT publish from a commit that
does not contain the version bump. `preflight` requires
`INPUT_VERSION == package.json#version`. The tag is created with
`--target $SOURCE_COMMIT` (the dispatch HEAD, asserted to be
origin/main), and origin/main contains the bump by construction.

**Stage that catches:** `release-github` "Create GitHub Release (tag →
origin/main HEAD)". The `--target ${SOURCE_COMMIT}` is the literal
commit SHA, not a branch ref. There is no path for the tag to point at
a commit that does not contain `1.18.0`.

### 5b. Tag created on a branch that has been force-pushed

**Setup:** A force-push replaces the dispatch HEAD with a different
commit after the workflow runs.

**Expected behaviour:** Tag remains pointing at the literal SHA. The
SHA, not the branch, is the canonical anchor. A subsequent
force-push would orphan the tag (no longer reachable from any branch),
but `git checkout v1.18.0` would still resolve to the original commit.

**Stage that catches:** The tag creation uses `--target` (exact SHA),
not a branch ref. Branch protection rules on `main` should prevent
force-pushes there; if they don't, the tag's SHA is still safe.

---

## 6. Missing environment protection

### 6a. `npm-release` environment does not exist

**Setup:** Workflow dispatched without the environment ever being created.

**Expected behaviour:** GitHub Actions rejects the dispatch with a 404
on `environment: npm-release`. The workflow cannot start.

**Stage that catches:** GitHub's own `environment:` validation. The
mission explicitly does NOT create this environment — that is a GitHub
UI action for Viktor with required reviewers + a deployment branch
rule.

### 6b. Environment exists but no required reviewers

**Setup:** Environment created without `required reviewers` configured.

**Expected behaviour:** Anyone with `workflow_dispatch` permission can
trigger the workflow. The environment protection rule is what makes
release a two-key event. Without it, the workflow still runs — but
Viktor's standing order is that production releases are reviewed before
dispatch.

**Stage that catches:** This is the policy gap, not a CI gate. The
mission's no-publish posture means we do not exercise this case; the
hostile case is the operator's standing order, not a code path.

### 6c. Environment protection bypassed via direct push

**Setup:** A contributor pushes a commit that modifies the workflow file
directly on main, bypassing the review gate.

**Expected behaviour:** The push hits the branch protection rule for
main (which is separate from the environment protection rule).
Branch protection blocks direct pushes to main.

**Stage that catches:** Branch protection on `main` (separate GitHub UI
configuration). The mission does not modify this — it is repo-owner
configuration.

---

## Test-runnability matrix

| Hostile case      | Local repro      | CI repro          | Post-merge repro |
|-------------------|------------------|-------------------|------------------|
| 1a wrong order    | edit workflow    | patch `needs:`    | n/a              |
| 1b release first | edit workflow    | patch `needs:`    | n/a              |
| 1c cascade first | edit workflow    | patch `needs:`    | n/a              |
| 2a stale branch   | dispatch off main| n/a               | n/a              |
| 2b commit B bump  | git-checkout B   | dispatch from B   | n/a              |
| 2c worker unknown | manual wrangler  | manual deploy     | n/a              |
| 3a bytes differ   | mirror rewrite   | n/a               | n/a              |
| 3b no gitHead     | linked worktree  | publish from wt   | n/a              |
| 3c partial        | force-fail stage | patch a step      | n/a              |
| 4a deploy fail    | bad wrangler     | n/a               | n/a              |
| 4b no converge    | kill Worker      | n/a               | n/a              |
| 4c stale health   | revert+redeploy  | n/a               | n/a              |
| 5a wrong tag      | separate bump    | merge bump+code   | n/a              |
| 5b force-push     | git push -f      | n/a               | n/a              |
| 6a no env         | delete env       | dispatch          | n/a              |
| 6b no reviewers   | unset rule       | dispatch          | n/a              |
| 6c direct push    | push main        | n/a               | n/a              |

All cases are reproducible by hand; none run in CI by design. The
workflow's fail-closed semantics make them impossible to "accidentally"
trigger via normal use — the hostile case is the failure mode that
arises from a misconfigured environment or a malicious PR.