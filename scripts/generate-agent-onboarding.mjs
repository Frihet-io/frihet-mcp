#!/usr/bin/env node
// Generate docs/agent-onboarding.json from the REAL registered MCP surface.
//
//   node scripts/generate-agent-onboarding.mjs           # write
//   node scripts/generate-agent-onboarding.mjs --check    # exit 1 on drift
//
// The tool lists inside the descriptor (confirm-guarded tools, tools with
// external side effects) and every count are captured through the MCP SDK
// against the same registration path the server uses. Hand-editing the JSON
// makes --check fail, which is the point: the descriptor is a projection of the
// server, never a parallel claim about it.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  captureAgentOnboardingDescriptor,
  serializeAgentOnboardingDescriptor,
} from "../dist/agent-onboarding.js";

const OUT = fileURLToPath(new URL("../docs/agent-onboarding.json", import.meta.url));
const CHECK = process.argv.includes("--check");

const serialized = serializeAgentOnboardingDescriptor(
  await captureAgentOnboardingDescriptor(),
);

if (!CHECK) {
  await writeFile(OUT, serialized);
  console.log(`GREEN — wrote docs/agent-onboarding.json (${serialized.length} bytes)`);
  process.exit(0);
}

let committed;
try {
  committed = await readFile(OUT, "utf8");
} catch {
  console.error(
    "RED — docs/agent-onboarding.json is missing. Run: npm run generate:agent-onboarding",
  );
  process.exit(1);
}

if (committed !== serialized) {
  console.error(
    "RED — docs/agent-onboarding.json drifted from the live MCP surface.\n" +
      "Run: npm run generate:agent-onboarding, then commit the result.",
  );
  process.exit(1);
}

console.log("GREEN — docs/agent-onboarding.json matches the live MCP surface");
