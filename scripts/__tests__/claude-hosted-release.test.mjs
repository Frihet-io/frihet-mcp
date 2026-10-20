import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertClaudeWorkerIsolation,
  assertClaudeOperationalSurface,
  assertClaudeConsultationSurface,
  assertErpCeilingDeployed,
  DRY_RUN_NAMESPACE,
  erpCeilingRoutes,
  readClaudeConfiguration,
  verifyErpCeilingDeployed,
} from "../check-claude-hosted-release.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("source config isolates Claude with its dedicated KV namespace and refuses dry-run placeholder on deploy", () => {
  const { config, sharedNamespaceIds } = readClaudeConfiguration();
  assert.doesNotThrow(() => assertClaudeWorkerIsolation(config, sharedNamespaceIds, true));
  assert.doesNotThrow(() => assertClaudeWorkerIsolation(config, sharedNamespaceIds, false));
  const unbootstrapped = structuredClone(config);
  unbootstrapped.kv_namespaces[0].id = DRY_RUN_NAMESPACE;
  assert.doesNotThrow(() => assertClaudeWorkerIsolation(unbootstrapped, sharedNamespaceIds, true));
  assert.throws(() => assertClaudeWorkerIsolation(unbootstrapped, sharedNamespaceIds), /bootstrap is pending/u);
  for (const mutate of [
    (c) => { c.name = "frihet-remote-mcp"; },
    (c) => { c.routes[0].pattern = "mcp.frihet.io/*"; },
    (c) => { c.vars.FRIHET_OPENAI_MODE = "true"; },
    (c) => { c.vars.FRIHET_CLAUDE_MODE = "false"; },
    (c) => { c.workers_dev = true; },
    (c) => { c.preview_urls = true; },
    (c) => { delete c.alias["@cloudflare/workers-oauth-provider"]; },
    (c) => { c.build.command = "echo skipped"; },
    (c) => { c.durable_objects.bindings[0].script_name = "frihet-remote-mcp"; },
    (c) => { c.kv_namespaces[0].id = sharedNamespaceIds[0]; },
    (c) => { c.kv_namespaces[0].id = sharedNamespaceIds[1]; },
  ]) {
    const candidate = structuredClone(config);
    mutate(candidate);
    assert.throws(() => assertClaudeWorkerIsolation(candidate, sharedNamespaceIds, true));
  }
});

const { routes: CONTRACT_ROUTES } = JSON.parse(readFileSync(new URL("../../src/__tests__/fixtures/claude-write-route-contract.json", import.meta.url), "utf8"));
const SERVED = JSON.parse(readFileSync(new URL("../../src/__tests__/fixtures/claude-consultation-route-contract.json", import.meta.url), "utf8"));

test("consultation source guard requires exact served reads while preserving the broader immutable credential ceiling", () => {
  // Historical nine-tool receipt oracle, independent of the current broad profile.
  const candidate = JSON.parse(readFileSync(new URL("../../src/__tests__/fixtures/claude-candidate-contract.json", import.meta.url), "utf8"));
  const core = ["list_clients", "list_expenses", "list_invoices", "list_products", "list_quotes", "list_vendors"];
  candidate.tools.full = candidate.tools.full.filter(({ name }) => core.includes(name));
  candidate.tools.grouped = candidate.tools.grouped.filter(({ name }) => [...core, "describe_tool", "list_tool_groups", "search_tools"].includes(name));
  candidate.prompts = []; candidate.promptContent = [];
  candidate.catalogue.canonicalOperations = 6; candidate.catalogue.aliases = {};
  candidate.groups.totalTools = 6;
  assert.doesNotThrow(() => assertClaudeConsultationSurface(candidate, SERVED));
  assert.equal(digest(CONTRACT_ROUTES.join("\n")), "bcf2185915523c60468afc380d1e2456a5c0da5cb2ca4b4820e74886b06b928f");
  assert.ok(CONTRACT_ROUTES.length > SERVED.routes.length);
  for (const mutate of [
    c => { c.tools.grouped = c.tools.grouped.slice(1); },
    c => { c.tools.grouped.push({ name: "create_invoice", annotations: { readOnlyHint: false } }); },
    c => { c.tools.full[0].annotations.readOnlyHint = false; },
    c => { c.prompts.push({ name: "invoice-review" }); },
    c => { c.resources.local.push({ uri: "frihet://business/profile" }); },
    c => { c.catalogue.aliases = { frihet_modelo_303_summary: "get_modelo_303_summary" }; },
    c => { c.groups.totalTools = 125; },
  ]) {
    const changed = structuredClone(candidate); mutate(changed);
    assert.throws(() => assertClaudeConsultationSurface(changed, SERVED));
  }
  for (const mutate of [
    s => { s.routes = []; },
    s => { s.tools.list_invoices.push("POST /invoices"); },
    s => { s.tools.create_invoice = ["POST /invoices"]; },
  ]) {
    const changed = structuredClone(SERVED); mutate(changed);
    assert.throws(() => assertClaudeConsultationSurface(candidate, changed));
  }
});

test("operational source guard preserves broad product scope without expanding the ERP ceiling", () => {
  const candidate = JSON.parse(readFileSync(new URL("../../src/__tests__/fixtures/claude-candidate-contract.json", import.meta.url), "utf8"));
  const ceiling = JSON.parse(readFileSync(new URL("../../src/__tests__/fixtures/claude-write-route-contract.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => assertClaudeOperationalSurface(candidate, ceiling));
  for (const mutate of [
    c => { c.tools.full.pop(); },
    c => { c.tools.grouped.pop(); },
    c => { c.tools.grouped[0].title = ""; },
    c => { c.tools.grouped[0].annotations.readOnlyHint = undefined; },
    c => { c.tools.grouped[0]._meta["io.frihet/capability"].callability = "unavailable"; },
    c => { c.tools.grouped[0]._meta["io.frihet/capability"].externalSideEffects = ["money_movement"]; },
    c => { c.tools.full.find(({ name }) => name === "create_invoice").annotations.readOnlyHint = true; },
    c => { c.groups.totalGroups = 4; },
    c => { c.prompts = []; },
    c => { c.resources.remote.push({ uri: "frihet://api/schema" }); },
    c => { c.catalogue.aliases = {}; },
  ]) {
    const changed = structuredClone(candidate); mutate(changed);
    assert.throws(() => assertClaudeOperationalSurface(changed, ceiling));
  }
  const expanded = structuredClone(ceiling);
  expanded.routes.push("POST /sales/:id/refund");
  assert.throws(() => assertClaudeOperationalSurface(candidate, expanded));
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function signed(receipt) {
  const { receiptSha256: _ignored, ...unsigned } = receipt;
  return { ...unsigned, receiptSha256: createHash("sha256").update(JSON.stringify(stable(unsigned))).digest("hex") };
}

/** A throwaway ERP checkout with one commit, plus the release receipt that deployed it. */
function erpRelease({ routes = CONTRACT_ROUTES, wired = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "erp-ceiling-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  mkdirSync(join(root, "functions/src/publicApi"), { recursive: true });
  writeFileSync(join(root, "functions/src/publicApi.ts"), wired
    ? "if (!isClaudeWriteRouteAllowed(req.method, pathParts)) deny();\n"
    : "import { isClaudeWriteRouteAllowed } from './publicApi/claudeWriteRoutes';\n");
  writeFileSync(join(root, "functions/src/publicApi/claudeWriteRoutes.ts"), [
    "/** Mentions CLAUDE_WRITE_ROUTES.join('\\n') before the list. */",
    "export const CLAUDE_WRITE_ROUTES: ReadonlyArray<string> = Object.freeze([",
    ...routes.map((route) => `  '${route}',`),
    "]);",
    "",
  ].join("\n"));
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "release");
  const sourceSha = git("rev-parse", "HEAD");
  const receipt = signed({
    schemaVersion: 1,
    kind: "frihet-production-firebase-release-receipt",
    status: "deployed",
    operation: "deploy",
    project: "gen-lang-client-0335716041",
    sourceSha,
    functionsTree: git("rev-parse", "HEAD:functions"),
    functions: {
      candidate: { sha256: "a".repeat(64) },
      mutations: [{
        target: "publicApi",
        region: "europe-west1",
        action: "UPDATE",
        candidateSourceSha256: "a".repeat(64),
        after: {
          presence: "present",
          sourceSha256: "a".repeat(64),
          versionId: "2",
          configSha256: "b".repeat(64),
          iamSha256: "c".repeat(64),
        },
      }],
    },
  });
  return { root, receipt, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("ERP route list parsing reads only the exported ceiling list", () => {
  assert.deepEqual(erpCeilingRoutes([
    "// CLAUDE_WRITE_ROUTES = 'not this'",
    "export const CLAUDE_WRITE_ROUTES: ReadonlyArray<string> = Object.freeze([",
    "  'DELETE /a/:id',",
    "  'POST /b',",
    "]);",
  ].join("\n")), ["DELETE /a/:id", "POST /b"]);
  assert.throws(() => erpCeilingRoutes("const unrelated = [];"), /no CLAUDE_WRITE_ROUTES list/u);
});

test("Claude deploy requires a verified ERP release receipt that deployed the matching ceiling", () => {
  const release = erpRelease();
  try {
    assert.doesNotThrow(() => assertErpCeilingDeployed(release.receipt, release.root, CONTRACT_ROUTES));
    for (const [label, mutate, pattern] of [
      ["kind", (r) => signed({ ...r, kind: "other-receipt" }), /receipt kind/u],
      ["status", (r) => signed({ ...r, status: "in_progress" }), /receipt status/u],
      ["operation", (r) => signed({ ...r, operation: "rollback" }), /receipt operation/u],
      ["project", (r) => signed({ ...r, project: "another-project" }), /receipt project/u],
      ["digest", (r) => ({ ...r, status: "deployed", sourceSha: r.sourceSha, functionsTree: "0".repeat(40) }), /receipt digest/u],
      ["candidate artifact", (r) => signed({ ...r, functions: { ...r.functions, candidate: { sha256: "b".repeat(64) } } }), /no post-verified publicApi deploy/u],
      ["missing artifact", (r) => signed({ ...r, functions: { ...r.functions, candidate: undefined } }), /candidate artifact digest/u],
      ["invalid artifact digest", (r) => signed({ ...r, functions: { ...r.functions, candidate: { sha256: "not-a-digest" } } }), /candidate artifact digest/u],
      ["tree", (r) => signed({ ...r, functionsTree: "0".repeat(40) }), /functions tree/u],
      ["unknown commit", (r) => signed({ ...r, sourceSha: "f".repeat(40) }), /./u],
    ]) {
      assert.throws(() => assertErpCeilingDeployed(mutate(release.receipt), release.root, CONTRACT_ROUTES), pattern, label);
    }
    for (const [label, mutate] of [
      ["no publicApi", (m) => { m.target = "otherFunction"; }],
      ["wrong region", (m) => { m.region = "us-central1"; }],
      ["missing region", (m) => { delete m.region; }],
      ["unverified source", (m) => { m.after.sourceSha256 = "b".repeat(64); }],
      ["resource path is not a target name", (m) => { m.target = "projects/gen-lang-client-0335716041/locations/europe-west1/functions/publicApi"; }],
    ]) {
      const candidate = structuredClone(release.receipt);
      mutate(candidate.functions.mutations[0]);
      assert.throws(() => assertErpCeilingDeployed(signed(candidate), release.root, CONTRACT_ROUTES), /no post-verified publicApi deploy/u, label);
    }
  } finally {
    release.cleanup();
  }

  for (const [label, options, pattern] of [
    ["unwired publicApi", { wired: false }, /does not reference the Claude ceiling/u],
    ["route drift", { routes: CONTRACT_ROUTES.slice(1) }, /differ from the Claude contract fixture/u],
  ]) {
    const drifted = erpRelease(options);
    try {
      assert.throws(() => assertErpCeilingDeployed(drifted.receipt, drifted.root, CONTRACT_ROUTES), pattern, label);
    } finally {
      drifted.cleanup();
    }
  }
});

test("Claude deploy refuses runtime recipes even when the control commit contains the ceiling", () => {
  const release = erpRelease();
  try {
    const git = (...args) => execFileSync("git", ["-C", release.root, ...args], { encoding: "utf8" }).trim();
    writeFileSync(join(release.root, "functions/src/publicApi.ts"), "// Runtime without the Claude write ceiling.\n");
    git("add", ".");
    git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "other runtime");
    const runtimeSha = git("rev-parse", "HEAD");
    assert.notEqual(runtimeSha, release.receipt.sourceSha);
    for (const repositorySha of [runtimeSha, release.receipt.sourceSha]) {
      const runtimeSource = {
        recipeSha256: "c".repeat(64),
        baseline: { repositorySha: runtimeSha },
        build: {
          repositorySha,
          repositoryTree: git("rev-parse", `${repositorySha}^{tree}`),
          reviewedDeltaSha: release.receipt.sourceSha,
          sourceDeltaSha256: "d".repeat(64),
          replacementArchiveSha256: "e".repeat(64),
        },
      };
      for (const variant of [
        { scope: "p0-fiscal-source-20260930", target: "publicApi", runtimeSource },
        { scope: "p0-fiscal-source-20260930", target: "publicApi" },
        { runtimeSource },
      ]) {
        assert.throws(
          () => assertErpCeilingDeployed(signed({ ...release.receipt, ...variant }), release.root, CONTRACT_ROUTES),
          /runtime provenance requires a direct-source release/u,
        );
      }
    }
    // Source inspection must use the receipt commit, independent of checkout HEAD.
    assert.doesNotThrow(() => assertErpCeilingDeployed(release.receipt, release.root, CONTRACT_ROUTES));
  } finally {
    release.cleanup();
  }
});

/** Authenticated Actions fixtures exercise the real ZIP/digest admission, without network or cloud writes. */
function hybridRelease({ mutationChange, buildReceiptChange, routes = CONTRACT_ROUTES } = {}) {
  const root = mkdtempSync(join(tmpdir(), "erp-claude-hybrid-"));
  const zip = (name, files) => {
    const stage = join(root, name);
    mkdirSync(stage, { recursive: true });
    for (const [path, bytes] of Object.entries(files)) {
      mkdirSync(join(stage, path, ".."), { recursive: true });
      writeFileSync(join(stage, path), bytes);
    }
    const output = join(root, `${name}.zip`);
    execFileSync("zip", ["-q", "-X", output, "-@"], { cwd: stage, input: `${Object.keys(files).join("\n")}\n` });
    return readFileSync(output);
  };
  const members = {
    "lib/functions/src/publicApi.js": Buffer.from("compiled fixture"),
    "lib/functions/src/publicApi.js.map": Buffer.from("{}"),
    "lib/functions/src/publicApi/claudeWriteRoutes.js": Buffer.from("compiled route fixture"),
    "lib/functions/src/publicApi/claudeWriteRoutes.js.map": Buffer.from("{}"),
    "src/publicApi.ts": Buffer.from("if (isClaudeWriteRouteForbidden(apiKeyAccessProfile, req.method, pathParts)) deny();"),
    "src/publicApi/claudeWriteRoutes.ts": Buffer.from(`export const CLAUDE_WRITE_ROUTES = Object.freeze([\n${routes.map((route) => `  '${route}',`).join("\n")}\n]);`),
  };
  const replacements = Object.fromEntries(Object.entries(members).map(([name, bytes]) => [name, digest(bytes)]));
  const replacementZip = zip("replacements", members);
  const buildSha = "d".repeat(40), buildTree = "e".repeat(40), buildControl = "c".repeat(40);
  const baseline = { repositorySha: "b".repeat(40), repositoryTree: "f".repeat(40), sourceArchiveSha256: "1".repeat(64) };
  const build = { repositorySha: buildSha, repositoryTree: buildTree, sourceDeltaSha256: "4".repeat(64), sourcePatch: "synthetic patch" };
  const baselineCompiled = {
    "lib/functions/src/publicApi.js": "456b6331f48a1668d88984d3ea4685241a9a07f374c69479de7c8f1a787fdeef",
    "lib/functions/src/publicApi.js.map": "98909f8d64e91f0dd58c92ff1145adb1526757a3485ef4fd1a484d07f47a24dd",
  };
  const input = { scope: "claude-publicapi-source-20261016", baseline, build, members: Object.keys(members), baselineCompiled };
  const buildReceiptData = { schemaVersion: 1, kind: "claude-publicapi-source-build-proof", status: "matched", deployable: false,
    scope: input.scope, inputSha256: digest(JSON.stringify(stable(input))), controlSha: buildControl, runId: "20", runAttempt: 1,
    sourceSha: buildSha, sourceTree: buildTree, baselineCompiled, replacements, replacementArchiveSha256: digest(replacementZip) };
  buildReceiptChange?.(buildReceiptData);
  const buildReceipt = Buffer.from(JSON.stringify(buildReceiptData));
  const buildZip = zip("build-artifact", { "build-proof.json": buildReceipt, "replacements.zip": replacementZip });
  const spec = {
    schemaVersion: 1, kind: "claude-publicapi-source-release-spec", scope: "claude-publicapi-source-20261016", approved: true,
    project: "gen-lang-client-0335716041", region: "europe-west1", target: "publicApi", action: "UPDATE", updateMask: "sourceArchiveUrl",
    rollbackArchiveBucket: "frihet-prod-release-artifacts-gen-lang-client-0335716041",
    before: { presence: "present", versionId: "131", sourceSha256: "1".repeat(64), configSha256: "2".repeat(64), iamSha256: "3".repeat(64), secretEnvironmentVariables: [] },
    baseline, build,
    replacements, replacementArchiveSha256: digest(replacementZip), candidateSourceSha256: "a".repeat(64),
    proof: { controlSha: buildControl, runId: "20", runAttempt: 1, artifactId: "202", artifactDigest: `sha256:${digest(buildZip)}`, receiptSha256: digest(buildReceipt) },
  };
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts/claude-publicapi-source-release.json"), JSON.stringify(spec));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("add", "scripts");
  git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "control");
  const sourceSha = git("rev-parse", "HEAD"), beforeArchive = { uri: `gs://${spec.rollbackArchiveBucket}/rollback/${sourceSha}/publicApi/131-${spec.before.sourceSha256}.zip`, generation: "1", sha256: spec.before.sourceSha256 };
  const { secretEnvironmentVariables: _bindings, ...before } = spec.before;
  const mutation = { target: "publicApi", region: "europe-west1", action: "UPDATE", before, beforeArchive,
    candidateSourceSha256: spec.candidateSourceSha256, providerOperationState: "succeeded",
    after: { ...before, versionId: "132", sourceSha256: spec.candidateSourceSha256 } };
  mutationChange?.(mutation);
  const receipt = signed({ schemaVersion: 1, kind: "frihet-claude-publicapi-source-release-receipt", scope: spec.scope,
    project: spec.project, region: spec.region, target: spec.target, operation: "deploy", status: "deployed", stage: "completed",
    sourceSha, workflowSha: sourceSha, specSha256: digest(JSON.stringify(stable(spec))), runId: "10", runAttempt: 1,
    runtimeSource: { baseline: spec.baseline, build: { repositorySha: build.repositorySha, repositoryTree: build.repositoryTree, sourceDeltaSha256: build.sourceDeltaSha256 }, replacements: spec.replacements, proof: spec.proof },
    credentialIssuance: "not_performed", rollback: null, functions: { mutations: [mutation] },
    releaseSurfaces: { functions: "participating", firestoreRules: "not_participating", indexes: "not_participating", storage: "not_participating" },
    prepared: { candidate: { uri: `gs://${spec.rollbackArchiveBucket}/candidates/${sourceSha}/${spec.candidateSourceSha256}.zip`, generation: "2", sha256: spec.candidateSourceSha256 }, beforeArchive },
  });
  const releaseZip = zip("release-artifact", { "firebase-release-output.json": Buffer.from(JSON.stringify(receipt)) });
  const run = (id, sha, path) => ({ id, run_attempt: 1, head_sha: sha, head_branch: "main", path, event: "workflow_dispatch", status: "completed", conclusion: "success", repository: { id: 99, full_name: "berthelius/Frihet-ERP" }, head_repository: { id: 99, full_name: "berthelius/Frihet-ERP" } });
  const releaseRun = run(10, sourceSha, ".github/workflows/deploy-firebase-production.yml"), buildRun = run(20, buildControl, ".github/workflows/build-claude-publicapi-source.yml");
  const artifact = (id, name, bytes, origin) => ({ id, name, digest: `sha256:${digest(bytes)}`, expired: false, workflow_run: { id: origin.id, head_sha: origin.head_sha, head_branch: "main", repository_id: 99, head_repository_id: 99 } });
  const releaseArtifact = artifact(101, "firebase-production-release-receipt", releaseZip, releaseRun);
  const buildArtifact = artifact(202, "claude-publicapi-source-proof-20-1", buildZip, buildRun);
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (String(url).includes(".blob.core.windows.net")) {
      assert.equal(options.headers, undefined, "GitHub token must not reach signed storage URL");
      return new Response(path === "/101.zip" ? releaseZip : buildZip);
    }
    assert.equal(options.headers.Authorization, "Bearer synthetic-token");
    if (path.endsWith("/zip")) return new Response(null, { status: 302, headers: { location: `https://fixture.blob.core.windows.net/${path.split("/").at(-2)}.zip?sig=private-test-marker` } });
    const data = path.endsWith("/10/attempts/1") ? releaseRun : path.endsWith("/20/attempts/1") ? buildRun
      : path.endsWith("/10/artifacts") ? { artifacts: [releaseArtifact] } : path.endsWith("/artifacts/202") ? buildArtifact : null;
    assert.ok(data, "unexpected evidence URL");
    return new Response(JSON.stringify(data));
  };
  return { root, receipt, releaseRun, buildArtifact, fetchImpl, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("Claude's dedicated lane requires authenticated release and build artifacts, exact bytes and routes", async () => {
  const fixture = hybridRelease();
  try {
    await verifyErpCeilingDeployed(fixture.receipt, fixture.root, CONTRACT_ROUTES, { token: "synthetic-token", fetchImpl: fixture.fetchImpl });
    const forged = signed({ ...fixture.receipt, sourceSha: "f".repeat(40), workflowSha: "f".repeat(40) });
    await assert.rejects(verifyErpCeilingDeployed(forged, fixture.root, CONTRACT_ROUTES, { token: "synthetic-token", fetchImpl: fixture.fetchImpl }));
    fixture.releaseRun.event = "pull_request";
    await assert.rejects(verifyErpCeilingDeployed(fixture.receipt, fixture.root, CONTRACT_ROUTES, { token: "synthetic-token", fetchImpl: fixture.fetchImpl }));
    fixture.releaseRun.event = "workflow_dispatch";
    fixture.buildArtifact.digest = `sha256:${"0".repeat(64)}`;
    await assert.rejects(verifyErpCeilingDeployed(fixture.receipt, fixture.root, CONTRACT_ROUTES, { token: "synthetic-token", fetchImpl: fixture.fetchImpl }));
    await assert.rejects(verifyErpCeilingDeployed(fixture.receipt, fixture.root, CONTRACT_ROUTES, {
      token: "synthetic-token", fetchImpl: async () => { throw new Error("private-test-marker"); },
    }), (error) => error.message === "Claude ERP source release evidence did not verify; Worker deployment refused.");
  } finally { fixture.cleanup(); }
});

test("an authenticated artifact cannot admit changed config, secret bindings, or route authority", async () => {
  for (const options of [
    { mutationChange: (m) => { m.after.configSha256 = "9".repeat(64); } },
    { mutationChange: (m) => { m.secretBindingChange = {}; } },
    { routes: [...CONTRACT_ROUTES, "DELETE /clients/:id"] },
  ]) {
    const fixture = hybridRelease(options);
    try { await assert.rejects(verifyErpCeilingDeployed(fixture.receipt, fixture.root, CONTRACT_ROUTES, { token: "synthetic-token", fetchImpl: fixture.fetchImpl })); }
    finally { fixture.cleanup(); }
  }
});

test("authenticated and re-signed build artifacts must prove the exact historical input and build identity", async () => {
  for (const buildReceiptChange of [
    (r) => { r.inputSha256 = "9".repeat(64); },
    (r) => { r.baselineCompiled = { ...r.baselineCompiled, "lib/functions/src/publicApi.js": "9".repeat(64) }; },
    (r) => { r.controlSha = "9".repeat(40); },
    (r) => { r.runId = "21"; },
    (r) => { r.runAttempt = 2; },
    (r) => { r.schemaVersion = 2; },
    (r) => { r.kind = "other-build-proof"; },
    (r) => { delete r.inputSha256; },
  ]) {
    const fixture = hybridRelease({ buildReceiptChange });
    try {
      await assert.rejects(verifyErpCeilingDeployed(fixture.receipt, fixture.root, CONTRACT_ROUTES, {
        token: "synthetic-token", fetchImpl: fixture.fetchImpl,
      }));
    } finally { fixture.cleanup(); }
  }
});
