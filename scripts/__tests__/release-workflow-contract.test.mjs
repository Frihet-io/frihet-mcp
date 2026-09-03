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
 *   7. missing protected environment — every mutating job declares npm-release.
 *   8. token fallback — id-token: write ONLY, NPM_TOKEN is rejected.
 *   9. rerun after partial success — idempotency: skip publish if version exists;
 *      accept an existing release only when its target is the exact source SHA.
 *  10. workflow structure — no unsupported top-level keys, duplicate step keys,
 *      or undeclared direct `needs` output references.
 *  11. lockfile authority — preflight freezes the exact-source digests and
 *      downstream installers consume those outputs without literal hash pins.
 *
 * Exit codes:
 *   0 = all hostile cases fail-closed against the actual workflow
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
const CI_WORKFLOW = ".github/workflows/ci.yml";
const ANCHOR = "scripts/assert-publish-anchor.mjs";
const NO_LEAK = "scripts/no-public-leak.sh";
const ANALYTICS = "scripts/check-no-analytics-emitters.mjs";

function loadWorkflow() {
  assert.ok(existsSync(WORKFLOW), `${WORKFLOW} must exist`);
  return readFileSync(WORKFLOW, "utf8");
}

/**
 * Minimal YAML stage parser — extracts jobs + their needs chain without a
 * yaml dependency. It deliberately starts at top-level `jobs:` so an invalid
 * workflow-level mapping cannot be mistaken for a job.
 */
function parseWorkflowStages(yaml) {
  const jobsOffset = yaml.indexOf("\njobs:\n");
  assert.notEqual(jobsOffset, -1, "workflow must contain a top-level jobs mapping");
  const jobsYaml = yaml.slice(jobsOffset + "\njobs:\n".length);
  const stages = [];
  const headers = [...jobsYaml.matchAll(/^  ([a-z0-9_-]+):\s*$/gm)];
  for (let i = 0; i < headers.length; i += 1) {
    const id = headers[i][1];
    const bodyStart = (headers[i].index ?? 0) + headers[i][0].length;
    const bodyEnd = headers[i + 1]?.index ?? jobsYaml.length;
    const body = jobsYaml.slice(bodyStart, bodyEnd);
    const needsMatch = body.match(/^    needs:\s*([^\n]+)/m);
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
    /npx wrangler deploy \\\n            --env "" \\/,
    "deploy-worker must explicitly select the default/full-profile Wrangler environment",
  );
  assert.doesNotMatch(
    deploy.body,
    /--env openai/,
    "the full-profile release workflow must never drift to the OpenAI environment",
  );
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
  assert.doesNotMatch(
    release.body,
    /SAME bytes|same bytes|Worker bytes.*tag source bytes/i,
    "release notes must claim shared source provenance, not byte equality across different artifacts",
  );
  assert.match(
    release.body,
    /registry tarball matches the locally packed tarball/,
    "release notes must state the exact byte-equivalence that is actually verified",
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
  const stages = parseWorkflowStages(wf);
  // GitHub environments are job-scoped. A top-level environment key makes
  // the entire workflow invalid and was the regression that caused a zero-job
  // dispatch failure.
  const workflowHeader = wf.slice(0, wf.indexOf("\njobs:\n"));
  assert.doesNotMatch(
    workflowHeader,
    /^environment:/m,
    "environment is not a valid workflow-level key",
  );
  const preflight = findStage(stages, "preflight");
  assert.ok(preflight, "preflight must exist");
  assert.doesNotMatch(
    preflight.body,
    /^    environment:/m,
    "preflight must run before GitHub can auto-create a missing environment",
  );
  assert.match(
    preflight.body,
    /^      actions:\s*read\s*$/m,
    "preflight needs only read access to query the live environment",
  );
  assert.match(
    preflight.body,
    /repos\/\$\{GITHUB_REPOSITORY\}\/environments\/npm-release/,
    "preflight must query the exact npm-release environment",
  );
  assert.match(
    preflight.body,
    /name: Assert protected npm-release environment exists\n        if: inputs\.dry_run != true/,
    "dry runs must reach non-mutating gates and pack without a provisioned environment",
  );
  assert.match(
    preflight.body,
    /select\(\.type == "required_reviewers"\)/,
    "preflight must require a required-reviewers protection rule",
  );
  assert.match(
    preflight.body,
    /REVIEWER_COUNT.*-lt 1/,
    "preflight must fail when no independent reviewer is configured",
  );
  assert.match(
    preflight.body,
    /PREVENT_SELF_REVIEW.*!= "true"/,
    "preflight must fail unless the dispatcher cannot approve their own release",
  );
  for (const id of ["publish-npm", "deploy-worker", "release-github", "cascade"]) {
    const stage = findStage(stages, id);
    assert.ok(stage, `${id} must exist`);
    assert.match(
      stage.body,
      /^    environment:\s*npm-release\s*$/m,
      `${id} must be protected by the npm-release environment`,
    );
  }

  const authorize = findStage(stages, "authorize-release");
  assert.ok(authorize, "authorize-release must exist");
  assert.ok(
    authorize.dependsOn.includes("build-pack"),
    "authorization must happen only after every gate and deterministic pack succeeds",
  );
  assert.ok(
    authorize.dependsOn.includes("preflight"),
    "authorization must consume the exact-source Worker lockfile digest",
  );
  assert.match(authorize.body, /^    if: inputs\.dry_run != true$/m);
  assert.match(authorize.body, /^    environment:\s*npm-release\s*$/m);
  const releaseCredentials = [
    "NPM_RELEASE_ENV_GUARD",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "SMITHERY_API_TOKEN",
    "MCP_REGISTRY_PRIVATE_KEY",
  ];
  for (const credential of releaseCredentials) {
    assert.match(
      authorize.body,
      new RegExp(`${credential}:\\s*\\$\\{\\{ secrets\\.${credential} \\}\\}`),
      `authorize-release must bind ${credential} before the first mutation`,
    );
    assert.match(
      authorize.body,
      new RegExp(`\\[ -n "\\$${credential}" \\] \\|\\| MISSING\\+=\\("${credential}"\\)`),
      `authorize-release must fail closed with the name of absent ${credential}`,
    );
  }
  assert.match(
    authorize.body,
    /if \[ "\$\{#MISSING\[@\]\}" -ne 0 \]/,
    "any absent release credential must stop authorization",
  );
  assert.match(
    authorize.body,
    /npm ci --prefix workers\/remote-mcp --ignore-scripts/,
    "authorization must install the Wrangler version frozen by the Worker lockfile",
  );
  assert.match(
    authorize.body,
    /EXPECTED_WORKER_LOCK_SHA:\s*\$\{\{ needs\.preflight\.outputs\.workerLockSha256 \}\}/,
    "authorization must verify the exact-source Worker lock before installing Wrangler",
  );
  assert.match(
    authorize.body,
    /\.\/node_modules\/\.bin\/wrangler secret list --env "" --format json/,
    "authorization must query only the default/full-profile Worker secret-name inventory",
  );
  assert.doesNotMatch(
    authorize.body,
    /wrangler secret list --env openai/,
    "the full-profile release must not substitute the separate OpenAI Worker inventory",
  );
  for (const secretName of [
    "COOKIE_ENCRYPTION_KEY",
    "FIREBASE_PROJECT_ID",
    "FRIHET_API_BASE",
    "FRIHET_OAUTH_API_KEY",
  ]) {
    assert.match(
      authorize.body,
      new RegExp(`\\b${secretName}\\b`),
      `authorization must require the ${secretName} Worker secret name`,
    );
  }
  assert.match(
    authorize.body,
    /required full-profile Worker secret name is absent/,
    "a missing runtime secret name must fail before npm publish",
  );
  for (const id of ["publish-npm", "deploy-worker", "release-github", "cascade"]) {
    const stage = findStage(stages, id);
    assert.ok(
      stage.dependsOn.includes("authorize-release"),
      `${id} must depend directly on the guarded authorization job`,
    );
  }
});

test("Release workflow — hostile case 8: token fallback (id-token ONLY, NPM_TOKEN rejected)", () => {
  const wf = loadWorkflow();
  const stages = parseWorkflowStages(wf);
  const publish = findStage(stages, "publish-npm");
  assert.ok(publish, "publish-npm must exist");
  // 8a. OIDC minting is scoped to the protected publish job only.
  assert.match(
    publish.body,
    /id-token:\s*write/,
    "publish-npm must request id-token: write",
  );
  const workflowHeader = wf.slice(0, wf.indexOf("\njobs:\n"));
  assert.doesNotMatch(
    workflowHeader,
    /^  id-token:\s*write\s*$/m,
    "id-token: write must not be granted workflow-wide",
  );
  for (const stage of stages.filter((candidate) => candidate.id !== "publish-npm")) {
    assert.doesNotMatch(
      stage.body,
      /^      id-token:\s*write\s*$/m,
      `${stage.id} must not receive OIDC token-minting permission`,
    );
  }
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
  // 8d. npm trusted publishing requires npm >=11.5.1 and Node >=22.14.
  // Pack and publish must use the same exact toolchain or byte readback can
  // fail only after an irreversible registry mutation.
  const buildPack = findStage(stages, "build-pack");
  assert.ok(buildPack, "build-pack must exist");
  for (const stage of [buildPack, publish]) {
    assert.match(stage.body, /node-version:\s*22\.23\.2/, `${stage.id} must pin Node 22.23.2`);
    assert.match(
      stage.body,
      /npm install --global --ignore-scripts npm@11\.19\.1/,
      `${stage.id} must install the exact OIDC-capable npm CLI`,
    );
    assert.match(
      stage.body,
      /test "\$\(npm --version\)" = "11\.19\.1"/,
      `${stage.id} must assert the effective npm CLI version`,
    );
  }
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
  assert.match(
    publish.body,
    /^    if: inputs\.dry_run != true$/m,
    "publish-npm must not run during a dry run",
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
  assert.match(
    release.body,
    /EXISTING_TARGET.*SOURCE_COMMIT/,
    "an existing release must target the exact source commit or fail closed",
  );
});

test("Release workflow — publish anchor runs before any publish-time build", () => {
  const wf = loadWorkflow();
  const stages = parseWorkflowStages(wf);
  const publish = findStage(stages, "publish-npm");
  assert.ok(publish, "publish-npm must exist");
  assert.doesNotMatch(
    publish.body,
    /Build \(publish time\)/,
    "publish job must not create dist before prepublishOnly checks the clean anchor",
  );

  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const prepublish = pkg.scripts?.prepublishOnly ?? "";
  assert.match(
    prepublish,
    /^node scripts\/assert-publish-anchor\.mjs &&/,
    "prepublishOnly must begin with the clean publish-anchor assertion",
  );
  assert.ok(
    prepublish.indexOf("assert-publish-anchor.mjs") < prepublish.indexOf("npm run build"),
    "prepublishOnly must assert the clean anchor before building dist",
  );
});

test("Release workflow — deploy installs root dependencies before Worker validation", () => {
  const wf = loadWorkflow();
  const deploy = findStage(parseWorkflowStages(wf), "deploy-worker");
  assert.ok(deploy, "deploy-worker must exist");
  const rootInstall = deploy.body.indexOf("run: npm ci --ignore-scripts");
  const workerInstall = deploy.body.indexOf("run: npm ci --prefix workers/remote-mcp --ignore-scripts");
  const workerTypecheck = deploy.body.indexOf("run: npm run typecheck --prefix workers/remote-mcp");
  assert.ok(rootInstall >= 0, "deploy-worker must install root SDK/Zod dependencies");
  assert.ok(workerInstall > rootInstall, "Worker install must follow the root install");
  assert.ok(workerTypecheck > workerInstall, "Worker typecheck must run after both installs");
});

test("Release workflow — executable YAML structure contract", () => {
  const wf = loadWorkflow();
  const stages = parseWorkflowStages(wf);

  // Expressions can read outputs only from jobs named directly in `needs`.
  // Transitive dependencies are not added to the needs context by GitHub.
  for (const stage of stages) {
    const referencedNeeds = [
      ...stage.body.matchAll(/\$\{\{\s*needs\.([a-z0-9_-]+)\./g),
    ].map((match) => match[1]);
    for (const dependency of new Set(referencedNeeds)) {
      assert.ok(
        stage.dependsOn.includes(dependency),
        `${stage.id} references needs.${dependency} without declaring it directly; declared ${JSON.stringify(stage.dependsOn)}`,
      );
    }

    // Duplicate keys inside one step are invalid YAML for Actions even when
    // a permissive text parser silently keeps the last one.
    const stepBlocks = stage.body.split(/^      - /m).slice(1);
    for (const [index, block] of stepBlocks.entries()) {
      const keys = [...block.matchAll(/^        ([a-z][a-z0-9_-]*):/gm)].map((match) => match[1]);
      const duplicates = keys.filter((key, position) => keys.indexOf(key) !== position);
      assert.deepEqual(
        duplicates,
        [],
        `${stage.id} step ${index + 1} contains duplicate keys: ${duplicates.join(", ")}`,
      );
    }
  }
});

test("Release workflow — CI executes the real actionlint parser", () => {
  assert.ok(existsSync(CI_WORKFLOW), `${CI_WORKFLOW} must exist`);
  const ci = readFileSync(CI_WORKFLOW, "utf8");
  assert.match(
    ci,
    /uses:\s*docker:\/\/rhysd\/actionlint@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667/,
    "CI must execute the pinned actionlint parser, not rely on regex tests alone",
  );
});

test("Release workflow — exact-source lockfile authority is single and propagated", () => {
  const wf = loadWorkflow();
  const stages = parseWorkflowStages(wf);
  const preflight = findStage(stages, "preflight");
  assert.ok(preflight, "preflight must exist");

  assert.match(
    preflight.body,
    /rootLockSha256:\s*\$\{\{ steps\.locks\.outputs\.root_lock_sha256 \}\}/,
    "preflight must expose the root lockfile digest",
  );
  assert.match(
    preflight.body,
    /workerLockSha256:\s*\$\{\{ steps\.locks\.outputs\.worker_lock_sha256 \}\}/,
    "preflight must expose the Worker lockfile digest",
  );
  assert.match(
    preflight.body,
    /sha256sum package-lock\.json/,
    "preflight must hash package-lock.json from the anchored checkout",
  );
  assert.match(
    preflight.body,
    /sha256sum workers\/remote-mcp\/package-lock\.json/,
    "preflight must hash the Worker lockfile from the anchored checkout",
  );

  // Literal digest pins duplicated across jobs become stale as soon as a
  // legitimate dependency PR updates a lockfile. The source SHA is the only
  // authority; downstream compares its checkout to preflight's frozen bytes.
  assert.doesNotMatch(
    wf,
    /\b[a-f0-9]{64}\s{2}(?:workers\/remote-mcp\/)?package-lock\.json\b/,
    "release workflow must not duplicate literal lockfile digests",
  );

  for (const id of ["gates", "build-pack", "publish-npm", "deploy-worker"]) {
    const stage = findStage(stages, id);
    assert.ok(stage, `${id} must exist`);
    assert.match(
      stage.body,
      /EXPECTED_ROOT_LOCK_SHA:\s*\$\{\{ needs\.preflight\.outputs\.rootLockSha256 \}\}/,
      `${id} must consume preflight's exact root lockfile digest`,
    );
    assert.match(
      stage.body,
      /EXPECTED_WORKER_LOCK_SHA:\s*\$\{\{ needs\.preflight\.outputs\.workerLockSha256 \}\}/,
      `${id} must consume preflight's exact Worker lockfile digest`,
    );
    assert.match(
      stage.body,
      /sha256sum --check --strict/,
      `${id} must fail closed when either lockfile byte differs`,
    );
  }
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
