#!/usr/bin/env node
/**
 * Executable CLI runner for the Daily Operational Brief
 * ("¿Qué debería revisar hoy en mi negocio y por qué?").
 *
 * Usage:
 *   npm run brief                           # Runs synthetic scenarios (complete + partial)
 *   npm run brief -- --live                 # Connects to live Frihet workspace via FRIHET_API_KEY
 *   npm run brief -- --live --json          # Live workspace structured JSON output
 *   npm run brief -- --json                 # Synthetic scenarios structured JSON output
 */

import { FrihetClient } from "../dist/client.js";
import {
  buildScenario1CompleteWorkspaceClient,
  buildScenario2PartialCoverageClient,
  generateDailyOperationalBrief,
} from "../dist/workflows/daily-operational-brief.js";

const isLive = process.argv.includes("--live");
const isJson = process.argv.includes("--json");
const asOfArg = process.argv.find((arg) => arg.startsWith("--as-of="));
const asOfDate = asOfArg ? asOfArg.slice("--as-of=".length) : undefined;

if (isLive) {
  const apiKey = process.env.FRIHET_API_KEY;
  if (!apiKey) {
    console.error("Error: FRIHET_API_KEY environment variable is required when running with --live.");
    process.exit(1);
  }
  const client = new FrihetClient({
    apiKey,
    apiUrl: process.env.FRIHET_API_URL ?? "https://api.frihet.io/v1",
  });
  const liveBrief = await generateDailyOperationalBrief(client, { asOfDate, pageLimit: 20 });
  if (isJson) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          mode: "live",
          brief: liveBrief,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(liveBrief.markdown);
  }
  process.exit(0);
}

const scenario1Calls = [];
const scenario1Brief = await generateDailyOperationalBrief(
  buildScenario1CompleteWorkspaceClient(scenario1Calls),
  { asOfDate: asOfDate ?? "2026-10-28", pageLimit: 20 },
);

const scenario2Calls = [];
const scenario2Brief = await generateDailyOperationalBrief(
  buildScenario2PartialCoverageClient(scenario2Calls),
  { asOfDate: asOfDate ?? "2026-10-28", pageLimit: 2 },
);

const output = {
  generatedAt: new Date().toISOString(),
  mode: "synthetic",
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

if (isJson) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log("=== ESCENARIO 1: COBERTURA COMPLETA ===");
  console.log(scenario1Brief.markdown);
  console.log("\n=== ESCENARIO 2: COBERTURA PARCIAL (MULTI-PÁGINA) ===");
  console.log(scenario2Brief.markdown);
}
