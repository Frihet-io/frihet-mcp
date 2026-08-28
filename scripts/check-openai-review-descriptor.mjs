#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  assertOpenAIReviewContract,
  buildOpenAIReviewContract,
  serializeOpenAIReviewContract,
} from "../dist/openai-review-contract.js";
import {
  buildOpenAIReviewOAuthContract,
} from "../dist/openai-review-oauth.js";
import {
  captureOpenAIReviewMcpSurfaceFromWorker,
} from "../workers/remote-mcp/scripts/capture-openai-review.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const snapshotPath = fileURLToPath(
  new URL("../src/__tests__/fixtures/openai-review-descriptor.snapshot.json", import.meta.url),
);
const workerLockPath = fileURLToPath(
  new URL("../workers/remote-mcp/package-lock.json", import.meta.url),
);

async function resolvedOAuthProviderVersion() {
  const lock = JSON.parse(await readFile(workerLockPath, "utf8"));
  const version = lock.packages?.[
    "node_modules/@cloudflare/workers-oauth-provider"
  ]?.version;
  if (typeof version !== "string" || !version) {
    throw new Error(
      "Cannot resolve @cloudflare/workers-oauth-provider from the Worker lockfile",
    );
  }
  return version;
}

async function captureCurrentContract() {
  const surface = await captureOpenAIReviewMcpSurfaceFromWorker();
  const oauth = {
    providerPackageVersion: await resolvedOAuthProviderVersion(),
    ...buildOpenAIReviewOAuthContract(),
  };
  return buildOpenAIReviewContract(surface, oauth);
}

async function main() {
  const actual = await captureCurrentContract();
  if (process.argv.includes("--print-current")) {
    process.stdout.write(serializeOpenAIReviewContract(actual));
    return;
  }

  if (process.argv.length > 2) {
    throw new Error(
      "Unknown argument. This checker deliberately has no snapshot update mode; use --print-current for review only.",
    );
  }

  const expected = JSON.parse(await readFile(snapshotPath, "utf8"));
  assertOpenAIReviewContract(actual, expected);
  console.log(
    `OpenAI review descriptor matches the reviewed ${actual.tools.length}-business-tool full-description surface (${root})`,
  );
}

main().catch((error) => {
  console.error(
    `OpenAI review descriptor check failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
