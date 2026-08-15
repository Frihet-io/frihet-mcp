/**
 * Regression test for #1393 — PDF / XML document responses killed by
 * `response.json()`.
 *
 * BUG: `FrihetClient.request<T>()` (src/client.ts) called `response.json()`
 * unconditionally on every 2xx body. That is correct for the JSON envelope
 * convention, but the live `/invoices/:id/pdf` endpoint returns raw
 * `application/pdf` bytes and `/invoices/:id/xml` returns raw `application/xml`
 * text. `response.json()` on either one throws a SyntaxError that surfaced to
 * the MCP client as an opaque fetch error — the document never reached the
 * tool's structuredContent.
 *
 * FIX: a content-type-aware path is added for **document** responses only
 * (`get_invoice_pdf`, `get_invoice_einvoice`). The generic JSON `request<T>`
 * path is unchanged. A single bounded document transport branches on the
 * response MIME while preserving timeout, retry, and error behavior:
 *   - PDF: 25 MiB (matches typical ERP-issued invoice PDF + headroom for
 *     embedded logos / Facturae XML attachments)
 *   - XML:  5 MiB (UBL / Facturae / PEPPOL stay well under 1 MiB in practice)
 * The cap is enforced TWICE — once as a precheck on `Content-Length` so an
 * honest server doesn't waste bandwidth, and once after streaming the body
 * so a missing/lying `Content-Length` still can't trigger an unbounded
 * `arrayBuffer()` allocation.
 *
 * Tests below prove PDF/XML/Factur-X round-trips, generic JSON non-regression,
 * malformed and oversized failures, one-fetch identity, reader cancellation,
 * rate-limit retry, and a timeout after headers.
 *
 * Run: npm test (after build).
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { FrihetClient } from "../client.js";
import type { IFrihetClient } from "../client-interface.js";
import { registerInvoiceTools } from "../tools/invoices.js";
import { einvoiceResultOutput, handleToolError, pdfResultOutput } from "../tools/shared.js";

const PDF_MAX_BYTES = 25 * 1024 * 1024;
const XML_MAX_BYTES = 5 * 1024 * 1024;

// Minimal valid PDF (header + EOF only — what we need for round-trip).
// Magic header `%PDF-1.4\n` is exactly 9 bytes; total payload = 9 + 5 + 1 = 15.
const PDF_BYTES = Buffer.from("%PDF-1.4\n%%EOF\n", "utf8");
const FACTURX_PDF_BYTES = Buffer.from("%PDF-1.7\n% Factur-X PDF/A-3\n%%EOF\n", "utf8");

// Minimal EN16931-shaped XML payload (XML declaration + root Invoice element).
const XML_TEXT =
  '<?xml version="1.0" encoding="UTF-8"?>\n<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">\n  <ID>inv_1</ID>\n</Invoice>\n';

let server: Server;
let baseUrl: string;
const requestCounts = new Map<string, number>();
let rateLimitedPdfAttempts = 0;

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requestCounts.set(url.pathname, (requestCounts.get(url.pathname) ?? 0) + 1);

    // ── NEW contract (post-#1393 fix): raw document bodies, content-type set.
    // getInvoicePdf(id) hits /invoices/{id}/pdf; getInvoiceEInvoice(id) hits
    // /invoices/{id}/xml. Match on the FULL path the client constructs.
    if (url.pathname === "/invoices/raw_pdf/pdf" && req.method === "GET") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", String(PDF_BYTES.byteLength));
      res.end(PDF_BYTES);
      return;
    }
    if (url.pathname === "/invoices/raw_xml/xml" && req.method === "GET") {
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("Content-Length", String(Buffer.byteLength(XML_TEXT)));
      res.end(XML_TEXT);
      return;
    }
    if (url.pathname === "/invoices/facturx/xml" && req.method === "GET") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="facturx-invoice.pdf"');
      res.setHeader("Content-Length", String(FACTURX_PDF_BYTES.byteLength));
      res.end(FACTURX_PDF_BYTES);
      return;
    }
    if (url.pathname === "/invoices/facturx_over_xml_cap/xml" && req.method === "GET") {
      const bytes = Buffer.alloc(XML_MAX_BYTES + 1, 0x20);
      FACTURX_PDF_BYTES.copy(bytes, 0);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", String(bytes.byteLength));
      res.end(bytes);
      return;
    }
    if (url.pathname === "/invoices/rate_limited/pdf" && req.method === "GET") {
      rateLimitedPdfAttempts += 1;
      if (rateLimitedPdfAttempts === 1) {
        res.statusCode = 429;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Retry-After", "0");
        res.end(JSON.stringify({ error: "rate_limited" }));
        return;
      }
      res.setHeader("Content-Type", "application/pdf");
      res.end(PDF_BYTES);
      return;
    }
    // Malformed successes must fail closed, never become empty artifacts.
    if (url.pathname === "/invoices/malformed_pdf/pdf" && req.method === "GET") {
      res.setHeader("Content-Type", "application/pdf");
      res.end("not a PDF");
      return;
    }
    if (url.pathname === "/invoices/malformed_xml/xml" && req.method === "GET") {
      res.setHeader("Content-Type", "application/xml");
      res.end(Buffer.from([0xc3, 0x28]));
      return;
    }
    if (url.pathname === "/invoices/unexpected_json/pdf" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end('{"data":');
      return;
    }

    // ── Cap precheck: server advertises an oversize PDF. End the response
    // normally (no 413 status) so the CLIENT'S precheck fires — that's the
    // behavior under test.
    if (url.pathname === "/invoices/huge_pdf/pdf" && req.method === "GET") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", String(PDF_MAX_BYTES + 1));
      res.end();
      return;
    }
    // Cap precheck: oversize XML.
    if (url.pathname === "/invoices/huge_xml/xml" && req.method === "GET") {
      res.setHeader("Content-Type", "application/xml");
      res.setHeader("Content-Length", String(XML_MAX_BYTES + 1));
      res.end();
      return;
    }
    if (url.pathname === "/invoices/huge_error/pdf" && req.method === "GET") {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Length", String(64 * 1024 + 1));
      res.end();
      return;
    }
    // Cap streaming: server streams past cap WITHOUT advertising Content-Length
    // (Node's HTTP server truncates to declared Content-Length, so the
    // honest "lie" approach doesn't actually deliver more bytes — use
    // Transfer-Encoding: chunked + no Content-Length so the cap can only be
    // enforced by the streaming reader).
    if (url.pathname === "/invoices/lying_pdf/pdf" && req.method === "GET") {
      res.setHeader("Content-Type", "application/pdf");
      // No Content-Length: forces chunked transfer encoding.
      res.write(Buffer.alloc(PDF_MAX_BYTES + 1, 0x25));
      res.end();
      return;
    }

    // JSON envelope regression smoke: getInvoice("smoke") must still work.
    if (url.pathname === "/invoices/smoke" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: { id: "smoke", total: 121, status: "sent" },
          meta: { source: "test" },
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "not_found" }));
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

describe("client.ts document responses (PDF / XML) — content-type aware", () => {
  test("getInvoicePdf: raw application/pdf → bounded bytes/base64, no JSON parse", async () => {
    const client = makeClient();
    const result = await (
      client as unknown as {
        getInvoicePdf(id: string): Promise<{
          id: string;
          contentType: string;
          sizeBytes: number;
          base64: string;
        }>;
      }
    ).getInvoicePdf("raw_pdf");

    assert.equal(result.id, "raw_pdf");
    assert.equal(result.contentType, "application/pdf");
    assert.equal(result.sizeBytes, PDF_BYTES.byteLength);
    assert.equal(typeof result.base64, "string");
    // Round-trip: decoded base64 MUST equal the original bytes exactly.
    assert.deepEqual(Buffer.from(result.base64, "base64"), PDF_BYTES);
    assert.equal(requestCounts.get("/invoices/raw_pdf/pdf"), 1, "a successful PDF read must perform one GET");
    assert.equal(pdfResultOutput.safeParse(result).success, true);
  });

  test("getInvoiceEInvoice: raw application/xml → bounded text, no JSON parse", async () => {
    const client = makeClient();
    const result = await (
      client as unknown as {
        getInvoiceEInvoice(id: string): Promise<{
          id: string;
          xml: string;
          contentType: string;
          sizeBytes: number;
        }>;
      }
    ).getInvoiceEInvoice("raw_xml");

    assert.equal(result.id, "raw_xml");
    assert.equal(result.contentType, "application/xml; charset=utf-8");
    assert.equal(result.xml, XML_TEXT);
    assert.equal(result.sizeBytes, Buffer.byteLength(XML_TEXT));
    assert.equal(requestCounts.get("/invoices/raw_xml/xml"), 1, "a successful XML read must perform one GET");
    assert.equal(einvoiceResultOutput.safeParse(result).success, true);
  });

  test("getInvoiceEInvoice: Factur-X application/pdf → bounded base64 with identity and filename", async () => {
    const client = makeClient();
    const result = await client.getInvoiceEInvoice("facturx");

    assert.equal(result.id, "facturx");
    assert.equal(result.contentType, "application/pdf");
    assert.equal(result.sizeBytes, FACTURX_PDF_BYTES.byteLength);
    assert.equal(result.filename, "facturx-invoice.pdf");
    assert.ok("base64" in result);
    assert.deepEqual(Buffer.from(result.base64, "base64"), FACTURX_PDF_BYTES);
    assert.equal("xml" in result, false);
    assert.equal(requestCounts.get("/invoices/facturx/xml"), 1);
    assert.equal(einvoiceResultOutput.safeParse(result).success, true);
  });

  test("getInvoiceEInvoice: Factur-X above the XML cap uses the 25 MiB PDF cap", async () => {
    const result = await makeClient().getInvoiceEInvoice("facturx_over_xml_cap");
    assert.ok("base64" in result);
    assert.equal(result.sizeBytes, XML_MAX_BYTES + 1);
    assert.equal(Buffer.from(result.base64, "base64").byteLength, XML_MAX_BYTES + 1);
  });

  test("getInvoicePdf: oversize PDF (Content-Length > 25 MiB) → FrihetApiError(413, payload_too_large)", async () => {
    const client = makeClient();
    await assert.rejects(
      () =>
        (
          client as unknown as {
            getInvoicePdf(id: string): Promise<unknown>;
          }
        ).getInvoicePdf("huge_pdf"),
      (err: Error & { statusCode?: number; errorCode?: string }) => {
        assert.equal(err.statusCode, 413);
        assert.equal(err.errorCode, "payload_too_large");
        return true;
      },
    );
  });

  test("getInvoiceEInvoice: oversize XML (Content-Length > 5 MiB) → FrihetApiError(413, payload_too_large)", async () => {
    const client = makeClient();
    await assert.rejects(
      () =>
        (
          client as unknown as {
            getInvoiceEInvoice(id: string): Promise<unknown>;
          }
        ).getInvoiceEInvoice("huge_xml"),
      (err: Error & { statusCode?: number; errorCode?: string }) => {
        assert.equal(err.statusCode, 413);
        assert.equal(err.errorCode, "payload_too_large");
        return true;
      },
    );
  });

  test("getInvoicePdf: non-2xx bodies use the bounded error reader", async () => {
    await assert.rejects(
      () => makeClient().getInvoicePdf("huge_error"),
      (error: Error & { statusCode?: number; errorCode?: string }) => {
        assert.equal(error.statusCode, 413);
        assert.equal(error.errorCode, "payload_too_large");
        return true;
      },
    );
  });

  test("getInvoicePdf: server lies about Content-Length, streams past 25 MiB → FrihetApiError(413) — no unbounded materialization", async () => {
    // No Content-Length is present, so only the running stream cap can fire.
    const client = makeClient();
    const t0 = Date.now();
    await assert.rejects(
      () =>
        (
          client as unknown as {
            getInvoicePdf(id: string): Promise<unknown>;
          }
        ).getInvoicePdf("lying_pdf"),
      (err: Error & { statusCode?: number; errorCode?: string }) => {
        assert.equal(err.statusCode, 413);
        assert.equal(err.errorCode, "payload_too_large");
        return true;
      },
    );
    const elapsedMs = Date.now() - t0;
    // Should be near-instant: the cancel happens on the first chunk that
    // crosses the cap, not after the whole 25 MiB+ stream completes.
    assert.ok(
      elapsedMs < 5000,
      `streaming 413 took ${elapsedMs}ms — looks like the body was materialized before the cap check`,
    );
  });

  test("getInvoicePdf: streaming overrun cancels the reader and aborts transport", async () => {
    const originalFetch = globalThis.fetch;
    let cancelCalled = false;
    let signalAborted = false;
    globalThis.fetch = async (_input, init) => {
      init?.signal?.addEventListener("abort", () => { signalAborted = true; }, { once: true });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(13 * 1024 * 1024));
          controller.enqueue(new Uint8Array(13 * 1024 * 1024));
        },
        cancel() {
          cancelCalled = true;
        },
      });
      return new Response(stream, { headers: { "Content-Type": "application/pdf" } });
    };

    try {
      await assert.rejects(
        () => new FrihetClient("fri_test_key", "https://example.test").getInvoicePdf("cancelled"),
        (error: Error & { statusCode?: number; errorCode?: string }) => {
          assert.equal(error.statusCode, 413);
          assert.equal(error.errorCode, "payload_too_large");
          return true;
        },
      );
      assert.equal(cancelCalled, true, "the bounded reader must be cancelled at the cap");
      assert.equal(signalAborted, true, "the underlying fetch transport must be aborted at the cap");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("getInvoicePdf: timeout remains active after headers while the body stalls", async () => {
    const originalFetch = globalThis.fetch;
    let headersReturned = false;
    let bodyReadStarted = false;
    let signalAborted = false;
    globalThis.fetch = async (_input, init) => {
      let streamController: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        pull() {
          bodyReadStarted = true;
          return new Promise<void>(() => {});
        },
      });
      init?.signal?.addEventListener("abort", () => {
        signalAborted = true;
        const abortError = new Error("aborted after headers");
        abortError.name = "AbortError";
        streamController.error(abortError);
      }, { once: true });
      headersReturned = true;
      return new Response(stream, { headers: { "Content-Type": "application/pdf" } });
    };

    try {
      const client = new FrihetClient("fri_test_key", "https://example.test", { timeoutMs: 20 });
      await assert.rejects(
        () => client.getInvoicePdf("stalled"),
        (error: Error & { statusCode?: number; errorCode?: string }) => {
          assert.equal(error.statusCode, 408);
          assert.equal(error.errorCode, "request_timeout");
          return true;
        },
      );
      assert.equal(headersReturned, true, "fetch must resolve headers before the timeout");
      assert.equal(bodyReadStarted, true, "the bounded reader must be waiting on the body");
      assert.equal(signalAborted, true, "the live document timer must abort after headers");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("getInvoicePdf: bounded 429 response retries, but an ordinary success does not refetch", async () => {
    const result = await makeClient().getInvoicePdf("rate_limited");
    assert.deepEqual(Buffer.from(result.base64, "base64"), PDF_BYTES);
    assert.equal(requestCounts.get("/invoices/rate_limited/pdf"), 2);
  });

  test("malformed or wrongly typed 2xx document bodies fail closed", async () => {
    const client = makeClient();
    for (const [label, call] of [
      ["malformed PDF", () => client.getInvoicePdf("malformed_pdf")],
      ["malformed XML", () => client.getInvoiceEInvoice("malformed_xml")],
      ["unexpected JSON", () => client.getInvoicePdf("unexpected_json")],
    ] as const) {
      await assert.rejects(call, (error: Error & { errorCode?: string }) => {
        assert.equal(error.errorCode, "invalid_response", label);
        return true;
      });
    }
  });

  test("generic JSON request path is unchanged: getInvoice on legacy envelope still works", async () => {
    // Regression guard — adding the binary/XML helpers MUST NOT touch
    // the JSON `request<T>` codepath. The full envelope-unwrap suite already
    // proves this for 22 fixtures; this single assertion is a smoke check
    // that the same client instance still drives JSON reads.
    const client = makeClient();
    const result = await (client as unknown as {
      getInvoice(id: string): Promise<{ id: string }>;
    }).getInvoice("smoke");
    assert.equal(result.id, "smoke");
  });

  test("PDF output schema rejects the phantom URL-only shape", () => {
    assert.equal(pdfResultOutput.safeParse({
      id: "legacy_pdf",
      url: "https://cdn.example.com/legacy_pdf.pdf",
      contentType: "application/pdf",
    }).success, false);
  });

  test("document payload-too-large errors report a response cap, not the 1 MiB request limit", () => {
    const result = handleToolError({
      statusCode: 413,
      errorCode: "payload_too_large",
      message: "Document response exceeds 5242880 bytes",
    });
    assert.match(result.content[0]!.text, /Document response too large/);
    assert.doesNotMatch(result.content[0]!.text, /max 1MB/);
  });

  test("document tool handlers keep large payloads out of duplicate text content", async () => {
    type HandlerResult = {
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
    };
    type Handler = (args: Record<string, unknown>) => Promise<HandlerResult>;
    const handlers = new Map<string, Handler>();
    const serverStub = {
      registerTool(name: string, _config: unknown, handler: Handler) {
        handlers.set(name, handler);
      },
    };
    const pdfPayload = "pdf-artifact-payload-marker".repeat(5_000);
    const einvoicePayload = "einvoice-artifact-payload-marker".repeat(5_000);
    const clientStub = {
      getInvoicePdf: async () => ({
        id: "inv_pdf",
        contentType: "application/pdf",
        sizeBytes: 90_000,
        base64: pdfPayload,
        filename: "invoice.pdf",
      }),
      getInvoiceEInvoice: async () => ({
        id: "inv_facturx",
        contentType: "application/pdf",
        sizeBytes: 95_000,
        base64: einvoicePayload,
        filename: "facturx.pdf",
      }),
    } as unknown as IFrihetClient;

    registerInvoiceTools(
      serverStub as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
      clientStub,
    );

    for (const [name, payload] of [
      ["get_invoice_pdf", pdfPayload],
      ["get_invoice_einvoice", einvoicePayload],
    ] as const) {
      const handler = handlers.get(name);
      assert.ok(handler, `${name} must be registered`);
      const result = await handler({ id: "inv_1" });
      assert.equal(result.structuredContent?.base64, payload);
      assert.ok(result.content[0]!.text.length < 1_000, `${name} text content must stay metadata-only`);
      assert.equal(result.content[0]!.text.includes(payload.slice(0, 100)), false);
      assert.match(result.content[0]!.text, /contentType/);
      assert.match(result.content[0]!.text, /sizeBytes/);
    }
  });
});
