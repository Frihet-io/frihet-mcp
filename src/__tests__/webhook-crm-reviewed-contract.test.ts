/**
 * Current ERP contract regression for webhook and CRM activity tools tracked
 * by #139. Direct MCP keeps both contracts; the narrower OpenAI profile must
 * exclude webhook configuration entirely. The tests cross both production
 * seams: the real HTTP client and the MCP SDK's real input/output validators.
 */

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { FrihetClient } from "../client.js";
import { DemoFrihetClient } from "../demo-client.js";
import { applyOpenAIReviewProfiles } from "../openai-profile.js";
import { registerCrmTools } from "../tools/crm.js";
import { registerWebhookTools } from "../tools/webhooks.js";
import {
  activityItemOutput,
  formatUnpaginatedListResponse,
  webhookCreateOutput,
  webhookItemOutput,
  webhookListOutput,
} from "../tools/shared.js";

const WEBHOOK = {
  id: "wh_139",
  userId: "user_139",
  name: "Reviewed webhook",
  url: "https://example.com/frihet-hook",
  events: ["invoice.paid"],
  status: "paused",
  metadata: { source: "contract-139" },
  hasSecret: true,
  pausedReason: "maintenance",
  lastTriggeredAt: "2026-08-16T08:45:00.000Z",
  createdAt: "2026-08-16T09:00:00.000Z",
  updatedAt: "2026-08-16T09:00:00.000Z",
};

const WEBHOOK_WIRE = {
  ...WEBHOOK,
  lastTriggeredAt: { _seconds: 1_786_869_900, _nanoseconds: 0 },
};

const ACTIVITY = {
  id: "act_139",
  type: "email_sent",
  title: "Sent contract follow-up",
  description: "Reviewed current activity shape",
  metadata: { channel: "email" },
  timestamp: "2026-08-16T10:00:00.000Z",
  createdBy: "user",
  createdAt: "2026-08-16T10:00:00.000Z",
  updatedAt: "2026-08-16T10:00:00.000Z",
};

interface SeenRequest {
  method: string;
  path: string;
  search: string;
  body?: Record<string, unknown>;
}

const seen: SeenRequest[] = [];
let httpServer: Server;
let baseUrl: string;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

before(async () => {
  httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const body = method === "POST" || method === "PATCH" ? await readJson(req) : undefined;
    seen.push({ method, path: url.pathname, search: url.search, ...(body ? { body } : {}) });

    if (method === "GET" && url.pathname === "/webhooks") {
      return sendJson(res, 200, {
        data: [{ ...WEBHOOK_WIRE, secret: "backend-regression-must-be-stripped" }],
        total: 1,
        meta: { requestId: "req_webhook_list" },
      });
    }
    if (method === "GET" && url.pathname === "/webhooks/wh_139") {
      return sendJson(res, 200, {
        data: { ...WEBHOOK_WIRE, secret: "backend-regression-must-be-stripped" },
        meta: { requestId: "req_webhook_get" },
      });
    }
    if (method === "GET" && url.pathname === "/webhooks/wh_legacy") {
      return sendJson(res, 200, {
        data: {
          ...WEBHOOK,
          id: "wh_legacy",
          active: true,
          secret: "must-not-surface-from-read",
        },
        meta: { requestId: "req_webhook_legacy" },
      });
    }
    if (method === "GET" && url.pathname === "/webhooks/wh_bad_timestamp") {
      return sendJson(res, 200, {
        data: {
          ...WEBHOOK,
          id: "wh_bad_timestamp",
          lastTriggeredAt: { _seconds: "not-a-number", _nanoseconds: 0 },
        },
        meta: { requestId: "req_webhook_bad_timestamp" },
      });
    }
    if (method === "POST" && url.pathname === "/webhooks") {
      const returnedSecret = body?.name === "Unrequested backend secret"
        ? "backend-secret-without-caller-value"
        : body?.name === "Mismatched backend secret"
          ? "different-from-caller-value"
          : body?.secret;
      const created = {
        ...WEBHOOK,
        id: "wh_created",
        name: body?.name,
        url: body?.url,
        events: body?.events,
        status: body?.status ?? "active",
        metadata: body?.metadata,
        hasSecret: typeof returnedSecret === "string" && returnedSecret.length > 0,
        ...(typeof returnedSecret === "string" ? { secret: returnedSecret } : {}),
      };
      return sendJson(res, 201, { data: created, meta: { requestId: "req_webhook_create" } });
    }
    if (method === "PATCH" && url.pathname === "/webhooks/wh_139") {
      return sendJson(res, 200, {
        data: {
          ...WEBHOOK_WIRE,
          ...body,
          hasSecret: true,
          secret: "backend-regression-must-be-stripped",
          updatedAt: "2026-08-16T11:00:00.000Z",
        },
        meta: { requestId: "req_webhook_update" },
      });
    }
    if (method === "POST" && url.pathname === "/clients/client_139/activities") {
      if (body?.title === "Legacy fabricated activity") {
        return sendJson(res, 201, {
          data: {
            ...ACTIVITY,
            id: "act_legacy",
            title: body.title,
            date: "2026-08-16",
          },
          meta: { requestId: "req_activity_legacy" },
        });
      }
      return sendJson(res, 201, {
        data: { ...body, ...ACTIVITY },
        meta: { requestId: "req_activity_create" },
      });
    }

    return sendJson(res, 404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

function realClient(): FrihetClient {
  return new FrihetClient("fri_test_key", baseUrl);
}

interface Harness {
  client: Client;
  server: McpServer;
}

async function makeHarness(reviewed = false): Promise<Harness> {
  const server = new McpServer(
    { name: "frihet-contract-139", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  if (reviewed) applyOpenAIReviewProfiles(server);
  const clientImpl = realClient();
  registerWebhookTools(server, clientImpl);
  registerCrmTools(server, clientImpl);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "frihet-contract-139-client", version: "0.0.0" },
    { capabilities: {} },
  );
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

async function dispose(harness: Harness): Promise<void> {
  await harness.client.close();
  await harness.server.close();
}

function calls(method: string, path: string): SeenRequest[] {
  return seen.filter((request) => request.method === method && request.path === path);
}

describe("real HTTP client — current webhook envelopes", () => {
  test("list unwraps {data,total,meta} to {data,total} with one GET and no query", async () => {
    const result = await realClient().listWebhooks();
    assert.deepEqual(result, { data: [WEBHOOK], total: 1 });
    const requests = calls("GET", "/webhooks");
    assert.equal(requests.length, 1, "list_webhooks must issue exactly one GET");
    assert.equal(requests[0]?.search, "", "backend has no webhook pagination contract");
  });

  test("read unwraps exactly once and preserves redaction", async () => {
    const result = await realClient().getWebhook("wh_139");
    assert.deepEqual(result, WEBHOOK);
    assert.equal("data" in result, false);
    assert.equal("meta" in result, false);
    assert.equal("secret" in result, false);
    assert.equal(calls("GET", "/webhooks/wh_139").length, 1, "get_webhook must issue exactly one GET");
  });
});

describe("real MCP SDK — reviewed webhook contract", () => {
  test("list has no phantom pagination input and returns the current list shape", async () => {
    const harness = await makeHarness();
    try {
      const rejected = await harness.client.callTool({
        name: "list_webhooks",
        arguments: { limit: 5 },
      });
      assert.equal(rejected.isError, true, "legacy limit input must be rejected by the SDK");
      assert.equal(calls("GET", "/webhooks").length, 0, "invalid input must not reach ERP");

      const result = await harness.client.callTool({ name: "list_webhooks", arguments: {} });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, { data: [WEBHOOK], total: 1 });
      assert.equal(JSON.stringify(result).includes("backend-regression-must-be-stripped"), false);
      assert.equal(calls("GET", "/webhooks").length, 1);
    } finally {
      await dispose(harness);
    }
  });

  test("create requires name, rejects fabricated active, and allows a one-time secret echo", async () => {
    const harness = await makeHarness();
    try {
      const missingName = await harness.client.callTool({
        name: "create_webhook",
        arguments: { url: WEBHOOK.url, events: WEBHOOK.events },
      });
      assert.equal(missingName.isError, true);

      const legacyActive = await harness.client.callTool({
        name: "create_webhook",
        arguments: { name: WEBHOOK.name, url: WEBHOOK.url, events: WEBHOOK.events, active: true },
      });
      assert.equal(legacyActive.isError, true, "fabricated active input must stay RED");
      assert.equal(calls("POST", "/webhooks").length, 0);

      const result = await harness.client.callTool({
        name: "create_webhook",
        arguments: {
          name: WEBHOOK.name,
          url: WEBHOOK.url,
          events: WEBHOOK.events,
          status: "inactive",
          metadata: WEBHOOK.metadata,
          secret: "caller-supplied-once",
        },
      });
      assert.equal(result.isError, undefined);
      assert.equal((result.structuredContent as { secret?: string }).secret, "caller-supplied-once");
      assert.deepEqual(calls("POST", "/webhooks")[0]?.body, {
        name: WEBHOOK.name,
        url: WEBHOOK.url,
        events: WEBHOOK.events,
        status: "inactive",
        metadata: WEBHOOK.metadata,
        secret: "caller-supplied-once",
      });

      const unrequested = await harness.client.callTool({
        name: "create_webhook",
        arguments: {
          name: "Unrequested backend secret",
          url: WEBHOOK.url,
          events: WEBHOOK.events,
        },
      });
      assert.equal(unrequested.isError, undefined);
      assert.equal("secret" in (unrequested.structuredContent as object), false);

      const mismatched = await harness.client.callTool({
        name: "create_webhook",
        arguments: {
          name: "Mismatched backend secret",
          url: WEBHOOK.url,
          events: WEBHOOK.events,
          secret: "caller-value",
        },
      });
      assert.equal(mismatched.isError, undefined);
      assert.equal("secret" in (mismatched.structuredContent as object), false);
      assert.equal(
        JSON.stringify([unrequested, mismatched]).includes("backend-secret"),
        false,
        "unrequested or mismatched backend secrets must not reach MCP output",
      );
    } finally {
      await dispose(harness);
    }
  });

  test("update supports name/status/metadata and never returns the stored secret", async () => {
    const harness = await makeHarness();
    try {
      const legacyActive = await harness.client.callTool({
        name: "update_webhook",
        arguments: { id: WEBHOOK.id, active: false },
      });
      assert.equal(legacyActive.isError, true);

      const result = await harness.client.callTool({
        name: "update_webhook",
        arguments: {
          id: WEBHOOK.id,
          name: "Paused webhook",
          status: "paused",
          metadata: { reason: "maintenance" },
          secret: "rotated-write-only",
        },
      });
      assert.equal(result.isError, undefined);
      assert.equal("secret" in (result.structuredContent as object), false);
      assert.equal(JSON.stringify(result).includes("backend-regression-must-be-stripped"), false);
      assert.equal((result.structuredContent as { hasSecret?: boolean }).hasSecret, true);
      assert.deepEqual(calls("PATCH", "/webhooks/wh_139")[0]?.body, {
        name: "Paused webhook",
        status: "paused",
        metadata: { reason: "maintenance" },
        secret: "rotated-write-only",
      });
    } finally {
      await dispose(harness);
    }
  });

  test("legacy read fixture carrying active/secret fails real SDK output validation", async () => {
    const harness = await makeHarness();
    try {
      const result = await harness.client.callTool({
        name: "get_webhook",
        arguments: { id: "wh_legacy" },
      });
      assert.equal(result.isError, true, "fabricated read fields must stay RED");
      assert.equal(
        JSON.stringify(result).includes("must-not-surface-from-read"),
        false,
        "a backend secret regression must never reach MCP error/content serialization",
      );
      assert.equal(webhookItemOutput.safeParse({
        ...WEBHOOK,
        id: "wh_legacy",
        active: true,
        secret: "must-not-surface-from-read",
      }).success, false);
    } finally {
      await dispose(harness);
    }
  });

  test("malformed Firestore lastTriggeredAt fails closed", async () => {
    const harness = await makeHarness();
    try {
      const result = await harness.client.callTool({
        name: "get_webhook",
        arguments: { id: "wh_bad_timestamp" },
      });
      assert.equal(result.isError, true, "invalid timestamp shape must not be fabricated");
    } finally {
      await dispose(harness);
    }
  });

  test("oversized exhaustive-list text never recommends unsupported pagination", () => {
    const text = formatUnpaginatedListResponse("webhooks", {
      data: [{ id: "wh_big", payload: "x".repeat(90_000) }],
      total: 1,
    });
    assert.match(text, /\[Response truncated\.\]$/);
    assert.doesNotMatch(text, /limit|offset|pagination/i);
  });
});

describe("OpenAI reviewed profile excludes webhook configuration — real MCP SDK", () => {
  test("tools/list contains neither webhook operations nor discovery meta-tools", async () => {
    const harness = await makeHarness(true);
    try {
      const { tools } = await harness.client.listTools();
      const forbidden = [
        "list_webhooks",
        "get_webhook",
        "create_webhook",
        "update_webhook",
        "delete_webhook",
      ];
      const names = new Set(tools.map((tool) => tool.name));
      for (const name of forbidden) {
        assert.equal(names.has(name), false, `${name} must not appear in reviewed tools/list`);
      }
      for (const name of ["list_tool_groups", "search_tools", "describe_tool"]) {
        assert.equal(names.has(name), false, `${name} must not appear on OpenAI`);
      }
      assert.equal(calls("POST", "/webhooks").length, 0);
      assert.equal(calls("PATCH", "/webhooks/wh_139").length, 0);
    } finally {
      await dispose(harness);
    }
  });
});

describe("real MCP SDK — reviewed CRM activity contract", () => {
  test("unsupported date is rejected before ERP and current fields round-trip", async () => {
    const harness = await makeHarness();
    try {
      const rejected = await harness.client.callTool({
        name: "log_client_activity",
        arguments: {
          clientId: "client_139",
          type: "call",
          title: "Legacy date input",
          date: "2026-08-16",
        },
      });
      assert.equal(rejected.isError, true, "unsupported date input must stay RED");
      assert.equal(calls("POST", "/clients/client_139/activities").length, 0);

      const oversized = await harness.client.callTool({
        name: "log_client_activity",
        arguments: {
          clientId: "client_139",
          type: "call",
          title: "x".repeat(501),
        },
      });
      assert.equal(oversized.isError, true, "ERP title maxLength=500 must reject pre-transport");
      assert.equal(calls("POST", "/clients/client_139/activities").length, 0);

      const result = await harness.client.callTool({
        name: "log_client_activity",
        arguments: {
          clientId: "client_139",
          type: "email",
          title: ACTIVITY.title,
          description: ACTIVITY.description,
        },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, ACTIVITY);
      assert.deepEqual(calls("POST", "/clients/client_139/activities")[0]?.body, {
        type: "email",
        title: ACTIVITY.title,
        description: ACTIVITY.description,
      });
    } finally {
      await dispose(harness);
    }
  });

  test("legacy date-only output fixture fails real SDK output validation", async () => {
    const harness = await makeHarness();
    try {
      const result = await harness.client.callTool({
        name: "log_client_activity",
        arguments: {
          clientId: "client_139",
          type: "call",
          title: "Legacy fabricated activity",
        },
      });
      assert.equal(result.isError, true, "fabricated date output must stay RED");
      assert.equal(activityItemOutput.safeParse({
        ...ACTIVITY,
        id: "act_legacy",
        title: "Legacy fabricated activity",
        date: "2026-08-16",
      }).success, false);
    } finally {
      await dispose(harness);
    }
  });
});

describe("demo client — reviewed shapes stay validator-compatible", () => {
  test("webhook list/read/create/update and CRM activity match the same schemas", async () => {
    const demo = new DemoFrihetClient();
    const list = await demo.listWebhooks();
    const read = await demo.getWebhook("demo_wh_139");
    const created = await demo.createWebhook({
      name: "Demo reviewed webhook",
      url: "https://example.com/demo-hook",
      events: ["invoice.paid"],
      secret: "demo-caller-supplied-once",
    });
    const updated = await demo.updateWebhook("demo_wh_139", {
      status: "paused",
      secret: "demo-write-only-rotation",
    });
    const activity = await demo.logClientActivity("demo_client_139", {
      type: "email",
      title: "Demo follow-up",
    });

    assert.equal(webhookListOutput.safeParse(list).success, true);
    assert.equal(webhookItemOutput.safeParse(read).success, true);
    assert.equal(webhookCreateOutput.safeParse(created).success, true);
    assert.equal(webhookItemOutput.safeParse(updated).success, true);
    assert.equal("secret" in updated, false, "demo update follows write-only secret semantics");
    assert.equal(activityItemOutput.safeParse(activity).success, true);
    assert.equal((activity as { type?: string }).type, "email_sent");
  });
});
