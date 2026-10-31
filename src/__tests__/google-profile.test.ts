import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GOOGLE_CANDIDATE_TOOLS,
  GOOGLE_CANDIDATE_TOOL_COUNT,
  applyGoogleProfile,
  googleToolResult,
} from "../google-profile.js";
import { registerMcpSurface, localMcpSurfaceComposition } from "../server-composition.js";
import type { IFrihetClient } from "../client-interface.js";

const stubClient: IFrihetClient = {
  get: async () => ({}),
  post: async () => ({}),
  patch: async () => ({}),
  delete: async () => ({}),
  put: async () => ({}),
  request: async () => ({}),
} as unknown as IFrihetClient;

test("google-profile: inventory matches exactly 18 curated small-business tools", () => {
  assert.equal(GOOGLE_CANDIDATE_TOOL_COUNT, 18);
  assert.equal(GOOGLE_CANDIDATE_TOOLS.size, 18);
  assert.ok(GOOGLE_CANDIDATE_TOOLS.has("get_business_context"));
  assert.ok(GOOGLE_CANDIDATE_TOOLS.has("get_monthly_summary"));
  assert.ok(GOOGLE_CANDIDATE_TOOLS.has("get_quarterly_taxes"));
  assert.ok(GOOGLE_CANDIDATE_TOOLS.has("list_invoices"));
  assert.ok(GOOGLE_CANDIDATE_TOOLS.has("get_invoice"));
  assert.ok(GOOGLE_CANDIDATE_TOOLS.has("search_invoices"));
  assert.ok(GOOGLE_CANDIDATE_TOOLS.has("list_expenses"));
  assert.ok(GOOGLE_CANDIDATE_TOOLS.has("create_expense"));
  assert.ok(GOOGLE_CANDIDATE_TOOLS.has("create_invoice"));
});

test("google-profile: registerMcpSurface in googleMode exposes exactly 18 tools, 0 resources, 0 prompts", () => {
  const server = new McpServer({ name: "test-google", version: "1.0.0" });
  const comp = localMcpSurfaceComposition(false, false, false, true);

  registerMcpSurface(server, stubClient, comp);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registeredTools = Object.keys((server as any)._registeredTools ?? {});
  assert.equal(registeredTools.length, 18);
  for (const name of registeredTools) {
    assert.ok(GOOGLE_CANDIDATE_TOOLS.has(name), `Unexpected tool in google profile: ${name}`);
  }

  // Resources and prompts must be 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registeredResources = Object.keys((server as any)._registeredResources ?? {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registeredPrompts = Object.keys((server as any)._registeredPrompts ?? {});
  assert.equal(registeredResources.length, 0);
  assert.equal(registeredPrompts.length, 0);
});

test("google-profile: create_invoice includes draft-only human-in-the-loop notice", () => {
  const server = new McpServer({ name: "test-google", version: "1.0.0" });
  const comp = localMcpSurfaceComposition(false, false, false, true);

  registerMcpSurface(server, stubClient, comp);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools?.["create_invoice"];
  assert.ok(tool);
  assert.match(tool.description, /Google Connected Apps: Generates an invoice strictly in 'draft' status/);
});

test("google-profile: redaction strips sensitive fiscal IDs and secrets from output", () => {
  const raw = {
    content: [{ type: "text", text: "Client tax ID: ESB12345678 and token: fri_sec_12345" }],
    structuredContent: {
      client: {
        name: "Acme",
        taxId: "ESB12345678",
      },
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const redacted = googleToolResult(raw) as any;
  assert.ok(redacted);
  assert.equal(redacted.structuredContent.client.taxId, undefined);
  assert.equal(redacted.structuredContent.client.name, "Acme");
});

test("google-profile: mutually exclusive flags throw before any registration", () => {
  const server = new McpServer({ name: "test-fail", version: "1.0.0" });
  const comp = localMcpSurfaceComposition(true, false, false, true); // both openai and google

  assert.throws(
    () => registerMcpSurface(server, stubClient, comp),
    /mutually exclusive/,
  );
});
