import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ListToolsRequestSchema as RootListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  assertOpenAIReviewContract,
  buildOpenAIReviewContract,
} from "../../dist/openai-review-contract.js";
import {
  captureOpenAIReviewMcpSurfaceFromWorker,
  WorkerListToolsRequestSchema,
} from "../../workers/remote-mcp/scripts/capture-openai-review.mjs";

const SNAPSHOT_PATH = fileURLToPath(
  new URL("../../src/__tests__/fixtures/openai-review-descriptor.snapshot.json", import.meta.url),
);
const EXPECTED = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
const REVIEWED_OAUTH_SCHEME = {
  type: "oauth2",
  scopes: ["frihet:workspace.manage"],
};

function countDescriptions(value) {
  if (Array.isArray(value)) {
    return value.reduce((total, child) => total + countDescriptions(child), 0);
  }
  if (!value || typeof value !== "object") return 0;
  return Object.entries(value).reduce(
    (total, [key, child]) => total + (key === "description" ? 1 : 0) + countDescriptions(child),
    0,
  );
}

test("deployed Worker SDK wire exactly matches the reviewed descriptor", async () => {
  assert.notEqual(
    WorkerListToolsRequestSchema,
    RootListToolsRequestSchema,
    "the deploy gate must exercise the Worker's separate SDK module instance",
  );

  const surface = await captureOpenAIReviewMcpSurfaceFromWorker();
  assert.equal(surface.tools.length, 33);
  assert.equal(surface.prompts.length, 0);
  assert.equal(surface.resources.length, 0);

  let schemaDescriptionCount = 0;
  let confirmationDescriptionCount = 0;
  let outputSchemaCount = 0;
  for (const tool of surface.tools) {
    assert.deepEqual(
      tool.securitySchemes,
      [REVIEWED_OAUTH_SCHEME],
      `${tool.name} must expose standard OAuth securitySchemes on the Worker wire`,
    );
    assert.deepEqual(
      tool._meta?.securitySchemes,
      [REVIEWED_OAUTH_SCHEME],
      `${tool.name} must expose the exact legacy OAuth mirror on the Worker wire`,
    );
    schemaDescriptionCount += countDescriptions(tool.inputSchema);
    confirmationDescriptionCount += Number(
      typeof tool.inputSchema?.properties?.confirm?.description === "string",
    );
    outputSchemaCount += Number(Boolean(tool.outputSchema));
  }

  assert.equal(schemaDescriptionCount, 151);
  assert.equal(confirmationDescriptionCount, 16);
  assert.equal(outputSchemaCount, 33);

  const actual = buildOpenAIReviewContract(surface, EXPECTED.oauth);
  assert.doesNotThrow(() => assertOpenAIReviewContract(actual, EXPECTED));
});
