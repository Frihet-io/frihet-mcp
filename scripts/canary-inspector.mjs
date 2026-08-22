#!/usr/bin/env node

/**
 * Canary Inspector Runner Script.
 *
 * Runs the MCP Inspector 2.3.0 compatibility harness and validates Frihet MCP
 * baseline before-state.
 *
 * Usage:
 *   node scripts/canary-inspector.mjs              # Run informational canary checks
 *   node scripts/canary-inspector.mjs --check      # Assert against committed baseline snapshot
 *   node scripts/canary-inspector.mjs --snapshot   # Regenerate golden baseline snapshot
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  assertInspectorBaseline,
  runInspectorBaseline,
  serializeInspectorBaseline,
} from "../dist/canary/inspector-harness.js";

const snapshotPath = fileURLToPath(
  new URL("../artifacts/mcp-inspector-v2-baseline.json", import.meta.url),
);

const isCheckMode = process.argv.includes("--check");
const isSnapshotMode = process.argv.includes("--snapshot");

try {
  const actual = await runInspectorBaseline();

  if (isSnapshotMode) {
    const serialized = serializeInspectorBaseline(actual);
    await writeFile(snapshotPath, serialized);
    console.log(`[canary:inspector] Golden baseline snapshot written to: ${snapshotPath}`);
    console.log(`[canary:inspector] Total tools: ${actual.summary.totalTools} (${actual.summary.canonicalOperations} canonical, ${actual.summary.fiscalAliases} aliases)`);
    console.log(`[canary:inspector] Resources: ${actual.summary.resources}, Prompts: ${actual.summary.prompts}`);
    process.exit(0);
  }

  if (isCheckMode) {
    const expected = JSON.parse(await readFile(snapshotPath, "utf8"));
    assertInspectorBaseline(actual, expected);
    console.log(`[canary:inspector:check] PASS — Verified against Inspector ${actual.inspectorVersion} golden baseline`);
    console.log(`[canary:inspector:check] ${actual.summary.totalTools} tools, ${actual.summary.resources} resources, ${actual.summary.prompts} prompts match exact contract`);
    process.exit(0);
  }

  // Default Informational Mode
  console.log("================================================================================");
  console.log("             FRIHET MCP COMPATIBILITY LAB — INSPECTOR 2.3.0 CANARY              ");
  console.log("================================================================================");
  console.log(`Inspector Version : ${actual.inspectorVersion}`);
  console.log(`Protocol Version  : ${actual.protocolVersion}`);
  console.log(`Server Name       : ${actual.serverInfo.name} v${actual.serverInfo.version}`);
  console.log("--------------------------------------------------------------------------------");
  console.log(`Catalogue Tools   : ${actual.summary.totalTools} (${actual.summary.canonicalOperations} canonical + ${actual.summary.fiscalAliases} aliases)`);
  console.log(`Resources         : ${actual.summary.resources}`);
  console.log(`Prompts           : ${actual.summary.prompts}`);
  console.log("--------------------------------------------------------------------------------");
  console.log("CHECK MATRIX:");
  for (const check of actual.checkMatrix) {
    const statusTag = check.status === "PASS"
      ? "\x1b[32m[PASS]\x1b[0m"
      : check.status === "FAIL"
      ? "\x1b[31m[FAIL]\x1b[0m"
      : check.status === "UNSUPPORTED"
      ? "\x1b[33m[UNSUPPORTED]\x1b[0m"
      : "\x1b[34m[NOT_EXERCISED]\x1b[0m";
    const duration = check.durationMs !== undefined ? ` (${check.durationMs}ms)` : "";
    console.log(`  ${statusTag} ${check.name.padEnd(42)} : ${check.detail}${duration}`);
  }
  console.log("--------------------------------------------------------------------------------");
  console.log(`SUMMARY: Total: ${actual.summary.checks.total} | Pass: ${actual.summary.checks.pass} | Fail: ${actual.summary.checks.fail} | Unsupported: ${actual.summary.checks.unsupported} | Not Exercised: ${actual.summary.checks.notExercised}`);
  console.log(`OVERALL STATUS: ${actual.summary.overallStatus === "PASS" ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}`);
  console.log("================================================================================");

  if (actual.summary.overallStatus !== "PASS") {
    process.exit(1);
  }
} catch (error) {
  console.error("\x1b[31m[canary:inspector] ERROR:\x1b[0m", error instanceof Error ? error.message : error);
  process.exit(1);
}
