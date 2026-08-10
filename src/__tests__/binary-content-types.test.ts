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
 * path is unchanged. Two new private helpers, `requestBinary` and
 * `requestXml`, branch on `Content-Type` after the existing 429 / error /
 * 204 guards. Both enforce a hard size cap:
 *   - PDF: 25 MiB (matches typical ERP-issued invoice PDF + headroom for
 *     embedded logos / Facturae XML attachments)
 *   - XML:  5 MiB (UBL / Facturae / PEPPOL stay well under 1 MiB in practice)
 * The cap is enforced TWICE — once as a precheck on `Content-Length` so an
 * honest server doesn't waste bandwidth, and once after streaming the body
 * so a missing/lying `Content-Length` still can't trigger an unbounded
 * `arrayBuffer()` allocation.
 *
 * Tests below prove all three things end-to-end against a real `node:http`
 * mock backend: PDF round-trip, XML text round-trip, JSON envelope
 * regression (the 22 pre-existing tests in
 * `get-envelope-unwrap-regression.test.ts` cover JSON; this file adds the
 * three mutations that broke + the cap behavior).
 *
 * Run: npm test (after build).
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { FrihetClient } from "../client.js";
import { pdfResultOutput } from "../tools/shared.js";

const PDF_MAX_BYTES = 25 * 1024 * 1024;
const XML_MAX_BYTES = 5 * 1024 * 1024;

// Minimal valid PDF (header + EOF only — what we need for round-trip).
// Magic header `%PDF-1.4\n` is exactly 9 bytes; total payload = 9 + 5 + 1 = 15.
const PDF_BYTES = Buffer.from("%PDF-1.4\n%%EOF\n", "utf8");

// Minimal EN16931-shaped XML payload (XML declaration + root Invoice element).
const XML_TEXT =
  '<?xml version="1.0" encoding="UTF-8"?>\n<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">\n  <ID>inv_1</ID>\n</Invoice>\n';

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

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

    // ── Legacy JSON envelope contract (pre-#1393): still must work.
    if (url.pathname === "/invoices/legacy_pdf/pdf" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: {
            id: "legacy_pdf",
            url: "https://cdn.example.com/legacy_pdf.pdf",
            contentType: "application/pdf",
          },
          meta: { source: "legacy" },
        }),
      );
      return;
    }
    if (url.pathname === "/invoices/legacy_xml/xml" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: {
            xml: "<Invoice/>",
            filename: "legacy_xml.xml",
            format: "ubl",
          },
          meta: { source: "legacy" },
        }),
      );
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
  });

  test("getInvoicePdf: legacy JSON envelope still unwraps to flat { id, url, contentType }", async () => {
    const client = makeClient();
    const result = await (
      client as unknown as {
        getInvoicePdf(id: string): Promise<Record<string, unknown>>;
      }
    ).getInvoicePdf("legacy_pdf");

    assert.equal(result.id, "legacy_pdf");
    assert.equal(result.url, "https://cdn.example.com/legacy_pdf.pdf");
    assert.equal(result.contentType, "application/pdf");
    assert.equal("data" in (result as object), false, "envelope 'data' must not leak");
    assert.equal("meta" in (result as object), false, "envelope 'meta' must not leak");
  });

  test("getInvoiceEInvoice: legacy JSON envelope still unwraps to { xml, filename, format }", async () => {
    const client = makeClient();
    const result = await (
      client as unknown as {
        getInvoiceEInvoice(id: string): Promise<Record<string, unknown>>;
      }
    ).getInvoiceEInvoice("legacy_xml");

    assert.equal(result.xml, "<Invoice/>");
    assert.equal(result.filename, "legacy_xml.xml");
    assert.equal(result.format, "ubl");
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

  test("getInvoicePdf: server lies about Content-Length, streams past 25 MiB → FrihetApiError(413) — no unbounded materialization", async () => {
    // The lying-server mock streams `PDF_MAX_BYTES + 1` bytes while claiming
    // Content-Length: 10. A correct streaming implementation cancels the
    // reader as soon as the running total crosses the cap; the test would
    // either OOM (old arrayBuffer()) or time out (post-stream check) under
    // a naive implementation. The 413 + payload_too_large pair is the only
    // acceptable outcome — and it MUST arrive quickly.
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

  test("getInvoicePdf: streaming path does NOT pre-materialize the entire body", async () => {
    // Sharp assertion on the streaming discipline: the mock serves a body
    // larger than `maxBytes` but the implementation must cancel the reader
    // AS the total crosses the cap — not allocate, then check. We verify
    // indirectly by asserting the returned error references the cap, NOT a
    // pre-materialized count (which would read "received 26214401" for the
    // exact byte count we sent).
    const client = makeClient();
    await assert.rejects(
      () =>
        (
          client as unknown as {
            getInvoicePdf(id: string): Promise<unknown>;
          }
        ).getInvoicePdf("lying_pdf"),
      (err: Error & { statusCode?: number; errorCode?: string; message?: string }) => {
        assert.equal(err.statusCode, 413);
        assert.equal(err.errorCode, "payload_too_large");
        // The streaming-path error message includes "during streaming"
        // — that's the marker that the cap fired mid-read, not post-hoc.
        assert.match(
          err.message ?? "",
          /during streaming/i,
          `expected streaming-mode 413 message, got: ${err.message}`,
        );
        return true;
      },
    );
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

  test("legacy { id, url, contentType } envelope validates against pdfResultOutput (ERP#1393 acceptance)", async () => {
    // ERP#1393 acceptance criteria: legacy JSON contract
    // `{ id, url, contentType }` (no sizeBytes / no base64) must still
    // validate against `pdfResultOutput`. Only `id` is REQUIRED; the
    // binary-document fields stay OPTIONAL so older backends don't break.
    const legacyShape = {
      id: "legacy_pdf",
      url: "https://cdn.example.com/legacy_pdf.pdf",
      contentType: "application/pdf",
    };
    const parsed = pdfResultOutput.safeParse(legacyShape);
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error, null, 2));
    assert.equal(parsed.data?.id, "legacy_pdf");
    assert.equal(parsed.data?.url, "https://cdn.example.com/legacy_pdf.pdf");
    assert.equal(parsed.data?.contentType, "application/pdf");
    assert.equal(parsed.data?.sizeBytes, undefined);
    assert.equal(parsed.data?.base64, undefined);
  });
});
