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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FrihetClient } from "../client.js";
import { applyClaudeCandidateProfile } from "../claude-profile.js";
import { applyOpenAIProfile } from "../openai-profile.js";
import { registerClientTools } from "../tools/clients.js";
import { registerVendorTools } from "../tools/vendors.js";
import { clientItemOutput, vendorItemOutput, paginatedOutput } from "../tools/shared.js";
import type { IFrihetClient } from "../client-interface.js";

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

  test("list_clients and list_vendors apply a conservative refusal (isError: true, no structuredContent) on truncated=true or q+after across Standard, Claude, and OpenAI profiles", async () => {
    const queriedTerms: string[] = [];
    const mockClient = {
      listClients: async (params: { q?: string; offset?: number; limit?: number; after?: string }) => {
        queriedTerms.push(`${params.q ?? ""}|${params.offset ?? 0}|${params.after ?? ""}`);
        if (params.q === "TruncatedCorp" || params.after === "force_truncated_scan") {
          return {
            data: [{ id: "cli_t1", name: "Truncated Corp 1" }],
            total: 1,
            limit: params.limit ?? 20,
            offset: params.offset ?? 0,
            truncated: true,
            meta: { requestId: "req_1" },
          };
        }
        return { data: [], total: undefined as unknown as number, limit: params.limit ?? 20, offset: params.offset ?? 0 };
      },
      listVendors: async (params: { q?: string; offset?: number; limit?: number; after?: string }) => {
        if (params.q === "TruncatedVendor" || params.after === "force_truncated_scan") {
          return {
            data: [{ id: "ven_t1", name: "Truncated Vendor 1" }],
            total: 1,
            limit: params.limit ?? 20,
            offset: params.offset ?? 0,
            truncated: true,
          };
        }
        return { data: [], total: 0, limit: params.limit ?? 20, offset: params.offset ?? 0 };
      },
    } as unknown as IFrihetClient;

    const tools = new Map<string, (args: any) => Promise<any>>();
    const fakeServer = {
      registerTool: (name: string, _opts: unknown, handler: (args: any) => Promise<any>) => {
        tools.set(name, handler);
      },
    } as unknown as McpServer;

    registerClientTools(fakeServer, mockClient);
    registerVendorTools(fakeServer, mockClient);
    const listClientsTool = tools.get("list_clients")!;
    const listVendorsTool = tools.get("list_vendors")!;

    // 1. Exhausted page 2 with undefined total: does not fallback and returns clean empty page
    await listClientsTool({ q: "SLCanarias", offset: 20, limit: 20 });
    assert.deepEqual(queriedTerms, ["SLCanarias|20|"], "Must not fallback when total is undefined on page 2+");

    // 2. Direct handler: truncated 500-doc scan refuses conservatively (isError=true, no structuredContent)
    queriedTerms.length = 0;
    const truncRes = await listClientsTool({ q: "TruncatedCorp", offset: 0, limit: 20 });
    assert.deepEqual(queriedTerms, ["TruncatedCorp|0|"], "Must not fallback when 500-doc scan is truncated");
    assert.equal(truncRes.isError, true, "Truncated 500-doc scan must return isError=true");
    assert.equal(truncRes.structuredContent, undefined, "Truncated scan must NOT emit structuredContent that protected profiles would render as exhaustive");
    assert.match(truncRes.content[0].text, /500-document|500 documentos/i);

    // 3. Direct handler: combining q with after cursor refuses conservatively without calling backend
    queriedTerms.length = 0;
    const cursorSearchRes = await listClientsTool({ q: "CanariasBlue", after: "cur_1" });
    assert.deepEqual(queriedTerms, [], "Must fail closed before calling backend when q and after are combined");
    assert.equal(cursorSearchRes.isError, true);
    assert.equal(cursorSearchRes.structuredContent, undefined);
    assert.match(cursorSearchRes.content[0].text, /ignores 'after'|ignora 'after'/i);

    const vendorCursorSearchRes = await listVendorsTool({ q: "VendorBlue", after: "cur_1" });
    assert.equal(vendorCursorSearchRes.isError, true);
    assert.equal(vendorCursorSearchRes.structuredContent, undefined);

    // 4. Real MCP SDK + Claude Candidate Profile (`applyClaudeCandidateProfile`):
    //    Verify neither truncated=true nor q+after is ever presented as an exhaustive list.
    //    Note: `claudeToolResult` (`src/claude-output-privacy.ts`) replaces unstructured error text
    //    with a generic privacy-redacted message ("Frihet could not complete or confirm this request..."),
    //    so Claude receives `isError=true` and `structuredContent=undefined`, never the partial list,
    //    while preserving the frozen Claude privacy filter contract.
    const claudeServer = new McpServer({ name: "claude-trunc-test", version: "1.0.0" });
    applyClaudeCandidateProfile(claudeServer);
    registerClientTools(claudeServer, mockClient);
    registerVendorTools(claudeServer, mockClient);
    const claudeClient = new Client({ name: "claude-trunc-client", version: "1.0.0" });
    const [claudeCt, claudeSt] = InMemoryTransport.createLinkedPair();
    await Promise.all([claudeClient.connect(claudeCt), claudeServer.connect(claudeSt)]);
    try {
      const claudeTruncClients = await claudeClient.callTool({
        name: "list_clients",
        arguments: { q: "TruncatedCorp" },
      });
      assert.equal(claudeTruncClients.isError, true, "Claude profile must receive isError=true on truncated client search");
      assert.equal(claudeTruncClients.structuredContent, undefined, "Claude profile must NOT receive structuredContent on truncated client search");
      const claudeTruncClientText = (claudeTruncClients.content as Array<{ type: string; text: string }>)[0]!.text;
      assert.equal(
        claudeTruncClientText,
        "Frihet could not complete or confirm this request. Check access and read the current record before deciding whether to retry.",
      );

      const claudeTruncVendors = await claudeClient.callTool({
        name: "list_vendors",
        arguments: { q: "TruncatedVendor" },
      });
      assert.equal(claudeTruncVendors.isError, true, "Claude profile must receive isError=true on truncated vendor search");
      assert.equal(claudeTruncVendors.structuredContent, undefined, "Claude profile must NOT receive structuredContent on truncated vendor search");

      const claudeQAfter = await claudeClient.callTool({
        name: "list_clients",
        arguments: { q: "CanariasBlue", after: "cur_1" },
      });
      assert.equal(claudeQAfter.isError, true, "Claude profile must receive isError=true when q and after are combined");
      assert.equal(claudeQAfter.structuredContent, undefined);
    } finally {
      await Promise.allSettled([claudeClient.close(), claudeServer.close()]);
    }

    // 5. Real MCP SDK + OpenAI Reviewed Profile (`applyOpenAIProfile`):
    //    Verify that:
    //    (a) passing `q` (or `q + after`) is rejected by the strict reviewed input contract, and
    //    (b) if the backend ever returns `truncated=true` on a list call, OpenAI receives `isError=true`
    //        with the refusal text intact and NEVER replaces it with "Frihet returned N reviewed summary record(s)".
    const openaiServer = new McpServer({ name: "openai-trunc-test", version: "1.0.0" });
    applyOpenAIProfile(openaiServer);
    registerClientTools(openaiServer, mockClient);
    registerVendorTools(openaiServer, mockClient);
    const openaiClient = new Client({ name: "openai-trunc-client", version: "1.0.0" });
    const [openaiCt, openaiSt] = InMemoryTransport.createLinkedPair();
    await Promise.all([openaiClient.connect(openaiCt), openaiServer.connect(openaiSt)]);
    try {
      const openaiTruncClients = await openaiClient.callTool({
        name: "list_clients",
        arguments: { after: "force_truncated_scan" },
      });
      assert.equal(openaiTruncClients.isError, true, "OpenAI profile must receive isError=true on truncated client scan");
      assert.equal(openaiTruncClients.structuredContent, undefined, "OpenAI profile must NOT receive structuredContent on truncated client scan");
      const openaiClientText = (openaiTruncClients.content as Array<{ type: string; text: string }>)[0]!.text;
      assert.match(openaiClientText, /500-document|500 documentos/i);
      assert.doesNotMatch(openaiClientText, /reviewed summary record/i);

      const openaiTruncVendors = await openaiClient.callTool({
        name: "list_vendors",
        arguments: { after: "force_truncated_scan" },
      });
      assert.equal(openaiTruncVendors.isError, true, "OpenAI profile must receive isError=true on truncated vendor scan");
      assert.equal(openaiTruncVendors.structuredContent, undefined);
      const openaiVendorText = (openaiTruncVendors.content as Array<{ type: string; text: string }>)[0]!.text;
      assert.match(openaiVendorText, /500-document|500 documentos/i);
      assert.doesNotMatch(openaiVendorText, /reviewed summary record/i);
    } finally {
      await Promise.allSettled([openaiClient.close(), openaiServer.close()]);
    }
  });

  test("client normalization preserves identity, NIF backfill, projected fields, null scalars, flat root address fields, and ERP zip/province/countryCode addresses", async () => {
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
        if (id === "flat_root_address") {
          return {
            id,
            name: "Flat Root Address Client",
            street: "Calle León y Castillo 20",
            city: "Las Palmas",
            province: "Las Palmas",
            zip: "35004",
            countryCode: "ES",
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

    const flatRoot = await tools.get("get_client")!({ id: "flat_root_address" });
    const parsedFlatRoot = clientItemOutput.safeParse(flatRoot.structuredContent);
    assert.equal(parsedFlatRoot.success, true);
    assert.deepEqual(parsedFlatRoot.data?.address, {
      street: "Calle León y Castillo 20",
      city: "Las Palmas",
      state: "Las Palmas",
      postalCode: "35004",
      country: "ES",
    });

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

  test("vendor tools normalize string/null/flat/ERP-canonical addresses, backfill taxId, and honor listResources search bounds", async () => {
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
              city: "Telde",
              province: "Las Palmas",
              zip: "35200",
              countryCode: "ES",
            }],
            total: 1,
            limit: 20,
            offset: 0,
          };
        }
        if (params.q === "Truncated_Vendor") {
          return { data: [], total: 0, limit: 20, offset: 0 };
        }
        if (params.q === "Truncated Vendor") {
          return {
            data: [],
            total: 0,
            limit: 20,
            offset: 0,
            truncated: true,
          };
        }
        return { data: [], total: 0, limit: 20, offset: 0 };
      },
      getVendor: async (id: string) => {
        if (id === "ven_flat") {
          return {
            id,
            name: "Proveedor Raiz Plana",
            street: "Calle Mayor 7",
            city: "La Laguna",
            province: "Santa Cruz de Tenerife",
            zip: "38201",
            countryCode: "ES",
          };
        }
        return {
          id,
          name: "Proveedor Canarias",
          address: { street: "Calle 1", province: "Santa Cruz de Tenerife", zip: "38001", countryCode: "ES" },
        };
      },
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
    assert.deepEqual(listed.structuredContent.data[0].address, {
      street: "Poligono Industrial 3",
      city: "Telde",
      state: "Las Palmas",
      postalCode: "35200",
      country: "ES",
    });
    assert.equal(listed.structuredContent.data[0].taxId, "B76543210");
    assert.equal("email" in listed.structuredContent.data[0], false);
    assert.equal(vendorItemOutput.safeParse(listed.structuredContent.data[0]).success, true);

    // Truncated fallback scan on vendor must also refuse conservatively
    const truncFallback = await tools.get("list_vendors")!({ q: "Truncated_Vendor" });
    assert.equal(truncFallback.isError, true);
    assert.equal(truncFallback.structuredContent, undefined);
    assert.match(truncFallback.content[0].text, /500-document|500 documentos/i);

    const fetched = await tools.get("get_vendor")!({ id: "ven_1" });
    const parsedFetched = vendorItemOutput.safeParse(fetched.structuredContent);
    assert.equal(parsedFetched.success, true);
    assert.equal(parsedFetched.data?.address?.state, "Santa Cruz de Tenerife");
    assert.equal(parsedFetched.data?.address?.postalCode, "38001");
    assert.equal(parsedFetched.data?.address?.country, "ES");

    const fetchedFlat = await tools.get("get_vendor")!({ id: "ven_flat" });
    const parsedFlat = vendorItemOutput.safeParse(fetchedFlat.structuredContent);
    assert.equal(parsedFlat.success, true);
    assert.deepEqual(parsedFlat.data?.address, {
      street: "Calle Mayor 7",
      city: "La Laguna",
      state: "Santa Cruz de Tenerife",
      postalCode: "38201",
      country: "ES",
    });

    const created = await tools.get("create_vendor")!({ name: "Vendor Null Addr" });
    assert.equal("address" in created.structuredContent, false);
    assert.equal(vendorItemOutput.safeParse(created.structuredContent).success, true);

    const updated = await tools.get("update_vendor")!({ id: "ven_1", phone: "+34928000000" });
    assert.deepEqual(updated.structuredContent.address, { street: "Av. Canarias 12" });
    assert.equal(vendorItemOutput.safeParse(updated.structuredContent).success, true);
  });
});

