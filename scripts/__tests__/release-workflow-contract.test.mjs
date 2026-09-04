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
import { createHash } from "node:crypto";
import {
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  cloudflareTopology,
  createJitPrestate,
  deriveOpenAITargetTopology,
  topologyFingerprint,
  validateCompatibleVersion,
  validateConfigAgainstContract,
  validateEstablishedBaseline,
  validateJitPrestates,
  validateRecoveryTarget,
} from "../check-openai-worker-topology.mjs";

const WORKFLOW = ".github/workflows/release-mcp-npm.yml";
const OPENAI_WORKFLOW = ".github/workflows/deploy-openai-mcp.yml";
const OPENAI_GUIDE = "docs/openai-resubmission-guide.md";
const OPENAI_BOOTSTRAP_GUIDE = "docs/openai-topology-bootstrap.md";
const OPENAI_COMPOSE = "scripts/test-openai-full-compose.mjs";
const OPENAI_TOPOLOGY = "marketplace/openai/cloudflare-topology-baseline.json";
const OPENAI_WRANGLER = "workers/remote-mcp/wrangler.toml";
const FULL_OAUTH_RELEASE_CONTRACT = "workers/remote-mcp/full-oauth-release-contract.json";
const CI_WORKFLOW = ".github/workflows/ci.yml";
const ANCHOR = "scripts/assert-publish-anchor.mjs";
const NO_LEAK = "scripts/no-public-leak.sh";
const ANALYTICS = "scripts/check-no-analytics-emitters.mjs";

const REVIEWED_ACTIONS = new Set([
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  "actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b",
]);

function loadWorkflow() {
  assert.ok(existsSync(WORKFLOW), `${WORKFLOW} must exist`);
  return readFileSync(WORKFLOW, "utf8");
}

function loadOpenAIWorkflow() {
  assert.ok(existsSync(OPENAI_WORKFLOW), `${OPENAI_WORKFLOW} must exist`);
  return readFileSync(OPENAI_WORKFLOW, "utf8");
}

function loadOpenAIGuide() {
  assert.ok(existsSync(OPENAI_GUIDE), `${OPENAI_GUIDE} must exist`);
  return readFileSync(OPENAI_GUIDE, "utf8");
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

function transitivelyDependsOn(stages, startId, targetId, seen = new Set()) {
  if (startId === targetId) return true;
  if (seen.has(startId)) return false;
  seen.add(startId);
  const stage = findStage(stages, startId);
  return Boolean(stage?.dependsOn.some(
    (dependency) => transitivelyDependsOn(stages, dependency, targetId, new Set(seen)),
  ));
}

function executableStageBody(stage) {
  return stage.body
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

function validateOpenAIWorkflowSupplyChain(yaml) {
  const errors = [];
  const actionReferences = [...yaml.matchAll(/^\s+uses:\s*([^\s#]+)/gm)]
    .map((match) => match[1]);
  if (actionReferences.length === 0) errors.push("no-action-references");
  for (const reference of actionReferences) {
    if (!/^[^@\s]+@[0-9a-f]{40}$/.test(reference)) {
      errors.push(`mutable-action-reference:${reference}`);
    } else if (!REVIEWED_ACTIONS.has(reference)) {
      errors.push(`unreviewed-action-reference:${reference}`);
    }
  }
  for (const stage of parseWorkflowStages(yaml)) {
    if (!/^    runs-on: ubuntu-24\.04$/m.test(stage.body)) {
      errors.push(`floating-runner:${stage.id}`);
    }
  }
  const nodeVersions = [...yaml.matchAll(/^\s+node-version:\s*([^\s#]+)/gm)]
    .map((match) => match[1]);
  if (nodeVersions.length === 0 || nodeVersions.some((version) => version !== "22.22.2")) {
    errors.push("floating-node-toolchain");
  }
  return errors;
}

function validatePinnedActionReferences(yaml) {
  const references = [...yaml.matchAll(/^\s+uses:\s*([^\s#]+)/gm)]
    .map((match) => match[1]);
  const errors = [];
  if (references.length === 0) errors.push("no-action-references");
  for (const reference of references) {
    if (!/^[^@\s]+@[0-9a-f]{40}$/.test(reference)) {
      errors.push(`mutable-action-reference:${reference}`);
    } else if (!REVIEWED_ACTIONS.has(reference)) {
      errors.push(`unreviewed-action-reference:${reference}`);
    }
  }
  return errors;
}

function validateFullOAuthReleaseHold(yaml, contract) {
  const stages = parseWorkflowStages(yaml);
  const preflight = findStage(stages, "preflight");
  const errors = [];
  if (!preflight) return ["missing-preflight"];
  const body = executableStageBody(preflight);
  const guardOffset = body.indexOf("Fail closed while Full OAuth lacks a separate reviewed authority");
  const protectedEnvironmentOffset = body.indexOf("Assert protected npm-release environment exists");
  if (guardOffset < 0 || protectedEnvironmentOffset < 0 || guardOffset > protectedEnvironmentOffset) {
    errors.push("full-hold-not-first-pre-mutation-authority");
  }
  const holdBody = guardOffset >= 0 && protectedEnvironmentOffset > guardOffset
    ? body.slice(guardOffset, protectedEnvironmentOffset)
    : "";
  if (!holdBody.includes("if: inputs.dry_run != true")) errors.push("full-hold-breaks-dry-run-or-is-unconditional");
  if (/continue-on-error:|\|\|\s*true/.test(holdBody)) errors.push("full-hold-error-can-be-ignored");
  if (!holdBody.includes(`CONTRACT=${FULL_OAUTH_RELEASE_CONTRACT}`)) errors.push("full-hold-contract-not-source-derived");
  if (!holdBody.includes('.status == "ready"') || contract.status !== "hold") {
    errors.push("full-hold-status-not-explicit");
  }
  for (const exact of [
    '.accessProfile == "full"',
    '.oauthResource == "https://mcp.frihet.io"',
    '.credentialName != "FRIHET_OAUTH_API_KEY"',
    '.sharedOpenAiCredentialAllowed == false',
    'FULL_OAUTH_LIFECYCLE_HOLD',
    "exit 1",
  ]) {
    if (!holdBody.includes(exact)) errors.push(`full-hold-missing:${exact}`);
  }
  if (
    contract.schemaVersion !== 1
    || contract.status !== "hold"
    || contract.reason !== "separate-full-oauth-authority-not-implemented"
    || contract.accessProfile !== "full"
    || contract.oauthResource !== "https://mcp.frihet.io"
    || contract.authorityUrl !== null
    || contract.credentialName !== null
    || contract.sharedOpenAiCredentialAllowed !== false
  ) errors.push("full-hold-contract-current-state-not-fail-closed");
  return errors;
}

function validateOpenAIComposeTransport(source) {
  const errors = [];
  if ([...source.matchAll(/\bfetch\(/g)].length !== 1) errors.push("unwrapped-fetch");
  if (!/const MAX_RESPONSE_BYTES = 1_048_576;/.test(source)) errors.push("response-cap-not-fixed");
  if (!/signal: AbortSignal\.timeout\(FETCH_TIMEOUT_MS\)/.test(source)) errors.push("fetch-timeout-missing");
  if (!/response\.body\.getReader\(\)/.test(source)) errors.push("bounded-reader-missing");
  if (!/bytesRead > MAX_RESPONSE_BYTES/.test(source)) errors.push("stream-cap-not-enforced");
  if (!/parsedLength > MAX_RESPONSE_BYTES/.test(source)) errors.push("content-length-cap-not-enforced");
  if (!/!allowedContentTypes\.includes\(contentType\)/.test(source)) errors.push("content-type-not-enforced");
  if (/response\.(?:text|json)\(\)/.test(source)) errors.push("unbounded-body-reader");
  return errors;
}

function stageEnvValue(stage, name) {
  const match = executableStageBody(stage).match(
    new RegExp(`^\\s+${name}:\\s*([^\\s#]+)\\s*$`, "m"),
  );
  return match?.[1];
}

function validateOpenAIReleaseSemantics(yaml) {
  const stages = parseWorkflowStages(yaml);
  const byId = Object.fromEntries(stages.map((stage) => [stage.id, stage]));
  const errors = [];
  const required = [
    "preflight",
    "wrangler-dry-run",
    "capture-rollback-state",
    "deploy-openai",
    "verify-public",
    "rollback-openai",
  ];
  for (const id of required) {
    if (!byId[id]) errors.push(`missing:${id}`);
  }
  if (errors.length) return errors;

  const preflight = executableStageBody(byId.preflight);
  const dryRun = executableStageBody(byId["wrangler-dry-run"]);
  const capture = executableStageBody(byId["capture-rollback-state"]);
  const deploy = executableStageBody(byId["deploy-openai"]);
  const publicVerify = executableStageBody(byId["verify-public"]);
  const rollback = executableStageBody(byId["rollback-openai"]);

  if (
    !preflight.includes("github.workflow_ref")
    || !preflight.includes("github.workflow_sha")
    || !preflight.includes("EXPECTED_WORKFLOW_REF")
    || !preflight.includes('WORKFLOW_SHA" != "$INPUT_SOURCE_SHA')
  ) errors.push("current-workflow-authority-not-proven");
  if (
    !/^      owner_confirmation:\s*$/m.test(yaml)
    || !preflight.includes("github.actor")
    || !preflight.includes("github.triggering_actor")
    || !preflight.includes('if [ "$ACTOR" != "berthelius" ]')
    || !preflight.includes('|| [ "$TRIGGERING_ACTOR" != "berthelius" ]; then')
    || !preflight.includes('EXPECTED_OWNER_CONFIRMATION="CONFIRM_OPENAI_DEPLOY_${INPUT_SOURCE_SHA}_berthelius"')
    || !preflight.includes('DRY_RUN" != "true"')
    || !preflight.includes('OWNER_CONFIRMATION" != "$EXPECTED_OWNER_CONFIRMATION')
  ) errors.push("owner-action-time-confirmation-not-source-bound");
  if (
    !preflight.includes("assert_owner_only_environment openai-plugin-release")
    || !preflight.includes("assert_owner_only_environment openai-plugin-rollback")
    || !preflight.includes(".can_admins_bypass == false")
    || !preflight.includes('.protection_rules | type == "array" and length == 0')
    || !preflight.includes(".deployment_branch_policy.protected_branches == false")
    || !preflight.includes(".deployment_branch_policy.custom_branch_policies == true")
    || /required_reviewers|prevent_self_review/.test(preflight)
  ) errors.push("owner-only-environment-governance-not-enforced");
  if (
    !/^      checks: read$/m.test(byId.preflight.body)
    || !preflight.includes("/check-runs?per_page=100")
    || !preflight.includes('and .conclusion == "success"')
    || !preflight.includes('and .app.slug == "github-actions"')
    || !preflight.includes("Build · Test · Drift audit")
  ) errors.push("exact-current-source-ci-not-proven");
  for (const output of [
    "workflowSha256",
    "configSha256",
    "profileSha256",
    "assetsManifestSha256",
  ]) {
    if (!byId.preflight.body.includes(`${output}:`)) errors.push(`missing-authority-output:${output}`);
  }
  if (
    /refs\/tags|gh release view|npm view|https:\/\/mcp\.frihet\.io\/health/.test(preflight)
    || /^      version:\s*$/m.test(yaml)
  ) errors.push("openai-release-still-coupled-to-full-or-npm");
  if (
    /https:\/\/mcp\.frihet\.io(?:\/|\s|$)/.test(yaml)
    || [...yaml.matchAll(/wrangler deploy(?: --dry-run)? --env openai/g)].length !== 3
    || [...yaml.matchAll(/wrangler versions deploy[\s\S]{0,160}?--env openai/g)].length !== 1
  ) errors.push("openai-workflow-can-target-full-worker");
  if (
    !dryRun.includes("EXPECTED_WORKFLOW_SHA256")
    || !dryRun.includes("EXPECTED_CONFIG_SHA256")
    || !dryRun.includes("EXPECTED_PROFILE_SHA256")
    || !dryRun.includes("EXPECTED_ASSETS_MANIFEST_SHA256")
    || !dryRun.includes("EXPECTED_WRANGLER_FILES")
    || !dryRun.includes("sha256sum ./index.js")
    || !dryRun.includes('echo "bundle_manifest_sha256=$BUNDLE_MANIFEST_SHA256"')
    || !byId["wrangler-dry-run"].body.includes("bundleManifestSha256:")
  ) errors.push("dry-run-provenance-not-frozen");
  if (
    !deploy.includes("EXPECTED_BUNDLE_MANIFEST_SHA256")
    || !deploy.includes("JIT_BUNDLE_MANIFEST_SHA256")
    || !deploy.includes('JIT_BUNDLE_MANIFEST_SHA256" != "$EXPECTED_BUNDLE_MANIFEST_SHA256')
    || !deploy.includes("JIT OpenAI bundle differs from the reviewed dry-run bundle")
    || [...deploy.matchAll(/sha256sum \.\/index\.js/g)].length !== 2
    || [...deploy.matchAll(/WRANGLER_FILES/g)].length < 5
    || !deploy.includes("--outdir \"$DEPLOY_OUTDIR\"")
    || !deploy.includes('DEPLOYED_BUNDLE_MANIFEST_SHA256" != "$EXPECTED_BUNDLE_MANIFEST_SHA256')
  ) errors.push("deployed-bundle-not-equal-reviewed-bundle");
  if (
    !publicVerify.includes("authorityHashes")
    || !publicVerify.includes("WORKFLOW_SHA256")
    || !publicVerify.includes("BUNDLE_MANIFEST_SHA256")
    || !publicVerify.includes("/^[a-f0-9]{64}$/")
    || !publicVerify.includes("equal(reviewedProfile, expectedReviewedProfile)")
  ) errors.push("public-receipt-omits-authority-hashes");

  if (!byId["capture-rollback-state"].dependsOn.includes("wrangler-dry-run")) {
    errors.push("capture-before-dry-run");
  }
  if (!byId["deploy-openai"].dependsOn.includes("capture-rollback-state")) {
    errors.push("deploy-without-captured-state");
  }
  if (!byId["verify-public"].dependsOn.includes("deploy-openai")) {
    errors.push("public-verify-before-deploy");
  }
  if (byId["verify-authenticated"]) errors.push("post-deploy-human-gate-present");
  for (const dependency of ["capture-rollback-state", "deploy-openai", "verify-public"]) {
    if (!byId["rollback-openai"].dependsOn.includes(dependency)) {
      errors.push(`rollback-missing-dependency:${dependency}`);
    }
  }

  if (!capture.includes("wrangler deployments status")) {
    errors.push("active-version-not-captured");
  }
  if (!capture.includes("previous_version_id=$PREVIOUS_VERSION_ID")) {
    errors.push("prior-version-not-exported");
  }
  if (
    !capture.includes('wrangler versions view "$PREVIOUS_VERSION_ID"')
    || !capture.includes("check-openai-worker-topology.mjs")
    || !capture.includes("--require-established")
    || !capture.includes("workers/routes")
    || !capture.includes("/subdomain")
    || !capture.includes("wrangler whoami --json")
  ) {
    errors.push("active-topology-baseline-not-proven");
  }
  if (
    !capture.includes("OPENAI_CLOUDFLARE_CHANGE_FREEZE_ID")
    || !capture.includes('INPUT_CHANGE_FREEZE_ID" != "$OPENAI_CLOUDFLARE_CHANGE_FREEZE_ID')
  ) errors.push("automatic-recovery-freeze-not-preauthorized");
  if (!deploy.includes('echo "started=true" >> "$GITHUB_OUTPUT"')) {
    errors.push("mutation-boundary-not-exported");
  }
  const readinessOffset = deploy.indexOf("--readiness-only");
  const mutationOffset = deploy.indexOf('echo "started=true" >> "$GITHUB_OUTPUT"');
  const deployOffset = deploy.indexOf("wrangler deploy --env openai");
  const composeOffsets = [...deploy.matchAll(/test-openai-full-compose\.mjs/g)]
    .map((match) => match.index ?? -1);
  if (
    !deploy.includes("OPENAI_TOKEN_BASELINE_VERSION_ID")
    || !deploy.includes("OPENAI_TOKEN_TOPOLOGY_SHA256")
    || !deploy.includes("FRIHET_OAUTH_ACCESS_TOKEN")
    || readinessOffset < 0
    || mutationOffset < 0
    || readinessOffset > mutationOffset
  ) {
    errors.push("token-readiness-not-proven-before-mutation");
  }
  if (deployOffset < mutationOffset || composeOffsets.length !== 2 || composeOffsets[1] < deployOffset) {
    errors.push("authenticated-compose-not-immediate-post-deploy");
  }
  const cloudflareJitOffset = deploy.lastIndexOf("--require-established", deployOffset);
  const cloudflareStatusOffsets = [...deploy.slice(0, deployOffset).matchAll(/wrangler deployments status/g)]
    .map((match) => match.index ?? -1);
  const snapshotStartOffset = deploy.indexOf('--write-snapshot-start "$snapshot_started_at"');
  const firstSnapshotReadOffset = deploy.indexOf("wrangler whoami --json", snapshotStartOffset);
  const jitUnchangedOffsets = [...deploy.matchAll(/--require-jit-unchanged/g)]
    .map((match) => match.index ?? -1);
  const firstJitUnchangedOffset = jitUnchangedOffsets[0] ?? -1;
  const finalJitUnchangedOffset = jitUnchangedOffsets.at(-1) ?? -1;
  const finalRemoteMainOffset = deploy.indexOf("FINAL_REMOTE_MAIN=", finalJitUnchangedOffset);
  const jitOutputSerializationOffset = deploy.indexOf('} >> "$GITHUB_OUTPUT"', firstJitUnchangedOffset);
  const finalJitGuard = finalJitUnchangedOffset >= 0 && mutationOffset >= 0
    ? deploy.slice(finalJitUnchangedOffset, mutationOffset)
    : "";
  if (
    cloudflareJitOffset >= 0
    || cloudflareStatusOffsets.length < 1
    || cloudflareJitOffset > mutationOffset
    || !deploy.includes("capture_snapshot before")
    || !deploy.includes("capture_snapshot after")
    || jitUnchangedOffsets.length < 2
    || !deploy.includes('--jit-before "$STATE_DIR/before-jit.json"')
    || !deploy.includes('--jit-after "$STATE_DIR/after-jit.json"')
    || !deploy.includes('--write-jit-prestate "$jit"')
    || !deploy.includes('--snapshot-started-at-file "$snapshot_started_at"')
    || !deploy.includes("workers/routes")
    || !deploy.includes("/subdomain")
    || !deploy.includes('--account-id "$CLOUDFLARE_ACCOUNT_ID"')
    || !deploy.includes('test "$(sha256sum "$CONTRACT"')
  ) {
    errors.push("cloudflare-live-receipt-not-revalidated-jit");
  }
  if (
    snapshotStartOffset < 0
    || firstSnapshotReadOffset < snapshotStartOffset
    || finalJitUnchangedOffset <= firstJitUnchangedOffset
    || finalJitUnchangedOffset <= jitOutputSerializationOffset
    || finalJitUnchangedOffset > mutationOffset
    || !finalJitGuard.includes('--jit-before "$STATE_DIR/before-jit.json"')
    || !finalJitGuard.includes('--jit-after "$STATE_DIR/after-jit.json"')
  ) errors.push("jit-capture-budget-not-enforced");
  if (
    finalRemoteMainOffset <= finalJitUnchangedOffset
    || finalRemoteMainOffset > mutationOffset
    || !deploy.slice(finalRemoteMainOffset, mutationOffset).includes('FINAL_REMOTE_MAIN" != "$SOURCE_COMMIT')
    || !deploy.slice(finalRemoteMainOffset, mutationOffset).includes("EXPECTED_WORKFLOW_SHA256")
    || !deploy.slice(finalRemoteMainOffset, mutationOffset).includes("EXPECTED_CONFIG_SHA256")
    || !deploy.slice(finalRemoteMainOffset, mutationOffset).includes("EXPECTED_PROFILE_SHA256")
    || !deploy.slice(finalRemoteMainOffset, mutationOffset).includes("EXPECTED_ASSETS_MANIFEST_SHA256")
    || !deploy.slice(finalRemoteMainOffset, mutationOffset).includes("EXPECTED_BUNDLE_MANIFEST_SHA256")
  ) errors.push("final-source-and-authority-jit-missing");
  if (
    !deploy.includes("OPENAI_CLOUDFLARE_CHANGE_FREEZE_ID")
    || !deploy.includes('INPUT_CHANGE_FREEZE_ID" != "$OPENAI_CLOUDFLARE_CHANGE_FREEZE_ID')
    || !deploy.includes('[[ "$INPUT_CHANGE_FREEZE_ID" =~ ^[0-9a-f]{64}$ ]]')
  ) errors.push("exclusive-change-freeze-not-enforced");
  if (stageEnvValue(byId["verify-public"], "OPENAI_BASE") !== "https://openai-mcp.frihet.io") {
    errors.push("wrong-public-host");
  }
  if (
    stageEnvValue(byId["deploy-openai"], "FRIHET_MCP_ENDPOINT") !==
    "https://openai-mcp.frihet.io/mcp"
  ) {
    errors.push("wrong-authenticated-host");
  }
  if (!publicVerify.includes("tools_count === 33") || !publicVerify.includes("prompts_count === 0")) {
    errors.push("public-profile-not-proven");
  }
  if (!/^    environment: openai-plugin-rollback$/m.test(byId["rollback-openai"].body)) {
    errors.push("rollback-environment-missing");
  }
  if (
    !rollback.includes('wrangler versions deploy "$JIT_PREVIOUS_VERSION_ID@100%"')
    || !rollback.includes('--env openai --name "$WORKER_NAME" --yes')
    || !rollback.includes("--message")
    || rollback.includes("wrangler rollback")
  ) {
    errors.push("recovery-command-not-compatible-or-noninteractive");
  }
  if (
    !rollback.includes("needs.capture-rollback-state.result == 'success'")
    || !rollback.includes("needs.deploy-openai.outputs.mutationStarted == 'true'")
    || !rollback.includes("needs.deploy-openai.result != 'success'")
    || !rollback.includes("needs.verify-public.result != 'success'")
    || !rollback.includes("always()")
  ) {
    errors.push("post-mutation-failure-does-not-trigger-recovery");
  }
  if (
    !rollback.includes(".versions[0].version_id == $versionId")
    || !rollback.includes(".versions[0].percentage == 100")
    || !rollback.includes('CURRENT_HEALTH_SHA" = "$JIT_PREVIOUS_HEALTH_SHA256')
    || !rollback.includes("check-openai-worker-topology.mjs")
    || !rollback.includes("--require-recovery-target")
    || [...rollback.matchAll(/^\s*capture_network_surface\s*$/gmu)].length !== 2
  ) {
    errors.push("compatible-recovery-not-verified");
  }
  if (
    !rollback.includes('JIT_PREVIOUS_DEPLOYMENT_ID: ${{ needs.deploy-openai.outputs.jitPreviousDeploymentId }}')
    || !rollback.includes('JIT_PREVIOUS_VERSION_ID: ${{ needs.deploy-openai.outputs.jitPreviousVersionId }}')
    || !rollback.includes('JIT_PREVIOUS_SCRIPT_ETAG_SHA256: ${{ needs.deploy-openai.outputs.jitPreviousScriptEtagSha256 }}')
    || !rollback.includes('DEPLOYED_VERSION_ID: ${{ needs.deploy-openai.outputs.versionId }}')
    || !rollback.includes('--expected-script-etag-sha256 "$JIT_PREVIOUS_SCRIPT_ETAG_SHA256"')
    || !rollback.includes('--expected-topology-sha256 "$JIT_PREVIOUS_TOPOLOGY_SHA256"')
    || !rollback.includes('CURRENT_DEPLOYMENT_ID" != "$DEPLOYED_DEPLOYMENT_ID')
    || !rollback.includes('CURRENT_VERSION_ID" != "$DEPLOYED_VERSION_ID')
    || !rollback.includes('wrangler versions view "$JIT_PREVIOUS_VERSION_ID"')
    || rollback.indexOf("--require-recovery-target")
      > rollback.indexOf('wrangler versions deploy "$JIT_PREVIOUS_VERSION_ID@100%"')
  ) {
    errors.push("recovery-jit-or-external-deployment-guard-missing");
  }
  return errors;
}

function validatePortalHardStops(guide) {
  const errors = [];
  if (!guide.includes("same OpenAI organization and project")) errors.push("identity-project-stop-missing");
  if (!guide.includes("Apps Management / `api.apps.write`")) errors.push("apps-permission-stop-missing");
  if (!guide.includes("data residency is **Global**")) errors.push("global-residency-proof-missing");
  if (!guide.includes("does not permit MCP plugin submission from a project with EU data")) {
    errors.push("eu-mcp-submission-stop-missing");
  }
  if (!guide.includes("exact project and its Global data-residency setting")) {
    errors.push("residency-evidence-missing");
  }
  return errors;
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

test("OpenAI release workflow — current source and frozen OpenAI profile are independent authorities", () => {
  const wf = loadOpenAIWorkflow();
  const stages = parseWorkflowStages(wf);
  const preflight = findStage(stages, "preflight");
  assert.ok(preflight, "OpenAI preflight must exist");

  assert.match(wf, /^      source_sha:\s*$/m, "dispatch must require an exact source SHA input");
  assert.doesNotMatch(wf, /^      version:\s*$/m, "OpenAI dispatch must not accept npm/full version authority");
  assert.match(wf, /^        default: true\s*$/m, "dry_run must default safe/true");
  assert.match(
    preflight.body,
    /ref:\s*\$\{\{ inputs\.source_sha \}\}/,
    "preflight must check out the requested exact commit",
  );
  assert.match(preflight.body, /\^\[0-9a-f\]\{40\}\$/, "source_sha must be exact lowercase hex");
  assert.match(preflight.body, /DISPATCH_REF.*refs\/heads\/main/s, "dispatch must originate on main");
  assert.match(
    preflight.body,
    /REMOTE_MAIN.*INPUT_SOURCE_SHA/s,
    "checkout, dispatch, and current origin/main must all match source_sha",
  );
  assert.match(preflight.body, /require\('\.\/package\.json'\)\.version/);
  assert.match(preflight.body, /workers\/remote-mcp\/public-openai\/releases\.json/);
  assert.match(preflight.body, /reviewed_profile_version=\$PROFILE_VERSION/);
  assert.match(preflight.body, /\.surface == "openai-chatgpt"/);
  assert.match(preflight.body, /github\.workflow_ref/);
  assert.match(preflight.body, /github\.workflow_sha/);
  assert.match(preflight.body, /EXPECTED_WORKFLOW_REF/);
  assert.match(preflight.body, /check-runs\?per_page=100/);
  assert.match(preflight.body, /Build · Test · Drift audit/);
  assert.match(preflight.body, /\.app\.slug == "github-actions"/);
  for (const path of [
    ".github/workflows/deploy-openai-mcp.yml",
    "workers/remote-mcp/wrangler.toml",
    "workers/remote-mcp/public-openai/releases.json",
  ]) assert.ok(preflight.body.includes(path), `preflight must freeze ${path}`);
  for (const output of [
    "workflowSha256",
    "configSha256",
    "profileSha256",
    "assetsManifestSha256",
  ]) assert.ok(preflight.body.includes(`${output}:`), `preflight must expose ${output}`);
  assert.doesNotMatch(preflight.body, /refs\/tags|gh release view|npm view/);
  assert.doesNotMatch(preflight.body, /https:\/\/mcp\.frihet\.io\/health/);
});

test("Full release workflow — current OpenAI-only lifecycle source remains on explicit HOLD", () => {
  const workflow = loadWorkflow();
  const stages = parseWorkflowStages(workflow);
  assert.ok(existsSync(FULL_OAUTH_RELEASE_CONTRACT), `${FULL_OAUTH_RELEASE_CONTRACT} must exist`);
  const contract = JSON.parse(readFileSync(FULL_OAUTH_RELEASE_CONTRACT, "utf8"));
  assert.deepEqual(validateFullOAuthReleaseHold(workflow, contract), []);
  assert.match(
    findStage(stages, "gates").body,
    /node --test scripts\/__tests__\/release-workflow-contract\.test\.mjs/,
    "future Full readiness must change both the exact source contract and its hostile tests",
  );
  for (const mutatingStage of ["publish-npm", "deploy-worker", "release-github", "cascade"]) {
    assert.ok(
      transitivelyDependsOn(stages, mutatingStage, "preflight"),
      `${mutatingStage} must remain downstream of the source-derived Full HOLD`,
    );
  }

  const bypass = workflow.replace(
    '            echo "The live Full Worker remains untouched until a separate Full authority and credential are implemented, tested, and independently reviewed."\n            exit 1',
    '            echo "mutant continues past the Full HOLD"',
  );
  assert.ok(
    validateFullOAuthReleaseHold(bypass, contract).includes("full-hold-missing:exit 1"),
    "removing the current Full HOLD must fail",
  );
  const sharedCredential = workflow.replace(
    '.credentialName != "FRIHET_OAUTH_API_KEY"',
    '.credentialName == "FRIHET_OAUTH_API_KEY"',
  );
  assert.ok(
    validateFullOAuthReleaseHold(sharedCredential, contract)
      .includes('full-hold-missing:.credentialName != "FRIHET_OAUTH_API_KEY"'),
    "reusing the OpenAI lifecycle credential for Full must fail",
  );
  const unconditional = workflow.replace(
    "      - name: Fail closed while Full OAuth lacks a separate reviewed authority\n        if: inputs.dry_run != true",
    "      - name: Fail closed while Full OAuth lacks a separate reviewed authority",
  );
  assert.ok(
    validateFullOAuthReleaseHold(unconditional, contract)
      .includes("full-hold-breaks-dry-run-or-is-unconditional"),
    "dry-run must remain non-mutating and usable while Full is held",
  );
  const ignoredFailure = workflow.replace(
    "      - name: Fail closed while Full OAuth lacks a separate reviewed authority\n",
    "      - name: Fail closed while Full OAuth lacks a separate reviewed authority\n        continue-on-error: true\n",
  );
  assert.ok(
    validateFullOAuthReleaseHold(ignoredFailure, contract).includes("full-hold-error-can-be-ignored"),
    "Full HOLD failures must never be ignored",
  );
});

test("OpenAI release workflow — privileged runner and actions are immutable inputs", () => {
  const workflow = loadOpenAIWorkflow();
  const fullWorkflow = loadWorkflow();
  assert.deepEqual(validateOpenAIWorkflowSupplyChain(workflow), []);
  assert.deepEqual(validatePinnedActionReferences(fullWorkflow), []);
  assert.match(
    fullWorkflow,
    /actions\/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b # reviewed immutable commit/,
  );
  assert.doesNotMatch(fullWorkflow, /github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b # v7\.0\.1/);

  const mutableAction = workflow.replace(
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "actions/checkout@v4",
  );
  assert.ok(
    validateOpenAIWorkflowSupplyChain(mutableAction)
      .some((error) => error.startsWith("mutable-action-reference:")),
    "moving an external action back to a mutable tag must fail",
  );
  const unknownPin = workflow.replace(
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "actions/checkout@0000000000000000000000000000000000000000",
  );
  assert.ok(
    validateOpenAIWorkflowSupplyChain(unknownPin)
      .some((error) => error.startsWith("unreviewed-action-reference:")),
    "an arbitrary SHA40 action pin must still fail the reviewed allowlist",
  );
  const floatingRunner = workflow.replace("runs-on: ubuntu-24.04", "runs-on: ubuntu-latest");
  assert.ok(validateOpenAIWorkflowSupplyChain(floatingRunner).some((error) => error.startsWith("floating-runner:")));
  const floatingNode = workflow.replace("node-version: 22.22.2", "node-version: 22");
  assert.ok(validateOpenAIWorkflowSupplyChain(floatingNode).includes("floating-node-toolchain"));
});

test("OpenAI release workflow — truthful sole-owner governance and recovery fail closed", () => {
  const wf = loadOpenAIWorkflow();
  const stages = parseWorkflowStages(wf);
  const preflight = findStage(stages, "preflight");
  const capture = findStage(stages, "capture-rollback-state");
  const deploy = findStage(stages, "deploy-openai");
  const rollback = findStage(stages, "rollback-openai");
  assert.ok(preflight && capture && deploy && rollback);

  assert.match(
    preflight.body,
    /^    permissions:\n      actions: read\n      checks: read\n      contents: read$/m,
  );
  assert.doesNotMatch(preflight.body, /^    environment:/m);
  for (const environment of [
    "openai-plugin-release",
    "openai-plugin-rollback",
  ]) {
    assert.ok(preflight.body.includes(environment), `${environment} must be checked before mutation`);
  }
  assert.match(wf, /^      owner_confirmation:\s*$/m);
  assert.match(preflight.body, /github\.actor/);
  assert.match(preflight.body, /github\.triggering_actor/);
  assert.match(preflight.body, /ACTOR" != "berthelius"/);
  assert.match(preflight.body, /TRIGGERING_ACTOR" != "berthelius"/);
  assert.match(
    preflight.body,
    /EXPECTED_OWNER_CONFIRMATION="CONFIRM_OPENAI_DEPLOY_\$\{INPUT_SOURCE_SHA\}_berthelius"/,
  );
  assert.match(preflight.body, /OWNER_CONFIRMATION" != "\$EXPECTED_OWNER_CONFIRMATION/);
  assert.match(preflight.body, /\.can_admins_bypass == false/);
  assert.match(preflight.body, /\.protection_rules \| type == "array" and length == 0/);
  assert.match(preflight.body, /\.deployment_branch_policy\.protected_branches == false/);
  assert.match(preflight.body, /\.deployment_branch_policy\.custom_branch_policies == true/);
  assert.doesNotMatch(preflight.body, /required_reviewers|prevent_self_review/);
  assert.match(preflight.body, /branch_policies.*length == 1.*name == "main"/s);
  assert.ok(
    preflight.body.indexOf("EXPECTED_OWNER_CONFIRMATION")
      > preflight.body.indexOf('REMOTE_MAIN" != "$INPUT_SOURCE_SHA'),
    "action-time confirmation must bind only after current-main source authority is established",
  );

  assert.match(capture.body, /^    environment: openai-plugin-rollback$/m);
  assert.match(deploy.body, /^    environment: openai-plugin-release$/m);
  assert.match(rollback.body, /^    environment: openai-plugin-rollback$/m);
  for (const credential of [
    "OPENAI_RELEASE_ENV_GUARD",
    "OPENAI_CLOUDFLARE_CHANGE_FREEZE_ID",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
  ]) {
    assert.match(deploy.body, new RegExp(`secrets\\.${credential}`));
    assert.match(deploy.body, new RegExp(`MISSING\\+=\\(\"${credential}\"\\)`));
  }
  for (const readinessSecret of [
    "FRIHET_OAUTH_ACCESS_TOKEN",
    "OPENAI_TOKEN_BASELINE_VERSION_ID",
    "OPENAI_TOKEN_TOPOLOGY_SHA256",
  ]) {
    assert.match(deploy.body, new RegExp(`secrets\\.${readinessSecret}`));
    assert.match(deploy.body, new RegExp(`MISSING\\+=\\("${readinessSecret}"\\)`));
  }
  assert.match(capture.body, /OPENAI_ROLLBACK_ENV_GUARD/);
  assert.match(capture.body, /secrets\.OPENAI_CLOUDFLARE_CHANGE_FREEZE_ID/);
  assert.match(capture.body, /automatic recovery does not hold this run's exclusive-change freeze/);
  assert.match(rollback.body, /OPENAI_ROLLBACK_ENV_GUARD/);
  assert.match(wf, /^      change_freeze_id:\s*$/m);
  assert.match(deploy.body, /INPUT_CHANGE_FREEZE_ID.*OPENAI_CLOUDFLARE_CHANGE_FREEZE_ID/s);
  assert.match(deploy.body, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(rollback.body, /recovery lost the one-time Cloudflare exclusive-change freeze/);
  assert.equal(
    [...wf.matchAll(/jq -cS '\{status, version, releaseSha, releaseVersion, releaseSource\}'/g)].length,
    2,
    "preapproval and recovery must hash the same compact canonical health projection as JIT prestate",
  );
  assert.doesNotMatch(wf, /jq -S '\{status, version, releaseSha, releaseVersion, releaseSource\}'/);
  assert.doesNotMatch(wf, /openai-plugin-verify|OPENAI_VERIFY_ENV_GUARD|OPENAI_VERIFY_TOKEN_SOURCE_SHA/);
  assert.match(deploy.body, /wrangler whoami/);
  assert.match(
    deploy.body,
    /\.\/node_modules\/\.bin\/wrangler secret list\s+\\\s*\n\s*--env openai --name frihet-openai-mcp --format json/,
  );
  assert.match(deploy.body, /targetTopology\.secretNames/);
  const topology = JSON.parse(readFileSync(OPENAI_TOPOLOGY, "utf8"));
  assert.deepEqual(topology.targetTopology.secretNames, [
    "COOKIE_ENCRYPTION_KEY",
    "FIREBASE_PROJECT_ID",
    "FRIHET_API_BASE",
    "FRIHET_OAUTH_API_KEY",
  ]);
});

test("OpenAI release workflow — full gates and exact-source lockfiles precede deploy", () => {
  const wf = loadOpenAIWorkflow();
  const stages = parseWorkflowStages(wf);
  const preflight = findStage(stages, "preflight");
  const gates = findStage(stages, "gates");
  assert.ok(preflight && gates);

  assert.match(preflight.body, /rootLockSha256:.*steps\.locks\.outputs\.root_lock_sha256/);
  assert.match(preflight.body, /workerLockSha256:.*steps\.locks\.outputs\.worker_lock_sha256/);
  assert.doesNotMatch(
    wf,
    /\b[a-f0-9]{64}\s{2}(?:workers\/remote-mcp\/)?package-lock\.json\b/,
    "workflow must propagate exact-source hashes rather than duplicate literal pins",
  );
  for (const command of [
    "npm test",
    "npm run typecheck --prefix workers/remote-mcp",
    "npm test --prefix workers/remote-mcp",
    "npm run gate:openai-review-descriptor",
    "npm run gate:openai-submission",
    "npm run gate:public-capability-truth",
    "npm run gate:agent-onboarding",
    "npm run gate:analytics",
    "npm run gate:openapi-fresh",
  ]) {
    assert.ok(gates.body.includes(command), `OpenAI release gates must execute: ${command}`);
  }

  for (const id of [
    "gates",
    "wrangler-dry-run",
    "capture-rollback-state",
    "deploy-openai",
    "rollback-openai",
  ]) {
    const stage = findStage(stages, id);
    assert.ok(stage, `${id} must exist`);
    assert.match(stage.body, /needs\.preflight\.outputs\.rootLockSha256/);
    assert.match(stage.body, /needs\.preflight\.outputs\.workerLockSha256/);
    assert.match(stage.body, /sha256sum --check --strict/);
  }
});

test("OpenAI release workflow — dry-run proves the dedicated binding set", () => {
  const wf = loadOpenAIWorkflow();
  const stages = parseWorkflowStages(wf);
  const dryRun = findStage(stages, "wrangler-dry-run");
  assert.ok(dryRun);
  assert.ok(dryRun.dependsOn.includes("gates"));
  assert.match(
    dryRun.body,
    /\.\/node_modules\/\.bin\/wrangler deploy --dry-run --env openai/,
  );
  assert.match(dryRun.body, /FRIHET_OPENAI_MODE.*true/s);
  assert.match(dryRun.body, /FRIHET_TOOL_MODE.*full/s);
  assert.match(dryRun.body, /7df4e387eee243268669425594aae45e/);
  assert.match(dryRun.body, /MCP_OBJECT.*FrihetMCP/s);
  assert.match(dryRun.body, /OAUTH_STATE.*OAuthStateStore/s);
  assert.match(dryRun.body, /ASSETS/);
  assert.match(dryRun.body, /openai-bundle-files\.sha256/);
  assert.match(dryRun.body, /EXPECTED_WRANGLER_FILES/);
  assert.match(dryRun.body, /sha256sum \.\/index\.js/);
  assert.match(dryRun.body, /bundle_manifest_sha256=\$BUNDLE_MANIFEST_SHA256/);
  for (const hash of [
    "EXPECTED_WORKFLOW_SHA256",
    "EXPECTED_CONFIG_SHA256",
    "EXPECTED_PROFILE_SHA256",
    "EXPECTED_ASSETS_MANIFEST_SHA256",
  ]) assert.ok(dryRun.body.includes(hash), `dry-run must consume ${hash}`);
  assert.match(dryRun.body, /wrangler-openai-dry-run\.json/);
  assert.doesNotMatch(
    dryRun.body,
    /uses:\s*actions\/upload-artifact[^]*RAW_LOG/,
    "raw Wrangler output must never be uploaded",
  );
});

test("OpenAI release workflow — mutation and production readback are exact and bounded", () => {
  const wf = loadOpenAIWorkflow();
  const stages = parseWorkflowStages(wf);
  const deploy = findStage(stages, "deploy-openai");
  const verify = findStage(stages, "verify-public");
  assert.ok(deploy && verify);

  assert.match(deploy.body, /REMOTE_MAIN.*SOURCE_COMMIT/s);
  assert.equal(
    [...wf.matchAll(/--require-compatible\s+\\\s*\n\s*--active-deployment/g)].length,
    3,
    "every active compatible-version proof must bind deployment and version timestamps",
  );
  assert.match(deploy.body, /\.\/node_modules\/\.bin\/wrangler deploy --env openai/);
  assert.doesNotMatch(deploy.body, /wrangler deploy --env ""/);
  assert.doesNotMatch(deploy.body, /refs\/tags|gh release|npm view|mcp\.frihet\.io\/health/);
  assert.match(deploy.body, /RELEASE_SOURCE_SHA:\$\{SOURCE_COMMIT\}/);
  assert.match(deploy.body, /RELEASE_VERSION:\$\{VERSION\}/);
  assert.match(deploy.body, /--outdir "\$DEPLOY_OUTDIR"/);
  assert.match(deploy.body, /EXPECTED_BUNDLE_MANIFEST_SHA256/);
  assert.match(deploy.body, /JIT_BUNDLE_MANIFEST_SHA256/);
  assert.match(deploy.body, /JIT OpenAI bundle differs from the reviewed dry-run bundle/);
  assert.match(deploy.body, /deployed Wrangler bundle differs from the reviewed dry-run bundle/);
  for (const hash of [
    "EXPECTED_WORKFLOW_SHA256",
    "EXPECTED_CONFIG_SHA256",
    "EXPECTED_PROFILE_SHA256",
    "EXPECTED_ASSETS_MANIFEST_SHA256",
  ]) assert.ok(deploy.body.includes(hash), `deploy must JIT consume ${hash}`);

  for (const path of [
    "/health",
    "/releases.json",
    "/.well-known/mcp",
    "/mcp.json",
    "/.well-known/mcp.json",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    "/support",
    "/privacy",
    "/openapi.json",
    "/openapi.yaml",
    "/mcp",
  ]) {
    assert.ok(verify.body.includes(path), `production readback must cover ${path}`);
  }
  assert.match(verify.body, /attempt <= 18/);
  assert.match(verify.body, /current\.body\.version === version/);
  assert.match(verify.body, /equal\(reviewedProfile, expectedReviewedProfile\)/);
  assert.match(verify.body, /live reviewed-profile asset differs from the exact-source asset/);
  assert.match(verify.body, /reviewedProfile\.version === reviewedProfileVersion/);
  assert.match(verify.body, /sourceReleaseVersion: version/);
  assert.match(verify.body, /reviewedProfileVersion/);
  assert.match(verify.body, /authorityHashes/);
  assert.match(verify.body, /Object\.values\(authorityHashes\).*\^\[a-f0-9\]\{64\}\$/s);
  assert.match(verify.body, /tools_count === 33/);
  assert.match(verify.body, /discovery_meta_tools_count === 0/);
  assert.match(verify.body, /resources_count === 0/);
  assert.match(verify.body, /prompts_count === 0/);
  assert.match(verify.body, /frihet:workspace\.manage/);
  assert.match(verify.body, /for \(const method of \["GET", "HEAD"\]\)/);
  assert.match(verify.body, /challenge\.status === 401/);
  assert.match(verify.body, /node --input-type=module <<'NODE'/);
  assert.equal(
    [...deploy.body.matchAll(/test-openai-full-compose\.mjs/g)].length,
    2,
    "authenticated readiness and exact compose must run in the protected deploy job",
  );
  assert.match(deploy.body, /--readiness-only/);
  assert.match(deploy.body, /secrets\.FRIHET_OAUTH_ACCESS_TOKEN/);
  assert.match(deploy.body, /authenticated-compose\.json/);
  assert.doesNotMatch(deploy.body, /tee|authenticated-compose\.txt/);
  assert.ok(
    deploy.body.indexOf("--readiness-only") < deploy.body.indexOf('echo "started=true"'),
    "OAuth readiness must complete before mutation",
  );
  assert.ok(
    deploy.body.lastIndexOf("test-openai-full-compose.mjs")
      > deploy.body.indexOf("wrangler deploy --env openai"),
    "full authenticated compose must run immediately after deploy without another environment",
  );
  assert.match(verify.body, /openai-public-readback/);
});

test("OpenAI release workflow — semantic mutants cannot bypass topology recovery or token readiness", () => {
  const workflow = loadOpenAIWorkflow();
  assert.deepEqual(validateOpenAIReleaseSemantics(workflow), []);

  const staleWorkflowAuthority = workflow.replace(
    'if [ "$WORKFLOW_REF" != "$EXPECTED_WORKFLOW_REF" ] || [ "$WORKFLOW_SHA" != "$INPUT_SOURCE_SHA" ]; then',
    'if [ "$WORKFLOW_REF" != "$EXPECTED_WORKFLOW_REF" ]; then',
  );
  assert.ok(
    validateOpenAIReleaseSemantics(staleWorkflowAuthority).includes("current-workflow-authority-not-proven"),
    "dispatching an old workflow against a newer source must fail",
  );
  const differentActor = workflow.replace(
    'ACTOR" != "berthelius"',
    'ACTOR" != "someone-else"',
  );
  assert.ok(
    validateOpenAIReleaseSemantics(differentActor)
      .includes("owner-action-time-confirmation-not-source-bound"),
    "a dispatcher other than the verified sole owner must fail",
  );
  const genericOwnerConfirmation = workflow.replace(
    'EXPECTED_OWNER_CONFIRMATION="CONFIRM_OPENAI_DEPLOY_${INPUT_SOURCE_SHA}_berthelius"',
    'EXPECTED_OWNER_CONFIRMATION="CONFIRM_OPENAI_DEPLOY"',
  );
  assert.ok(
    validateOpenAIReleaseSemantics(genericOwnerConfirmation)
      .includes("owner-action-time-confirmation-not-source-bound"),
    "a generic confirmation must not authorize a different source",
  );
  const adminBypass = workflow.replace(
    ".can_admins_bypass == false",
    ".can_admins_bypass == true",
  );
  assert.ok(
    validateOpenAIReleaseSemantics(adminBypass)
      .includes("owner-only-environment-governance-not-enforced"),
    "administrators must not bypass the exact environment governance",
  );
  const humanGate = workflow.replace(
    '.protection_rules | type == "array" and length == 0',
    '.protection_rules | type == "array" and length > 0',
  );
  assert.ok(
    validateOpenAIReleaseSemantics(humanGate)
      .includes("owner-only-environment-governance-not-enforced"),
    "a fictional reviewer, wait timer, or custom gate must not enter the sole-owner ceremony",
  );
  const blockedRecovery = workflow.replace(
    "assert_owner_only_environment openai-plugin-rollback",
    "# mutant skips non-blocking recovery governance",
  );
  assert.ok(
    validateOpenAIReleaseSemantics(blockedRecovery)
      .includes("owner-only-environment-governance-not-enforced"),
    "automatic recovery must remain free of a blocking environment gate",
  );
  const missingChecksPermission = workflow.replace("      checks: read\n", "");
  assert.ok(
    validateOpenAIReleaseSemantics(missingChecksPermission).includes("exact-current-source-ci-not-proven"),
    "the Check Runs proof must have explicit least-privilege checks:read",
  );
  const wrongCiConclusion = workflow.replace(
    'and .conclusion == "success"',
    'and .conclusion != "success"',
  );
  assert.ok(
    validateOpenAIReleaseSemantics(wrongCiConclusion).includes("exact-current-source-ci-not-proven"),
    "a non-successful current-source CI check must never authorize release",
  );
  const missingBundleEquality = workflow.replace(
    'if [ "$DEPLOYED_BUNDLE_MANIFEST_SHA256" != "$EXPECTED_BUNDLE_MANIFEST_SHA256" ]; then',
    'if [ "$DEPLOYED_BUNDLE_MANIFEST_SHA256" = "$EXPECTED_BUNDLE_MANIFEST_SHA256" ]; then',
  );
  assert.ok(
    validateOpenAIReleaseSemantics(missingBundleEquality)
      .includes("deployed-bundle-not-equal-reviewed-bundle"),
    "deploy must compare its exact output bundle against the reviewed dry-run bundle",
  );
  const missingJitBundleEquality = workflow.replace(
    'if [ "$JIT_BUNDLE_MANIFEST_SHA256" != "$EXPECTED_BUNDLE_MANIFEST_SHA256" ]; then',
    'if [ "$JIT_BUNDLE_MANIFEST_SHA256" = "$EXPECTED_BUNDLE_MANIFEST_SHA256" ]; then',
  );
  assert.ok(
    validateOpenAIReleaseSemantics(missingJitBundleEquality)
      .includes("deployed-bundle-not-equal-reviewed-bundle"),
    "the protected job must compare its pre-mutation JIT bundle against the reviewed bundle",
  );
  const staleMainAtMutation = workflow.replace(
    '|| [ "$FINAL_REMOTE_MAIN" != "$SOURCE_COMMIT" ]; then',
    '|| [ "$FINAL_REMOTE_MAIN" = "$SOURCE_COMMIT" ]; then',
  );
  assert.ok(
    validateOpenAIReleaseSemantics(staleMainAtMutation)
      .includes("final-source-and-authority-jit-missing"),
    "origin/main must be re-read after JIT validation and immediately before mutation",
  );
  const npmCoupling = workflow.replace(
    "      source_sha:\n",
    "      version:\n        required: true\n        type: string\n      source_sha:\n",
  );
  assert.ok(
    validateOpenAIReleaseSemantics(npmCoupling).includes("openai-release-still-coupled-to-full-or-npm"),
    "OpenAI deploy must not regain a caller-supplied npm/full release dependency",
  );

  const wrongHost = workflow.replaceAll("https://openai-mcp.frihet.io", "https://mcp.frihet.io");
  assert.ok(
    validateOpenAIReleaseSemantics(wrongHost).some((error) => error.includes("wrong-")),
    "full-profile host mutant must fail",
  );

  const wrongRecoveryTarget = workflow.replace(
    'wrangler versions deploy "$JIT_PREVIOUS_VERSION_ID@100%"',
    'wrangler versions deploy "$VERSION_ID@100%"',
  );
  assert.ok(
    validateOpenAIReleaseSemantics(wrongRecoveryTarget)
      .includes("recovery-command-not-compatible-or-noninteractive"),
    "recovery-to-unproven-version mutant must fail",
  );

  const lifecycleRollback = workflow.replace(
    'wrangler versions deploy "$JIT_PREVIOUS_VERSION_ID@100%"',
    'wrangler rollback "$JIT_PREVIOUS_VERSION_ID"',
  );
  assert.ok(
    validateOpenAIReleaseSemantics(lifecycleRollback)
      .includes("recovery-command-not-compatible-or-noninteractive"),
    "lifecycle rollback mutant must fail",
  );

  const missingTopologyGate = workflow.replace(
    "node ../../scripts/check-openai-worker-topology.mjs \\\n            --require-established",
    "node ../../scripts/check-openai-worker-topology.mjs",
  );
  assert.ok(
    validateOpenAIReleaseSemantics(missingTopologyGate)
      .includes("active-topology-baseline-not-proven"),
    "removing the established-baseline check must fail",
  );

  const postMutationReadiness = workflow.replace(
    /(^      - name: Prove authenticated token works on compatible baseline[\s\S]*?)(?=^      - name: JIT revalidate exact live receipt)/m,
    "",
  );
  assert.ok(
    validateOpenAIReleaseSemantics(postMutationReadiness)
      .includes("token-readiness-not-proven-before-mutation"),
    "removing pre-mutation OAuth readiness must fail",
  );

  const stages = parseWorkflowStages(workflow);
  const captureStage = findStage(stages, "capture-rollback-state");
  const deployStage = findStage(stages, "deploy-openai");
  const rollbackStage = findStage(stages, "rollback-openai");
  assert.ok(captureStage && deployStage && rollbackStage);
  const missingJit = workflow.replace(
    deployStage.body,
    deployStage.body.replace("capture_snapshot after", "# removed second snapshot"),
  );
  assert.ok(
    validateOpenAIReleaseSemantics(missingJit)
      .includes("cloudflare-live-receipt-not-revalidated-jit"),
    "removing the in-job live receipt readback must fail",
  );
  const missingSnapshotStart = workflow.replace(
    '              --write-snapshot-start "$snapshot_started_at"',
    "              # removed trusted snapshot start marker",
  );
  assert.ok(
    validateOpenAIReleaseSemantics(missingSnapshotStart).includes("jit-capture-budget-not-enforced"),
    "sealing freshness only after provider reads must fail",
  );
  const finalJitGuard = `          node ../../scripts/check-openai-worker-topology.mjs \\
            --require-jit-unchanged \\
            --jit-before "$STATE_DIR/before-jit.json" \\
            --jit-after "$STATE_DIR/after-jit.json"`;
  const missingFinalFreshness = workflow.replace(finalJitGuard, "          # removed final two-snapshot freshness check");
  assert.ok(
    validateOpenAIReleaseSemantics(missingFinalFreshness).includes("jit-capture-budget-not-enforced"),
    "a runner pause between both JIT reads and deploy must fail closed",
  );
  const externalDeploymentBypass = workflow.replace(
    rollbackStage.body,
    rollbackStage.body.replace(
      'CURRENT_DEPLOYMENT_ID" != "$DEPLOYED_DEPLOYMENT_ID',
      'CURRENT_DEPLOYMENT_ID" = "$DEPLOYED_DEPLOYMENT_ID',
    ),
  );
  assert.ok(
    validateOpenAIReleaseSemantics(externalDeploymentBypass)
      .includes("recovery-jit-or-external-deployment-guard-missing"),
    "recovery must refuse a deployment created outside this run",
  );

  const freezeBypass = workflow.replace(
    deployStage.body,
    deployStage.body.replace(
      'INPUT_CHANGE_FREEZE_ID" != "$OPENAI_CLOUDFLARE_CHANGE_FREEZE_ID',
      'INPUT_CHANGE_FREEZE_ID" = "$OPENAI_CLOUDFLARE_CHANGE_FREEZE_ID',
    ),
  );
  assert.ok(
    validateOpenAIReleaseSemantics(freezeBypass).includes("exclusive-change-freeze-not-enforced"),
    "real deployment must hard-stop without the protected one-time exclusive-change attestation",
  );
  const rollbackFreezeUnavailable = workflow.replace(
    captureStage.body,
    captureStage.body.replace(
      'INPUT_CHANGE_FREEZE_ID" != "$OPENAI_CLOUDFLARE_CHANGE_FREEZE_ID',
      'INPUT_CHANGE_FREEZE_ID" = "$OPENAI_CLOUDFLARE_CHANGE_FREEZE_ID',
    ),
  );
  assert.ok(
    validateOpenAIReleaseSemantics(rollbackFreezeUnavailable)
      .includes("automatic-recovery-freeze-not-preauthorized"),
    "the rollback environment must prove it holds the same freeze before any deployment",
  );
  const staleTerminalNetworkReadback = workflow.replace(
    "          # Terminal proof must be a new authenticated network-surface read,\n" +
      "          # never the pre-recovery files reused under a new label.\n" +
      "          capture_network_surface\n",
    "          # mutant reuses the stale pre-recovery network files\n",
  );
  assert.ok(
    validateOpenAIReleaseSemantics(staleTerminalNetworkReadback).includes("compatible-recovery-not-verified"),
    "recovery must re-read account, zone, route, and subdomain after switching traffic",
  );
});

test("OpenAI topology contract — exact DO migration and dedicated KV drift fail closed", () => {
  const toml = readFileSync(OPENAI_WRANGLER, "utf8");
  const contract = JSON.parse(readFileSync(OPENAI_TOPOLOGY, "utf8"));
  assert.deepEqual(validateConfigAgainstContract(toml, contract), []);
  assert.deepEqual(deriveOpenAITargetTopology(toml), {
    environment: "openai",
    workerName: "frihet-openai-mcp",
    entrypoint: "src/index.ts",
    compatibilityDate: "2025-12-01",
    compatibilityFlags: ["nodejs_compat"],
    routes: [{ pattern: "openai-mcp.frihet.io/*", zoneName: "frihet.io" }],
    workersDev: false,
    previewUrls: false,
    migrations: [
      { tag: "v1", newSqliteClasses: ["FrihetMCP"] },
      { tag: "v2", newSqliteClasses: ["OAuthStateStore"] },
    ],
    migrationTag: "v2",
    migrationClasses: ["FrihetMCP", "OAuthStateStore"],
    durableObjectExports: [
      { className: "FrihetMCP", state: "created", storage: "sqlite" },
      { className: "OAuthStateStore", state: "created", storage: "sqlite" },
    ],
    durableObjects: [
      { binding: "MCP_OBJECT", className: "FrihetMCP" },
      { binding: "OAUTH_STATE", className: "OAuthStateStore" },
    ],
    kvNamespaces: [
      { binding: "OAUTH_KV", namespaceId: "7df4e387eee243268669425594aae45e" },
    ],
    assets: {
      binding: "ASSETS",
      directory: "./public-openai",
      runWorkerFirst: ["/openapi.json"],
    },
    vars: { FRIHET_OPENAI_MODE: "true", FRIHET_TOOL_MODE: "full" },
    configShapeIssues: [],
  });

  const sharedKvMutant = toml.replace(
    "7df4e387eee243268669425594aae45e",
    "9207b98598f849109139ad11f3b0ac51",
  );
  assert.ok(validateConfigAgainstContract(sharedKvMutant, contract).includes("TARGET_TOPOLOGY_DRIFT"));

  const missingDoMutant = toml.replaceAll(
    '  { name = "OAUTH_STATE", class_name = "OAuthStateStore" }',
    "",
  );
  assert.ok(validateConfigAgainstContract(missingDoMutant, contract).includes("TARGET_TOPOLOGY_DRIFT"));

  const staleMigrationMutant = toml.replace('tag = "v2"', 'tag = "v1-stale"');
  assert.ok(validateConfigAgainstContract(staleMigrationMutant, contract).includes("TARGET_TOPOLOGY_DRIFT"));

  for (const mutant of [
    toml.replace("openai-mcp.frihet.io/*", "mcp.frihet.io/*"),
    toml.replace('directory = "./public-openai"', 'directory = "./public"'),
    toml.replace('run_worker_first = ["/openapi.json"]', 'run_worker_first = ["/mcp"]'),
    toml.replace('FRIHET_OPENAI_MODE = "true"', 'FRIHET_OPENAI_MODE = "false"'),
    `${toml}\n[env.openai.services]\nbinding = "EXTRA"\nservice = "other"\n`,
    toml.replace(
      'run_worker_first = ["/openapi.json"]',
      'run_worker_first = ["/openapi.json"]\nhtml_handling = "none"',
    ),
    toml.replace('tag = "v2"', 'tag = "v2"\ndeleted_classes = ["LegacyStore"]'),
    toml.replaceAll(
      '{ name = "OAUTH_STATE", class_name = "OAuthStateStore" }',
      '{ name = "OAUTH_STATE", class_name = "OAuthStateStore", script_name = "other" }',
    ),
    toml.replace(
      '{ pattern = "openai-mcp.frihet.io/*", zone_name = "frihet.io" }',
      '{ pattern = "openai-mcp.frihet.io/*", zone_name = "frihet.io", custom_domain = "true" }',
    ),
  ]) {
    assert.ok(
      validateConfigAgainstContract(mutant, contract).includes("TARGET_TOPOLOGY_DRIFT"),
      "route, Assets directory/routing, and profile-var mutants must fail",
    );
  }
});

test("OpenAI topology contract — immutable anchor and JIT recovery authority fail closed", () => {
  const contract = JSON.parse(readFileSync(OPENAI_TOPOLOGY, "utf8"));
  const toml = readFileSync(OPENAI_WRANGLER, "utf8");
  const versionId = "11111111-1111-4111-8111-111111111111";
  const deploymentId = "44444444-4444-4444-8444-444444444444";
  const routeId = "d".repeat(32);
  const zoneId = "c".repeat(32);
  const sourceSha = "a".repeat(40);
  const sourceVersion = "1.18.0";
  const accountId = "b".repeat(32);
  const scriptEtag = "strong-worker-etag";
  const now = new Date("2026-09-03T13:00:00Z");
  const liveVersion = {
    id: versionId,
    number: 42,
    metadata: { created_on: "2026-09-03T11:58:00Z", source: "wrangler" },
    resources: {
      script: { etag: scriptEtag, handlers: ["fetch"] },
      script_runtime: {
        compatibility_date: "2025-12-01",
        compatibility_flags: ["nodejs_compat"],
        migration_tag: "v2",
        exports: {
          default: { type: "worker", state: "created" },
          FrihetMCP: { type: "durable-object", state: "created", storage: "sqlite" },
          OAuthStateStore: { type: "durable-object", state: "created", storage: "sqlite" },
        },
      },
      bindings: [
        { type: "durable_object_namespace", name: "MCP_OBJECT", class_name: "FrihetMCP",
          namespace_id: "2".repeat(32) },
        { type: "durable_object_namespace", name: "OAUTH_STATE", class_name: "OAuthStateStore",
          namespace_id: "3".repeat(32) },
        { type: "kv_namespace", name: "OAUTH_KV", namespace_id: "7df4e387eee243268669425594aae45e" },
        { type: "assets", name: "ASSETS" },
        { type: "plain_text", name: "FRIHET_OPENAI_MODE", text: "true" },
        { type: "plain_text", name: "FRIHET_TOOL_MODE", text: "full" },
        { type: "plain_text", name: "RELEASE_SOURCE_SHA", text: sourceSha },
        { type: "plain_text", name: "RELEASE_VERSION", text: sourceVersion },
        { type: "secret_text", name: "COOKIE_ENCRYPTION_KEY" },
        { type: "secret_text", name: "FIREBASE_PROJECT_ID" },
        { type: "secret_text", name: "FRIHET_API_BASE" },
        { type: "secret_text", name: "FRIHET_OAUTH_API_KEY" },
      ],
    },
  };
  const health = { status: "ok", version: sourceVersion, releaseSha: sourceSha,
    releaseVersion: sourceVersion, releaseSource: "wrangler-var" };
  const deploymentView = { id: deploymentId, created_on: "2026-09-03T12:00:00Z", source: "wrangler",
    strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }] };
  const identityView = { loggedIn: true, accounts: [{ id: accountId, name: "Frihet" }] };
  const zoneView = { id: zoneId, name: "frihet.io", status: "active", account: { id: accountId } };
  const routesView = [{ id: routeId, pattern: "openai-mcp.frihet.io/*", script: "frihet-openai-mcp" }];
  const subdomainView = { enabled: false, previews_enabled: false };
  const observations = { deploymentView, versionView: liveVersion, health, identityView, zoneView, routesView,
    subdomainView, accountId, workerName: "frihet-openai-mcp", environment: "openai", now };
  assert.deepEqual(validateEstablishedBaseline(contract, observations), ["BASELINE_NOT_ESTABLISHED"]);

  const established = structuredClone(contract);
  established.status = "established";
  established.baseline = {
    accountId,
    workerName: "frihet-openai-mcp",
    environment: "openai",
    zone: { id: zoneId, name: "frihet.io" },
    route: routesView[0],
    subdomain: { enabled: false, previewsEnabled: false },
    deployment: { id: deploymentId, createdOn: deploymentView.created_on, source: "wrangler",
      strategy: "percentage", versionId, percentage: 100 },
    version: { id: versionId, number: 42, createdOn: liveVersion.metadata.created_on,
      source: "wrangler", scriptEtag },
    source: { sha: sourceSha, version: sourceVersion, releaseSource: "wrangler-var" },
    targetConfigSha256: topologyFingerprint(deriveOpenAITargetTopology(toml)),
    topology: cloudflareTopology(liveVersion),
    topologySha256: topologyFingerprint(cloudflareTopology(liveVersion)),
    publicProvenance: health,
    capturedAt: "2026-09-03T12:00:01Z",
  };
  assert.deepEqual(validateEstablishedBaseline(established, observations), [],
    "the immutable reviewed anchor does not expire; only JIT prestate does");
  assert.deepEqual(validateEstablishedBaseline(established, {
    ...observations,
    now: new Date("2030-01-01T00:00:00Z"),
  }), [], "an old internally ordered anchor remains valid historical evidence");
  assert.deepEqual(validateCompatibleVersion(established, liveVersion, {
    sourceSha, sourceVersion, deploymentView, accountId,
    workerName: "frihet-openai-mcp", environment: "openai", now,
  }), []);
  const recoveryOptions = { accountId, workerName: "frihet-openai-mcp", environment: "openai", identityView,
    zoneView, routesView, subdomainView, expectedVersionId: versionId, expectedSourceSha: sourceSha,
    expectedSourceVersion: sourceVersion,
    expectedScriptEtagSha256: createHash("sha256").update(scriptEtag).digest("hex"),
    expectedTopologySha256: topologyFingerprint(cloudflareTopology(liveVersion)) };
  assert.deepEqual(validateRecoveryTarget(established, liveVersion, recoveryOptions), []);

  const liveKvDrift = structuredClone(liveVersion);
  liveKvDrift.resources.bindings.find((binding) => binding.type === "kv_namespace").namespace_id =
    "9207b98598f849109139ad11f3b0ac51";
  assert.ok(validateRecoveryTarget(established, liveKvDrift, recoveryOptions).includes("LIVE_KV_SET_DRIFT"));
  const lifecycleDrift = structuredClone(liveVersion);
  lifecycleDrift.resources.script_runtime.exports.OAuthStateStore.storage = "legacy-kv";
  assert.ok(validateRecoveryTarget(established, lifecycleDrift, recoveryOptions)
    .includes("LIVE_DURABLE_OBJECT_EXPORT_SET_DRIFT"));
  const extraBinding = structuredClone(liveVersion);
  extraBinding.resources.bindings.push({ type: "service", name: "UNREVIEWED", service: "other" });
  assert.ok(validateCompatibleVersion(established, extraBinding, {
    sourceSha, sourceVersion, deploymentView, accountId,
    workerName: "frihet-openai-mcp", environment: "openai", now,
  }).includes("LIVE_UNEXPECTED_BINDING"));

  for (const [mutant, error] of [
    [{ ...recoveryOptions, accountId: "e".repeat(32) }, "CLOUDFLARE_ACCOUNT_RECEIPT_MISMATCH"],
    [{ ...recoveryOptions, workerName: "frihet-remote-mcp" }, "CLOUDFLARE_SCRIPT_RECEIPT_MISMATCH"],
    [{ ...recoveryOptions, environment: "production" }, "CLOUDFLARE_ENVIRONMENT_RECEIPT_MISMATCH"],
    [{ ...recoveryOptions, routesView: [{ ...routesView[0], pattern: "mcp.frihet.io/*" }] },
      "CLOUDFLARE_ROUTE_SET_DRIFT"],
    [{ ...recoveryOptions, subdomainView: { enabled: true, previews_enabled: true } },
      "CLOUDFLARE_SUBDOMAIN_DRIFT"],
    [{ ...recoveryOptions, expectedVersionId: "55555555-5555-4555-8555-555555555555" },
      "RECOVERY_VERSION_JIT_MISMATCH"],
    [{ ...recoveryOptions, expectedScriptEtagSha256: "0".repeat(64) }, "RECOVERY_ETAG_JIT_MISMATCH"],
    [{ ...recoveryOptions, expectedTopologySha256: "0".repeat(64) }, "RECOVERY_TOPOLOGY_JIT_MISMATCH"],
  ]) assert.ok(validateRecoveryTarget(established, liveVersion, mutant).includes(error), error);

  const before = createJitPrestate(
    established,
    observations,
    new Date("2026-09-03T12:58:59Z"),
    new Date("2026-09-03T12:59:00Z"),
  );
  const after = createJitPrestate(
    established,
    observations,
    new Date("2026-09-03T12:59:00Z"),
    new Date("2026-09-03T12:59:01Z"),
  );
  assert.deepEqual(validateJitPrestates(established, before, after, now), []);
  const moved = structuredClone(after);
  moved.deployment.id = "66666666-6666-4666-8666-666666666666";
  assert.ok(validateJitPrestates(established, before, moved, now).includes("JIT_PRESTATE_CHANGED_BETWEEN_READS"));
  const jointlyForgedRouteBefore = structuredClone(before);
  const jointlyForgedRouteAfter = structuredClone(after);
  jointlyForgedRouteBefore.route.id = "e".repeat(32);
  jointlyForgedRouteAfter.route.id = "e".repeat(32);
  assert.ok(validateJitPrestates(established, jointlyForgedRouteBefore, jointlyForgedRouteAfter, now)
    .some((error) => error.includes("JIT_ROUTE_ANCHOR_MISMATCH")));
  const stale = structuredClone(after);
  stale.snapshotStartedAt = "2026-09-03T12:54:59Z";
  assert.ok(validateJitPrestates(established, stale, stale, now).some((error) => error.includes("JIT_PRESTATE_STALE")));
  const freshlySealedAfterSlowReads = structuredClone(after);
  freshlySealedAfterSlowReads.snapshotStartedAt = "2026-09-03T12:53:59Z";
  freshlySealedAfterSlowReads.observedAt = "2026-09-03T12:59:59Z";
  assert.ok(validateJitPrestates(established, freshlySealedAfterSlowReads, freshlySealedAfterSlowReads, now)
    .some((error) => error.includes("JIT_CAPTURE_DURATION_EXCEEDED")));

  // Both reads finish inside a 299-second provider window, and the second
  // snapshot is exactly 300 seconds old at deploy. Only the first snapshot's
  // trusted start proves the total read-to-mutation interval is 450 seconds.
  const pausedBefore = createJitPrestate(
    established,
    observations,
    new Date("2026-09-03T13:00:00Z"),
    new Date("2026-09-03T13:02:30Z"),
  );
  const pausedAfter = createJitPrestate(
    established,
    observations,
    new Date("2026-09-03T13:02:30Z"),
    new Date("2026-09-03T13:04:59Z"),
  );
  const pausedDeployErrors = validateJitPrestates(
    established,
    pausedBefore,
    pausedAfter,
    new Date("2026-09-03T13:07:30Z"),
  );
  assert.ok(pausedDeployErrors.includes("BEFORE:JIT_PRESTATE_STALE"));
  assert.ok(pausedDeployErrors.includes("JIT_DOUBLE_READ_WINDOW_INVALID"));
  assert.ok(!pausedDeployErrors.includes("AFTER:JIT_PRESTATE_STALE"));

  const futureVersion = structuredClone(liveVersion);
  futureVersion.metadata.created_on = "2099-01-01T00:00:00Z";
  assert.ok(validateEstablishedBaseline(established, { ...observations, versionView: futureVersion })
    .includes("VERSION_CREATED_ON_IN_FUTURE"));
  const futureDeployment = structuredClone(deploymentView);
  futureDeployment.created_on = "2099-01-01T00:00:00Z";
  assert.ok(validateEstablishedBaseline(established, { ...observations, deploymentView: futureDeployment })
    .includes("DEPLOYMENT_CREATED_ON_IN_FUTURE"));
  const futureJit = structuredClone(after);
  futureJit.version.createdOn = "2099-01-01T00:00:00Z";
  futureJit.deployment.createdOn = "2099-01-01T00:00:01Z";
  assert.ok(validateJitPrestates(established, futureJit, futureJit, now)
    .some((error) => error.includes("VERSION_CREATED_ON_IN_FUTURE")));
  assert.ok(validateJitPrestates(established, futureJit, futureJit, now)
    .some((error) => error.includes("DEPLOYMENT_CREATED_ON_IN_FUTURE")));
  const observationBeforeDeployment = structuredClone(after);
  observationBeforeDeployment.snapshotStartedAt = "2026-09-03T11:59:49Z";
  observationBeforeDeployment.observedAt = "2026-09-03T11:59:50Z";
  assert.ok(validateJitPrestates(established, observationBeforeDeployment, observationBeforeDeployment, now)
    .some((error) => error.includes("JIT_OBSERVATION_PRECEDES_DEPLOYMENT")));
  const deploymentBeforeVersion = structuredClone(liveVersion);
  deploymentBeforeVersion.metadata.created_on = "2026-09-03T12:00:10Z";
  assert.ok(validateEstablishedBaseline(established, { ...observations, versionView: deploymentBeforeVersion })
    .includes("DEPLOYMENT_PRECEDES_VERSION"));

  const falseReceiptField = structuredClone(established);
  falseReceiptField.baseline.authenticated = false;
  assert.ok(validateEstablishedBaseline(falseReceiptField, observations).includes("BASELINE_RECEIPT_FIELDS_INVALID"));
  const falseProvenance = structuredClone(established);
  falseProvenance.baseline.publicProvenance.releaseSha = null;
  assert.ok(validateEstablishedBaseline(falseProvenance, observations).includes("BASELINE_PUBLIC_PROVENANCE_INVALID"));
  const wrongLiveProvenance = { ...observations, health: { ...health, releaseSha: "e".repeat(40) } };
  assert.ok(validateEstablishedBaseline(established, wrongLiveProvenance)
    .includes("LIVE_PUBLIC_PROVENANCE_VERSION_MISMATCH"));
  const movedZone = { ...observations, zoneView: { ...zoneView, id: "e".repeat(32) } };
  assert.ok(validateEstablishedBaseline(established, movedZone).includes("LIVE_ZONE_ANCHOR_MISMATCH"));
  const replacedRoute = {
    ...observations,
    routesView: [{ ...routesView[0], id: "e".repeat(32) }],
  };
  assert.ok(validateEstablishedBaseline(established, replacedRoute).includes("LIVE_ROUTE_ANCHOR_MISMATCH"));
  assert.ok(validateRecoveryTarget(established, liveVersion, {
    ...recoveryOptions,
    routesView: replacedRoute.routesView,
  }).includes("RECOVERY_ROUTE_ANCHOR_MISMATCH"));
  const futureAnchor = structuredClone(established);
  futureAnchor.baseline.capturedAt = "2026-09-03T13:00:06Z";
  assert.ok(validateEstablishedBaseline(futureAnchor, observations).includes("BASELINE_CAPTURE_TIME_IN_FUTURE"));
  const futureProviderAnchor = structuredClone(established);
  futureProviderAnchor.baseline.version.createdOn = "2099-01-01T00:00:00Z";
  futureProviderAnchor.baseline.deployment.createdOn = "2099-01-01T00:00:01Z";
  assert.ok(validateEstablishedBaseline(futureProviderAnchor, observations)
    .includes("VERSION_CREATED_ON_IN_FUTURE"));
  assert.ok(validateEstablishedBaseline(futureProviderAnchor, observations)
    .includes("DEPLOYMENT_CREATED_ON_IN_FUTURE"));
});

test("OpenAI topology bootstrap — irreversible boundary and force-cancel recovery are explicit", () => {
  const guide = readFileSync(OPENAI_BOOTSTRAP_GUIDE, "utf8");
  assert.match(guide, /cannot safely manufacture a behavior-preserving bridge/);
  assert.match(guide, /separate PR/);
  assert.match(guide, /exact-SHA review/);
  assert.match(guide, /migration `v2`/);
  assert.match(guide, /OAUTH_STATE:OAuthStateStore/);
  assert.match(guide, /dedicated `OAUTH_KV` namespace/);
  assert.match(guide, /`pending-bootstrap`/);
  assert.match(guide, /`established`/);
  assert.match(guide, /non-interactive compatible-version recovery encoded in the\s+reviewed workflow/);
  assert.match(guide, /force-cancel.*prevent an `always\(\)` job/s);
  assert.match(guide, /Never claim recovery across the migration/);
  assert.match(guide, /immutable anchor proves the\s+independently reviewed bridge transition/);
  assert.match(guide, /Seal each trusted snapshot\s+start time before its first Cloudflare read/);
  assert.match(guide, /first-start-to-deploy window and each capture duration\s+must remain within five minutes/);
  assert.match(guide, /version creation, deployment creation, and observation must be logically\s+ordered/);
  assert.match(guide, /exposes no deployment compare-and-swap primitive/);
  assert.match(guide, /does not exclude direct Wrangler,\s+API, dashboard, or unrelated-workflow changes/);
  assert.match(guide, /does not.*local Assets directory or\s+`run_worker_first`/s);
  assert.doesNotMatch(guide, /receipt must be no older than 24 hours/);
  assert.doesNotMatch(guide, /wrangler (?:deploy|deployments|versions|rollback|secret)/iu);
});

test("OpenAI compose smoke — every fetch is bounded and evidence cannot serialize bodies", () => {
  const source = readFileSync(OPENAI_COMPOSE, "utf8");
  assert.deepEqual(validateOpenAIComposeTransport(source), []);
  const uncappedStream = source.replace("bytesRead > MAX_RESPONSE_BYTES", "false");
  assert.ok(
    validateOpenAIComposeTransport(uncappedStream).includes("stream-cap-not-enforced"),
    "removing the streaming byte cap must fail",
  );
  const unboundedMaximum = source.replace(
    "const MAX_RESPONSE_BYTES = 1_048_576;",
    "const MAX_RESPONSE_BYTES = Number.MAX_SAFE_INTEGER;",
  );
  assert.ok(
    validateOpenAIComposeTransport(unboundedMaximum).includes("response-cap-not-fixed"),
    "making the response cap effectively unbounded must fail",
  );
  const permissiveContentType = source.replace(
    "!allowedContentTypes.includes(contentType)",
    "false",
  );
  assert.ok(
    validateOpenAIComposeTransport(permissiveContentType).includes("content-type-not-enforced"),
    "accepting arbitrary response types must fail",
  );
  assert.doesNotMatch(source, /JSON\.stringify\(payload\.(?:error|data)/);
  assert.doesNotMatch(source, /JSON-RPC error:.*payload|console\.(?:log|error).*payload/);
  assert.match(source, /JSON\.stringify\(\{ passed: Boolean\(passed\), invariants \}/);
  assert.doesNotMatch(source, /authenticated-compose\.txt/);
});

test("OpenAI release workflow — every job has a bounded runtime", () => {
  for (const stage of parseWorkflowStages(loadOpenAIWorkflow())) {
    assert.match(
      stage.body,
      /^    timeout-minutes: (?:10|15|20)$/m,
      `${stage.id} lacks a bounded timeout`,
    );
  }
});

test("OpenAI release workflow — every needs output is a direct dependency", () => {
  const wf = loadOpenAIWorkflow();
  const stages = parseWorkflowStages(wf);
  for (const stage of stages) {
    const referencedNeeds = [
      ...stage.body.matchAll(/\$\{\{\s*needs\.([a-z0-9_-]+)\./g),
    ].map((match) => match[1]);
    for (const dependency of new Set(referencedNeeds)) {
      assert.ok(
        stage.dependsOn.includes(dependency),
        `${stage.id} references needs.${dependency} without declaring it directly`,
      );
    }

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

test("OpenAI release workflow — portal hard stops remain explicit", () => {
  const guide = loadOpenAIGuide();
  assert.deepEqual(validatePortalHardStops(guide), []);
  assert.match(guide, /same OpenAI organization and project/);
  assert.match(guide, /VICTOR BERTHELIUS PATO/);
  assert.match(guide, /Apps Management \/ `api\.apps\.write`/);
  assert.match(guide, /STOP before\s+creating the draft/);
  assert.match(guide, /screenshot of the selected identity and project/);
  assert.match(guide, /marketing@rewinder\.eco/);
  assert.match(guide, /data residency is \*\*Global\*\*/);
  assert.match(guide, /does not permit MCP plugin submission from a project with EU data/);
  assert.match(guide, /exact project and its Global data-residency setting/);
  assert.match(guide, /@modelcontextprotocol\/inspector@2\.5\.0/);
  assert.match(guide, /Configure \*\*Streamable HTTP\*\* at exactly\s+`https:\/\/openai-mcp\.frihet\.io\/mcp`/);
  assert.match(guide, /OPENAI_TOKEN_BASELINE_VERSION_ID/);
  assert.match(guide, /OPENAI_TOKEN_TOPOLOGY_SHA256/);
  assert.match(guide, /OPENAI_CLOUDFLARE_CHANGE_FREEZE_ID/);
  assert.match(guide, /same freeze ID as dispatch `change_freeze_id`/);
  assert.match(guide, /owner_confirmation/);
  assert.match(guide, /CONFIRM_OPENAI_DEPLOY_<source_sha>_berthelius/);
  assert.match(guide, /github\.actor.*github\.triggering_actor/s);
  assert.match(guide, /can_admins_bypass=false/);
  assert.doesNotMatch(guide, /must\s+have at least one required independent reviewer/);
  assert.match(guide, /do not configure a fictitious independent reviewer/);
  assert.match(guide, /portal options available.*values to select/s);
  assert.doesNotMatch(guide, /portal selections observed/);
  assert.match(guide, /two fresh live prestate snapshots/);
  assert.match(guide, /exposes no compare-and-swap deployment primitive/);
  assert.match(guide, /exact version ID from this run's account-bound JIT\s+prestate/);
  assert.doesNotMatch(guide, /receipt[^.]*no older than 24 hours/);
  assert.match(guide, /complete all five positive and three negative cases/);
  for (const forbiddenDependency of ["MFA", "SMS", "email confirmation", "private network"]) {
    assert.match(guide, new RegExp(forbiddenDependency));
  }
  assert.match(guide, /STOP before\s+the portal/);
  assert.match(guide, /does not declare a workspace-domain restriction/);
  assert.match(guide, /sole\s+OAuth scope remains `frihet:workspace\.manage`/);
  assert.match(guide, /do not add or imply UserInfo,\s+`openid`, or `email` support/);
  assert.match(guide, /Verify domain ownership inside the current portal draft/);
  assert.match(guide, /historical challenge token/);
  assert.match(guide, /STOP before Scan Tools/);
  assert.match(guide, /Never publish or retain multiple verification tokens/);
  for (const starterPrompt of [
    "Give me an overview of my current Frihet business context.",
    "Show me my draft invoices.",
    "Show me my active products and services.",
  ]) {
    assert.match(guide, new RegExp(starterPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(
    guide,
    /Fourth resubmission: Frihet now exposes only 33 reviewed business tools[^\n]+five positive plus three negative review cases\./,
  );
  assert.match(guide, /Select `Spain` only\./);
  assert.match(guide, /Do not select another jurisdiction until its commercial,/);
  assert.doesNotMatch(
    guide,
    /wrangler (?:deploy|deployments|versions|rollback|secret)/iu,
    "public submission guidance must not expose Cloudflare mutation commands",
  );

  const euStopRemoved = guide.replace(
    "OpenAI does not permit MCP plugin submission from a project with EU data",
    "OpenAI project residency is shown in settings",
  );
  assert.ok(
    validatePortalHardStops(euStopRemoved).includes("eu-mcp-submission-stop-missing"),
    "removing the EU-residency submission stop must fail",
  );
});
