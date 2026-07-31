import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertOpenAIReviewContract,
  buildOpenAIReviewContract,
  captureOpenAIReviewMcpSurface,
  type JsonValue,
  type OpenAIReviewContract,
  type OpenAIReviewTool,
} from "../openai-review-contract.js";

const SNAPSHOT_PATH = fileURLToPath(
  new URL(
    "../../src/__tests__/fixtures/openai-review-descriptor.snapshot.json",
    import.meta.url,
  ),
);
const EXPECTED = JSON.parse(
  readFileSync(SNAPSHOT_PATH, "utf8"),
) as OpenAIReviewContract;

function cloneExpected(): OpenAIReviewContract {
  return structuredClone(EXPECTED);
}

function findTool(contract: OpenAIReviewContract, name: string): OpenAIReviewTool {
  const tool = contract.tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `fixture must contain ${name}`);
  return tool;
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
  assert.ok(value && !Array.isArray(value) && typeof value === "object");
  return value;
}

function expectMutationRejected(
  mutate: (contract: OpenAIReviewContract) => void,
): void {
  const actual = cloneExpected();
  mutate(actual);
  assert.throws(() => assertOpenAIReviewContract(actual, EXPECTED));
}

function reverseObjectKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseObjectKeys(child)]),
    );
  }
  return value;
}

test("real tools/list composition exactly matches the frozen review descriptor", async () => {
  const surface = await captureOpenAIReviewMcpSurface();
  const actual = buildOpenAIReviewContract(surface, EXPECTED.oauth);
  assert.doesNotThrow(() => assertOpenAIReviewContract(actual, EXPECTED));
});

test("canonicalization ignores only object-key and tools/list ordering noise", () => {
  const reordered = reverseObjectKeys(
    cloneExpected() as unknown as JsonValue,
  ) as unknown as OpenAIReviewContract;
  reordered.tools.reverse();
  assert.doesNotThrow(() => assertOpenAIReviewContract(reordered, EXPECTED));
});

test("mutation selftest: tool removal turns the checker red", () => {
  expectMutationRejected((contract) => {
    contract.tools = contract.tools.filter((tool) => tool.name !== "get_invoice");
  });
});

test("mutation selftest: tool rename turns the checker red", () => {
  expectMutationRejected((contract) => {
    findTool(contract, "get_invoice").name = "get_invoice_renamed";
  });
});

test("mutation selftest: description drift turns the checker red", () => {
  expectMutationRejected((contract) => {
    const tool = findTool(contract, "list_invoices");
    tool.description = `${String(tool.description)} drift`;
  });
});

test("mutation selftest: annotation flip turns the checker red", () => {
  expectMutationRejected((contract) => {
    const annotations = asObject(findTool(contract, "list_invoices").annotations);
    annotations.openWorldHint = !annotations.openWorldHint;
  });
});

test("mutation selftest: required input addition turns the checker red", () => {
  expectMutationRejected((contract) => {
    const inputSchema = asObject(findTool(contract, "list_invoices").inputSchema);
    const properties = asObject(inputSchema.properties);
    properties.reviewFreezeRequired = { type: "string" };
    const required = Array.isArray(inputSchema.required)
      ? inputSchema.required
      : [];
    inputSchema.required = [...required, "reviewFreezeRequired"];
  });
});

test("mutation selftest: sensitive schema field turns the checker red", () => {
  expectMutationRejected((contract) => {
    const inputSchema = asObject(findTool(contract, "list_invoices").inputSchema);
    const properties = asObject(inputSchema.properties);
    properties.password = { type: "string" };
  });
});

test("mutation selftest: documentNumber remains sensitive outside commercial-document tools", () => {
  expectMutationRejected((contract) => {
    const outputSchema = asObject(findTool(contract, "get_client").outputSchema);
    const properties = asObject(outputSchema.properties);
    properties.documentNumber = { type: "string" };
  });
});

test("mutation selftest: hidden tool leak turns the checker red", () => {
  expectMutationRejected((contract) => {
    const leaked = structuredClone(findTool(contract, "list_invoices"));
    leaked.name = "payroll_export";
    contract.tools.push(leaked);
  });
});

test("mutation selftest: OAuth issuer drift turns the checker red", () => {
  expectMutationRejected((contract) => {
    const authorizationServer = asObject(contract.oauth.authorizationServer);
    authorizationServer.issuer = "https://issuer.invalid";
  });
});

test("mutation selftest: protected-resource URL drift turns the checker red", () => {
  expectMutationRejected((contract) => {
    const protectedResource = asObject(contract.oauth.protectedResource);
    protectedResource.resource = "https://resource.invalid";
  });
});

test("mutation selftest: WWW-Authenticate resource_metadata drift turns the checker red", () => {
  expectMutationRejected((contract) => {
    const challenge = asObject(contract.oauth.wwwAuthenticate);
    challenge.resourceMetadataUrl = "https://resource.invalid/.well-known/oauth-protected-resource";
  });
});

test("mutation selftest: prompt or resource registration turns the checker red", () => {
  expectMutationRejected((contract) => {
    contract.prompts.push({ name: "hidden_prompt" });
  });
  expectMutationRejected((contract) => {
    contract.resources.push({ uri: "frihet://hidden-resource" });
  });
});
