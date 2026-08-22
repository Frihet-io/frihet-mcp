#!/usr/bin/env node
/**
 * CLI Runner for Frihet MCP SDK Compatibility & Golden Baseline Canary.
 *
 * Usage:
 *   node scripts/canary-mcp.mjs              # Run canary checks & print table
 *   node scripts/canary-mcp.mjs --check      # Compare against committed baseline snapshot (exit 1 on drift)
 *   node scripts/canary-mcp.mjs --snapshot   # Regenerate golden baseline snapshot file
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runMcpBaseline,
  serializeMcpBaseline,
  assertMcpBaseline,
} from "../dist/canary/mcp-harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const SNAPSHOT_PATH = path.join(REPO_ROOT, "artifacts", "mcp-v2-baseline.json");

async function main() {
  const args = process.argv.slice(2);
  const isCheckMode = args.includes("--check");
  const isSnapshotMode = args.includes("--snapshot");

  const report = await runMcpBaseline();

  if (isSnapshotMode) {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    const serialized = serializeMcpBaseline(report);
    fs.writeFileSync(SNAPSHOT_PATH, serialized, "utf8");
    console.log(`[canary:mcp] Golden baseline snapshot written to: ${SNAPSHOT_PATH}`);
    console.log(`[canary:mcp] Total tools: ${report.summary.totalTools} (${report.summary.canonicalOperations} canonical, ${report.summary.fiscalAliases} aliases)`);
    console.log(`[canary:mcp] Resources: ${report.summary.resources}, Prompts: ${report.summary.prompts}`);
    process.exit(0);
  }

  if (isCheckMode) {
    if (!fs.existsSync(SNAPSHOT_PATH)) {
      console.error(`[canary:mcp:check] ERROR: Golden baseline snapshot not found at ${SNAPSHOT_PATH}`);
      console.error(`Run 'npm run canary:mcp:snapshot' to generate the baseline snapshot.`);
      process.exit(1);
    }

    const baselineRaw = fs.readFileSync(SNAPSHOT_PATH, "utf8");
    const baseline = JSON.parse(baselineRaw);

    try {
      assertMcpBaseline(report, baseline);
      console.log(`[canary:mcp:check] PASS — Verified against MCP SDK golden baseline`);
      console.log(`[canary:mcp:check] ${report.summary.totalTools} tools, ${report.summary.resources} resources, ${report.summary.prompts} prompts match exact contract`);
      process.exit(0);
    } catch (err) {
      console.error(`[canary:mcp:check] FAIL — MCP SDK baseline contract drift detected:`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  // Default mode: formatted table output
  const line = "=".repeat(80);
  const subline = "-".repeat(80);

  console.log(line);
  console.log("       FRIHET MCP COMPATIBILITY LAB — SDK CONTRACT & V2 BASELINE        ");
  console.log(line);
  console.log(`Harness Mode      : ${report.harnessMode}`);
  console.log(`Inspector Target  : ${report.inspectorPinnedVersion} (pinned reference)`);
  console.log(`Server Info       : ${report.serverInfo.name} v${report.serverInfo.version}`);
  console.log(subline);
  console.log(`Catalogue Tools   : ${report.summary.totalTools} (${report.summary.canonicalOperations} canonical + ${report.summary.fiscalAliases} aliases)`);
  console.log(`Resources         : ${report.summary.resources}`);
  console.log(`Prompts           : ${report.summary.prompts}`);
  console.log(subline);
  console.log("CHECK MATRIX:");

  for (const check of report.checkMatrix) {
    const statusFormatted = `[${check.status}]`.padEnd(16);
    const duration = check.durationMs !== undefined ? ` (${check.durationMs}ms)` : "";
    console.log(`  ${statusFormatted} ${check.name.padEnd(35)}: ${check.detail}${duration}`);
  }

  console.log(subline);
  console.log(
    `SUMMARY: Total: ${report.summary.checks.total} | ` +
    `Pass: ${report.summary.checks.pass} | ` +
    `Fail: ${report.summary.checks.fail} | ` +
    `Unsupported: ${report.summary.checks.unsupported} | ` +
    `Not Exercised: ${report.summary.checks.notExercised}`
  );
  console.log(`OVERALL STATUS: ${report.summary.overallStatus}`);
  console.log(line);

  if (report.summary.overallStatus === "FAIL" || report.summary.checks.fail > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[canary:mcp] Fatal error:", err);
  process.exit(1);
});
