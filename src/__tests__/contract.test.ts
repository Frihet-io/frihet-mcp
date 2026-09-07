/**
 * Output-schema CONTRACT tests.
 *
 * WHY THIS FILE EXISTS (the bug class it locks down forever):
 *
 * The MCP tools declare Zod `outputSchema`s and put the raw Cloud Function (CF)
 * response into `structuredContent`. The CF response has TWO shapes that have
 * historically drifted from the schemas and broken tools silently:
 *
 *   1. The `{ data, meta }` ENVELOPE. Single-object reads (e.g. the shipped
 *      `/v1/fiscal/modelo/:code` CF) return `res.json({ data: <item>, meta })`;
 *      list reads return `{ data: [<item>...], total, limit, offset }`. The
 *      client unwraps single objects to `body.data` (`requestUnwrapped`) and
 *      keeps the paginated envelope (`requestPaginated`). If the schema and the
 *      unwrap disagree, the tool emits a structuredContent the model can't parse.
 *
 *   2. Firestore-TIMESTAMP-shaped fields. Firestore-direct reads can leak
 *      `{ _seconds, _nanoseconds }` objects on date-ish fields instead of ISO
 *      strings. The enumerated date fields are typed `z.string()`, so a raw
 *      timestamp on `createdAt` would FAIL — but `.passthrough()` carries extra
 *      Firestore-internal timestamp fields (`_syncedAt`, `lastTouchedAt`, …)
 *      through untouched. This test pins BOTH facts: enumerated dates stay ISO
 *      strings, and extra `{_seconds}` fields pass via `.passthrough()`.
 *
 * If a future refactor tightens a schema (drops `.passthrough()`, or retypes a
 * passthrough timestamp field as `z.string()`), or the CF starts returning a
 * shape the schema rejects, THIS test goes red in CI — instead of the bug
 * reaching an LLM as an unparseable tool result.
 *
 * Run: npm test (after build) — node:test + node:assert.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { IFrihetClient } from "../client-interface.js";
import { registerProductTools } from "../tools/products.js";

import {
  fiscalModeloSummaryOutput,
  verifactuStatusOutput,
  paginatedOutput,
  invoiceItemOutput,
  expenseItemOutput,
  clientItemOutput,
  listContent,
  getContent,
  mutateContent,
  handleToolError,
} from "../tools/shared.js";

describe("content annotations — client compatibility", () => {
  for (const [operation, contentHelper] of [["list", listContent], ["get", getContent]] as const) {
    test(`${operation} preserves text and audience without an optional priority`, () => {
      const text = "Synthetic product\nDetails remain intact: á, €, 0.5";
      const result = { content: [contentHelper(text)], structuredContent: { id: "synthetic-product" } };

      // SDK validation alone permits fractional priorities; absence also pins
      // compatibility with clients that fail to decode those valid numbers.
      assert.deepEqual(CallToolResultSchema.parse(result), result);
      assert.deepEqual(result.content, [{ type: "text", text, annotations: { audience: ["user", "assistant"] } }]);
    });
  }

  test("mutation and error responses retain their user audience and highest priority", () => {
    const mutation = { content: [mutateContent("Synthetic update")], structuredContent: { id: "synthetic-product" } };
    const error = handleToolError({ statusCode: 404, errorCode: "not_found", message: "Synthetic missing product" });

    for (const result of [mutation, error]) {
      assert.deepEqual(CallToolResultSchema.parse(result), result);
      assert.deepEqual(result.content[0].annotations, { audience: ["user"], priority: 1 });
    }
    assert.equal(error.isError, true);
    assert.equal(error.content[0].text, "Error: Resource not found. / Recurso no encontrado.");
  });

  test("product reads preserve payloads and tool safety annotations through the real SDK", async () => {
    const product = { id: "synthetic-product", name: "Synthetic product", unitPrice: 12.5, description: "Complete synthetic details" };
    const page = { data: [{ id: product.id }], total: 1, limit: 1, offset: 0 };
    const backend = {
      listProducts: async (params: { fields?: string; limit?: number }) => {
        assert.equal(params.fields, "id");
        assert.equal(params.limit, 1);
        return page;
      },
      getProduct: async (id: string) => {
        assert.equal(id, product.id);
        return product;
      },
    } as unknown as IFrihetClient;
    const server = new McpServer({ name: "content-contract", version: "0.0.0" });
    registerProductTools(server, backend);
    const client = new Client({ name: "content-contract-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const { tools } = await client.listTools();
      for (const name of ["list_products", "get_product"]) {
        assert.deepEqual(tools.find(tool => tool.name === name)?.annotations, {
          readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
        });
      }
      const list = await client.callTool({ name: "list_products", arguments: { limit: 1, fields: "id" } }, CallToolResultSchema);
      const get = await client.callTool({ name: "get_product", arguments: { id: product.id } }, CallToolResultSchema);
      assert.deepEqual(list.structuredContent, page);
      assert.deepEqual(get.structuredContent, product);
      assert.deepEqual(list.content, [{
        type: "text",
        text: `Found 1 products (showing 1, offset 0):\n\n${JSON.stringify(page.data[0], null, 2)}\n---`,
        annotations: { audience: ["user", "assistant"] },
      }]);
      assert.deepEqual(get.content, [{
        type: "text", text: `Product:\n${JSON.stringify(product, null, 2)}`,
        annotations: { audience: ["user", "assistant"] },
      }]);
      assert.ok(!list.isError && !get.isError);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// ── Fixtures: representative CF responses ────────────────────────────────────

/** A Firestore Timestamp as it appears in a JSON-serialized CF response. */
const FIRESTORE_TS = { _seconds: 1_771_200_000, _nanoseconds: 0 } as const;

/**
 * The fiscal-summary CF body AFTER `requestUnwrapped` strips the `{ data, meta }`
 * envelope — i.e. exactly what the tool receives. Includes the `model` (not
 * `modeloCode`) shape the live CF emits, the `modelo303` totals block, a
 * `summary` counts block, and a passthrough Firestore-timestamp field
 * (`computedAt`) that is NOT in the schema's enumerated fields.
 */
const FISCAL_303_UNWRAPPED = {
  model: "303",
  period: "2026-Q1",
  months: ["2026-01", "2026-02", "2026-03"],
  modelo303: {
    baseImponible: 10_000,
    cuotaRepercutida: 2_100,
    baseDeducible: 4_000,
    cuotaDeducible: 840,
    resultado: 1_260,
  },
  summary: { invoiceCount: 12, expenseCount: 7 },
  readonly: true as const,
  note: "Informational summary — never filed to AEAT.",
  // Firestore-internal timestamp leaking through .passthrough() — must validate.
  computedAt: FIRESTORE_TS,
};

/** The raw `{ data, meta }` envelope as the CF emits it pre-unwrap. */
const FISCAL_303_ENVELOPE = {
  data: FISCAL_303_UNWRAPPED,
  meta: { generatedAt: FIRESTORE_TS, source: "cf:getFiscalModeloSummary" },
};

/** Mirror of `requestUnwrapped`: pull `.data` out of a single-object envelope. */
function unwrap(body: unknown): unknown {
  if (body !== null && typeof body === "object" && !Array.isArray(body) && "data" in body) {
    const inner = (body as { data: unknown }).data;
    if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
      return inner;
    }
  }
  return body;
}

const VERIFACTU_STATUS = {
  invoiceId: "inv_2026_001",
  lastSubmissionAt: "2026-04-15T10:30:00.000Z", // enumerated date field stays ISO
  hash: "a1b2c3",
  status: "success" as const,
  aeatResponse: "Aceptado",
  qrUrl: "https://www2.agenciatributaria.gob.es/qr/...",
  // Firestore-internal timestamp via passthrough — must validate.
  _chainTouchedAt: FIRESTORE_TS,
};

/** A paginated list envelope as `requestPaginated` keeps it: data[] + counts. */
const INVOICE_LIST_ENVELOPE = {
  data: [
    {
      id: "inv_1",
      clientName: "ACME SL",
      items: [{ description: "Consulting", quantity: 1, unitPrice: 1000 }],
      issueDate: "2026-03-01",
      dueDate: "2026-03-31",
      status: "sent",
      total: 1210,
      createdAt: "2026-03-01T09:00:00.000Z", // enumerated date → ISO string
      // Firestore-internal timestamp via passthrough.
      _firestoreUpdatedAt: FIRESTORE_TS,
    },
  ],
  total: 1,
  limit: 20,
  offset: 0,
  nextCursor: "inv_1",
};

const EXPENSE_LIST_ENVELOPE = {
  data: [
    {
      id: "exp_1",
      description: "AWS",
      amount: 42.5,
      category: "software",
      date: "2026-03-02",
      taxDeductible: true,
      createdAt: "2026-03-02T00:00:00.000Z",
      _syncedAt: FIRESTORE_TS,
    },
  ],
  total: 1,
  limit: 20,
  offset: 0,
};

const CLIENT_LIST_ENVELOPE = {
  data: [
    {
      id: "cli_1",
      name: "ACME SL",
      email: "facturas@acme.es",
      taxId: "B12345678",
      address: { city: "Madrid", country: "ES" },
      createdAt: "2026-01-10T00:00:00.000Z",
      _importedAt: FIRESTORE_TS,
    },
  ],
  total: 1,
  limit: 20,
  offset: 0,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("output-schema contract — fiscal single-object reads", () => {
  test("fiscalModeloSummaryOutput accepts the unwrapped 303 CF body", () => {
    const unwrapped = unwrap(FISCAL_303_ENVELOPE);
    const parsed = fiscalModeloSummaryOutput.safeParse(unwrapped);
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
  });

  test("unwrap() strips the { data, meta } envelope (matches client.requestUnwrapped)", () => {
    const unwrapped = unwrap(FISCAL_303_ENVELOPE) as Record<string, unknown>;
    assert.equal(unwrapped.model, "303");
    assert.equal("meta" in unwrapped, false, "meta must NOT leak into the unwrapped item");
  });

  test("a Firestore-Timestamp {_seconds} field survives via .passthrough()", () => {
    const parsed = fiscalModeloSummaryOutput.safeParse(unwrap(FISCAL_303_ENVELOPE));
    assert.equal(parsed.success, true);
    if (parsed.success) {
      const ts = (parsed.data as Record<string, unknown>).computedAt as { _seconds?: number };
      assert.equal(ts?._seconds, FIRESTORE_TS._seconds, "timestamp field must pass through intact");
    }
  });

  test("verifactuStatusOutput accepts the status CF body incl. passthrough timestamp", () => {
    const parsed = verifactuStatusOutput.safeParse(VERIFACTU_STATUS);
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
  });

  test("enumerated date fields MUST stay strings — a raw {_seconds} there is rejected", () => {
    // This pins the contract: the CF must emit ISO strings for enumerated dates.
    // If it ever leaks a raw timestamp onto `lastSubmissionAt`, the tool would
    // emit garbage — so we assert the schema (correctly) refuses it.
    const bad = { ...VERIFACTU_STATUS, lastSubmissionAt: FIRESTORE_TS };
    const parsed = verifactuStatusOutput.safeParse(bad);
    assert.equal(parsed.success, false, "raw timestamp on an enumerated z.string() date must fail");
  });
});

describe("output-schema contract — core list reads ({ data, ... } envelope)", () => {
  test("invoices list envelope validates against paginatedOutput(invoiceItemOutput)", () => {
    const schema = paginatedOutput(invoiceItemOutput);
    const parsed = schema.safeParse(INVOICE_LIST_ENVELOPE);
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
  });

  test("a list item carrying a Firestore Timestamp passthrough field validates", () => {
    const schema = paginatedOutput(invoiceItemOutput);
    const parsed = schema.safeParse(INVOICE_LIST_ENVELOPE);
    assert.equal(parsed.success, true);
    if (parsed.success) {
      const item = parsed.data.data[0] as Record<string, unknown>;
      const ts = item._firestoreUpdatedAt as { _seconds?: number };
      assert.equal(ts?._seconds, FIRESTORE_TS._seconds);
    }
  });

  test("expenses list envelope validates against paginatedOutput(expenseItemOutput)", () => {
    const schema = paginatedOutput(expenseItemOutput);
    const parsed = schema.safeParse(EXPENSE_LIST_ENVELOPE);
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
  });

  test("clients list envelope validates against paginatedOutput(clientItemOutput)", () => {
    const schema = paginatedOutput(clientItemOutput);
    const parsed = schema.safeParse(CLIENT_LIST_ENVELOPE);
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
  });

  test("paginatedOutput requires the envelope counts (data/total/limit/offset)", () => {
    const schema = paginatedOutput(invoiceItemOutput);
    // Missing `total`/`limit`/`offset` (a bare array-ish body) must fail — this
    // is the drift that breaks pagination if the CF stops emitting counts.
    const parsed = schema.safeParse({ data: INVOICE_LIST_ENVELOPE.data });
    assert.equal(parsed.success, false, "envelope without counts must be rejected");
  });
});
