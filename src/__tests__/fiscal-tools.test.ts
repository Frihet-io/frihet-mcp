/**
 * Tests for Fiscal MCP tools — Wave 6 (7 tools).
 *
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Run: npm test (after build)
 *
 * Coverage:
 *   1. Tool registration — all 7 fiscal tools registered
 *   2. get_modelo_303_summary — success path + period param
 *   3. get_modelo_130_summary — success path
 *   4. get_modelo_390_summary — success path
 *   5. get_modelo_180_summary — success path
 *   6. get_modelo_347_summary — success path
 *   7. verifactu_status — success path
 *   8. verifactu_resubmit — confirm=false gate + confirm=true success
 *   9. API error — 404 propagated as isError=true
 *
 * NOTE: ticketbai_status is tested in einvoice-day4-tools.test.ts (canonical).
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

const MOCK_MODELO_SUMMARY = {
  modeloCode: "303",
  period: "2026-Q1",
  totalsByRate: { "21": 4200.0, "10": 350.0, "4": 80.0 },
  totalDeductible: 1200.0,
  totalDue: 3430.0,
  deadline: "2026-04-20",
};

const MOCK_VERIFACTU_STATUS = {
  invoiceId: "inv_abc123",
  lastSubmissionAt: "2026-05-09T10:00:00Z",
  hash: "sha256:abcdef1234567890",
  status: "success",
  aeatResponse: "0000",
  qrUrl: "https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=B12345678&numserie=2026-001&fecha=2026-05-09&importe=1210.00",
};

const MOCK_TICKETBAI_STATUS = {
  invoiceId: "inv_def456",
  lastSubmissionAt: "2026-05-09T11:00:00Z",
  hash: "sha256:xyz9876543210",
  status: "success",
  aeatResponse: "0000",
  qrUrl: "https://tbai.ehu.eus/qr/...",
  province: "bizkaia",
};

// ── Client stubs ─────────────────────────────────────────────────────────────

function makeSuccessClient(): import("../client-interface.js").IFrihetClient {
  return {
    getFiscalModeloSummary: async (modeloCode: string, period?: string) => ({
      ...MOCK_MODELO_SUMMARY,
      modeloCode,
      period: period ?? "2026-Q1",
    }),
    getVerifactuStatus: async (_invoiceId: string) => MOCK_VERIFACTU_STATUS,
    resubmitVerifactu: async (_invoiceId: string) => ({ ...MOCK_VERIFACTU_STATUS, status: "pending" }),
    getTicketbaiStatus: async (_invoiceId: string) => MOCK_TICKETBAI_STATUS,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

function make404Client(): import("../client-interface.js").IFrihetClient {
  const notFound = () => {
    const err = Object.assign(new Error("Not Found"), { statusCode: 404, errorCode: "not_found" });
    return Promise.reject(err);
  };
  return {
    getFiscalModeloSummary: notFound,
    getVerifactuStatus: notFound,
    resubmitVerifactu: notFound,
    getTicketbaiStatus: notFound,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

// ── Helper ───────────────────────────────────────────────────────────────────

async function makeServer(
  clientFn: () => import("../client-interface.js").IFrihetClient,
): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  const { registerFiscalTools } = await import("../tools/fiscal.js");
  registerFiscalTools(
    server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    clientFn(),
  );
  return server;
}

// ── Registration tests ───────────────────────────────────────────────────────

describe("Fiscal Tools — Registration", () => {
  let server: StubMcpServer;

  beforeEach(async () => {
    server = await makeServer(makeSuccessClient);
  });

  test("registers exactly 7 fiscal tools", () => {
    assert.equal(server.tools.size, 7);
  });

  for (const name of [
    "get_modelo_303_summary",
    "get_modelo_130_summary",
    "get_modelo_390_summary",
    "get_modelo_180_summary",
    "get_modelo_347_summary",
    "verifactu_status",
    "verifactu_resubmit",
  ]) {
    test(`registers ${name}`, () => {
      assert.ok(server.tools.has(name), `${name} not registered`);
    });
  }
});

// ── Modelo summaries ─────────────────────────────────────────────────────────

describe("get_modelo_303_summary — success path", () => {
  test("returns summary with totalsDue and period", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_modelo_303_summary")!;
    const result = await tool.handler({ period: "2026-Q1" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["modeloCode"], "303");
    assert.equal(sc["period"], "2026-Q1");
    assert.equal(sc["totalDue"], 3430.0);
    assert.ok(typeof sc["totalsByRate"] === "object");
  });

  test("content block mentions Modelo 303", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_modelo_303_summary")!;
    const result = await tool.handler({});
    assert.ok(result.content[0]!.text.includes("303"));
  });

  test("404 propagates as isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("get_modelo_303_summary")!;
    const result = await tool.handler({ period: "2026-Q1" });
    assert.ok(result.isError);
  });
});

describe("get_modelo_130_summary — success path", () => {
  test("returns modeloCode 130", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_modelo_130_summary")!;
    const result = await tool.handler({ period: "2026-Q1" });
    assert.ok(!result.isError);
    assert.equal(result.structuredContent!["modeloCode"], "130");
  });
});

describe("get_modelo_390_summary — success path", () => {
  test("returns modeloCode 390", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_modelo_390_summary")!;
    const result = await tool.handler({ period: "2025" });
    assert.ok(!result.isError);
    assert.equal(result.structuredContent!["modeloCode"], "390");
  });
});

describe("get_modelo_180_summary — success path", () => {
  test("returns modeloCode 180", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_modelo_180_summary")!;
    const result = await tool.handler({ period: "2025" });
    assert.ok(!result.isError);
    assert.equal(result.structuredContent!["modeloCode"], "180");
  });
});

describe("get_modelo_347_summary — success path", () => {
  test("returns modeloCode 347", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("get_modelo_347_summary")!;
    const result = await tool.handler({ period: "2025" });
    assert.ok(!result.isError);
    assert.equal(result.structuredContent!["modeloCode"], "347");
  });
});

// ── verifactu_status ─────────────────────────────────────────────────────────

describe("verifactu_status — success path", () => {
  test("returns status with hash and qrUrl", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("verifactu_status")!;
    const result = await tool.handler({ invoiceId: "inv_abc123" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["invoiceId"], "inv_abc123");
    assert.equal(sc["status"], "success");
    assert.ok(typeof sc["hash"] === "string");
    assert.ok(typeof sc["qrUrl"] === "string");
  });

  test("aeatResponse is present", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("verifactu_status")!;
    const result = await tool.handler({ invoiceId: "inv_abc123" });
    assert.equal(result.structuredContent!["aeatResponse"], "0000");
  });
});

// ── verifactu_status — app-level 404 semantics ───────────────────────────────
// The live endpoint (publicApi GET /fiscal/verifactu/:id/status) IS deployed and
// uses 404 for two app-level states. Neither may surface as the guard's
// "backend unavailable" (which tells the user the feature is not enabled — the
// exact misleading message a fresh invoice produced in the golden flow).

describe("verifactu_status — 404 'no submission yet' is a normal state, not an error", () => {
  function makeNoSubmissionClient(): import("../client-interface.js").IFrihetClient {
    const noSub = () => {
      const msg =
        "No VeriFactu submission found for this invoice. Submit first via the VeriFactu submission flow.";
      return Promise.reject(Object.assign(new Error(msg), { statusCode: 404, errorCode: msg }));
    };
    return { getVerifactuStatus: noSub } as unknown as import("../client-interface.js").IFrihetClient;
  }

  test("maps to status=not_submitted success result (no isError, no backend_unavailable)", async () => {
    const server = await makeServer(makeNoSubmissionClient);
    const tool = server.tools.get("verifactu_status")!;
    const result = await tool.handler({ invoiceId: "inv_fresh" });

    assert.ok(!result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["invoiceId"], "inv_fresh");
    assert.equal(sc["status"], "not_submitted");
    assert.equal(sc["accepted"], false);
    assert.equal(sc["_backendUnavailable"], undefined);
    // Copy must state it is a normal state — never "feature not enabled".
    assert.ok(result.content[0]!.text.includes("NOT an error"));
    assert.ok(!result.content[0]!.text.includes("not available yet"));
  });
});

describe("verifactu_status — 404 'invoice not found' is a real error, not backend_unavailable", () => {
  function makeInvoiceNotFoundClient(): import("../client-interface.js").IFrihetClient {
    const nf = () => {
      const msg = "Invoice 'inv_missing' not found";
      return Promise.reject(Object.assign(new Error(msg), { statusCode: 404, errorCode: msg }));
    };
    return { getVerifactuStatus: nf } as unknown as import("../client-interface.js").IFrihetClient;
  }

  test("returns isError with invoice_not_found (guides to internal id)", async () => {
    const server = await makeServer(makeInvoiceNotFoundClient);
    const tool = server.tools.get("verifactu_status")!;
    const result = await tool.handler({ invoiceId: "inv_missing" });

    assert.ok(result.isError);
    const sc = result.structuredContent!;
    assert.equal(sc["error"], "invoice_not_found");
    assert.equal(sc["_backendUnavailable"], undefined);
    assert.ok(result.content[0]!.text.includes("internal invoice id"));
  });
});

describe("verifactu_status — generic 404 still falls through to the backend guard", () => {
  test("plain 'Not Found' body keeps backend_unavailable behavior", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("verifactu_status")!;
    const result = await tool.handler({ invoiceId: "inv_abc123" });

    assert.ok(result.isError);
    assert.equal(result.structuredContent!["error"], "backend_unavailable");
  });
});

// ── verifactu_resubmit ───────────────────────────────────────────────────────

describe("verifactu_resubmit — trust area gate", () => {
  test("confirm=false returns isError=true", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("verifactu_resubmit")!;
    const result = await tool.handler({ invoiceId: "inv_abc123", confirm: false });
    assert.ok(result.isError);
    assert.ok(result.content[0]!.text.includes("confirm=true"));
  });

  test("confirm=true proceeds and returns pending status", async () => {
    const server = await makeServer(makeSuccessClient);
    const tool = server.tools.get("verifactu_resubmit")!;
    const result = await tool.handler({ invoiceId: "inv_abc123", confirm: true });
    assert.ok(!result.isError);
    assert.equal(result.structuredContent!["status"], "pending");
  });

  test("confirm=true with 404 propagates isError=true", async () => {
    const server = await makeServer(make404Client);
    const tool = server.tools.get("verifactu_resubmit")!;
    const result = await tool.handler({ invoiceId: "inv_missing", confirm: true });
    assert.ok(result.isError);
  });
});

// ticketbai_status is tested in einvoice-day4-tools.test.ts (canonical location).
