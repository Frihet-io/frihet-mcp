/**
 * Surface counts derived from the generated public-capability contract
 * (`npm run generate:public-capability-truth`), so adding a tool never needs a
 * hand-edited number in a test.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const contract = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../src/__tests__/fixtures/public-capability-contract.json",
    ),
    "utf8",
  ),
) as {
  catalogue: { canonicalOperations: number };
  surfaces: Record<string, { tools: unknown[]; resources: unknown[]; prompts: unknown[] }>;
};

export const CANONICAL_COUNT = contract.catalogue.canonicalOperations;
export const LOCAL_FULL_TOOLS = contract.surfaces.localFull!.tools.length;
export const REMOTE_GROUPED_TOOLS = contract.surfaces.remoteGrouped!.tools.length;
