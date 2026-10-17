/**
 * Claude write-route contract, captured on the wire.
 *
 * The Claude pilot credential carries the generic `write` scope. On its own the
 * ERP would honour that scope on every mutating route, including the ones this
 * profile excludes on purpose (delete_client, send_quote, refund_sale, ...): in
 * this repository the exclusion lives only in the Worker's registration
 * interceptor. The ERP-side write-route ceiling for keys stored with
 * `accessProfile: "claude"` (Frihet-ERP `functions/src/publicApi/claudeWriteRoutes.ts`)
 * must be exactly the set of non-GET routes the Claude allowlist sends, and the
 * Claude Worker deploy requires an ERP release receipt showing that ceiling
 * deployed (`scripts/check-claude-hosted-release.mjs`, `assertErpCeilingDeployed`).
 *
 * This test drives every allowlisted tool through a REAL FrihetClient against a
 * local node:http server, records method + path as they arrive, and compares
 * them with the committed fixture. `CLAUDE_WRITE_ROUTES_SHA256` is the same
 * literal the ERP ceiling's test pins. The two copies are kept equal by hand: no
 * CI job compares the two repositories, so a change on one side must be repeated
 * on the other. The deploy check above compares the deployed ERP list with this
 * fixture.
 *
 * Regenerate after a reviewed allowlist change:
 *   npm run build && FRIHET_UPDATE_CLAUDE_WRITE_ROUTES=1 node --test dist/__tests__/claude-write-route-contract.test.js
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FrihetClient } from "../client.js";
import { CLAUDE_CANDIDATE_TOOLS, CLAUDE_EXCLUDED_TOOLS } from "../claude-profile.js";
import { FISCAL_MODELO_ALIASES } from "../fiscal-aliases.js";
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
      // A record read (path ends in the synthetic id) feeds send_* tools the
      // linked client and email they check before sending; lists are empty.
      const record = url.pathname.split("/").at(-1) === ID;
      res.end(JSON.stringify(record
        ? { data: { id: ID, clientId: ID, email: "a@example.com", status: "draft" } }
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
  if (schema.format === "date") return "2026-01-01";
  return ID;
}

const template = (route: string) => route.split("/").map((segment) => (segment === ID ? ":id" : segment)).join("/");

/** Calls each tool once and returns the templated non-GET routes it sent. */
async function captureWrites(claudeMode: boolean, only?: ReadonlySet<string>) {
  const mcp = new McpServer({ name: "write-route-capture", version: "1.0.0" });
  registerMcpSurface(mcp, new FrihetClient("fri_test_key", baseUrl), remoteMcpSurfaceComposition(false, false, claudeMode));
  const client = new Client({ name: "write-route-capture-client", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(st), client.connect(ct)]);
  const writes = new Map<string, { readOnly: boolean; routes: string[] }>();
  try {
    for (const tool of (await client.listTools()).tools) {
      if (only && !only.has(tool.name)) continue;
      captured.length = 0;
      for (const every of [false, true]) {
        await client.callTool({ name: tool.name, arguments: synthesize(tool.inputSchema as Schema, "", every) as Record<string, unknown> });
      }
      const routes = captured.filter((route) => !route.startsWith("GET ") && !route.startsWith("HEAD ")).map(template);
      writes.set(tool.name, { readOnly: tool.annotations?.readOnlyHint === true, routes: [...new Set(routes)].sort() });
    }
  } finally {
    await Promise.allSettled([client.close(), mcp.close()]);
  }
  return writes;
}

test("every Claude write tool reaches the wire and the route set matches the committed contract", async () => {
  const writes = await captureWrites(true);
  for (const name of CLAUDE_CANDIDATE_TOOLS) assert.ok(writes.has(name), `${name} was not captured`);
  for (const name of writes.keys()) assert.ok(CLAUDE_CANDIDATE_TOOLS.has(name) || name in FISCAL_MODELO_ALIASES, `${name} is not reviewed`);

  const tools: Record<string, string[]> = {};
  for (const [name, { readOnly, routes }] of [...writes].sort(([a], [b]) => a.localeCompare(b))) {
    if (readOnly) {
      assert.deepEqual(routes, [], `${name} is readOnlyHint but sent a non-GET request`);
      continue;
    }
    assert.ok(routes.length > 0, `${name} sent no write: the ceiling would be untested for it`);
    tools[name] = routes;
  }
  const routes = [...new Set(Object.values(tools).flat())].sort();
  const sha256 = createHash("sha256").update(routes.join("\n")).digest("hex");
  const contract = `${JSON.stringify({ accessProfile: "claude", sha256, routes, tools }, null, 2)}\n`;

  if (process.env.FRIHET_UPDATE_CLAUDE_WRITE_ROUTES === "1") writeFileSync(FIXTURE, contract);
  assert.equal(contract, readFileSync(FIXTURE, "utf8"), "regenerate the fixture and update both SHA-256 mirrors");
  assert.equal(sha256, CLAUDE_WRITE_ROUTES_SHA256);
});

test("routes of excluded write tools stay outside the Claude contract", async () => {
  const { routes } = JSON.parse(readFileSync(FIXTURE, "utf8")) as { routes: string[] };
  const probe = ["delete_client", "delete_expense", "send_quote", "refund_sale"];
  for (const name of probe) assert.ok(name in CLAUDE_EXCLUDED_TOOLS, `${name} must stay excluded`);
  const writes = await captureWrites(false, new Set(probe));
  assert.deepEqual([...writes.keys()].sort(), [...probe].sort());
  for (const [name, { routes: sent }] of writes) {
    assert.ok(sent.length > 0, `${name} sent no write on the full surface`);
    for (const route of sent) assert.ok(!routes.includes(route), `${name} route ${route} must not be in the Claude contract`);
  }
});
