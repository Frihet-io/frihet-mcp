#!/usr/bin/env node
/**
 * Executable CLI runner for the Daily Operational Brief prototype
 * ("¿Qué debería revisar hoy en mi negocio y por qué?").
 *
 * Runs both synthetic scenarios (or connects to a live workspace if FRIHET_API_KEY
 * is set with `--live`) and writes the structured receipt + markdown output.
 */

import {
  buildScenario1CompleteWorkspaceClient,
  buildScenario2PartialCoverageClient,
} from "../dist/__tests__/daily-operational-brief.test.js";
import { generateDailyOperationalBrief } from "../dist/workflows/daily-operational-brief.js";

const scenario1Calls = [];
const scenario1Brief = await generateDailyOperationalBrief(
  buildScenario1CompleteWorkspaceClient(scenario1Calls),
  { asOfDate: "2026-10-28", pageLimit: 20 },
);

const scenario2Calls = [];
const scenario2Brief = await generateDailyOperationalBrief(
  buildScenario2PartialCoverageClient(scenario2Calls),
  { asOfDate: "2026-10-28", pageLimit: 2 },
);

const output = {
  generatedAt: new Date().toISOString(),
  scenarios: {
    scenario1_complete_workspace: {
      callsExecuted: scenario1Calls,
      brief: scenario1Brief,
    },
    scenario2_partial_multi_page: {
      callsExecuted: scenario2Calls,
      brief: scenario2Brief,
    },
  },
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log("=== ESCENARIO 1: COBERTURA COMPLETA ===");
  console.log(scenario1Brief.markdown);
  console.log("\n=== ESCENARIO 2: COBERTURA PARCIAL (MULTI-PÁGINA) ===");
  console.log(scenario2Brief.markdown);
}
