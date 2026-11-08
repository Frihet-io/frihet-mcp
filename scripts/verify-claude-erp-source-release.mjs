/** Authenticate the one Claude source-only ERP lane before deploying its Worker. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLAUDE_ERP_RECEIPT_KIND = "frihet-claude-publicapi-source-release-receipt";
const REPOSITORY = "berthelius/Frihet-ERP";
const SCOPE = "claude-publicapi-source-20261016";
const RELEASE_WORKFLOW = ".github/workflows/deploy-firebase-production.yml";
const BUILD_WORKFLOW = ".github/workflows/build-claude-publicapi-source.yml";
const MEMBERS = [
  "lib/functions/src/publicApi.js", "lib/functions/src/publicApi.js.map",
  "lib/functions/src/publicApi/claudeWriteRoutes.js", "lib/functions/src/publicApi/claudeWriteRoutes.js.map",
  "src/publicApi.ts", "src/publicApi/claudeWriteRoutes.ts",
];
// Mirror the closed ERP build input: these are the observed version 131 bytes,
// not hashes supplied by the candidate build itself.
const BASELINE_COMPILED = Object.freeze({
  "lib/functions/src/publicApi.js": "456b6331f48a1668d88984d3ea4685241a9a07f374c69479de7c8f1a787fdeef",
  "lib/functions/src/publicApi.js.map": "98909f8d64e91f0dd58c92ff1145adb1526757a3485ef4fd1a484d07f47a24dd",
});
const hex = (value, length) => typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value);
const decimal = (value) => typeof value === "string" && /^[1-9][0-9]*$/u.test(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
const canonical = (value) => JSON.stringify(stable(value));

function assertOrigin(run, { id, attempt, sha, workflow }) {
  assert.ok(String(run?.id) === id && run.run_attempt === attempt && run.head_sha === sha
    && run.head_branch === "main" && run.path === workflow && run.event === "workflow_dispatch"
    && run.status === "completed" && run.conclusion === "success"
    && run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY
    && Number.isSafeInteger(run.repository?.id) && run.repository.id === run.head_repository.id,
  "Claude ERP proof must originate from the successful protected main workflow");
}

/** No credentials or provider response bodies enter errors or command arguments. */
export async function verifyClaudeErpSourceRelease(receipt, erpRoot, {
  fetchImpl = fetch,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
} = {}) {
  assert.ok(receipt?.kind === CLAUDE_ERP_RECEIPT_KIND && receipt.schemaVersion === 1
    && receipt.scope === SCOPE && receipt.operation === "deploy" && receipt.status === "deployed"
    && receipt.stage === "completed" && receipt.project === "gen-lang-client-0335716041"
    && receipt.target === "publicApi" && receipt.region === "europe-west1"
    && decimal(receipt.runId) && Number.isSafeInteger(receipt.runAttempt) && receipt.runAttempt > 0
    && hex(receipt.sourceSha, 40) && receipt.workflowSha === receipt.sourceSha,
  "Claude ERP source-only receipt identity");
  if (!token) token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  assert.ok(token, "Authenticated GitHub evidence is required for the Claude ERP receipt");
  const json = async (path) => {
    const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
      redirect: "error", signal: AbortSignal.timeout(30000),
    });
    assert.ok(response.ok, `Claude ERP GitHub evidence unavailable (${response.status})`);
    return response.json();
  };
  const directory = mkdtempSync(join(tmpdir(), "claude-erp-proof-"));
  let archiveIndex = 0;
  const unpack = (bytes, names) => {
    assert.ok(bytes.length <= 128 * 1024 * 1024, "Claude ERP evidence exceeds its bound");
    const path = join(directory, `${archiveIndex++}.zip`);
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    const listed = execFileSync("unzip", ["-Z1", path], { encoding: "utf8", maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] }).trimEnd().split("\n");
    assert.deepEqual([...listed].sort(), [...names].sort(), "Claude ERP evidence member inventory");
    return Object.fromEntries(names.map((name) => [name, execFileSync("unzip", ["-p", path, name], {
      maxBuffer: name.endsWith(".zip") ? 128 * 1024 * 1024 : 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    })]));
  };
  const download = async (artifact, run, names) => {
    assert.ok(Number.isSafeInteger(artifact?.id) && artifact.id > 0 && artifact.expired === false
      && /^sha256:[0-9a-f]{64}$/u.test(artifact.digest || "")
      && artifact.workflow_run?.id === run.id && artifact.workflow_run?.head_sha === run.head_sha
      && artifact.workflow_run?.head_branch === "main" && artifact.workflow_run?.repository_id === run.repository.id
      && artifact.workflow_run?.head_repository_id === run.repository.id, "Claude ERP artifact origin");
    const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(30000),
    });
    const location = response.headers.get("location");
    const url = location ? new URL(location) : null;
    assert.ok(response.status === 302 && url?.protocol === "https:" && url.hostname.endsWith(".blob.core.windows.net")
      && !url.username && !url.password && !url.port, "Claude ERP artifact redirect");
    const archive = await fetchImpl(url.href, { redirect: "error", signal: AbortSignal.timeout(60000) });
    assert.ok(archive.ok, "Claude ERP artifact unavailable");
    const bytes = Buffer.from(await archive.arrayBuffer());
    assert.equal(`sha256:${hash(bytes)}`, artifact.digest, "Claude ERP authenticated artifact digest");
    return unpack(bytes, names);
  };
  try {
    const run = await json(`actions/runs/${receipt.runId}/attempts/${receipt.runAttempt}`);
    assertOrigin(run, { id: receipt.runId, attempt: receipt.runAttempt, sha: receipt.sourceSha, workflow: RELEASE_WORKFLOW });
    const listed = await json(`actions/runs/${receipt.runId}/artifacts?per_page=100`);
    const artifacts = listed.artifacts?.filter((item) => item.name === "firebase-production-release-receipt");
    assert.equal(artifacts?.length, 1, "Claude ERP release receipt artifact must be unique");
    const files = await download(artifacts[0], run, ["firebase-release-output.json"]);
    assert.deepEqual(JSON.parse(files["firebase-release-output.json"]), receipt, "Local Claude ERP receipt differs from authenticated Actions evidence");
    const { receiptSha256, ...unsigned } = receipt;
    assert.equal(hash(canonical(unsigned)), receiptSha256, "Claude ERP receipt digest");
    const spec = JSON.parse(execFileSync("git", ["-C", erpRoot, "show", `${receipt.sourceSha}:scripts/claude-publicapi-source-release.json`], {
      encoding: "utf8", maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }));
    assert.ok(spec.schemaVersion === 1 && spec.kind === "claude-publicapi-source-release-spec" && spec.scope === SCOPE
      && spec.approved === true && spec.project === receipt.project && spec.region === receipt.region
      && spec.target === "publicApi" && spec.action === "UPDATE" && spec.updateMask === "sourceArchiveUrl"
      && spec.rollbackArchiveBucket === "frihet-prod-release-artifacts-gen-lang-client-0335716041"
      && hex(spec.candidateSourceSha256, 64), "Claude ERP approved source-only spec");
    assert.equal(hash(canonical(spec)), receipt.specSha256, "Claude ERP committed spec digest");
    assert.deepEqual(Object.keys(spec.replacements).sort(), MEMBERS, "Claude ERP replacement inventory");
    assert.deepEqual(receipt.runtimeSource, {
      baseline: spec.baseline, build: { repositorySha: spec.build.repositorySha, repositoryTree: spec.build.repositoryTree, sourceDeltaSha256: spec.build.sourceDeltaSha256 },
      replacements: spec.replacements, proof: spec.proof,
    }, "Claude ERP runtime provenance");
    assert.equal(receipt.credentialIssuance, "not_performed");
    assert.deepEqual(receipt.releaseSurfaces, { functions: "participating", firestoreRules: "not_participating", indexes: "not_participating", storage: "not_participating" });
    assert.equal(receipt.rollback, null);
    assert.equal(receipt.functions?.mutations?.length, 1);
    const mutation = receipt.functions.mutations[0];
    assert.ok(!Object.hasOwn(mutation, "secretBindingChange"), "Claude ERP must preserve secret bindings");
    const { secretEnvironmentVariables: _bindings, ...before } = spec.before;
    assert.ok(decimal(before.versionId), "Claude ERP approved BEFORE version");
    assert.deepEqual(mutation.before, before, "Claude ERP captured BEFORE");
    assert.ok(mutation.target === "publicApi" && mutation.region === receipt.region && mutation.action === "UPDATE"
      && ["succeeded", "succeeded_reconciled"].includes(mutation.providerOperationState)
      && mutation.candidateSourceSha256 === spec.candidateSourceSha256 && mutation.after?.presence === "present"
      && mutation.after.sourceSha256 === spec.candidateSourceSha256 && decimal(mutation.after.versionId)
      && mutation.after.versionId !== before.versionId && mutation.after.configSha256 === before.configSha256
      && mutation.after.iamSha256 === before.iamSha256, "Claude ERP source/config/IAM AFTER");
    assert.equal(receipt.prepared?.candidate?.sha256, spec.candidateSourceSha256);
    assert.equal(receipt.prepared?.beforeArchive?.sha256, before.sourceSha256);
    assert.equal(receipt.prepared.candidate.uri, `gs://${spec.rollbackArchiveBucket}/candidates/${receipt.sourceSha}/${spec.candidateSourceSha256}.zip`);
    assert.equal(receipt.prepared.beforeArchive.uri, `gs://${spec.rollbackArchiveBucket}/rollback/${receipt.sourceSha}/publicApi/${before.versionId}-${before.sourceSha256}.zip`);
    assert.ok(decimal(receipt.prepared.candidate.generation) && decimal(receipt.prepared.beforeArchive.generation), "Claude ERP immutable object generations");
    assert.deepEqual(mutation.beforeArchive, receipt.prepared.beforeArchive);
    const proof = spec.proof;
    assert.ok(decimal(proof?.runId) && Number.isSafeInteger(proof.runAttempt) && proof.runAttempt > 0
      && decimal(proof.artifactId) && hex(proof.controlSha, 40), "Claude ERP build proof identity");
    const buildRun = await json(`actions/runs/${proof.runId}/attempts/${proof.runAttempt}`);
    assertOrigin(buildRun, { id: proof.runId, attempt: proof.runAttempt, sha: proof.controlSha, workflow: BUILD_WORKFLOW });
    const artifact = await json(`actions/artifacts/${proof.artifactId}`);
    assert.equal(String(artifact.id), proof.artifactId);
    assert.equal(artifact.name, `claude-publicapi-source-proof-${proof.runId}-${proof.runAttempt}`);
    assert.equal(artifact.digest, proof.artifactDigest);
    const built = await download(artifact, buildRun, ["build-proof.json", "replacements.zip"]);
    assert.equal(hash(built["build-proof.json"]), proof.receiptSha256);
    assert.equal(hash(built["replacements.zip"]), spec.replacementArchiveSha256);
    const buildReceipt = JSON.parse(built["build-proof.json"]);
    assert.deepEqual(Object.keys(buildReceipt).sort(), [
      "schemaVersion", "kind", "scope", "deployable", "status", "inputSha256", "controlSha", "runId", "runAttempt",
      "sourceSha", "sourceTree", "baselineCompiled", "replacements", "replacementArchiveSha256",
    ].sort(), "Claude ERP exact build receipt fields");
    const input = { scope: SCOPE, baseline: spec.baseline, build: spec.build, members: MEMBERS, baselineCompiled: BASELINE_COMPILED };
    assert.ok(buildReceipt.schemaVersion === 1 && buildReceipt.kind === "claude-publicapi-source-build-proof"
      && buildReceipt.status === "matched" && buildReceipt.deployable === false && buildReceipt.scope === SCOPE
      && buildReceipt.inputSha256 === hash(canonical(input)) && buildReceipt.controlSha === proof.controlSha
      && buildReceipt.runId === proof.runId && buildReceipt.runAttempt === proof.runAttempt
      && buildReceipt.sourceSha === spec.build.repositorySha && buildReceipt.sourceTree === spec.build.repositoryTree
      && buildReceipt.replacementArchiveSha256 === spec.replacementArchiveSha256, "Claude ERP build output provenance");
    assert.deepEqual(buildReceipt.baselineCompiled, BASELINE_COMPILED, "Claude ERP reproduced live baseline compiler bytes");
    assert.deepEqual(buildReceipt.replacements, spec.replacements);
    const members = unpack(built["replacements.zip"], MEMBERS);
    for (const name of MEMBERS) assert.equal(hash(members[name]), spec.replacements[name], `Claude ERP rebuilt ${name}`);
    return { publicApiSource: members["src/publicApi.ts"].toString("utf8"), ceilingSource: members["src/publicApi/claudeWriteRoutes.ts"].toString("utf8") };
  } catch {
    // In particular, never expose a signed artifact URL in a fetch exception.
    throw new Error("Claude ERP source release evidence did not verify; Worker deployment refused.");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
