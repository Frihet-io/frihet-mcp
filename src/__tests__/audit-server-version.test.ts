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

const SOT_VERSION = JSON.parse(readFileSync(PKG_PATH, "utf8")).version as string;

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
