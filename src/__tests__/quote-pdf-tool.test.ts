import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { erpServer, fixture, mcpSurface } from "./helpers/erp-parity.js";
import { MAX_PDF_BYTES } from "../client.js";
import { DemoFrihetClient } from "../demo-client.js";
import { CAPABILITY_META_KEY } from "../capability-truth.js";

const pdf = fixture<{ id: string; filename: string; text: string }>("quote-pdf");
const bytes = Buffer.from(pdf.text, "utf8");

describe("Quote PDF OpenAPI parity", () => {
  test("one read returns raw PDF bytes as structured base64 and metadata-only human content", async (t) => {
    const { backend, requests } = await erpServer(t, (_req, res) => {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${pdf.filename}"`);
      res.end(bytes);
    });
    const client = await mcpSurface(t, backend);
    const result = await client.callTool({ name: "get_quote_pdf", arguments: { id: pdf.id } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      id: pdf.id, filename: pdf.filename, contentType: "application/pdf", sizeBytes: bytes.byteLength, base64: bytes.toString("base64"),
    });
    assert.equal(JSON.stringify(result.content).includes(bytes.toString("base64")), false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[0].url.pathname, `/v1/quotes/${pdf.id}/pdf`);
    assert.equal(requests[0].url.search, "");
    assert.equal(requests[0].body, "");
    assert.equal(requests[0].headers.accept, "*/*");
    assert.equal(requests[0].headers["idempotency-key"], undefined);
    const tools = (await client.listTools()).tools.filter((tool) => tool.name === "get_quote_pdf");
    assert.equal(tools.length, 1);
    assert.deepEqual(tools[0].annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const capability = tools[0]._meta?.[CAPABILITY_META_KEY] as { writesFrihet: boolean; externalSideEffects: string[] };
    assert.equal(capability.writesFrihet, false);
    assert.deepEqual(capability.externalSideEffects, []);
  });

  test("strict input rejects missing, blank, oversized and unsupported parameters without I/O", async (t) => {
    const { backend, requests } = await erpServer(t, (_req, res) => res.end(bytes));
    const client = await mcpSurface(t, backend);
    for (const args of [{}, { id: " " }, { id: 1 }, { id: "x".repeat(129) }, { id: pdf.id, to: "x@example.com" }]) {
      assert.equal((await client.callTool({ name: "get_quote_pdf", arguments: args })).isError, true);
    }
    assert.equal(requests.length, 0);
  });

  test("identifiers stay within one encoded path segment", async (t) => {
    const { backend, requests } = await erpServer(t, (_req, res) => {
      res.setHeader("Content-Type", "application/pdf");
      res.end(bytes);
    });
    const id = "quote/other?fields=secret#fragment";
    assert.equal((await backend.getQuotePdf(id)).id, id);
    assert.equal(requests[0].url.pathname, `/v1/quotes/${encodeURIComponent(id)}/pdf`);
    assert.equal(requests[0].url.search, "");
    for (const invalid of ["", ".", ".."]) await assert.rejects(backend.getQuotePdf(invalid));
    assert.equal(requests.length, 1);
  });

  test("octet-stream PDFs validate by signature; malformed bytes or MIME fail closed", async (t) => {
    let mime = "application/octet-stream";
    let body = bytes;
    const { backend } = await erpServer(t, (_req, res) => {
      res.setHeader("Content-Type", mime);
      res.end(body);
    });
    const client = await mcpSurface(t, backend);
    const call = () => client.callTool({ name: "get_quote_pdf", arguments: { id: pdf.id } });
    assert.equal((await call()).isError, undefined);
    body = Buffer.from("not a PDF");
    assert.equal((await call()).isError, true);
    body = bytes;
    mime = "text/html";
    assert.equal((await call()).isError, true);
  });

  test("the 25 MiB cap rejects declared and chunked oversized responses", async (t) => {
    let declared = true;
    const { backend } = await erpServer(t, (_req, res) => {
      res.setHeader("Content-Type", "application/pdf");
      if (declared) {
        res.setHeader("Content-Length", String(MAX_PDF_BYTES + 1));
        res.end();
      } else {
        res.write(Buffer.alloc(MAX_PDF_BYTES + 1, 0x25));
        res.end();
      }
    });
    for (const useDeclared of [true, false]) {
      declared = useDeclared;
      await assert.rejects(backend.getQuotePdf(pdf.id), { statusCode: 413, errorCode: "payload_too_large" });
    }
  });

  for (const status of [403, 404]) {
    test(`HTTP ${status} stays a sanitized tool error`, async (t) => {
      const { backend } = await erpServer(t, (_req, res) => {
        res.statusCode = status;
        res.end(JSON.stringify({ error: "fri_live_PRIVATE-provider-body" }));
      });
      const client = await mcpSurface(t, backend);
      const result = await client.callTool({ name: "get_quote_pdf", arguments: { id: pdf.id } });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.equal(JSON.stringify(result).includes("fri_live_PRIVATE"), false);
    });
  }

  test("rate limits retry only GET and redirects never forward the credential", async (t) => {
    let status = 429;
    const { backend, requests } = await erpServer(t, (_req, res) => {
      res.statusCode = status;
      if (status === 429) {
        res.setHeader("Retry-After", "0");
        status = 200;
        res.end(JSON.stringify({ error: "rate_limited" }));
      } else if (status === 302) {
        res.setHeader("Location", "https://example.com/private-pdf");
        res.end();
      } else {
        res.setHeader("Content-Type", "application/pdf");
        res.end(bytes);
      }
    });
    assert.equal((await backend.getQuotePdf(pdf.id)).sizeBytes, bytes.byteLength);
    assert.equal(requests.length, 2);
    status = 302;
    await assert.rejects(backend.getQuotePdf(pdf.id), { errorCode: "network_error" });
    assert.equal(requests.length, 3);
    assert.ok(requests.every((request) => request.method === "GET"));
  });

  test("demo PDF uses the same output contract and carries its fixture notice", async (t) => {
    const client = await mcpSurface(t, new DemoFrihetClient());
    const result = await client.callTool({ name: "get_quote_pdf", arguments: { id: pdf.id } });
    assert.equal(result.isError, undefined);
    const output = result.structuredContent as Record<string, unknown>;
    assert.equal(output._demo, true);
    assert.equal(output.contentType, "application/pdf");
  });
});
