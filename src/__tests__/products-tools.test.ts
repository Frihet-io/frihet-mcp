/**
 * End-to-end tool and client contract tests for `list_products` (`isActive`
 * filter, empty results, and multi-page offset/cursor pagination) and product
 * mutations.
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod/v4";
import { FrihetClient } from "../client.js";
import { registerProductTools } from "../tools/products.js";

interface ToolConfig {
  title: string;
  description: string;
  annotations?: Record<string, unknown>;
  inputSchema: Record<string, z.ZodType>;
  outputSchema?: unknown;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

interface RegisteredTool {
  name: string;
  config: ToolConfig;
  handler: ToolHandler;
}

class StubMcpServer {
  tools: Map<string, RegisteredTool> = new Map();

  registerTool(name: string, config: ToolConfig, handler: ToolHandler): void {
    this.tools.set(name, { name, config, handler });
  }
}

interface ProductFixture {
  id: string;
  name: string;
  unitPrice: number;
  taxRate: number;
  isActive: boolean;
}

const CATALOG_FIXTURES: ProductFixture[] = [
  { id: "prod_1", name: "OpenAI Demo Annual Hosting", unitPrice: 240, taxRate: 21, isActive: true },
  { id: "prod_2", name: "OpenAI Demo UX Design Hour", unitPrice: 65, taxRate: 21, isActive: true },
  { id: "prod_3", name: "OpenAI Demo Consulting Hour", unitPrice: 80, taxRate: 21, isActive: true },
  { id: "prod_4", name: "Legacy Setup Package", unitPrice: 500, taxRate: 21, isActive: false },
  { id: "prod_5", name: "Archived Maintenance Plan", unitPrice: 120, taxRate: 21, isActive: false },
];

describe("list_products tool & FrihetClient — isActive filter and pagination coverage", () => {
  const originalFetch = globalThis.fetch;
  let recordedRequests: Array<{ method: string; url: URL; headers: Record<string, string> }> = [];
  let currentFixtures: ProductFixture[] = [];

  beforeEach(() => {
    recordedRequests = [];
    currentFixtures = [...CATALOG_FIXTURES];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl);
      const method = init?.method ?? "GET";
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
      }
      recordedRequests.push({ method, url, headers });

      if (method === "GET" && url.pathname === "/v1/products") {
        const isActiveParam = url.searchParams.get("isActive");
        const limit = Number(url.searchParams.get("limit") ?? "50");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const cursor = url.searchParams.get("cursor");

        let filtered = [...currentFixtures];
        if (isActiveParam !== null) {
          const expectedActive = isActiveParam === "true";
          filtered = filtered.filter((item) => item.isActive === expectedActive);
        }

        const total = filtered.length;
        let paged: ProductFixture[];
        if (cursor) {
          const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { __id?: string };
          const idx = filtered.findIndex((item) => item.id === decoded.__id);
          paged = idx >= 0 ? filtered.slice(idx + 1, idx + 1 + limit) : [];
        } else {
          paged = filtered.slice(offset, offset + limit);
        }

        const nextCursor =
          paged.length === limit && paged.length > 0
            ? Buffer.from(JSON.stringify({ __id: paged[paged.length - 1].id })).toString("base64url")
            : undefined;

        return new Response(
          JSON.stringify({
            data: paged,
            total,
            limit,
            offset,
            ...(nextCursor ? { nextCursor } : {}),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (method === "POST" && url.pathname === "/v1/products") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            data: { id: "prod_new", isActive: true, ...body },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }) as typeof fetch;
  });

  test.after(() => {
    globalThis.fetch = originalFetch;
  });

  function buildToolHarness(): StubMcpServer {
    const server = new StubMcpServer();
    const client = new FrihetClient("fri_test_key", "https://api.frihet.io/v1");
    registerProductTools(
      server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      client,
    );
    return server;
  }

  test("filters active products (isActive: true) and paginates across multiple pages via offset and cursor", async () => {
    const server = buildToolHarness();
    const listTool = server.tools.get("list_products")!;

    // Page 1 (limit 2, isActive: true)
    const page1 = await listTool.handler({ isActive: true, limit: 2 });
    assert.equal(recordedRequests[0].url.searchParams.get("isActive"), "true");
    assert.equal(recordedRequests[0].url.searchParams.get("limit"), "2");

    const sc1 = page1.structuredContent as {
      data: ProductFixture[];
      total: number;
      nextCursor?: string;
    };
    assert.equal(sc1.total, 3);
    assert.deepEqual(
      sc1.data.map((p) => p.id),
      ["prod_1", "prod_2"],
    );
    assert.ok(sc1.nextCursor, "page 1 must return nextCursor when full page is returned");

    // Page 2 via offset
    const page2Offset = await listTool.handler({ isActive: true, limit: 2, offset: 2 });
    assert.equal(recordedRequests[1].url.searchParams.get("isActive"), "true");
    assert.equal(recordedRequests[1].url.searchParams.get("offset"), "2");
    const sc2Offset = page2Offset.structuredContent as { data: ProductFixture[]; total: number; nextCursor?: string };
    assert.equal(sc2Offset.total, 3);
    assert.deepEqual(
      sc2Offset.data.map((p) => p.id),
      ["prod_3"],
    );
    assert.equal(sc2Offset.nextCursor, undefined);

    // Page 2 via cursor (`after`)
    const page2Cursor = await listTool.handler({ isActive: true, limit: 2, after: sc1.nextCursor });
    assert.equal(recordedRequests[2].url.searchParams.get("isActive"), "true");
    assert.equal(recordedRequests[2].url.searchParams.get("cursor"), sc1.nextCursor);
    const sc2Cursor = page2Cursor.structuredContent as { data: ProductFixture[]; total: number };
    assert.equal(sc2Cursor.total, 3);
    assert.deepEqual(
      sc2Cursor.data.map((p) => p.id),
      ["prod_3"],
    );
  });

  test("filters inactive products (isActive: false)", async () => {
    const server = buildToolHarness();
    const listTool = server.tools.get("list_products")!;

    const res = await listTool.handler({ isActive: false, limit: 10 });
    assert.equal(recordedRequests[0].url.searchParams.get("isActive"), "false");

    const sc = res.structuredContent as { data: ProductFixture[]; total: number };
    assert.equal(sc.total, 2);
    assert.deepEqual(
      sc.data.map((p) => p.id),
      ["prod_4", "prod_5"],
    );
  });

  test("returns all products when isActive is omitted", async () => {
    const server = buildToolHarness();
    const listTool = server.tools.get("list_products")!;

    const res = await listTool.handler({ limit: 10 });
    assert.equal(recordedRequests[0].url.searchParams.get("isActive"), null);

    const sc = res.structuredContent as { data: ProductFixture[]; total: number };
    assert.equal(sc.total, 5);
    assert.deepEqual(
      sc.data.map((p) => p.id),
      ["prod_1", "prod_2", "prod_3", "prod_4", "prod_5"],
    );
  });

  test("returns empty data and total=0 when no products match the filter", async () => {
    currentFixtures = CATALOG_FIXTURES.filter((p) => p.isActive);
    const server = buildToolHarness();
    const listTool = server.tools.get("list_products")!;

    const res = await listTool.handler({ isActive: false, limit: 10 });
    const sc = res.structuredContent as { data: ProductFixture[]; total: number; nextCursor?: string };
    assert.equal(sc.total, 0);
    assert.deepEqual(sc.data, []);
    assert.equal(sc.nextCursor, undefined);
  });

  test("inputSchema rejects non-boolean isActive values", () => {
    const server = buildToolHarness();
    const listTool = server.tools.get("list_products")!;
    const schema = z.object(listTool.config.inputSchema).strict();

    assert.equal(schema.safeParse({ isActive: "true" }).success, false);
    assert.equal(schema.safeParse({ isActive: 1 }).success, false);
    assert.equal(schema.safeParse({ isActive: true, limit: 3 }).success, true);
    assert.equal(schema.safeParse({ isActive: false, limit: 3 }).success, true);
  });

  test("preserves nextCursor and instructs after= continuation when a scan window truncates with data.length < limit", async () => {
    const frontierCursor = Buffer.from(
      JSON.stringify({ __id: "prod-a-inactive-0500", __offset: 2 }),
    ).toString("base64url");

    let callCount = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl);
      callCount += 1;

      if (callCount === 1) {
        assert.equal(url.searchParams.get("isActive"), "true");
        assert.equal(url.searchParams.get("cursor"), null);
        // Simulate 500 inactive docs scanned first before reaching the active doc:
        // data is empty, total is 1, and nextCursor points to the 500th scanned doc.
        return new Response(
          JSON.stringify({
            data: [],
            total: 1,
            limit: 20,
            offset: 0,
            truncated: true,
            nextCursor: frontierCursor,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      assert.equal(url.searchParams.get("isActive"), "true");
      assert.equal(url.searchParams.get("cursor"), frontierCursor);
      return new Response(
        JSON.stringify({
          data: [{ id: "prod-z-active-0501", name: "Active After 500 Inactive", unitPrice: 99, taxRate: 21, isActive: true }],
          total: 1,
          limit: 20,
          offset: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const server = buildToolHarness();
    const listTool = server.tools.get("list_products")!;

    const page1 = await listTool.handler({ isActive: true, limit: 20 });
    const sc1 = page1.structuredContent as {
      data: ProductFixture[];
      total: number;
      nextCursor?: string;
    };
    assert.deepEqual(sc1.data, []);
    assert.equal(sc1.total, 1);
    assert.equal(sc1.nextCursor, frontierCursor);
    assert.match(page1.content[0].text, new RegExp(`after='${frontierCursor}'`));
    assert.doesNotMatch(page1.content[0].text, /Use offset=0/);

    const page2 = await listTool.handler({ isActive: true, limit: 20, after: sc1.nextCursor });
    const sc2 = page2.structuredContent as {
      data: ProductFixture[];
      total: number;
      nextCursor?: string;
    };
    assert.equal(sc2.data.length, 1);
    assert.equal(sc2.data[0].id, "prod-z-active-0501");
    assert.equal(sc2.nextCursor, undefined);
  });

  test("create_product sends Idempotency-Key header on mutation", async () => {
    const server = buildToolHarness();
    const createTool = server.tools.get("create_product")!;

    const res = await createTool.handler({ name: "Advisory Retainer", unitPrice: 950, taxRate: 21 });
    assert.equal(recordedRequests[0].method, "POST");
    assert.ok(recordedRequests[0].headers["idempotency-key"], "POST /v1/products must include Idempotency-Key");
    assert.equal((res.structuredContent as Record<string, unknown>).name, "Advisory Retainer");
  });
});
