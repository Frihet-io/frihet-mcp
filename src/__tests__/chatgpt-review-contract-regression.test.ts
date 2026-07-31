/**
 * Executable regressions for the ChatGPT-review tool/API boundary.
 *
 * These tests use the real FrihetClient against a local HTTP server and invoke
 * the registered tool handlers. They pin the wire bodies and the legacy
 * unpaginated webhook response shape, not just a hand-written mirror schema.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import { FrihetClient } from "../client.js";
import { registerCrmTools } from "../tools/crm.js";
import { registerWebhookTools } from "../tools/webhooks.js";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface ToolConfig {
  inputSchema?: Record<string, z.ZodType>;
  outputSchema?: {
    safeParse: (value: unknown) => { success: boolean; error?: unknown };
  };
}

interface RegisteredTool {
  config: ToolConfig;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

class StubMcpServer {
  readonly tools = new Map<string, RegisteredTool>();

  registerTool(
    name: string,
    config: ToolConfig,
    handler: (args: Record<string, unknown>) => Promise<ToolResult>,
  ): void {
    this.tools.set(name, { config, handler });
  }
}

interface CapturedRequest {
  method: string;
  path: string;
  query: string;
  body?: Record<string, unknown>;
}

let apiServer: Server;
let baseUrl: string;
let captured: CapturedRequest[];

const WEBHOOKS = [
  {
    id: "wh_1",
    name: "First",
    url: "https://example.com/first",
    events: ["invoice.created"],
    status: "active",
    hasSecret: false,
  },
  {
    id: "wh_2",
    name: "Second",
    url: "https://example.com/second",
    events: ["invoice.paid"],
    status: "inactive",
    hasSecret: false,
  },
  {
    id: "wh_3",
    name: "Third",
    url: "https://example.com/third",
    events: ["expense.created"],
    status: "active",
    hasSecret: true,
  },
];

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

before(async () => {
  apiServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const body = await readJsonBody(req);
    captured.push({
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.search,
      ...(body ? { body } : {}),
    });

    res.setHeader("Content-Type", "application/json");
    const send = (status: number, responseBody: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(responseBody));
    };

    if (url.pathname === "/webhooks" && req.method === "GET") {
      // Exact current ERP shape: complete list, no limit/offset fields.
      return send(200, { data: WEBHOOKS, total: WEBHOOKS.length, meta: { requestId: "req_list" } });
    }
    if (url.pathname === "/webhooks" && req.method === "POST") {
      return send(201, { data: { id: "wh_new", ...body, hasSecret: false }, meta: {} });
    }
    if (url.pathname === "/webhooks/wh_2" && req.method === "PATCH") {
      return send(200, { data: { ...WEBHOOKS[1], ...body }, meta: {} });
    }
    if (url.pathname === "/clients/client_1/activities" && req.method === "POST") {
      return send(201, {
        data: {
          id: "act_1",
          ...body,
          timestamp: "2026-07-31T10:00:00.000Z",
          createdAt: "2026-07-31T10:00:00.000Z",
        },
      });
    }

    return send(404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  const { port } = apiServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => apiServer.close(() => resolve()));
});

function makeTools(): StubMcpServer {
  const server = new StubMcpServer();
  const client = new FrihetClient("fri_test_key", baseUrl);
  registerWebhookTools(server as unknown as McpServer, client);
  registerCrmTools(server as unknown as McpServer, client);
  return server;
}

function toolInputSchema(tool: RegisteredTool): z.ZodObject<Record<string, z.ZodType>> {
  assert.ok(tool.config.inputSchema, "tool must publish an input schema");
  return z.object(tool.config.inputSchema);
}

async function invoke(
  server: StubMcpServer,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = server.tools.get(name);
  assert.ok(tool, `${name} must be registered`);
  const parsed = toolInputSchema(tool).parse(input);
  const result = await tool.handler(parsed);
  assert.notEqual(result.isError, true, `${name} must not return an MCP error`);
  assert.ok(result.structuredContent, `${name} must return structuredContent`);
  assert.equal(
    tool.config.outputSchema?.safeParse(result.structuredContent).success,
    true,
    `${name} structuredContent must satisfy its advertised output schema`,
  );
  return result;
}

describe("ChatGPT review: webhook tool contracts match the strict ERP API", () => {
  test("create_webhook requires name and translates active=false to status=inactive", async () => {
    captured = [];
    const server = makeTools();
    const tool = server.tools.get("create_webhook");
    assert.ok(tool);

    assert.equal(
      toolInputSchema(tool).safeParse({
        url: "https://example.com/hook",
        events: ["invoice.created"],
      }).success,
      false,
      "a request without the API-required name must be rejected before the network call",
    );

    await invoke(server, "create_webhook", {
      name: "Invoice notifications",
      url: "https://example.com/hook",
      events: ["invoice.created"],
      active: false,
    });

    assert.deepEqual(captured.at(-1), {
      method: "POST",
      path: "/webhooks",
      query: "",
      body: {
        name: "Invoice notifications",
        url: "https://example.com/hook",
        events: ["invoice.created"],
        status: "inactive",
      },
    });
  });

  test("update_webhook keeps the public active flag but never sends it to the strict API", async () => {
    captured = [];
    const server = makeTools();

    await invoke(server, "update_webhook", { id: "wh_2", active: true });

    assert.deepEqual(captured.at(-1), {
      method: "PATCH",
      path: "/webhooks/wh_2",
      query: "",
      body: { status: "active" },
    });
  });

  test("list_webhooks locally pages the ERP's unpaginated response", async () => {
    captured = [];
    const server = makeTools();

    const result = await invoke(server, "list_webhooks", { limit: 1, offset: 1 });

    assert.deepEqual(result.structuredContent, {
      data: [WEBHOOKS[1]],
      total: 3,
      meta: { requestId: "req_list" },
      limit: 1,
      offset: 1,
    });
    assert.deepEqual(captured.at(-1), {
      method: "GET",
      path: "/webhooks",
      query: "?limit=1&offset=1",
    });
  });
});

describe("ChatGPT review: CRM activity input never sends the rejected date field", () => {
  test("date is absent from the descriptor and stripped before invoking the handler", async () => {
    captured = [];
    const server = makeTools();
    const tool = server.tools.get("log_client_activity");
    assert.ok(tool);
    assert.equal("date" in (tool.config.inputSchema ?? {}), false);

    await invoke(server, "log_client_activity", {
      clientId: "client_1",
      type: "call",
      title: "Follow-up",
      description: "Discussed renewal",
      date: "2020-01-01T00:00:00.000Z",
    });

    assert.deepEqual(captured.at(-1), {
      method: "POST",
      path: "/clients/client_1/activities",
      query: "",
      body: {
        type: "call",
        title: "Follow-up",
        description: "Discussed renewal",
      },
    });
  });
});
