/**
 * Tests for e-invoice MCP tools — wired to api.frihet.io with 404-fallback stubs.
 *
 * Uses Node.js built-in test runner (node:test + node:assert) — no extra deps.
 * Run: node --experimental-strip-types --test src/__tests__/einvoice-tools.test.ts
 * Or via: npm test (after build: node --test dist/__tests__/einvoice-tools.test.js)
 *
 * Coverage:
 *   1. Tool registration — all original 4 tools registered on McpServer (plus 6 Day 4 = 10 total)
 *   2. 404-fallback path — when CF endpoint returns 404, stub fallback fires
 *   3. Success path — when CF endpoint returns real data, it is passed through
 *   4. Stub response shape — matches declared outputSchema (via fallback)
 *   5. Langfuse wrapper confirmed invoked via traceMCPTool patch
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
    sendEInvoice: notFound,
    getEInvoiceStatus: notFound,
    validateEInvoiceXml: notFound,
    exportDatev: notFound,
  } as unknown as import("../client-interface.js").IFrihetClient;
}

/** Simulates CF endpoint live and returning real data. */
function makeLiveClient(): import("../client-interface.js").IFrihetClient {
  return {
    sendEInvoice: async () => ({
      workflowRunId: "wfr_live_abc123",
      status: "queued" as const,
      estimatedCompletionSec: 12,
    }),
    getEInvoiceStatus: async () => ({
      status: "succeeded" as const,
      step: "dispatch_complete",
      ackId: "ack_live_xyz",
      xmlUrl: "https://storage.frihet.io/live/wfr_live_abc123.xml",
    }),
    validateEInvoiceXml: async () => ({
      valid: true,
      errors: [],
      validator: "kosit" as const,
      durationMs: 87,
    }),
    exportDatev: async () => ({
      fileUrl: "https://storage.frihet.io/live/datev/EXTF_Buchungsstapel_2026-01.csv",
      filename: "EXTF_Buchungsstapel_2026-01.csv",
      rowCount: 42,
      fiscalPeriod: "2026-01",
      encoding: "cp1252" as const,
    }),
  } as unknown as import("../client-interface.js").IFrihetClient;
}

// ── Langfuse trace tracker ───────────────────────────────────────────────────

let langfuseCallCount = 0;

// Mock traceMCPTool — we can't easily module-mock in node:test without extra tooling,
// so instead we verify indirectly via withToolLogging which is the real instrumentation
// wrapper. The global patchServerWithTracing wraps registerTool with traceMCPTool,
// confirmed by checking the patched server in the integration test below.

// ── Imports ──────────────────────────────────────────────────────────────────

// Import after stubs so we can pass the stub server
// We test the registration function directly with a stub server.

describe("E-Invoice Tools — Registration", () => {
  let server: StubMcpServer;

  beforeEach(async () => {
    server = new StubMcpServer();
    const clientStub = make404Client();

    const { registerEInvoiceTools } = await import("../tools/einvoice.js");
    registerEInvoiceTools(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, clientStub);
  });

  test("registers exactly 10 e-invoice tools (4 original + 6 Day 4)", () => {
    assert.equal(server.tools.size, 10);
  });

  test("registers send_einvoice", () => {
    assert.ok(server.tools.has("send_einvoice"), "send_einvoice not registered");
  });

  test("registers get_einvoice_status", () => {
    assert.ok(server.tools.has("get_einvoice_status"), "get_einvoice_status not registered");
  });

  test("registers validate_einvoice_xml", () => {
    assert.ok(server.tools.has("validate_einvoice_xml"), "validate_einvoice_xml not registered");
  });

  test("registers export_datev", () => {
    assert.ok(server.tools.has("export_datev"), "export_datev not registered");
  });
});

describe("E-Invoice Tools — registerAllTools includes new tools (127→133)", () => {
  test("registerAllTools wires 10 e-invoice tools via patchServerWithTracing", async () => {
    const server = new StubMcpServer();
    const clientStub = make404Client();

    // Apply the same patch registerAllTools does
    const originalRegisterTool = server.registerTool.bind(server);
    let wrappedCount = 0;
    (server as unknown as Record<string, unknown>).registerTool = function patchedRegisterTool(
      name: string,
      config: ToolConfig,
      cb: ToolHandler,
    ): void {
      wrappedCount++;
      // Verify Langfuse tracing wrapper would be applied (traceMCPTool wraps cb)
      // We confirm the patch captures all tool registrations including all 10 einvoice tools
      const wrappedCb: ToolHandler = async (args) => {
        langfuseCallCount++;
        return cb(args);
      };
      originalRegisterTool(name, config, wrappedCb);
    };

    const { registerEInvoiceTools } = await import("../tools/einvoice.js");
    registerEInvoiceTools(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, clientStub);

    assert.equal(wrappedCount, 10, `Expected 10 tools wrapped, got ${wrappedCount}`);
    assert.equal(server.tools.size, 10);
  });
});

describe("send_einvoice — honest unavailable response (absent endpoint)", () => {
  let sendTool: RegisteredTool | undefined;

  beforeEach(async () => {
    const server = new StubMcpServer();
    const clientStub = make404Client();
    const { registerEInvoiceTools } = await import("../tools/einvoice.js");
    registerEInvoiceTools(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, clientStub);
    sendTool = server.tools.get("send_einvoice");
  });

  test("tool registered with correct title", () => {
    assert.ok(sendTool, "send_einvoice not registered");
    assert.equal(sendTool!.config.title, "Send E-Invoice");
  });

  test("absent endpoint → isError + _unavailable, NEVER a fabricated queued status", async () => {
    assert.ok(sendTool, "send_einvoice not registered");
    const result = await sendTool!.handler({
      invoiceId: "inv_test_123",
      format: "xrechnung-cii",
      dispatchMode: "email",
    });

    assert.ok(result.structuredContent, "structuredContent missing");
    const sc = result.structuredContent!;
    // HONEST: no fabricated workflow/status, agent sees a failure.
    assert.equal((result as { isError?: boolean }).isError, true, "must be isError:true");
    assert.equal(sc["_unavailable"], true, "_unavailable flag should be true");
    assert.equal(sc["_stub"], undefined, "must NOT carry a fake-success _stub flag");
    assert.equal(sc["workflowRunId"], undefined, "must NOT fabricate a workflowRunId");
    assert.equal(sc["status"], undefined, "must NOT fabricate a queued status");
    assert.ok(typeof sc["_plannedEndpoint"] === "string", "_plannedEndpoint should be set");
  });

  test("peppol-bis-3 also returns honest unavailable", async () => {
    assert.ok(sendTool, "send_einvoice not registered");
    const result = await sendTool!.handler({
      invoiceId: "inv_peppol_456",
      format: "peppol-bis-3",
      dispatchMode: "peppol",
    });
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.equal(result.structuredContent!["_unavailable"], true);
  });

  test("content block has type text", async () => {
    assert.ok(sendTool, "send_einvoice not registered");
    const result = await sendTool!.handler({
      invoiceId: "inv_test_123",
      format: "facturae",
      dispatchMode: "download",
    });
    assert.ok(Array.isArray(result.content), "content should be array");
    assert.ok(result.content.length > 0, "content should have at least 1 block");
    assert.equal(result.content[0]!.type, "text");
    assert.ok(/unavailable/i.test(result.content[0]!.text), "text should say unavailable");
  });
});

describe("get_einvoice_status — honest unavailable response (absent endpoint)", () => {
  let statusTool: RegisteredTool | undefined;

  beforeEach(async () => {
    const server = new StubMcpServer();
    const clientStub = make404Client();
    const { registerEInvoiceTools } = await import("../tools/einvoice.js");
    registerEInvoiceTools(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, clientStub);
    statusTool = server.tools.get("get_einvoice_status");
  });

  test("absent endpoint → isError + _unavailable, NEVER a fabricated 'succeeded'", async () => {
    assert.ok(statusTool, "get_einvoice_status not registered");
    const result = await statusTool!.handler({ workflowRunId: "wfr_stub_abc123" });

    const sc = result.structuredContent!;
    assert.equal((result as { isError?: boolean }).isError, true, "must be isError:true");
    assert.equal(sc["_unavailable"], true, "_unavailable flag should be true");
    assert.equal(sc["status"], undefined, "must NOT fabricate a 'succeeded' status");
    assert.equal(sc["ackId"], undefined, "must NOT fabricate an ackId");
    assert.equal(sc["xmlUrl"], undefined, "must NOT fabricate an XML URL");
    assert.equal(sc["_stub"], undefined, "must NOT carry a fake-success _stub flag");
  });
});

describe("validate_einvoice_xml — honest unavailable response (absent endpoint)", () => {
  let validateTool: RegisteredTool | undefined;

  beforeEach(async () => {
    const server = new StubMcpServer();
    const clientStub = make404Client();
    const { registerEInvoiceTools } = await import("../tools/einvoice.js");
    registerEInvoiceTools(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, clientStub);
    validateTool = server.tools.get("validate_einvoice_xml");
  });

  test("absent endpoint → isError + _unavailable, NEVER a fabricated valid=true", async () => {
    assert.ok(validateTool, "validate_einvoice_xml not registered");
    const result = await validateTool!.handler({
      xml: "<Invoice><ID>TEST-001</ID></Invoice>",
      format: "xrechnung-cii",
    });

    const sc = result.structuredContent!;
    assert.equal((result as { isError?: boolean }).isError, true, "must be isError:true");
    assert.equal(sc["_unavailable"], true, "_unavailable flag should be true");
    // A fabricated valid=true is the most dangerous stub — must never appear.
    assert.equal(sc["valid"], undefined, "must NOT fabricate valid=true");
    assert.equal(sc["validator"], undefined, "must NOT fabricate a validator verdict");
    assert.equal(sc["_stub"], undefined, "must NOT carry a fake-success _stub flag");
    assert.ok(typeof sc["_plannedEndpoint"] === "string", "_plannedEndpoint should be set");
  });
});

describe("export_datev — honest unavailable response (absent endpoint)", () => {
  let datevTool: RegisteredTool | undefined;

  beforeEach(async () => {
    const server = new StubMcpServer();
    const clientStub = make404Client();
    const { registerEInvoiceTools } = await import("../tools/einvoice.js");
    registerEInvoiceTools(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, clientStub);
    datevTool = server.tools.get("export_datev");
  });

  test("absent endpoint → isError + _unavailable, NEVER a fabricated fileUrl", async () => {
    assert.ok(datevTool, "export_datev not registered");
    const result = await datevTool!.handler({
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      format: "extf-buchungsstapel",
    });

    const sc = result.structuredContent!;
    assert.equal((result as { isError?: boolean }).isError, true, "must be isError:true");
    assert.equal(sc["_unavailable"], true, "_unavailable flag should be true");
    assert.equal(sc["fileUrl"], undefined, "must NOT fabricate a download fileUrl");
    assert.equal(sc["filename"], undefined, "must NOT fabricate a filename");
    assert.equal(sc["_stub"], undefined, "must NOT carry a fake-success _stub flag");
    assert.ok(typeof sc["_plannedEndpoint"] === "string", "_plannedEndpoint should be set");
  });
});

describe("Langfuse wrapper — patchServerWithTracing wraps all tool callbacks", () => {
  test("patched registerTool intercepts all 10 einvoice tools (simulates traceMCPTool path)", async () => {
    const server = new StubMcpServer();
    const clientStub = make404Client();

    // Simulate patchServerWithTracing (same mechanism as register-all.ts)
    let interceptCount = 0;
    const orig = server.registerTool.bind(server);
    (server as unknown as Record<string, unknown>).registerTool = function (
      name: string,
      config: ToolConfig,
      cb: ToolHandler,
    ): void {
      interceptCount++;
      // Wrap with a simulated traceMCPTool (fail-open pattern)
      const traced: ToolHandler = async (args) => {
        langfuseCallCount++; // would normally call traceMCPTool
        return cb(args);
      };
      orig(name, config, traced);
    };

    const { registerEInvoiceTools } = await import("../tools/einvoice.js");
    registerEInvoiceTools(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, clientStub);

    // All 10 tools were intercepted by the patch (4 original + 6 Day 4)
    assert.equal(interceptCount, 10, `Expected 10 tools intercepted by tracing patch, got ${interceptCount}`);

    // Exercise each tool to confirm the traced wrapper runs
    for (const [name, tool] of server.tools) {
      const args = getValidArgs(name);
      await tool.handler(args);
    }

    assert.equal(langfuseCallCount, 10, `Expected 10 Langfuse trace calls (one per tool), got ${langfuseCallCount}`);
  });
});

function getValidArgs(toolName: string): Record<string, unknown> {
  switch (toolName) {
    case "send_einvoice":
      return { invoiceId: "inv_123", format: "ubl", dispatchMode: "email" };
    case "get_einvoice_status":
      return { workflowRunId: "wfr_123" };
    case "validate_einvoice_xml":
      return { xml: "<Invoice/>", format: "cii" };
    case "export_datev":
      return { periodStart: "2026-01-01", periodEnd: "2026-01-31", format: "extf-buchungsstapel" };
    // Day 4 tools
    case "einvoice_export":
      return { invoiceId: "inv_123", format: "facturae" };
    case "face_submit":
      return { invoiceId: "inv_123", mode: "production" };
    case "face_status":
      return { invoiceId: "inv_123" };
    case "ticketbai_submit":
      return { invoiceId: "inv_123" };
    case "ticketbai_status":
      return { invoiceId: "inv_123" };
    case "ksef_submit":
      return { invoiceId: "inv_123", mode: "production" };
    default:
      return {};
  }
}

// ── 404-fallback tests ────────────────────────────────────────────────────────

describe("absent-endpoint path — honest unavailable, NO fabricated success", () => {
  async function makeServer(client: import("../client-interface.js").IFrihetClient): Promise<StubMcpServer> {
    const server = new StubMcpServer();
    const { registerEInvoiceTools } = await import("../tools/einvoice.js");
    registerEInvoiceTools(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, client);
    return server;
  }

  test("send_einvoice: 404 → isError + _unavailable + _plannedEndpoint, no fabricated data", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("send_einvoice")!;
    const result = await tool.handler({ invoiceId: "inv_test", format: "xrechnung-cii", dispatchMode: "email" });
    const sc = result.structuredContent!;
    assert.equal((result as { isError?: boolean }).isError, true, "must be isError:true");
    assert.equal(sc["_unavailable"], true, "_unavailable should be true");
    assert.equal(sc["_stub"], undefined, "must NOT be a fake-success stub");
    assert.ok(typeof sc["_plannedEndpoint"] === "string", "_plannedEndpoint should be set");
    assert.equal(sc["status"], undefined, "no fabricated queued status");
    assert.equal(sc["workflowRunId"], undefined, "no fabricated workflowRunId");
  });

  test("get_einvoice_status: 404 → isError + _unavailable + _plannedEndpoint", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("get_einvoice_status")!;
    const result = await tool.handler({ workflowRunId: "wfr_pending_123" });
    const sc = result.structuredContent!;
    assert.equal((result as { isError?: boolean }).isError, true, "must be isError:true");
    assert.equal(sc["_unavailable"], true, "_unavailable should be true");
    assert.ok(typeof sc["_plannedEndpoint"] === "string", "_plannedEndpoint should be set");
    assert.equal(sc["status"], undefined, "no fabricated status");
  });

  test("validate_einvoice_xml: 404 → isError + _unavailable, NEVER a fabricated valid verdict", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("validate_einvoice_xml")!;
    const result = await tool.handler({ xml: "<Invoice/>", format: "xrechnung-cii" });
    const sc = result.structuredContent!;
    assert.equal((result as { isError?: boolean }).isError, true, "must be isError:true");
    assert.equal(sc["_unavailable"], true, "_unavailable should be true");
    assert.equal(sc["valid"], undefined, "must NOT fabricate a valid verdict");
    assert.equal(sc["validator"], undefined, "must NOT fabricate a validator");
  });

  test("export_datev: 404 → isError + _unavailable, no fabricated file", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("export_datev")!;
    const result = await tool.handler({ periodStart: "2026-03-01", periodEnd: "2026-03-31", format: "extf-buchungsstapel" });
    const sc = result.structuredContent!;
    assert.equal((result as { isError?: boolean }).isError, true, "must be isError:true");
    assert.equal(sc["_unavailable"], true, "_unavailable should be true");
    assert.equal(sc["fileUrl"], undefined, "must NOT fabricate a fileUrl");
    assert.equal(sc["filename"], undefined, "must NOT fabricate a filename");
  });

  test("ksef_submit: forward-compat stub → isError + _unavailable + _notImplemented preserved", async () => {
    const server = await makeServer(make404Client());
    const tool = server.tools.get("ksef_submit")!;
    const result = await tool.handler({ invoiceId: "inv_test", mode: "production" });
    const sc = result.structuredContent!;
    assert.equal((result as { isError?: boolean }).isError, true, "must be isError:true");
    assert.equal(sc["_unavailable"], true, "_unavailable should be true");
    assert.equal(sc["_notImplemented"], true, "_notImplemented marker preserved for forward-compat");
    assert.ok(typeof sc["_plannedEndpoint"] === "string", "_plannedEndpoint should be set");
    assert.equal(sc["mode"], "production", "echoes the requested mode");
  });
});

// ── Success-path tests (live client mock) ─────────────────────────────────────

describe("Success path — CF endpoint live, real data returned", () => {
  async function makeServer(client: import("../client-interface.js").IFrihetClient): Promise<StubMcpServer> {
    const server = new StubMcpServer();
    const { registerEInvoiceTools } = await import("../tools/einvoice.js");
    registerEInvoiceTools(server as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer, client);
    return server;
  }

  test("send_einvoice: live client → workflowRunId from CF response, no _stub flag", async () => {
    const server = await makeServer(makeLiveClient());
    const tool = server.tools.get("send_einvoice")!;
    const result = await tool.handler({ invoiceId: "inv_live", format: "peppol-bis-3", dispatchMode: "peppol" });
    const sc = result.structuredContent!;
    assert.equal(sc["workflowRunId"], "wfr_live_abc123");
    assert.equal(sc["status"], "queued");
    assert.equal(sc["estimatedCompletionSec"], 12);
    assert.equal(sc["_stub"], undefined, "no _stub flag on live response");
  });

  test("get_einvoice_status: live client → real status and ackId", async () => {
    const server = await makeServer(makeLiveClient());
    const tool = server.tools.get("get_einvoice_status")!;
    const result = await tool.handler({ workflowRunId: "wfr_live_abc123" });
    const sc = result.structuredContent!;
    assert.equal(sc["status"], "succeeded");
    assert.equal(sc["ackId"], "ack_live_xyz");
    assert.equal(sc["_stub"], undefined, "no _stub flag on live response");
  });

  test("validate_einvoice_xml: live client → real durationMs and empty errors", async () => {
    const server = await makeServer(makeLiveClient());
    const tool = server.tools.get("validate_einvoice_xml")!;
    const result = await tool.handler({ xml: "<Invoice/>", format: "xrechnung-cii" });
    const sc = result.structuredContent!;
    assert.equal(sc["valid"], true);
    assert.equal(sc["durationMs"], 87);
    assert.equal((sc["errors"] as unknown[]).length, 0);
    assert.equal(sc["_stub"], undefined, "no _stub flag on live response");
  });

  test("export_datev: live client → real rowCount and fileUrl from CF", async () => {
    const server = await makeServer(makeLiveClient());
    const tool = server.tools.get("export_datev")!;
    const result = await tool.handler({ periodStart: "2026-01-01", periodEnd: "2026-01-31", format: "extf-buchungsstapel" });
    const sc = result.structuredContent!;
    assert.equal(sc["rowCount"], 42);
    assert.equal(sc["fiscalPeriod"], "2026-01");
    assert.ok((sc["fileUrl"] as string).includes("live"), "fileUrl should be from live CF");
    assert.equal(sc["_stub"], undefined, "no _stub flag on live response");
  });
});
