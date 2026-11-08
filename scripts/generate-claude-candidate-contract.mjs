#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { captureClaudeCandidateContract, serializeClaudeCandidateContract } from "../dist/claude-candidate-contract.js";

const path = new URL("../src/__tests__/fixtures/claude-candidate-contract.json", import.meta.url);
const captured = await captureClaudeCandidateContract();
const serialized = serializeClaudeCandidateContract(captured);
if (process.argv.includes("--check")) {
  if (await readFile(path, "utf8") !== serialized) {
    throw new Error("Claude candidate descriptor drift; regenerate and review the SDK capture");
  }
  console.log(`Claude candidate matches: ${captured.catalogue.canonicalOperations} operations, ${Object.keys(captured.catalogue.aliases).length} aliases, ${captured.resources.local.length}/${captured.resources.remote.length} local/remote resources, ${captured.prompts.length} prompts`);
} else {
  await writeFile(path, serialized);
  console.log(`Wrote ${path.pathname}`);
}
