/**
 * Tests for the server.json version gate in scripts/audit-mcp-refs.mjs.
 *
 * Regression guard: server.json carries the package version as BARE JSON values
 * (root `.version` and `.packages[0].version`). The audit's generic line-scan
 * version check requires an MCP marker on the same line, which never matched
 * those bare `"version": "x.y.z"` lines — so a desynced server.json passed the
 * publish gate silently and caused a Registry 400 "duplicate version" in
 * release 1.13.1. The `checkServerJsonVersion` helper closes that gap; these
 * tests prove it FAILS on drift and PASSES when synced.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// dist/__tests__/ → repo root is ../../ ; scripts + server.json live at root.
const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..", "..");
const SERVER_JSON_PATH = join(REPO_ROOT, "server.json");
const PKG_PATH = join(REPO_ROOT, "package.json");

// Import the pure helper from the audit script. The script is import-safe:
// its CLI body is guarded by an `if (isMain)` check, so importing it does not
// run the audit or call process.exit.
const auditScriptUrl = pathToFileURL(
  resolve(REPO_ROOT, "scripts", "audit-mcp-refs.mjs"),
).href;
const auditMod = await import(auditScriptUrl);
const checkServerJsonVersion = auditMod.checkServerJsonVersion as (
  serverJson: unknown,
  expectedVersion: string,
) => Array<{ kind: string; jsonPath: string; found: unknown; expected: string }>;
type ReleaseProjectionInput = {
  packageJson: { version: string; description: string };
  glamaJson: { version: string; description: string };
  releasesJson: {
    version: string;
    mcpToolCount: number;
    products: { mcp_server: { version: string } };
    releases: Array<Record<string, unknown> & { version: string }>;
    surfaceCounts: Record<string, { tools: number; resources: number; prompts: number }>;
  };
  anthropicManifest: {
    version: string;
    description: string;
    packages: Array<{ version: string }>;
  };
  readme: string;
  changelog: string;
  capabilityContract: {
    catalogue: { canonicalOperations: number };
    surfaces: Record<string, { tools: unknown[]; resources: unknown[]; prompts: unknown[] }>;
  };
  skillDocuments: string[];
};
const checkCurrentReleaseProjections = auditMod.checkCurrentReleaseProjections as (
  input: ReleaseProjectionInput,
  expectedVersion: string,
) => Array<{ kind: string; jsonPath: string; found: unknown; expected: unknown }>;

const SOT_VERSION = JSON.parse(readFileSync(PKG_PATH, "utf8")).version as string;

function releaseProjectionInput(): ReleaseProjectionInput {
  return {
    packageJson: JSON.parse(readFileSync(PKG_PATH, "utf8")),
    glamaJson: JSON.parse(readFileSync(join(REPO_ROOT, "glama.json"), "utf8")),
    releasesJson: JSON.parse(readFileSync(
      join(REPO_ROOT, "workers", "remote-mcp", "public", "releases.json"),
      "utf8",
    )),
    anthropicManifest: JSON.parse(readFileSync(
      join(REPO_ROOT, "marketplace", "anthropic", "connector", "manifest.json"),
      "utf8",
    )),
    readme: readFileSync(join(REPO_ROOT, "README.md"), "utf8"),
    changelog: readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8"),
    capabilityContract: JSON.parse(readFileSync(
      join(REPO_ROOT, "src", "__tests__", "fixtures", "public-capability-contract.json"),
      "utf8",
    )),
    skillDocuments: [
      readFileSync(join(REPO_ROOT, "skill", "SKILL.md"), "utf8"),
      readFileSync(join(REPO_ROOT, "skills", "frihet-mcp", "SKILL.md"), "utf8"),
    ],
  };
}

describe("server.json version gate", () => {
  test("exports a checkServerJsonVersion helper", () => {
    assert.equal(typeof checkServerJsonVersion, "function");
  });

  test("real server.json is in sync with package.json (no drift)", () => {
    const serverJson = JSON.parse(readFileSync(SERVER_JSON_PATH, "utf8"));
    const drifts = checkServerJsonVersion(serverJson, SOT_VERSION);
    assert.deepEqual(
      drifts,
      [],
      `server.json must match SoT ${SOT_VERSION} — drift: ${JSON.stringify(drifts)}`,
    );
  });

  test("reports STALE when root .version drifts", () => {
    const serverJson = JSON.parse(readFileSync(SERVER_JSON_PATH, "utf8"));
    serverJson.version = "9.9.9";
    const drifts = checkServerJsonVersion(serverJson, SOT_VERSION);
    assert.equal(drifts.length, 1, "exactly one drift expected");
    assert.equal(drifts[0].jsonPath, ".version");
    assert.equal(drifts[0].found, "9.9.9");
    assert.equal(drifts[0].expected, SOT_VERSION);
  });

  test("reports STALE when .packages[0].version drifts", () => {
    const serverJson = JSON.parse(readFileSync(SERVER_JSON_PATH, "utf8"));
    serverJson.packages[0].version = "0.0.1";
    const drifts = checkServerJsonVersion(serverJson, SOT_VERSION);
    assert.equal(drifts.length, 1);
    assert.equal(drifts[0].jsonPath, ".packages[0].version");
    assert.equal(drifts[0].found, "0.0.1");
  });

  test("reports BOTH fields when both drift", () => {
    const serverJson = JSON.parse(readFileSync(SERVER_JSON_PATH, "utf8"));
    serverJson.version = "2.0.0";
    serverJson.packages[0].version = "2.0.0";
    const drifts = checkServerJsonVersion(serverJson, SOT_VERSION);
    assert.equal(drifts.length, 2);
    assert.deepEqual(
      drifts.map((d) => d.jsonPath).sort(),
      [".packages[0].version", ".version"],
    );
  });

  test("treats a missing version field as drift (not a silent pass)", () => {
    const serverJson = JSON.parse(readFileSync(SERVER_JSON_PATH, "utf8"));
    delete serverJson.version;
    const drifts = checkServerJsonVersion(serverJson, SOT_VERSION);
    assert.equal(drifts.length, 1);
    assert.equal(drifts[0].jsonPath, ".version");
    assert.equal(drifts[0].found, undefined);
  });

  // End-to-end proof the gate fires on a real desynced file, written to a temp
  // copy so the repo's server.json is never mutated. We reproduce the exact
  // helper-driven check the CLI runs, then confirm the synced copy is clean.
  test("temp-file round trip: desync fails, sync passes", () => {
    const dir = mkdtempSync(join(tmpdir(), "frihet-serverjson-"));
    try {
      const original = readFileSync(SERVER_JSON_PATH, "utf8");
      const tmpFile = join(dir, "server.json");

      // Desync the temp copy.
      const desynced = JSON.parse(original);
      desynced.version = "0.0.0-stale";
      writeFileSync(tmpFile, JSON.stringify(desynced, null, 2) + "\n");

      const staleDrifts = checkServerJsonVersion(
        JSON.parse(readFileSync(tmpFile, "utf8")),
        SOT_VERSION,
      );
      assert.ok(staleDrifts.length > 0, "desynced temp file must report STALE");

      // Re-sync and confirm clean.
      writeFileSync(tmpFile, original);
      const cleanDrifts = checkServerJsonVersion(
        JSON.parse(readFileSync(tmpFile, "utf8")),
        SOT_VERSION,
      );
      assert.deepEqual(cleanDrifts, [], "synced temp file must pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("current release projection gate", () => {
  test("real package-facing projections match generated profile truth", () => {
    assert.deepEqual(checkCurrentReleaseProjections(releaseProjectionInput(), SOT_VERSION), []);
  });

  test("bare JSON version drift cannot pass the line-oriented audit", () => {
    const mutations: Array<[string, (input: ReleaseProjectionInput) => void]> = [
      ["glama", (input) => { input.glamaJson.version = "0.0.0"; }],
      ["default Worker release root", (input) => { input.releasesJson.version = "0.0.0"; }],
      ["default Worker product", (input) => { input.releasesJson.products.mcp_server.version = "0.0.0"; }],
      ["Anthropic root", (input) => { input.anthropicManifest.version = "0.0.0"; }],
      ["Anthropic npm package", (input) => { input.anthropicManifest.packages[0].version = "0.0.0"; }],
      ["skill frontmatter", (input) => { input.skillDocuments[0] = input.skillDocuments[0]!.replace("  version: 1.18.0", "  version: 0.0.0"); }],
    ];
    for (const [label, mutate] of mutations) {
      const input = releaseProjectionInput();
      mutate(input);
      assert.ok(
        checkCurrentReleaseProjections(input, SOT_VERSION).length > 0,
        `${label} version drift must fail`,
      );
    }
  });

  test("canonical and per-profile count drift fails in prose and structured metadata", () => {
    const mutations: Array<[string, (input: ReleaseProjectionInput) => void]> = [
      ["package canonical prose", (input) => { input.packageJson.description = "157 canonical operations"; }],
      ["README generated surface", (input) => { input.readme = input.readme.replace("166 tool names, 7 resources, and 10 prompts", "165 tool names, 9 resources, and 10 prompts"); }],
      ["Glama remote surface", (input) => { input.glamaJson.description = "158 canonical operations"; }],
      ["release local resources", (input) => { input.releasesJson.surfaceCounts.localFull.resources = 9; }],
      ["release OpenAI prompts", (input) => { input.releasesJson.surfaceCounts.openaiFull.prompts = 10; }],
      ["skill catalogue", (input) => { input.skillDocuments[0] = input.skillDocuments[0]!.replaceAll("158 canonical operations", "157 canonical operations"); }],
      ["Anthropic remote profile", (input) => { input.anthropicManifest.description = input.anthropicManifest.description.replace("166 tool names, 7 resources, and 10 prompts", "163 tool names, 11 resources, and 10 prompts"); }],
    ];
    for (const [label, mutate] of mutations) {
      const input = releaseProjectionInput();
      mutate(input);
      assert.ok(
        checkCurrentReleaseProjections(input, SOT_VERSION).length > 0,
        `${label} drift must fail`,
      );
    }
  });

  test("README counts are bound to their exact profile labels", () => {
    const input = releaseProjectionInput();
    const localCounts = "163 tool names, 11 resources, and 10 prompts";
    const remoteCounts = "166 tool names, 7 resources, and 10 prompts";
    input.readme = input.readme
      .replace(localCounts, "__LOCAL_COUNTS__")
      .replace(remoteCounts, localCounts)
      .replace("__LOCAL_COUNTS__", remoteCounts);

    const drifts = checkCurrentReleaseProjections(input, SOT_VERSION);
    assert.deepEqual(
      drifts.map((drift) => drift.jsonPath).filter((path) => path.startsWith("README.md.")),
      ["README.md.localFull", "README.md.remoteGrouped"],
      "swapping otherwise-valid tuples between profile labels must fail",
    );
  });
});
