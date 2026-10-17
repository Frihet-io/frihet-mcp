/**
 * Pagination cursor wire-param contract.
 *
 * Bug (verified live): the client built the cursor-pagination query as
 * `after: params?.after`, but the ERP backend reads `req.query.cursor`
 * (functions/src/publicApi.ts:6472 in Frihet-ERP) and returns `nextCursor`.
 * The cursor token therefore never reached the backend, every "next page"
 * request fell back to offset=0, and cursor-based pagination looped on
 * page 1 forever.
 *
 * Current state (post-fix): `after` remains the caller-facing param name on
 * every public list/search method below — tools/*.ts and other callers keep
 * passing `{ after }` unchanged, it's a naming alias only. The wire query
 * key actually sent to the backend is `cursor` (see the doc comment atop
 * `FrihetClient` in src/client.ts); `after` itself is never sent.
 *
 * This spins up a local node:http server (acting as the ERP backend), points
 * a REAL FrihetClient at it, and asserts — for EVERY paginated public method
 * that accepts `after` (the 16 call sites in src/client.ts where the wire
 * query builder has `cursor: params?.after`) — that the captured query
 * string contains `cursor=<token>` and NOT `after=<token>` when a pagination
 * token is passed.
 *
 * Run: npm test (after build)
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { FrihetClient } from "../client.js";
import { registerClientTools } from "../tools/clients.js";
import { registerVendorTools } from "../tools/vendors.js";
import { clientItemOutput, vendorItemOutput, paginatedOutput } from "../tools/shared.js";
import type { IFrihetClient } from "../client-interface.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface CapturedRequest {
  method: string;
  path: string; // pathname only (no query)
  query: URLSearchParams;
}

const captured: CapturedRequest[] = [];

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    captured.push({
      method: req.method ?? "",
      path: url.pathname,
      query: url.searchParams,
    });

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [], total: 0, limit: 20, offset: 0 }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeClient(): FrihetClient {
  return new FrihetClient("fri_test_key", baseUrl);
}

function lastRequest(): CapturedRequest {
  return captured[captured.length - 1]!;
}

const CURSOR_TOKEN = "eyJpZCI6Imludl8xMjMifQ"; // opaque base64url-ish token, matches backend shape

/**
 * Every public FrihetClient method whose wire-query builder in src/client.ts
 * sends `cursor: params?.after` — i.e. every method that accepts a
 * caller-facing `after` pagination token. Verified via
 * `grep -n "cursor: params?.after" src/client.ts` (16 call sites as of the
 * `cursor` rename in PR #71). Each entry drives the real method with
 * `{ after: CURSOR_TOKEN }` the same way a real caller (or tools/*.ts) would.
 * Add new paginated methods here as they ship so coverage stays exhaustive.
 */
const PAGINATED_ENDPOINTS: Array<{
  method: string;
  invoke: (client: FrihetClient) => Promise<unknown>;
}> = [
  { method: "listInvoices", invoke: (c) => c.listInvoices({ after: CURSOR_TOKEN, limit: 20 }) },
  { method: "searchInvoices", invoke: (c) => c.searchInvoices("acme", { after: CURSOR_TOKEN }) },
  { method: "listExpenses", invoke: (c) => c.listExpenses({ after: CURSOR_TOKEN }) },
  { method: "listClients", invoke: (c) => c.listClients({ after: CURSOR_TOKEN }) },
  { method: "listProducts", invoke: (c) => c.listProducts({ after: CURSOR_TOKEN }) },
  { method: "listQuotes", invoke: (c) => c.listQuotes({ after: CURSOR_TOKEN }) },
  { method: "listVendors", invoke: (c) => c.listVendors({ after: CURSOR_TOKEN }) },
  { method: "listDeposits", invoke: (c) => c.listDeposits({ after: CURSOR_TOKEN }) },
  { method: "listReservations", invoke: (c) => c.listReservations({ after: CURSOR_TOKEN }) },
  { method: "listProperties", invoke: (c) => c.listProperties({ after: CURSOR_TOKEN }) },
  { method: "listSales", invoke: (c) => c.listSales({ after: CURSOR_TOKEN }) },
  { method: "listKitchenTickets", invoke: (c) => c.listKitchenTickets({ after: CURSOR_TOKEN }) },
  { method: "listMenuItems", invoke: (c) => c.listMenuItems({ after: CURSOR_TOKEN }) },
  { method: "listTransactions", invoke: (c) => c.listTransactions({ after: CURSOR_TOKEN }) },
  { method: "listTimeEntries", invoke: (c) => c.listTimeEntries({ after: CURSOR_TOKEN }) },
  { method: "listLeaves", invoke: (c) => c.listLeaves({ after: CURSOR_TOKEN }) },
];

describe("Pagination cursor wire param — every list/search method must send `cursor`, not `after`", () => {
  for (const { method, invoke } of PAGINATED_ENDPOINTS) {
    test(`${method}({ after: token }) → query string has cursor=token, no after param`, async () => {
      const client = makeClient();
      await invoke(client);

      const req = lastRequest();
      assert.equal(
        req.query.get("cursor"),
        CURSOR_TOKEN,
        `${method}: backend reads req.query.cursor — token must land there`,
      );
      assert.equal(
        req.query.get("after"),
        null,
        `${method}: the \`after\` param is not read by the backend and must not be sent`,
      );
    });
  }
});

describe("Product active filter wire contract", () => {
  for (const value of [true, false] as const) {
    test(`listProducts({ isActive: ${value} }) sends the literal boolean string`, async () => {
      const client = makeClient();
      await client.listProducts({ isActive: value });
      assert.equal(lastRequest().query.get("isActive"), String(value));
    });
  }
});

describe("Client & Vendor search, normalization, and listResources limitation truthfulness", () => {
  test("list_clients applies consistent search criteria on page 1 and page 2 when query has zero total matches", async () => {
    const queriedTerms: string[] = [];
    const mockClient = {
      listClients: async (params: { q?: string; offset?: number; limit?: number }) => {
        queriedTerms.push(`${params.q}|${params.offset ?? 0}`);
        if (params.q === "CanariasBlue") {
          return { data: [], total: 0, limit: params.limit ?? 20, offset: params.offset ?? 0 };
        }
        if (params.q === "Canarias Blue") {
          const start = params.offset ?? 0;
          return {
            data: [{ id: `cli_${start + 1}`, name: "Canarias Blue S.L.", address: "Calle Mayor 1" }],
            total: 35,
            limit: params.limit ?? 20,
            offset: start,
          };
        }
        return { data: [], total: 0, limit: 20, offset: 0 };
      },
      getClient: async () => ({ id: "cli_1", name: "Canarias Blue S.L." }),
    } as unknown as IFrihetClient;

    const tools = new Map<string, (args: any) => Promise<any>>();
    const fakeServer = {
      registerTool: (name: string, _opts: unknown, handler: (args: any) => Promise<any>) => {
        tools.set(name, handler);
      },
    } as unknown as McpServer;

    registerClientTools(fakeServer, mockClient);
    const listClientsTool = tools.get("list_clients")!;

    // Page 1
    const page1 = await listClientsTool({ q: "CanariasBlue", offset: 0, limit: 20 });
    assert.equal(page1.structuredContent.total, 35);
    assert.equal(page1.structuredContent.data.length, 1);
    assert.equal(page1.structuredContent.data[0].id, "cli_1");
    assert.deepEqual(page1.structuredContent.data[0].address, { street: "Calle Mayor 1" });

    // Page 2: with offset=20
    const page2 = await listClientsTool({ q: "CanariasBlue", offset: 20, limit: 20 });
    assert.equal(page2.structuredContent.total, 35);
    assert.equal(page2.structuredContent.data.length, 1);
    assert.equal(page2.structuredContent.data[0].id, "cli_21");

    assert.ok(queriedTerms.includes("Canarias Blue|0"), "Page 1 must query split terms");
    assert.ok(queriedTerms.includes("Canarias Blue|20"), "Page 2 must query split terms with matching offset");
  });

  test("list_clients does NOT switch search criteria when total is undefined on page 2+, when truncated=true, or when after cursor is used with q", async () => {
    const queriedTerms: string[] = [];
    const mockClient = {
      listClients: async (params: { q?: string; offset?: number; limit?: number; after?: string }) => {
        queriedTerms.push(`${params.q}|${params.offset ?? 0}|${params.after ?? ""}`);
        if (params.q === "TruncatedCorp") {
          return {
            data: [],
            total: 0,
            limit: params.limit ?? 20,
            offset: params.offset ?? 0,
            truncated: true,
            meta: { requestId: "req_1" },
          };
        }
        return { data: [], total: undefined as unknown as number, limit: params.limit ?? 20, offset: params.offset ?? 0 };
      },
    } as unknown as IFrihetClient;

    const tools = new Map<string, (args: any) => Promise<any>>();
    const fakeServer = {
      registerTool: (name: string, _opts: unknown, handler: (args: any) => Promise<any>) => {
        tools.set(name, handler);
      },
    } as unknown as McpServer;

    registerClientTools(fakeServer, mockClient);
    const listClientsTool = tools.get("list_clients")!;

    // 1. Exhausted page 2 with undefined total
    await listClientsTool({ q: "SLCanarias", offset: 20, limit: 20 });
    assert.deepEqual(queriedTerms, ["SLCanarias|20|"], "Must not fallback when total is undefined on page 2+");

    // 2. Truncated 500-doc scan: must NOT fallback, must strip undeclared `truncated`/`meta` from structuredContent,
    //    and must disclose `truncated=true` in human-readable content.
    queriedTerms.length = 0;
    const truncRes = await listClientsTool({ q: "TruncatedCorp", offset: 0, limit: 20 });
    assert.deepEqual(queriedTerms, ["TruncatedCorp|0|"], "Must not fallback when 500-doc scan is truncated");
    assert.equal("truncated" in truncRes.structuredContent, false, "truncated must not leak into strict paginatedOutput structuredContent");
    assert.equal("meta" in truncRes.structuredContent, false, "meta must not leak into strict paginatedOutput structuredContent");
    assert.equal(paginatedOutput(clientItemOutput, { projectable: true }).safeParse(truncRes.structuredContent).success, true);
    assert.match(truncRes.content[0].text, /500-document|500 documentos/i);

    // 3. Combining q with after cursor: must NOT fallback and must warn that backend search ignores `after`
    queriedTerms.length = 0;
    const cursorSearchRes = await listClientsTool({ q: "CanariasBlue", after: "cur_1" });
    assert.deepEqual(queriedTerms, ["CanariasBlue|0|cur_1"], "Must not fallback when after cursor is combined with q");
    assert.match(cursorSearchRes.content[0].text, /ignores the 'after' cursor|ignora el cursor 'after'/i);
  });

  test("client normalization preserves identity, NIF backfill, projected fields, null scalars, and ERP zip/province/countryCode addresses", async () => {
    const mockClient = {
      listClients: async (params: { fields?: string }) => {
        if (params.fields === "id,name") {
          return {
            data: [{ id: "cli_proj", name: "Projected Client" }],
            total: 1,
            limit: 20,
            offset: 0,
          };
        }
        return { data: [], total: 0, limit: 20, offset: 0 };
      },
      getClient: async (id: string) => {
        if (id === "null_fields_and_nif") {
          return {
            id,
            name: "Legacy Fiscal Client",
            email: null,
            phone: null,
            stage: null,
            taxId: null,
            nif: "B99887766",
            address: null,
            createdAt: null,
            updatedAt: null,
            customAttr: "preserved",
          };
        }
        return {
          id,
          name: "ERP Canonical Address Client",
          taxId: "B12345678",
          address: {
            street: "Av. Maritima 10",
            city: "Las Palmas",
            province: "Las Palmas",
            zip: "35001",
            countryCode: "ES",
          },
        };
      },
      createClient: async (input: Record<string, unknown>) => ({
        id: "cli_created",
        ...input,
        address: {
          street: "Calle Triana 5",
          city: "Las Palmas",
          province: "Las Palmas",
          zip: "35002",
          country: "ES",
          countryCode: "ES",
        },
      }),
      updateClient: async (id: string, data: Record<string, unknown>) => ({
        id,
        name: "Updated Client",
        ...data,
        address: "Calle String Legacy 42",
      }),
    } as unknown as IFrihetClient;

    const tools = new Map<string, (args: any) => Promise<any>>();
    const fakeServer = {
      registerTool: (name: string, _opts: unknown, handler: (args: any) => Promise<any>) => {
        tools.set(name, handler);
      },
    } as unknown as McpServer;

    registerClientTools(fakeServer, mockClient);

    const projected = await tools.get("list_clients")!({ fields: "id,name" });
    assert.deepEqual(projected.structuredContent.data[0], { id: "cli_proj", name: "Projected Client" });
    assert.equal(paginatedOutput(clientItemOutput, { projectable: true }).safeParse(projected.structuredContent).success, true);

    const legacy = await tools.get("get_client")!({ id: "null_fields_and_nif" });
    assert.equal("address" in legacy.structuredContent, false);
    assert.equal("email" in legacy.structuredContent, false);
    assert.equal("phone" in legacy.structuredContent, false);
    assert.equal("stage" in legacy.structuredContent, false);
    assert.equal(legacy.structuredContent.taxId, "B99887766");
    assert.equal(legacy.structuredContent.nif, "B99887766");
    assert.equal(legacy.structuredContent.customAttr, "preserved");
    assert.equal(clientItemOutput.safeParse(legacy.structuredContent).success, true);

    const canonical = await tools.get("get_client")!({ id: "erp_addr" });
    const parsedCanonical = clientItemOutput.safeParse(canonical.structuredContent);
    assert.equal(parsedCanonical.success, true);
    assert.equal(parsedCanonical.data?.address?.state, "Las Palmas");
    assert.equal(parsedCanonical.data?.address?.postalCode, "35001");
    assert.equal(parsedCanonical.data?.address?.country, "ES");

    const created = await tools.get("create_client")!({ name: "New Client" });
    const parsedCreated = clientItemOutput.safeParse(created.structuredContent);
    assert.equal(parsedCreated.success, true);
    assert.equal(parsedCreated.data?.address?.postalCode, "35002");
    assert.equal(parsedCreated.data?.address?.state, "Las Palmas");

    const updated = await tools.get("update_client")!({ id: "cli_1", phone: "+34600000000" });
    const parsedUpdated = clientItemOutput.safeParse(updated.structuredContent);
    assert.equal(parsedUpdated.success, true);
    assert.deepEqual(parsedUpdated.data?.address, { street: "Calle String Legacy 42" });
  });

  test("vendor tools normalize string/null/ERP-canonical addresses, backfill taxId, and honor listResources search bounds", async () => {
    const queriedVendors: string[] = [];
    const mockClient = {
      listVendors: async (params: { q?: string; offset?: number; limit?: number; after?: string }) => {
        queriedVendors.push(`${params.q ?? ""}|${params.offset ?? 0}|${params.after ?? ""}`);
        if (params.q === "Canarias_Blue") {
          return { data: [], total: 0, limit: 20, offset: 0 };
        }
        if (params.q === "Canarias Blue") {
          return {
            data: [{
              id: "ven_1",
              name: "Canarias Blue Suministros",
              email: null,
              taxId: null,
              cif: "B76543210",
              address: "Poligono Industrial 3",
            }],
            total: 1,
            limit: 20,
            offset: 0,
            truncated: true,
          };
        }
        return { data: [], total: 0, limit: 20, offset: 0 };
      },
      getVendor: async (id: string) => ({
        id,
        name: "Proveedor Canarias",
        address: { street: "Calle 1", province: "Santa Cruz de Tenerife", zip: "38001", countryCode: "ES" },
      }),
      createVendor: async (input: Record<string, unknown>) => ({
        id: "ven_new",
        ...input,
        address: null,
      }),
      updateVendor: async (id: string, data: Record<string, unknown>) => ({
        id,
        name: "Proveedor Editado",
        ...data,
        address: "Av. Canarias 12",
      }),
    } as unknown as IFrihetClient;

    const tools = new Map<string, (args: any) => Promise<any>>();
    const fakeServer = {
      registerTool: (name: string, _opts: unknown, handler: (args: any) => Promise<any>) => {
        tools.set(name, handler);
      },
    } as unknown as McpServer;

    registerVendorTools(fakeServer, mockClient);

    const listed = await tools.get("list_vendors")!({ q: "Canarias_Blue" });
    assert.ok(queriedVendors.includes("Canarias Blue|0|"));
    assert.deepEqual(listed.structuredContent.data[0].address, { street: "Poligono Industrial 3" });
    assert.equal(listed.structuredContent.data[0].taxId, "B76543210");
    assert.equal("email" in listed.structuredContent.data[0], false);
    assert.equal("truncated" in listed.structuredContent, false);
    assert.match(listed.content[0].text, /500-document|500 documentos/i);
    assert.equal(vendorItemOutput.safeParse(listed.structuredContent.data[0]).success, true);

    const fetched = await tools.get("get_vendor")!({ id: "ven_1" });
    const parsedFetched = vendorItemOutput.safeParse(fetched.structuredContent);
    assert.equal(parsedFetched.success, true);
    assert.equal(parsedFetched.data?.address?.state, "Santa Cruz de Tenerife");
    assert.equal(parsedFetched.data?.address?.postalCode, "38001");
    assert.equal(parsedFetched.data?.address?.country, "ES");

    const created = await tools.get("create_vendor")!({ name: "Vendor Null Addr" });
    assert.equal("address" in created.structuredContent, false);
    assert.equal(vendorItemOutput.safeParse(created.structuredContent).success, true);

    const updated = await tools.get("update_vendor")!({ id: "ven_1", phone: "+34928000000" });
    assert.deepEqual(updated.structuredContent.address, { street: "Av. Canarias 12" });
    assert.equal(vendorItemOutput.safeParse(updated.structuredContent).success, true);
  });
});

