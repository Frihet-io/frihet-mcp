/** Claude route isolation: the frozen ERP credential ceiling remains unchanged.
 * Both the general historical surface and the operational Claude handlers must
 * dispatch exactly its reviewed write routes. Loopback responses establish
 * method/path wiring only, never backend or hosted acceptance. Neither contract
 * is regenerated here, and no deployed credential or permission changes.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FrihetClient } from "../client.js";
import { CLAUDE_CANDIDATE_TOOLS } from "../claude-profile.js";
import { registerMcpSurface, remoteMcpSurfaceComposition } from "../server-composition.js";

/** Mirrored byte-for-byte in Frihet-ERP functions/src/publicApi/claudeWriteRoutes.ts. */
const CLAUDE_WRITE_ROUTES_SHA256 = "bcf2185915523c60468afc380d1e2456a5c0da5cb2ca4b4820e74886b06b928f";

const FIXTURE = new URL("../../src/__tests__/fixtures/claude-write-route-contract.json", import.meta.url);
const ID = "zzid";

const captured: string[] = [];
let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    captured.push(`${req.method} ${url.pathname}`);
    req.resume();
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") {
      // A record read (path ends in the synthetic id) feeds send_* and duplicate_*
      // tools the linked client, email, clientName, and items they validate before writing; lists are empty.
      const record = url.pathname.split("/").at(-1) === ID;
      res.end(JSON.stringify(record
        ? {
          data: {
            id: ID,
            clientId: ID,
            clientName: "Synthetic Client",
            email: "a@example.com",
            status: "draft",
            items: [{ description: "Synthetic item", quantity: 1, unitPrice: 100 }],
          },
        }
        : { data: [], total: 0, limit: 20, offset: 0 }));
      return;
    }
    res.end(JSON.stringify({ data: { id: ID, success: true }, meta: { requestId: "req_1" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

type Schema = {
  type?: string | string[]; const?: unknown; enum?: unknown[]; format?: string; minimum?: number;
  pattern?: string; minLength?: number; maxLength?: number;
  anyOf?: Schema[]; oneOf?: Schema[]; items?: Schema; properties?: Record<string, Schema>; required?: string[];
};

/**
 * Schema-valid arguments with confirm interlocks set: required fields only, or
 * every declared field so optional branches that write elsewhere are captured.
 */
function synthesize(schema: Schema | undefined, key = "", every = false): unknown {
  if (!schema) return ID;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return synthesize(variants[0], key, every);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "boolean") return /confirm/i.test(key);
  if (type === "number" || type === "integer") return Math.max(1, schema.minimum ?? 1);
  if (type === "array") return [synthesize(schema.items, key, every)];
  if (type === "object" || schema.properties) {
    const names = every ? Object.keys(schema.properties ?? {}) : (schema.required ?? []);
    return Object.fromEntries(names.map((name) => [name, synthesize(schema.properties?.[name], name, every)]));
  }
  if (schema.format === "uri") return "https://example.com/hook";
  if (schema.format === "email") return "a@example.com";
  if (schema.format === "date" || schema.pattern === "^\\d{4}-\\d{2}-\\d{2}$") return "2026-01-01";
  return ID.padEnd(schema.minLength ?? 0, "x").slice(0, schema.maxLength);
}

const template = (route: string) => route.split("/").map((segment) => (segment === ID ? ":id" : segment)).join("/");

/** Calls each tool once and returns the templated non-GET routes it sent. */
async function captureRoutes(claudeMode: boolean, only?: ReadonlySet<string>, grouped = false) {
  const mcp = new McpServer({ name: "write-route-capture", version: "1.0.0" });
  registerMcpSurface(mcp, new FrihetClient("fri_test_key", baseUrl), remoteMcpSurfaceComposition(false, grouped, claudeMode));
  const client = new Client({ name: "write-route-capture-client", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(st), client.connect(ct)]);
  const writes = new Map<string, { readOnly: boolean; routes: string[] }>();
  try {
    for (const tool of (await client.listTools()).tools) {
      if (only && !only.has(tool.name)) continue;
      captured.length = 0;
      for (const every of [false, true]) {
        const args = tool.name === "describe_tool" ? { name: "list_invoices" }
          : synthesize(tool.inputSchema as Schema, "", every) as Record<string, unknown>;
        await client.callTool({ name: tool.name, arguments: args });
      }
      const routes = captured.map(template);
      writes.set(tool.name, { readOnly: tool.annotations?.readOnlyHint === true, routes: [...new Set(routes)].sort() });
    }
  } finally {
    await Promise.allSettled([client.close(), mcp.close()]);
  }
  return writes;
}

test("historical ERP credential ceiling still captures the exact frozen write routes on the general surface", async () => {
  const frozen = JSON.parse(readFileSync(FIXTURE, "utf8")) as { tools: Record<string, string[]> };
  const writes = await captureRoutes(false, new Set(Object.keys(frozen.tools)));
  assert.deepEqual([...writes.keys()].sort(), Object.keys(frozen.tools).sort());

  const tools: Record<string, string[]> = {};
  for (const [name, { readOnly, routes: allRoutes }] of [...writes].sort(([a], [b]) => a.localeCompare(b))) {
    assert.equal(readOnly, false, `${name} must retain its historical write annotation`);
    const routes = allRoutes.filter((route) => !route.startsWith("GET ") && !route.startsWith("HEAD "));
    assert.ok(routes.length > 0, `${name} sent no write: the ceiling would be untested for it`);
    tools[name] = routes;
  }
  const routes = [...new Set(Object.values(tools).flat())].sort();
  const sha256 = createHash("sha256").update(routes.join("\n")).digest("hex");
  const contract = `${JSON.stringify({ accessProfile: "claude", sha256, routes, tools }, null, 2)}\n`;

  assert.equal(contract, readFileSync(FIXTURE, "utf8"), "historical credential ceiling drift requires separate ERP review");
  assert.equal(sha256, CLAUDE_WRITE_ROUTES_SHA256);
});

test("historically forbidden writes remain outside the unchanged ERP ceiling", async () => {
  const { routes } = JSON.parse(readFileSync(FIXTURE, "utf8")) as { routes: string[] };
  const probe = ["delete_client", "delete_expense", "send_quote", "refund_sale"];
  const writes = await captureRoutes(false, new Set(probe));
  assert.deepEqual([...writes.keys()].sort(), [...probe].sort());
  for (const [name, { routes: allRoutes }] of writes) {
    const sent = allRoutes.filter((route) => !route.startsWith("GET ") && !route.startsWith("HEAD "));
    assert.ok(sent.length > 0, `${name} sent no write on the full surface`);
    for (const route of sent) assert.ok(!routes.includes(route), `${name} route ${route} must not be in the Claude contract`);
  }
});

test("operational Claude write handlers dispatch exactly the unchanged ERP credential ceiling", async () => {
  const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as { tools: Record<string, string[]>; routes: string[]; sha256: string };
  const served = await captureRoutes(true);
  for (const name of CLAUDE_CANDIDATE_TOOLS) assert.ok(served.has(name), `${name} must be registered`);
  const tools: Record<string, string[]> = {};
  for (const [name, item] of [...served].sort(([a], [b]) => a.localeCompare(b))) {
    const writes = item.routes.filter((route) => !route.startsWith("GET ") && !route.startsWith("HEAD "));
    if (item.readOnly) {
      assert.deepEqual(writes, [], `${name} is read-only but attempted a write`);
    } else {
      assert.ok(writes.length > 0, `${name} must reach its write route`);
      tools[name] = writes;
    }
  }
  assert.deepEqual(tools, expected.tools, "Claude must use only the already-reviewed write handlers");
  const routes = [...new Set(Object.values(tools).flat())].sort();
  assert.deepEqual(routes, expected.routes);
  assert.equal(createHash("sha256").update(routes.join("\n")).digest("hex"), CLAUDE_WRITE_ROUTES_SHA256);
});

test("every excluded general handler is absent from Claude before any API call", async () => {
  const mcp = new McpServer({ name: "operational-denials", version: "1.0.0" });
  const general = new McpServer({ name: "general-names", version: "1.0.0" });
  const api = new FrihetClient("fri_test_key", baseUrl);
  registerMcpSurface(mcp, api, remoteMcpSurfaceComposition(false, true, true));
  registerMcpSurface(general, api, remoteMcpSurfaceComposition(false, false, false));
  const client = new Client({ name: "operational-denials-client", version: "1.0.0" });
  const generalClient = new Client({ name: "general-names-client", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const [gct, gst] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([mcp.connect(st), client.connect(ct), general.connect(gst), generalClient.connect(gct)]);
    const served = new Set((await client.listTools()).tools.map((tool) => tool.name));
    const excluded = (await generalClient.listTools()).tools.filter((tool) => !served.has(tool.name));
    assert.ok(excluded.length >= 31, "the full general catalogue must be used for denial coverage");
    captured.length = 0;
    for (const tool of excluded) {
      const result = await client.callTool({ name: tool.name, arguments: synthesize(tool.inputSchema as Schema) as Record<string, unknown> });
      assert.equal(result.isError, true, `${tool.name} must be rejected`);
      assert.match(JSON.stringify(result.content), /not found/u, `${tool.name} must fail at registration, not validation`);
    }
    assert.deepEqual(captured, [], "excluded calls must not reach the API");
    assert.deepEqual((await client.listPrompts()).prompts.map((prompt) => prompt.name).sort(), ["invoice-aging-review", "overdue-followup"]);
    assert.deepEqual((await client.listResources()).resources.map((resource) => resource.uri), ["frihet://config/currencies"]);
    captured.length = 0;
    await client.readResource({ uri: "frihet://config/currencies" });
    assert.deepEqual(captured, [], "the sole resource must stay static");
  } finally {
    await Promise.allSettled([client.close(), mcp.close(), generalClient.close(), general.close()]);
  }
});
