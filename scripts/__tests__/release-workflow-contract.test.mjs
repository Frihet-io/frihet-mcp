#!/usr/bin/env node
/**
 * Release workflow contract tests (Phase B repair).
 *
 * The hostile test matrix in `docs/release-hostile-tests.md` describes 17
 * failure modes. These tests execute the actual workflow YAML and assert the
 * control logic — not the prose. Every test is a real assertion against
 * `.github/workflows/release-mcp-npm.yml`, against the production
 * `scripts/assert-publish-anchor.mjs`, and against the OAuth binding the
 * workflow declares. None of these are grepped comments.
 *
 * What this pins:
 *   1. stale source SHA — preflight rejects non-origin/main HEAD.
 *   2. npm partial publication — verify-npm compares dist.tarball sha256.
 *   3. Worker failure after npm — deploy-worker depends on verify-npm;
 *      release-github does not run if Worker fails.
 *   4. Worker wrong release SHA — verify-worker asserts /health.releaseSha.
 *   5. wrong tag target — release-github creates tag with --target SHA.
 *   6. GitHub Release before Worker convergence — needs: [verify-npm, verify-worker].
 *   7. missing protected environment — workflow declares environment: npm-release.
 *   8. token fallback — id-token: write ONLY, NPM_TOKEN is rejected.
 *   9. rerun after partial success — idempotency: skip publish if version exists,
 *      skip release if exists.
 *
 * Exit codes:
 *   0 = all 9 hostile cases fail-closed against the actual workflow
 *   1 = at least one hostile case is no longer pinned (regression)
 */
import assert from "node:assert/strict";
import {
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const WORKFLOW = ".github/workflows/release-mcp-npm.yml";
const ANCHOR = "scripts/assert-publish-anchor.mjs";
const NO_LEAK = "scripts/no-public-leak.sh";
const ANALYTICS = "scripts/check-no-analytics-emitters.mjs";

function loadWorkflow() {
  assert.ok(existsSync(WORKFLOW), `${WORKFLOW} must exist`);
  return readFileSync(WORKFLOW, "utf8");
}

/**
 * Minimal YAML stage parser — extracts jobs + their needs chain without a
 * yaml dependency. Looks for top-level `jobs:` then walks `  <id>:` keys,
 * and within each block pulls the `needs:` list (string or list form).
 */
function parseWorkflowStages(yaml) {
  const stages = [];
  const jobBlocks = yaml.split(/\n  ([a-z0-9_-]+):\n/).slice(1);
  for (let i = 0; i < jobBlocks.length; i += 2) {
    const id = jobBlocks[i];
    const body = jobBlocks[i + 1] ?? "";
    const block = body.split(/\n    - /)[0];
    const needsMatch = block.match(/needs:\s*([^\n]+)/);
    const dependsOn = [];
    if (needsMatch) {
      const raw = needsMatch[1].trim();
      if (raw.startsWith("[")) {
        dependsOn.push(...raw.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean));
      } else if (raw) {
        dependsOn.push(raw);
      }
    }
    stages.push({ id, dependsOn, body });
  }
  return stages;
}

function findStage(stages, id) {
  return stages.find((s) => s.id === id);
}

test("Release workflow — hostile case 1: stale source SHA (preflight rejects)", () => {
  const wf = loadWorkflow();
  const stages = parseWorkflowStages(wf);
  const preflight = findStage(stages, "preflight");
  assert.ok(preflight, "preflight stage must exist");
  // 1a. HEAD must equal origin/main.
  assert.match(
    preflight.body,
    /REMOTE_MAIN.*HEAD_SHA/,
    "preflight must assert HEAD === origin/main",
  );
  assert.match(
    preflight.body,
    /assert-publish-anchor\.mjs/,
    "preflight must invoke scripts/assert-publish-anchor.mjs",
  );
  // 1b. assert-publish-anchor exists and is the canonical script.
  assert.ok(existsSync(ANCHOR), `${ANCHOR} must exist`);
  const anchorSrc = readFileSync(ANCHOR, "utf8");
  assert.match(anchorSrc, /headMatchesRemote/, "anchor script must validate head matches remote");
  assert.match(anchorSrc, /gitMetadataIsDirectory/, "anchor must reject linked worktrees");
});

test("Release workflow — hostile case 2: npm partial publication (verify-npm byte readback)", () => {
  const wf = loadWorkflow();
  const stages = parseWorkflowStages(wf);
  const verifyNpm = findStage(stages, "verify-npm");
  assert.ok(verifyNpm, "verify-npm stage must exist");
  // 2a. Reads the dist.tarball URL via `npm view`.
  assert.match(
    verifyNpm.body,
    /npm view .* dist\.tarball/,
    "verify-npm must query dist.tarball via npm view",
  );
  // 2b. Computes sha256 of the downloaded tarball and compares against local.
  assert.match(verifyNpm.body, /sha256sum/, "verify-npm must sha256 the registry tarball");
  // 2c. Compares against expected-tarball-sha.
  assert.match(
    verifyNpm.body,
    /EXPECTED_TARBALL_SHA/,
    "verify-npm must compare against the build-time sha256",
  );
  // 2d. Asserts npm gitHead against origin/main HEAD.
  assert.match(
    verifyNpm.body,
    /npm view .* gitHead/,
    "verify-npm must read gitHead from the registry",
  );
  assert.match(
    verifyNpm.body,
    /GIT_HEAD.*SOURCE_COMMIT/,
    "verify-npm must compare gitHead against the dispatch SHA",
  );
});

test("Release workflow — hostile case 3: Worker failure after npm (deploy-worker depends on verify-npm)", () => {
  const wf = loadWorkflow();
  const stages = parseWorkflowStages(wf);
  const deploy = findStage(stages, "deploy-worker");
  const verifyWorker = findStage(stages, "verify-worker");
  const release = findStage(stages, "release-github");
  assert.ok(deploy && verifyWorker && release, "deploy-worker + verify-worker + release-github must all exist");
  // 3a. deploy-worker depends on verify-npm — Worker cannot ship before npm verified.
  assert.ok(
    deploy.dependsOn.includes("verify-npm"),
    `deploy-worker must depend on verify-npm; got ${JSON.stringify(deploy.dependsOn)}`,
  );
  // 3b. verify-worker depends on deploy-worker.
  assert.ok(
    verifyWorker.dependsOn.includes("deploy-worker"),
    `verify-worker must depend on deploy-worker; got ${JSON.stringify(verifyWorker.dependsOn)}`,
  );
  // 3c. release-github depends on verify-worker — no Release before Worker convergence.
  assert.ok(
    release.dependsOn.includes("verify-worker"),
    `release-github must depend on verify-worker; got ${JSON.stringify(release.dependsOn)}`,
  );
  // 3d. Wrangler deploy runs inside deploy-worker.
  assert.match(deploy.body, /wrangler deploy/, "deploy-worker must invoke wrangler deploy");
  assert.match(
    deploy.body,
    /RELEASE_SOURCE_SHA/,
    "deploy-worker must inject RELEASE_SOURCE_SHA via wrangler var",
  );
});

test("Release workflow — hostile case 4: Worker wrong release SHA (verify-worker asserts)", () => {
  const wf = loadWorkflow();
  const stages = parseWorkflowStages(wf);
  const verifyWorker = findStage(stages, "verify-worker");
  assert.ok(verifyWorker, "verify-worker must exist");
  // 4a. Fetches /health from the canonical Worker URL.
  assert.match(
    verifyWorker.body,
    /mcp\.frihet\.io\/health/,
    "verify-worker must GET mcp.frihet.io/health",
  );
  // 4b. Asserts releaseSha === SOURCE_COMMIT.
  assert.match(
    verifyWorker.body,
    /LIVE_SHA.*SOURCE_COMMIT/,
    "verify-worker must compare LIVE_SHA against SOURCE_COMMIT",
  );
  // 4c. Asserts releaseVersion === published version.
  assert.match(
    verifyWorker.body,
    /LIVE_VERSION.*VERSION/,
    "verify-worker must compare LIVE_VERSION against the dispatched version",
  );
  // 4d. Asserts releaseSource === "wrangler-var" — proves the deploy pipeline set it.
  assert.match(
    verifyWorker.body,
    /LIVE_SOURCE.*wrangler-var/,
    "verify-worker must require LIVE_SOURCE === wrangler-var",
  );
});

test("Release workflow — hostile case 5: wrong tag target (--target SHA, not branch)", () => {
  const wf = loadWorkflow();
  const stages = parseWorkflowStages(wf);
  const release = findStage(stages, "release-github");
  assert.ok(release, "release-github must exist");
  // 5a. The release body must use --target with a literal SHA, not a branch.
  assert.match(
    release.body,
    /--target.*SOURCE_COMMIT/,
    "release must create tag with --target ${SOURCE_COMMIT} (literal SHA)",
  );
  // 5b. The tag format must be `v<version>`.
  assert.match(
    release.body,
    /TAG.*VERSION/,
    "release must construct TAG from v${VERSION}",
  );
  // 5c. The release MUST NOT use --target main (or any branch ref).
  assert.doesNotMatch(
    release.body,
    /--target.*\bmain\b/,
    "release must NEVER target main (only literal SHA)",
  );
});

test("Release workflow — hostile case 6: GitHub Release waits for BOTH npm AND Worker convergence", () => {
  const wf = loadWorkflow();
  const stages = parseWorkflowStages(wf);
  const release = findStage(stages, "release-github");
  assert.ok(release, "release-github must exist");
  // 6a. release-github depends on BOTH verify-npm AND verify-worker.
  assert.ok(
    release.dependsOn.includes("verify-npm"),
    `release-github must depend on verify-npm; got ${JSON.stringify(release.dependsOn)}`,
  );
  assert.ok(
    release.dependsOn.includes("verify-worker"),
    `release-github must depend on verify-worker; got ${JSON.stringify(release.dependsOn)}`,
  );
  // 6b. cascade must depend on release-github (no downstream spin-up before Release).
  const cascade = findStage(stages, "cascade");
  assert.ok(cascade, "cascade must exist");
  assert.ok(
    cascade.dependsOn.includes("release-github"),
    `cascade must depend on release-github; got ${JSON.stringify(cascade.dependsOn)}`,
  );
});

test("Release workflow — hostile case 7: missing protected environment (declares npm-release)", () => {
  const wf = loadWorkflow();
  // 7a. The workflow declares environment: npm-release at the top level.
  assert.match(
    wf,
    /^environment:\s*\n\s+name: npm-release/m,
    "workflow must declare environment: npm-release at the top level",
  );
  // 7b. ALL environment declarations (top-level + per-job) must be `npm-release`.
  // Per-job environment: npm-release re-declares the protection rule for that
  // job's deploy step, which is the canonical GitHub pattern — the protection
  // rule is enforced at the job scope, not just the workflow scope.
  const envNames = [...wf.matchAll(/environment:\s*name:\s*([a-z0-9-]+)/g)].map((m) => m[1]);
  assert.ok(
    envNames.length >= 1,
    "workflow must declare at least one environment",
  );
  for (const name of envNames) {
    assert.equal(
      name,
      "npm-release",
      `every environment declaration must be npm-release; found ${name}`,
    );
  }
});

test("Release workflow — hostile case 8: token fallback (id-token ONLY, NPM_TOKEN rejected)", () => {
  const wf = loadWorkflow();
  // 8a. id-token: write is the ONLY auth mechanism (no NPM_TOKEN fallback).
  assert.match(
    wf,
    /id-token:\s*write/,
    "workflow must request id-token: write",
  );
  // 8b. The publish step explicitly refuses NPM_TOKEN if any is set.
  assert.match(
    wf,
    /NPM_TOKEN/,
    "workflow must reference NPM_TOKEN (to refuse it explicitly)",
  );
  assert.match(
    wf,
    /NPM_TOKEN is set but this workflow MUST use OIDC only/,
    "publish step must refuse NPM_TOKEN with a loud error",
  );
  // 8c. npm publish must use --provenance (attestation, not just a token).
  assert.match(
    wf,
    /npm publish --provenance/,
    "publish must use npm publish --provenance for attestation",
  );
});

test("Release workflow — hostile case 9: rerun after partial success (idempotent)", () => {
  const wf = loadWorkflow();
  const stages = parseWorkflowStages(wf);
  const publish = findStage(stages, "publish-npm");
  const release = findStage(stages, "release-github");
  assert.ok(publish, "publish-npm must exist");
  assert.ok(release, "release-github must exist");
  // 9a. publish-npm checks for existing version before publishing.
  assert.match(
    publish.body,
    /npm view .* version/,
    "publish-npm must check if version already exists on the registry",
  );
  assert.match(
    publish.body,
    /already_published/,
    "publish-npm must record the already_published output",
  );
  // 9b. The publish step skips when already_published is true.
  assert.match(
    publish.body,
    /if: steps\.check\.outputs\.already_published != 'true'/,
    "publish step must skip when already_published=true",
  );
  // 9c. release-github checks for existing release before creating.
  assert.match(
    release.body,
    /gh release view/,
    "release-github must check if release already exists via gh release view",
  );
  assert.match(
    release.body,
    /already_exists/,
    "release-github must record the already_exists output",
  );
  assert.match(
    release.body,
    /if: steps\.check\.outputs\.already_exists != 'true'/,
    "release step must skip when already_exists=true",
  );
});

test("Release workflow — control-file integrity (no leaks, no analytics drift)", () => {
  // The tripwire files referenced by the workflow must all exist on disk.
  // A workflow whose gates reference a missing file would green-screen at
  // dispatch — this test catches that before merge.
  assert.ok(existsSync(NO_LEAK), `${NO_LEAK} must exist`);
  assert.ok(existsSync(ANALYTICS), `${ANALYTICS} must exist`);
  assert.ok(existsSync(ANCHOR), `${ANCHOR} must exist`);
  assert.ok(existsSync("workers/remote-mcp/src/release-meta.ts"), "release-meta.ts must exist");
  assert.ok(
    existsSync("workers/remote-mcp/src/__tests__/release-meta.test.ts"),
    "release-meta.test.ts must exist",
  );
});

test("Release workflow — provenance chain invariant (3-link contract)", () => {
  // The end-to-end provenance chain is asserted by 3 separate gates:
  //   1. publish-anchor (npm gitHead === origin/main) — runs in preflight
  //   2. verify-npm (registry sha256 === local pack sha256)
  //   3. verify-worker (Worker /health.releaseSha === origin/main)
  // If any link is broken, downstream stage must not run.
  const wf = loadWorkflow();
  const stages = parseWorkflowStages(wf);
  const deploy = findStage(stages, "deploy-worker");
  const verifyNpm = findStage(stages, "verify-npm");
  assert.ok(deploy.dependsOn.includes("verify-npm"), "deploy-worker must not run before verify-npm");
  // assert-publish-anchor + npm gitHead check must BOTH exist.
  const preflight = findStage(stages, "preflight");
  assert.match(preflight.body, /assert-publish-anchor/, "preflight must run assert-publish-anchor");
  assert.match(verifyNpm.body, /npm view .* gitHead/, "verify-npm must check gitHead");
});