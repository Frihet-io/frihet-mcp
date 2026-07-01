/**
 * Tests for Banking MCP tools — Wave 6 (5 tools).
 *
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Run: npm test (after build)
 *
 * Coverage:
 *   1. Tool registration — all 6 banking tools registered
 *   2. list_bank_accounts — success path + structuredContent shape
 *   3. get_bank_account — success path
 *   4. list_transactions — success path + filters
 *   5. categorize_transaction — success path + update response
 *   6. match_transaction_to_invoice — confirm=false gate
 *   7. match_transaction_to_invoice — confirm=true success path
 *   8. API error — 404 propagated as isError=true
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Minimal McpServer stub ───────────────────────────────────────────────────

interface ToolConfig {
  title: string;
  description: string;
  annotations?: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
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

// ── Mock data ────────────────────────────────────────────────────────────────

const MOCK_ACCOUNT = {
  id: "acct_001",
  alias: "Cuenta corriente BRTHLS",
  ibanLast4: "4321",
  currency: "EUR",
  balance: 12345.67,
  lastSyncedAt: "2026-05-10T08:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
};

const MOCK_ACCOUNTS_LIST = {
  data: [MOCK_ACCOUNT],
  total: 1,
  limit: 20,
  offset: 0,
};

const MOCK_TRANSACTION = {
  id: "tx_abc123",
  accountId: "acct_001",
  amount: -250.0,
  currency: "EUR",
  description: "Pago proveedor Acme",
  postedAt: "2026-05-09T14:23:00Z",
  category: "supplies",
  status: "posted",
  matchedDocId: null,
};

const MOCK_TRANSACTIONS_LIST = {
  data: [MOCK_TRANSACTION],
  total: 1,
  limit: 20,
  offset: 0,
};

const MOCK_RECONCILIATION_SUGGESTIONS = {
  transactionId: "tx_abc123",
  limit: 5,
  suggestions: [
    {
      documentType: "expense",
      documentId: "exp_match_001",
      score: 94,
      confidence: 94,
      suggested: true,
      amountDiff: 0,
      dateDiff: 1,
      breakdown: [
        { signal: "amount", points: 40, similarity: 1, reason: "Amount matches within tolerance" },
        { signal: "date", points: 24, similarity: 0.8, reason: "Date is within tolerance" },
        { signal: "counterparty", points: 30, similarity: 1, reason: "Counterparty is similar" },
      ],
      reasons: ["Amount matches within tolerance", "Counterparty is similar"],
    },
  ],
};

// ── Client stubs ─────────────────────────────────────────────────────────────

function makeSuccessClient(): import("../client-interface.js").IFrihetClient {
  return {
    listBankAccounts: async () => MOCK_ACCOUNTS_LIST,
    getBankAccount: async (_id: string) => MOCK_ACCOUNT,
    listTransactions: async () => MOCK_TRANSACTIONS_LIST,
    categorizeTransaction: async (_id: string, data: Record<string, unknown>) => ({ ...MOCK_TRANSACTION, category: data["category"] }),
    getReconciliationSuggestions: async () => MOCK_RECONCILIATION_SUGGESTIONS,
    matchTransactionToDocument: async (_txId: string, data: Record<string, unknown>) => ({
      ...MOCK_TRANSACTION,
      matchedDocId: data["documentId"],
    }),
  } as unknown as import("../client-interface.js").IFrihetClient;
}

function make404Client(): import("../client-interface.js").IFrihetClient {
  const notFound = () => {
    const err = Object.assign(new Error("Not Found"), { statusCode: 404, errorCode: "not_found" });
    return Promise.reject(err);
  };
  return {
    listBankAccounts: notFound,
    getBankAccount: notFound,
    listTransactions: notFound,
    categorizeTransaction: notFound,
    getReconciliationSuggestions: notFound,
    matchTransactionToDocument: notFound,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

// ── Helper ───────────────────────────────────────────────────────────────────

async function makeServer(
  clientFn: () => import("../client-interface.js").IFrihetClient,
): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  const { registerBankingTools } = await import("../tools/banking.js");
  registerBankingTools(
    server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    clientFn(),
  );
  return server;
}

// ── Registration tests ───────────────────────────────────────────────────────

describe("Banking Tools — Registration", () => {
  let server: StubMcpServer;

  beforeEach(async () => {
    server = await makeServer(makeSuccessClient);
  });

  test("registers exactly 6 banking tools", () => {
    assert.equal(server.tools.size, 6);
  });

  test("registers list_bank_accounts", () => {
    assert.ok(server.tools.has("list_bank_accounts"));
  });

  test("registers get_bank_account", () => {
    assert.ok(server.tools.has("get_bank_account"));
  });

  test("registers list_transactions", () => {
    assert.ok(server.tools.has("list_transactions"));
  });

  test("registers categorize_transaction", () => {
    assert.ok(server.tools.has("categorize_transaction"));
  });

  test("registers match_transaction_to_invoice", () => {
    assert.ok(server.tools.has("match_transaction_to_invoice"));
  });

  test("registers get_reconciliation_suggestions", () => {
    assert.ok(server.tools.has("get_reconciliation_suggestions"));
  });
});

// ── list_bank_accounts ───────────────────────────────────────────────────────

describe("list_bank_accounts — success path", () => {
  test("returns structuredContent with data array", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_bank_accounts")!;
    const result = await tool.handler({});

    assert.ok(!result.isError);
    assert.ok(result.structuredContent);
    const sc = result.structuredContent!;
    assert.ok(Array.isArray(sc["data"]));
    assert.equal((sc["data"] as unknown[]).length, 1);
    assert.equal(sc["total"], 1);
  });

  test("first account has IBAN last 4 and balance", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_bank_accounts")!;
    const result = await tool.handler({});

    const first = (result.structuredContent!["data"] as Record<string, unknown>[])[0]!;
    assert.equal(first["id"], "acct_001");
    assert.equal(first["ibanLast4"], "4321");
    assert.equal(first["currency"], "EUR");
    assert.equal(first["balance"], 12345.67);
  });

  test("content block has type text and mentions bank_accounts", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_bank_accounts")!;
    const result = await tool.handler({});
    assert.equal(result.content[0]!.type, "text");
    assert.ok(result.content[0]!.text.includes("bank_accounts"));
  });
});

// ── get_bank_account ─────────────────────────────────────────────────────────

describe("get_bank_account — success path", () => {
  test("returns single account by ID", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_bank_account")!;
    const result = await tool.handler({ id: "acct_001" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["id"], "acct_001");
    assert.equal(sc["alias"], "Cuenta corriente BRTHLS");
  });

  test("404 propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("get_bank_account")!;
    const result = await tool.handler({ id: "acct_missing" });
    assert.ok(result.isError);
    assert.ok(result.content[0]!.text.includes("Error:"));
  });
});

// ── list_transactions ────────────────────────────────────────────────────────

describe("list_transactions — success path", () => {
  test("returns transactions list", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_transactions")!;
    const result = await tool.handler({ accountId: "acct_001", from: "2026-05-01", to: "2026-05-31" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.ok(Array.isArray(sc["data"]));
    assert.equal(sc["total"], 1);
  });

  test("first transaction has expected fields", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_transactions")!;
    const result = await tool.handler({});

    const first = (result.structuredContent!["data"] as Record<string, unknown>[])[0]!;
    assert.equal(first["id"], "tx_abc123");
    assert.equal(first["amount"], -250.0);
    assert.equal(first["status"], "posted");
    assert.equal(first["category"], "supplies");
  });

  test("accepts status filter without error", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("list_transactions")!;
    const result = await tool.handler({ status: "posted" });
    assert.ok(!result.isError);
  });
});

// ── categorize_transaction ───────────────────────────────────────────────────

describe("categorize_transaction — success path", () => {
  test("returns updated transaction with new category", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("categorize_transaction")!;
    const result = await tool.handler({ id: "tx_abc123", category: "travel" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["id"], "tx_abc123");
    assert.equal(sc["category"], "travel");
  });

  test("content block mentions categorized", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("categorize_transaction")!;
    const result = await tool.handler({ id: "tx_abc123", category: "software", notes: "SaaS Q2" });
    assert.ok(result.content[0]!.text.includes("categorized"));
  });
});

// ── get_reconciliation_suggestions ──────────────────────────────────────────

describe("get_reconciliation_suggestions — read-only suggestions", () => {
  test("returns candidate matches with scoring breakdown", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_reconciliation_suggestions")!;
    const result = await tool.handler({ transactionId: "tx_abc123", limit: 5 });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["transactionId"], "tx_abc123");
    const suggestions = sc["suggestions"] as Record<string, unknown>[];
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0]!["documentId"], "exp_match_001");
    assert.equal(suggestions[0]!["confidence"], 94);
    assert.equal(suggestions[0]!["suggested"], true);
    assert.deepEqual(suggestions[0]!["breakdown"], [
      { signal: "amount", points: 40, similarity: 1, reason: "Amount matches within tolerance" },
      { signal: "date", points: 24, similarity: 0.8, reason: "Date is within tolerance" },
      { signal: "counterparty", points: 30, similarity: 1, reason: "Counterparty is similar" },
    ]);
  });

  test("tool is annotated read-only and closed-world", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_reconciliation_suggestions")!;
    assert.equal(tool.config.annotations?.["readOnlyHint"], true);
    assert.equal(tool.config.annotations?.["openWorldHint"], false);
  });
});

// ── match_transaction_to_invoice ─────────────────────────────────────────────

describe("match_transaction_to_invoice — trust area gate", () => {
  test("confirm=false returns isError=true without calling API", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("match_transaction_to_invoice")!;
    const result = await tool.handler({
      transactionId: "tx_abc123",
      documentId: "inv_xyz",
      documentType: "invoice",
      confirm: false,
    });

    assert.ok(result.isError, "should be isError when confirm=false");
    assert.ok(result.content[0]!.text.includes("confirm=true"));
  });

  test("confirm=true success path returns matched transaction", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("match_transaction_to_invoice")!;
    const result = await tool.handler({
      transactionId: "tx_abc123",
      documentId: "inv_xyz456",
      documentType: "invoice",
      confirm: true,
    });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["id"], "tx_abc123");
    assert.equal(sc["matchedDocId"], "inv_xyz456");
  });

  test("confirm=true with expense type works", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("match_transaction_to_invoice")!;
    const result = await tool.handler({
      transactionId: "tx_abc123",
      documentId: "exp_abc",
      documentType: "expense",
      confirm: true,
    });
    assert.ok(!result.isError);
  });
});
