/**
 * Tests for Day 4 e-invoice MCP tools — FACe, TicketBAI, KSeF, einvoice_export.
 *
 * Uses Node.js built-in test runner (node:test + node:assert) — no extra deps.
 * Run: npm test (after build: node --test dist/__tests__/einvoice-day4-tools.test.js)
 *
 * Coverage:
 *   1. Tool registration — all 6 Day 4 tools registered (127→133)
 *   2. 404-fallback path — CF endpoint not yet deployed → stub fires
 *   3. Success path — live client data passed through correctly
 *   4. Error paths — 403/422/500 are rethrown (not swallowed)
 *   5. ksef_submit stub — always returns _notImplemented=true
 *   6. Stub response shapes match declared outputSchema fields
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

// ── Client stubs ─────────────────────────────────────────────────────────────

/** Simulates CF endpoint not yet deployed (returns 404). */
function make404Client(): import("../client-interface.js").IFrihetClient {
  const notFound = () => {
    const err = Object.assign(new Error("Not Found"), { statusCode: 404, errorCode: "not_found" });
    return Promise.reject(err);
  };
  return {
    exportEInvoice: notFound,
    faceSubmit: notFound,
    faceStatus: notFound,
    ticketbaiSubmit: notFound,
    ticketbaiStatus: notFound,
    // kSeFSubmit: not wired in client — tool is always-stub
  } as unknown as import("../client-interface.js").IFrihetClient;
}

/** Simulates a 403 Forbidden error (auth failure — should rethrow, not stub). */
function make403Client(): import("../client-interface.js").IFrihetClient {
  const forbidden = () => {
    const err = Object.assign(new Error("Forbidden"), { statusCode: 403, errorCode: "forbidden" });
    return Promise.reject(err);
  };
  return {
    exportEInvoice: forbidden,
    faceSubmit: forbidden,
    faceStatus: forbidden,
    ticketbaiSubmit: forbidden,
    ticketbaiStatus: forbidden,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

/**
 * Simulates a 500 from a LIVE CF — e.g. a real FACe/TicketBAI signature or
 * submission failure. COMPLIANCE: must rethrow (isError), NEVER masked as a
 * success stub. This is the case the genuine-404-only fallback contract guards.
 */
function make500Client(): import("../client-interface.js").IFrihetClient {
  const serverError = () => {
    const err = Object.assign(new Error("Signature/submission failed"), {
      statusCode: 500,
      errorCode: "signature_failed",
    });
    return Promise.reject(err);
  };
  return {
    exportEInvoice: serverError,
    faceSubmit: serverError,
    faceStatus: serverError,
    ticketbaiSubmit: serverError,
    ticketbaiStatus: serverError,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

/** Simulates CF endpoints live and returning real data. */
function makeLiveClient(): import("../client-interface.js").IFrihetClient {
  return {
    exportEInvoice: async () => ({
      xmlUrl: "https://storage.frihet.io/live/einvoice/inv_123-facturae.xml",
      filename: "inv_123-facturae.xml",
      format: "facturae",
      signed: true,
    }),
    faceSubmit: async () => ({
      registroFACe: "RCF_LIVE_20260513_001",
      status: "submitted" as const,
      submittedAt: "2026-05-13T10:00:00.000Z",
      mode: "production",
    }),
    faceStatus: async () => ({
      registroFACe: "RCF_LIVE_20260513_001",
      statusCode: "1400",
      statusDescription: "Contabilizada",
      rejectionReason: undefined,
    }),
    ticketbaiSubmit: async () => ({
      tbaiId: "TBAI-00001-20260513-LIVE",
      territory: "bizkaia" as const,
      status: "accepted" as const,
      sandbox: false,
      qrUrl: "https://batuz.eus/QRTBAI/?id=TBAI-00001-20260513-LIVE",
    }),
    ticketbaiStatus: async () => ({
      tbaiId: "TBAI-00001-20260513-LIVE",
      territory: "bizkaia" as const,
      status: "accepted" as const,
      rejectionReason: undefined,
      error: undefined,
    }),
  } as unknown as import("../client-interface.js").IFrihetClient;
}

// ── Helper to register Day 4 tools on a fresh server ─────────────────────────

async function makeServer(client: import("../client-interface.js").IFrihetClient): Promise<StubMcpServer> {
  const server = new StubMcpServer();
  const { registerEInvoiceTools } = await import("../tools/einvoice.js");
  registerEInvoiceTools(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, client);
  return server;
}

// ── Registration tests ────────────────────────────────────────────────────────

describe("Day 4 E-Invoice Tools — Registration", () => {
  let server: StubMcpServer;

  beforeEach(async () => {
    server = await makeServer(make404Client());
  });

  test("registers exactly 10 e-invoice tools (4 original + 6 Day 4)", () => {
    assert.equal(server.tools.size, 10, `Expected 10 tools, got ${server.tools.size}`);
  });

  test("registers einvoice_export", () => {
    assert.ok(server.tools.has("einvoice_export"), "einvoice_export not registered");
  });

  test("registers face_submit", () => {
    assert.ok(server.tools.has("face_submit"), "face_submit not registered");
  });

  test("registers face_status", () => {
    assert.ok(server.tools.has("face_status"), "face_status not registered");
  });

  test("registers ticketbai_submit", () => {
    assert.ok(server.tools.has("ticketbai_submit"), "ticketbai_submit not registered");
  });

  test("registers ticketbai_status", () => {
    assert.ok(server.tools.has("ticketbai_status"), "ticketbai_status not registered");
  });

  test("registers ksef_submit", () => {
    assert.ok(server.tools.has("ksef_submit"), "ksef_submit not registered");
  });

  test("all Day 4 tools have titles", () => {
    const day4 = ["einvoice_export", "face_submit", "face_status", "ticketbai_submit", "ticketbai_status", "ksef_submit"];
    for (const name of day4) {
      const tool = server.tools.get(name);
      assert.ok(tool, `${name} not registered`);
      assert.ok(tool!.config.title, `${name} missing title`);
    }
  });
});

// ── einvoice_export tests ─────────────────────────────────────────────────────

describe("einvoice_export — 404-fallback stub", () => {
  test("404 → stub with _stub=true, xmlUrl and filename set", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("einvoice_export")!;
    const result = await tool.handler({ invoiceId: "inv_001", format: "facturae", signed: true });
    const sc = result.structuredContent!;
    assert.equal(sc["_stub"], true);
    assert.equal(sc["_note"], "CF endpoint pending deploy");
    assert.ok(typeof sc["xmlUrl"] === "string");
    assert.ok(typeof sc["filename"] === "string");
    assert.equal(sc["format"], "facturae");
    assert.equal(sc["signed"], true);
  });

  test("signed defaults to false when omitted", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("einvoice_export")!;
    const result = await tool.handler({ invoiceId: "inv_002", format: "xrechnung-cii" });
    const sc = result.structuredContent!;
    assert.equal(sc["signed"], false);
  });

  test("403 error returns isError response (not stub)", async () => {
    const server = await makeServer(make403Client());
    const tool = server.tools.get("einvoice_export")!;
    const result = await tool.handler({ invoiceId: "inv_003", format: "ubl" });
    // withToolLogging converts non-404 errors to error content — should NOT be a stub
    assert.equal((result as Record<string, unknown>)["isError"], true, "403 should produce isError response");
    assert.equal((result.structuredContent as Record<string, unknown> | undefined)?.["_stub"], undefined, "403 should not produce a stub");
  });
});

describe("einvoice_export — live client", () => {
  test("live → real xmlUrl from CF, no _stub flag", async () => {
    const server = await makeServer(makeLiveClient());
    const tool = server.tools.get("einvoice_export")!;
    const result = await tool.handler({ invoiceId: "inv_123", format: "facturae", signed: true });
    const sc = result.structuredContent!;
    assert.ok((sc["xmlUrl"] as string).includes("live"));
    assert.equal(sc["format"], "facturae");
    assert.equal(sc["signed"], true);
    assert.equal(sc["_stub"], undefined);
  });
});

// ── face_submit tests ─────────────────────────────────────────────────────────

describe("face_submit — 404-fallback stub", () => {
  test("404 → stub with _stub=true, registroFACe and status set", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("face_submit")!;
    const result = await tool.handler({ invoiceId: "inv_face_001", mode: "production" });
    const sc = result.structuredContent!;
    assert.equal(sc["_stub"], true);
    assert.equal(sc["_note"], "CF endpoint pending deploy");
    assert.ok(typeof sc["registroFACe"] === "string");
    assert.equal(sc["status"], "submitted");
    assert.ok(typeof sc["submittedAt"] === "string");
    assert.equal(sc["mode"], "production");
  });

  test("mode defaults to production when omitted", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("face_submit")!;
    const result = await tool.handler({ invoiceId: "inv_face_002" });
    const sc = result.structuredContent!;
    assert.equal(sc["mode"], "production");
  });

  test("sandbox mode accepted", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("face_submit")!;
    const result = await tool.handler({ invoiceId: "inv_face_003", mode: "sandbox" });
    const sc = result.structuredContent!;
    assert.equal(sc["mode"], "sandbox");
  });

  test("403 error returns isError response (not stub)", async () => {
    const server = await makeServer(make403Client());
    const tool = server.tools.get("face_submit")!;
    const result = await tool.handler({ invoiceId: "inv_face_403", mode: "production" });
    assert.equal((result as Record<string, unknown>)["isError"], true, "403 should produce isError response");
  });
});

describe("face_submit — live client", () => {
  test("live → real registroFACe, no _stub flag", async () => {
    const server = await makeServer(makeLiveClient());
    const tool = server.tools.get("face_submit")!;
    const result = await tool.handler({ invoiceId: "inv_face_live", mode: "production" });
    const sc = result.structuredContent!;
    assert.equal(sc["registroFACe"], "RCF_LIVE_20260513_001");
    assert.equal(sc["status"], "submitted");
    assert.equal(sc["_stub"], undefined);
  });
});

// ── face_status tests ─────────────────────────────────────────────────────────

describe("face_status — 404-fallback stub", () => {
  test("404 → stub with statusCode '1200' (Registrada)", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("face_status")!;
    const result = await tool.handler({ invoiceId: "inv_face_001" });
    const sc = result.structuredContent!;
    assert.equal(sc["_stub"], true);
    assert.equal(sc["statusCode"], "1200");
    assert.equal(sc["statusDescription"], "Registrada");
    assert.ok(typeof sc["registroFACe"] === "string");
  });

  test("403 error returns isError response (not stub)", async () => {
    const server = await makeServer(make403Client());
    const tool = server.tools.get("face_status")!;
    const result = await tool.handler({ invoiceId: "inv_face_403" });
    assert.equal((result as Record<string, unknown>)["isError"], true, "403 should produce isError response");
  });
});

describe("face_status — live client", () => {
  test("live → statusCode 1400 (Contabilizada), no _stub", async () => {
    const server = await makeServer(makeLiveClient());
    const tool = server.tools.get("face_status")!;
    const result = await tool.handler({ invoiceId: "inv_face_live" });
    const sc = result.structuredContent!;
    assert.equal(sc["statusCode"], "1400");
    assert.equal(sc["statusDescription"], "Contabilizada");
    assert.equal(sc["_stub"], undefined);
  });
});

// ── ticketbai_submit tests ────────────────────────────────────────────────────

describe("ticketbai_submit — 404-fallback stub", () => {
  test("404 → stub with tbaiId, territory=bizkaia, status=submitted", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("ticketbai_submit")!;
    const result = await tool.handler({ invoiceId: "inv_tbai_001" });
    const sc = result.structuredContent!;
    assert.equal(sc["_stub"], true);
    assert.ok(typeof sc["tbaiId"] === "string");
    assert.equal(sc["territory"], "bizkaia");
    assert.equal(sc["status"], "submitted");
    assert.equal(sc["sandbox"], false);
    assert.ok(typeof sc["qrUrl"] === "string");
  });

  test("sandbox=true is reflected in stub", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("ticketbai_submit")!;
    const result = await tool.handler({ invoiceId: "inv_tbai_002", sandbox: true });
    const sc = result.structuredContent!;
    assert.equal(sc["sandbox"], true);
  });

  test("sandbox defaults to false when omitted", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("ticketbai_submit")!;
    const result = await tool.handler({ invoiceId: "inv_tbai_003" });
    const sc = result.structuredContent!;
    assert.equal(sc["sandbox"], false);
  });

  test("403 error returns isError response (not stub)", async () => {
    const server = await makeServer(make403Client());
    const tool = server.tools.get("ticketbai_submit")!;
    const result = await tool.handler({ invoiceId: "inv_tbai_403" });
    assert.equal((result as Record<string, unknown>)["isError"], true, "403 should produce isError response");
  });
});

describe("ticketbai_submit — live client", () => {
  test("live → real tbaiId, status=accepted, qrUrl present", async () => {
    const server = await makeServer(makeLiveClient());
    const tool = server.tools.get("ticketbai_submit")!;
    const result = await tool.handler({ invoiceId: "inv_tbai_live" });
    const sc = result.structuredContent!;
    assert.equal(sc["tbaiId"], "TBAI-00001-20260513-LIVE");
    assert.equal(sc["status"], "accepted");
    assert.ok((sc["qrUrl"] as string).includes("TBAI"));
    assert.equal(sc["_stub"], undefined);
  });
});

// ── ticketbai_status tests ────────────────────────────────────────────────────

describe("ticketbai_status — 404-fallback stub", () => {
  test("404 → stub with tbaiId, territory, status=accepted", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("ticketbai_status")!;
    const result = await tool.handler({ invoiceId: "inv_tbai_001" });
    const sc = result.structuredContent!;
    assert.equal(sc["_stub"], true);
    assert.ok(typeof sc["tbaiId"] === "string");
    assert.equal(sc["territory"], "bizkaia");
    assert.equal(sc["status"], "accepted");
    assert.equal(sc["rejectionReason"], undefined);
    assert.equal(sc["error"], undefined);
  });

  test("403 error returns isError response (not stub)", async () => {
    const server = await makeServer(make403Client());
    const tool = server.tools.get("ticketbai_status")!;
    const result = await tool.handler({ invoiceId: "inv_tbai_403" });
    assert.equal((result as Record<string, unknown>)["isError"], true, "403 should produce isError response");
  });
});

describe("ticketbai_status — live client", () => {
  test("live → real tbaiId and accepted status", async () => {
    const server = await makeServer(makeLiveClient());
    const tool = server.tools.get("ticketbai_status")!;
    const result = await tool.handler({ invoiceId: "inv_tbai_live" });
    const sc = result.structuredContent!;
    assert.equal(sc["tbaiId"], "TBAI-00001-20260513-LIVE");
    assert.equal(sc["status"], "accepted");
    assert.equal(sc["_stub"], undefined);
  });
});

// ── Compliance smoke: live CF wiring + real-failure-never-masked-as-success ───
//
// These 5 tools have a LIVE Cloud Function server-side (Frihet-ERP publicApi.ts).
// 1. On a live success the tool must return the REAL CF payload (no _stub flag),
//    proving the client method (correct /invoices/:id/{...} path) was hit, not a stub.
// 2. On a 500 (genuine FACe/TicketBAI signature/submission failure) the tool must
//    surface an error (isError) and MUST NOT emit a success stub. A masked failure
//    would tell the user agent the invoice was submitted/accepted when it was not.

const LIVE_TOOLS: Array<{
  name: string;
  args: Record<string, unknown>;
  /** A field whose value is unique to the live (non-stub) response. */
  liveAssert: (sc: Record<string, unknown>) => void;
}> = [
  {
    name: "einvoice_export",
    args: { invoiceId: "inv_smoke", format: "facturae", signed: true },
    liveAssert: (sc) => assert.ok((sc["xmlUrl"] as string).includes("live")),
  },
  {
    name: "face_submit",
    args: { invoiceId: "inv_smoke", mode: "production" },
    liveAssert: (sc) => assert.equal(sc["registroFACe"], "RCF_LIVE_20260513_001"),
  },
  {
    name: "face_status",
    args: { invoiceId: "inv_smoke" },
    liveAssert: (sc) => assert.equal(sc["statusCode"], "1400"),
  },
  {
    name: "ticketbai_submit",
    args: { invoiceId: "inv_smoke" },
    liveAssert: (sc) => assert.equal(sc["tbaiId"], "TBAI-00001-20260513-LIVE"),
  },
  {
    name: "ticketbai_status",
    args: { invoiceId: "inv_smoke" },
    liveAssert: (sc) => assert.equal(sc["tbaiId"], "TBAI-00001-20260513-LIVE"),
  },
];

describe("Compliance smoke — 5 live einvoice tools hit the real CF", () => {
  for (const { name, args, liveAssert } of LIVE_TOOLS) {
    test(`${name}: live → real CF payload, no _stub`, async () => {
      const server = await makeServer(makeLiveClient());
      const tool = server.tools.get(name)!;
      const result = await tool.handler(args);
      const sc = result.structuredContent!;
      assert.equal(sc["_stub"], undefined, `${name} returned a stub on a live CF response`);
      assert.notEqual(
        (result as Record<string, unknown>)["isError"],
        true,
        `${name} reported isError on a live success`,
      );
      liveAssert(sc);
    });
  }
});

describe("Compliance smoke — real CF failure (500) never masked as success", () => {
  for (const { name, args } of LIVE_TOOLS) {
    test(`${name}: 500 → isError, NOT a success stub`, async () => {
      const server = await makeServer(make500Client());
      const tool = server.tools.get(name)!;
      const result = await tool.handler(args);
      // A genuine signature/submission failure must surface as an error...
      assert.equal(
        (result as Record<string, unknown>)["isError"],
        true,
        `${name} did not surface 500 as an error`,
      );
      // ...and must NOT be dressed up as a successful stub.
      const sc = (result.structuredContent ?? {}) as Record<string, unknown>;
      assert.notEqual(sc["_stub"], true, `${name} masked a 500 failure as a success stub`);
      assert.equal(sc["status"], undefined, `${name} emitted a success status on a 500 failure`);
    });
  }
});

// ── ksef_submit tests ─────────────────────────────────────────────────────────

describe("ksef_submit — always-stub (PR #417 pending)", () => {
  test("returns _notImplemented=true regardless of client", async () => {
    // Test with both 404 and live clients — ksef_submit is always-stub
    for (const clientFactory of [make404Client, makeLiveClient]) {
      const server = await makeServer(clientFactory());
      const tool = server.tools.get("ksef_submit")!;
      const result = await tool.handler({ invoiceId: "inv_ksef_001", mode: "production" });
      const sc = result.structuredContent!;
      assert.equal(sc["_notImplemented"], true, "_notImplemented should be true");
      assert.ok(typeof sc["_note"] === "string", "_note should be present");
      assert.ok((sc["_note"] as string).includes("PR #417"), "_note should mention PR #417");
      assert.ok(typeof sc["_plannedEndpoint"] === "string", "_plannedEndpoint should be set");
    }
  });

  test("invoiceId and mode echoed back in structuredContent", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("ksef_submit")!;
    const result = await tool.handler({ invoiceId: "inv_ksef_002", mode: "sandbox" });
    const sc = result.structuredContent!;
    assert.equal(sc["invoiceId"], "inv_ksef_002");
    assert.equal(sc["mode"], "sandbox");
  });

  test("mode defaults to production when omitted", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("ksef_submit")!;
    const result = await tool.handler({ invoiceId: "inv_ksef_003" });
    const sc = result.structuredContent!;
    assert.equal(sc["mode"], "production");
  });

  test("content block explains how to work around missing endpoint", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("ksef_submit")!;
    const result = await tool.handler({ invoiceId: "inv_ksef_004", mode: "mock" });
    const text = result.content[0]!.text;
    assert.ok(text.includes("PR #417"), "Content should mention PR #417");
    assert.ok(text.includes("einvoice_export"), "Content should suggest einvoice_export as workaround");
  });

  test("does not throw — always returns graceful stub", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("ksef_submit")!;
    // Should NOT throw even though endpoint doesn't exist
    const result = await tool.handler({ invoiceId: "inv_ksef_005", mode: "production" });
    assert.ok(result.content.length > 0);
    assert.ok(result.structuredContent);
  });
});
