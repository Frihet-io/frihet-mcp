import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  assertOpenAIReviewContract,
  buildOpenAIReviewContract,
  captureOpenAIReviewMcpSurface,
  type JsonValue,
  type OpenAIReviewContract,
  type OpenAIReviewTool,
} from "../openai-review-contract.js";
import { OPENAI_REVIEW_CONFIRM_REQUIRED_TOOLS } from "../openai-profile.js";

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

test("real Worker SDK tools/list exactly matches the reviewed descriptor", async () => {
  const workerRequire = createRequire(
    fileURLToPath(
      new URL("../../workers/remote-mcp/package.json", import.meta.url),
    ),
  );
  const workerListToolsRequestSchema = workerRequire(
    "@modelcontextprotocol/sdk/types.js",
  ).ListToolsRequestSchema;
  assert.notEqual(
    workerListToolsRequestSchema,
    ListToolsRequestSchema,
    "the gate must exercise the Worker's separate SDK module instance",
  );

  const surface = await captureOpenAIReviewMcpSurface();
  for (const tool of surface.tools) {
    assert.deepEqual(
      tool.securitySchemes,
      [{ type: "oauth2", scopes: ["frihet:workspace.manage"] }],
      `${tool.name} must expose standard top-level OAuth securitySchemes on the Worker wire`,
    );
  }
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

test("semantic gate: standard OAuth securitySchemes cannot disappear", () => {
  const actual = cloneExpected();
  delete findTool(actual, "list_invoices").securitySchemes;
  assert.throws(
    () => assertOpenAIReviewContract(actual, EXPECTED),
    /list_invoices\.securitySchemes must contain exactly one reviewed OAuth scheme/,
  );
});

test("semantic gate: legacy OAuth mirror cannot drift from the reviewed scope", () => {
  const actual = cloneExpected();
  const metadata = asObject(findTool(actual, "list_invoices")._meta);
  metadata.securitySchemes = [{ type: "oauth2", scopes: ["broader:scope"] }];
  assert.throws(
    () => assertOpenAIReviewContract(actual, EXPECTED),
    /list_invoices\._meta\.securitySchemes must require only the reviewed connector OAuth scope/,
  );
});

test("semantic gate: empty reviewed output object turns the checker red", () => {
  const actual = cloneExpected();
  const output = asObject(findTool(actual, "get_invoice").outputSchema);
  output.properties = {};
  assert.throws(
    () => assertOpenAIReviewContract(actual, EXPECTED),
    /must declare at least one reviewed property/,
  );
});

test("semantic gate: nested reviewed input objects must stay closed", () => {
  const actual = cloneExpected();
  const input = asObject(findTool(actual, "create_invoice").inputSchema);
  const properties = asObject(input.properties);
  const items = asObject(properties.items);
  const item = asObject(items.items);
  delete item.additionalProperties;
  assert.throws(
    () => assertOpenAIReviewContract(actual, EXPECTED),
    /create_invoice\.inputSchema\.properties\.items\.items must set additionalProperties=false/,
  );
});

test("semantic gate: reviewed list summaries cannot regain detail fields or larger pages", () => {
  const widenedOutput = cloneExpected();
  const output = asObject(findTool(widenedOutput, "list_invoices").outputSchema);
  const outputProperties = asObject(output.properties);
  const data = asObject(outputProperties.data);
  const item = asObject(data.items);
  const itemProperties = asObject(item.properties);
  itemProperties.notes = { type: "string" };
  assert.throws(
    () => assertOpenAIReviewContract(widenedOutput, EXPECTED),
    /list_invoices must expose only its reviewed summary fields/,
  );

  const largerPage = cloneExpected();
  const input = asObject(findTool(largerPage, "list_invoices").inputSchema);
  const inputProperties = asObject(input.properties);
  const limit = asObject(inputProperties.limit);
  limit.maximum = 100;
  assert.throws(
    () => assertOpenAIReviewContract(largerPage, EXPECTED),
    /list_invoices must cap reviewed pagination at 50 rows and offset 10000/,
  );
});

test("semantic gate: persisted expense labels and descriptions stay bounded", () => {
  const actual = cloneExpected();
  const input = asObject(findTool(actual, "update_expense").inputSchema);
  const properties = asObject(input.properties);
  const category = asObject(properties.category);
  category.maxLength = 10_000;
  assert.throws(
    () => assertOpenAIReviewContract(actual, EXPECTED),
    /update_expense\.category must be capped at 100 characters/,
  );
});

test("semantic gate: direct email delivery is absent from the reviewed surface", () => {
  assert.equal(EXPECTED.tools.some((tool) => tool.name === "send_quote"), false);
});

test("semantic gate: confirmation cannot disappear from reviewed side effects", () => {
  for (const name of OPENAI_REVIEW_CONFIRM_REQUIRED_TOOLS) {
    const actual = cloneExpected();
    const inputSchema = asObject(findTool(actual, name).inputSchema);
    const properties = asObject(inputSchema.properties);
    delete properties.confirm;
    inputSchema.required = (inputSchema.required as JsonValue[]).filter(
      (field) => field !== "confirm",
    );
    assert.throws(
      () => assertOpenAIReviewContract(actual, EXPECTED),
      /must expose confirm as a required literal-true reviewed input/,
    );
  }
});

test("semantic gate: raw PDF and webhook tools can never re-enter the reviewed surface", () => {
  for (const forbidden of [
    "get_invoice_pdf",
    "list_webhooks",
    "get_webhook",
    "create_webhook",
    "update_webhook",
    "delete_webhook",
    "apply_late_fee",
    "update_invoice",
    "mark_invoice_paid",
    "delete_invoice",
    "send_invoice",
  ]) {
    const actual = cloneExpected();
    findTool(actual, "get_invoice").name = forbidden;
    assert.throws(
      () => assertOpenAIReviewContract(actual, EXPECTED),
      /Unsafe tools are forbidden/,
    );
  }
});

test("semantic gate: discovery cannot advertise hidden business domains", () => {
  const actual = cloneExpected();
  const inputSchema = asObject(findTool(actual, "search_tools").inputSchema);
  const properties = asObject(inputSchema.properties);
  const group = asObject(properties.group);
  group.enum = [...(group.enum as JsonValue[]), "fiscal"];
  assert.throws(
    () => assertOpenAIReviewContract(actual, EXPECTED),
    /search_tools advertises hidden groups: fiscal/,
  );
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

test("mutation selftest: reviewed pagination widening turns the checker red", () => {
  const inputWidened = cloneExpected();
  const inputSchema = asObject(findTool(inputWidened, "list_client_notes").inputSchema);
  const inputProperties = asObject(inputSchema.properties);
  const limit = asObject(inputProperties.limit);
  limit.maximum = 100;
  assert.throws(
    () => assertOpenAIReviewContract(inputWidened, EXPECTED),
    /list_client_notes must cap reviewed pagination/,
  );

  const outputWidened = cloneExpected();
  const outputSchema = asObject(findTool(outputWidened, "list_client_notes").outputSchema);
  const outputProperties = asObject(outputSchema.properties);
  const data = asObject(outputProperties.data);
  data.maxItems = 100;
  assert.throws(
    () => assertOpenAIReviewContract(outputWidened, EXPECTED),
    /list_client_notes must cap reviewed structured output/,
  );
});

test("mutation selftest: sensitive schema field turns the checker red", () => {
  expectMutationRejected((contract) => {
    const inputSchema = asObject(findTool(contract, "list_invoices").inputSchema);
    const properties = asObject(inputSchema.properties);
    properties.password = { type: "string" };
  });
});

test("mutation selftest: clientTaxId reviewed input turns the checker red", () => {
  expectMutationRejected((contract) => {
    const inputSchema = asObject(findTool(contract, "create_invoice").inputSchema);
    const properties = asObject(inputSchema.properties);
    properties.clientTaxId = { type: "string" };
  });
});

test("semantic gate: create_invoice can never expose a lifecycle status", () => {
  const actual = cloneExpected();
  const inputSchema = asObject(findTool(actual, "create_invoice").inputSchema);
  const properties = asObject(inputSchema.properties);
  properties.status = { type: "string", enum: ["draft", "sent"] };
  assert.throws(
    () => assertOpenAIReviewContract(actual, EXPECTED),
    /draft-only and minimal/,
  );
});

test("semantic gate: reviewed quote creation can never expose lifecycle status", () => {
  const actual = cloneExpected();
  const inputSchema = asObject(findTool(actual, "create_quote").inputSchema);
  const properties = asObject(inputSchema.properties);
  properties.status = { type: "string", enum: ["draft", "accepted", "rejected"] };
  assert.throws(
    () => assertOpenAIReviewContract(actual, EXPECTED),
    /lifecycle status|draft-only/,
  );
});

test("semantic gate: reviewed create outputs require number and literal draft status", () => {
  for (const [name, numberField] of [
    ["create_invoice", "invoiceNumber"],
    ["create_quote", "quoteNumber"],
  ] as const) {
    const missingNumber = cloneExpected();
    const output = asObject(findTool(missingNumber, name).outputSchema);
    output.required = (output.required as JsonValue[]).filter(
      (field) => field !== numberField,
    );
    assert.throws(
      () => assertOpenAIReviewContract(missingNumber, EXPECTED),
      new RegExp(`${name} output schema must require its reserved number`),
    );

    const widenedStatus = cloneExpected();
    const widenedOutput = asObject(findTool(widenedStatus, name).outputSchema);
    const properties = asObject(widenedOutput.properties);
    properties.status = { type: "string" };
    assert.throws(
      () => assertOpenAIReviewContract(widenedStatus, EXPECTED),
      new RegExp(`${name} output schema must require its reserved number`),
    );
  }
});

test("semantic gate: delete_quote outcome cannot become optional or ambiguous", () => {
  const missingOutcome = cloneExpected();
  const output = asObject(findTool(missingOutcome, "delete_quote").outputSchema);
  output.required = (output.required as JsonValue[]).filter(
    (field) => field !== "outcome",
  );
  assert.throws(
    () => assertOpenAIReviewContract(missingOutcome, EXPECTED),
    /delete_quote output schema must require a successful deleted\/cancelled outcome/,
  );

  const impossibleStatus = cloneExpected();
  const impossibleOutput = asObject(findTool(impossibleStatus, "delete_quote").outputSchema);
  const properties = asObject(impossibleOutput.properties);
  properties.status = { type: "string" };
  assert.throws(
    () => assertOpenAIReviewContract(impossibleStatus, EXPECTED),
    /delete_quote output schema must require a successful deleted\/cancelled outcome/,
  );
});

test("semantic gate: reviewed outputs cannot reintroduce unusable item or activity metadata", () => {
  const lineItemLeak = cloneExpected();
  const invoiceOutput = asObject(findTool(lineItemLeak, "get_invoice").outputSchema);
  const invoiceProperties = asObject(invoiceOutput.properties);
  const items = asObject(invoiceProperties.items);
  const lineItem = asObject(items.items);
  asObject(lineItem.properties).id = { type: "string" };
  assert.throws(
    () => assertOpenAIReviewContract(lineItemLeak, EXPECTED),
    /get_invoice must omit unusable reviewed line-item ids/,
  );

  const activityLeak = cloneExpected();
  const activityOutput = asObject(findTool(activityLeak, "log_client_activity").outputSchema);
  asObject(activityOutput.properties).createdBy = {
    type: "string",
    enum: ["system", "user"],
  };
  assert.throws(
    () => assertOpenAIReviewContract(activityLeak, EXPECTED),
    /log_client_activity must omit the unnecessary reviewed activity creator marker/,
  );
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
