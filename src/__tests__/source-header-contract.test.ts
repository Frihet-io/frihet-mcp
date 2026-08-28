/**
 * MCP origin-marker wire contract.
 *
 * Bug (verified against both repos, not inferred): the client sent only
 * X-API-Key / Content-Type / Accept (+ Idempotency-Key), so an invoice created
 * through the MCP server was byte-identical on the wire to one created by a
 * direct API call. The backend classifier `detectApiInvoiceSource`
 * (Frihet-ERP functions/src/publicApi.ts) therefore returned 'api' for every
 * MCP create and the `invoice_created` analytics event attributed 100% of MCP
 * usage to the raw API — MCP adoption was unmeasurable. `grep -rn
 * "x-frihet-source" src/ workers/` returned 0 hits before this change.
 *
 * The subtle half: setting `X-Frihet-Source: mcp` ALONE does not fix it on the
 * default baseUrl. `api.frihet.io` is fronted by workers/api-proxy/worker.js,
 * which rebuilds the upstream request from an allowlist
 * (`ALLOWED_REQUEST_HEADERS`) that contains `user-agent` but NOT
 * `x-frihet-source`. Verified live 6-ago-2026: GET /agents.json answers 200 at
 * api.frihet.io (a path only the Worker serves, with the Worker's exact
 * `cache-control: public, max-age=3600, stale-while-revalidate=86400`) and 401
 * at the Cloud Function directly — the Worker is in path. So the source header
 * would be set by the client and stripped at the edge: a mechanism promised by
 * a comment and implemented by nothing.
 *
 * These tests therefore assert BOTH halves on the wire, and the last one is
 * the load-bearing one: it replays the Worker's allowlist over the captured
 * request and runs the REAL backend predicate over what survives.
 *
 * Run: npm test (after build)
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { FrihetClient } from "../client.js";

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
}

const captured: CapturedRequest[] = [];

let server: Server;
let baseUrl: string;

/**
 * Verbatim copy of `detectApiInvoiceSource` from Frihet-ERP
 * functions/src/publicApi.ts. Copied rather than imported because the backend
 * lives in a different repo — if it ever diverges, this test is what tells us,
 * which is the point.
 */
function detectApiInvoiceSource(headers: Record<string, string>): "api" | "mcp" {
  const marker = [
    headers["x-frihet-source"] ?? "",
    headers["x-frihet-client"] ?? "",
    headers["user-agent"] ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return /(^|[^a-z])mcp([^a-z]|$)|frihet-mcp|@frihet\/mcp/.test(marker) ? "mcp" : "api";
}

/**
 * Verbatim copy of `ALLOWED_REQUEST_HEADERS` from workers/api-proxy/worker.js
 * — the allowlist `buildUpstreamHeaders` rebuilds the upstream request from.
 * Anything not in this list never reaches the Cloud Function on the default
 * baseUrl.
 */
const PROXY_ALLOWED_REQUEST_HEADERS = [
  "x-api-key",
  "content-type",
  "accept",
  "authorization",
  "user-agent",
  "accept-language",
  "idempotency-key",
  "x-request-id",
];

/** What the Cloud Function actually receives once the edge proxy is in path. */
function throughApiProxy(headers: Record<string, string>): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const name of PROXY_ALLOWED_REQUEST_HEADERS) {
    if (headers[name] !== undefined) forwarded[name] = headers[name];
  }
  return forwarded;
}

before(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(" ") : (value ?? "");
    }
    captured.push({ method: req.method ?? "", path: url.pathname, headers });

    // Drain the body so the socket stays reusable.
    req.resume();

    if (req.method === "GET" && url.pathname === "/invoices/inv_pdf/pdf") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/pdf");
      res.end("%PDF-1.4\n%%EOF");
      return;
    }

    res.setHeader("Content-Type", "application/json");

    // List reads need the `{ data: [...] }` envelope requestPaginated validates.
    if (req.method === "GET" && url.pathname === "/invoices") {
      res.statusCode = 200;
      res.end(JSON.stringify({ data: [], total: 0, limit: 20, offset: 0 }));
      return;
    }

    res.statusCode = 201;
    res.end(
      JSON.stringify({
        data: { id: "inv_1", documentNumber: "F-2026-001" },
        meta: { requestId: "req_1", timestamp: "2026-08-06T00:00:00.000Z" },
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  captured.length = 0;
});

const client = () => new FrihetClient("fri_test_key", `${baseUrl}`);
const oauthClient = () => new FrihetClient("fri_oauth_key", "https://api.frihet.io/v1", {
  oauthServiceSecret: "s".repeat(32),
});

async function withCapturedTrustedFetch(run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    captured.push({ method: init?.method ?? "GET", path: url.pathname, headers });

    if (init?.method === "GET" && url.pathname === "/v1/invoices/inv_pdf/pdf") {
      return new Response("%PDF-1.4\n%%EOF", {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }
    if (init?.method === "GET" && url.pathname === "/v1/invoices") {
      return Response.json({ data: [], total: 0, limit: 20, offset: 0 });
    }
    return Response.json({
      data: { id: "inv_1", documentNumber: "F-2026-001" },
      meta: { requestId: "req_1", timestamp: "2026-08-06T00:00:00.000Z" },
    }, { status: 201 });
  };
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("MCP origin-marker wire contract", () => {
  test("createInvoice sends X-Frihet-Source: mcp", async () => {
    await client().createInvoice({ clientId: "cli_1", items: [] });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "POST");
    assert.equal(
      captured[0].headers["x-frihet-source"],
      "mcp",
      "POST /invoices reached the backend with no source marker — every MCP invoice is attributed to source:'api'",
    );
  });

  test("the marker is sent on reads too, not just on invoice creates", async () => {
    const c = client();
    await c.listInvoices({ limit: 1 });
    await c.getInvoice("inv_1");

    assert.equal(captured.length, 2);
    for (const req of captured) {
      assert.equal(
        req.headers["x-frihet-source"],
        "mcp",
        `${req.method} ${req.path} carried no source marker`,
      );
    }
  });

  test("ordinary API keys never receive the internal OAuth second factor", async () => {
    await client().getInvoice("inv_direct");

    assert.equal(captured[0].headers["x-frihet-oauth-key"], undefined);
  });

  test("OAuth-bound JSON and binary requests carry the second factor", async () => {
    await withCapturedTrustedFetch(async () => {
      const c = oauthClient();
      await c.listInvoices({ limit: 1 });
      await c.createInvoice({ clientId: "cli_oauth", items: [] });
      await c.getInvoicePdf("inv_pdf");
    });

    assert.equal(captured.length, 3);
    for (const req of captured) {
      assert.equal(req.headers["x-frihet-oauth-key"], "s".repeat(32));
    }
  });

  test("malformed OAuth service secrets fail before any request", () => {
    assert.throws(
      () => new FrihetClient("fri_oauth_key", "https://api.frihet.io/v1", {
        oauthServiceSecret: "too-short",
      }),
      /service authentication is not configured/u,
    );
    assert.throws(
      () => new FrihetClient("fri_oauth_key", "https://api.frihet.io/v1", {
        oauthServiceSecret: `${"s".repeat(32)}\nleak`,
      }),
      /service authentication is not configured/u,
    );
  });

  test("OAuth service secrets reject arbitrary, lookalike, and non-canonical API authorities", () => {
    for (const candidate of [
      `${baseUrl}`,
      "https://api.frihet.io/v1/",
      "https://api.frihet.io/v1?redirect=evil",
      "https://api.frihet.io.evil.example/v1",
      "https://attacker-project.cloudfunctions.net/publicApi/api/v1",
    ]) {
      assert.throws(
        () => new FrihetClient("fri_oauth_key", candidate, {
          oauthServiceSecret: "s".repeat(32),
        }),
        /service authority is not trusted/u,
        candidate,
      );
    }

    assert.doesNotThrow(() => new FrihetClient(
      "fri_oauth_key",
      "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/publicApi/api/v1",
      { oauthServiceSecret: "s".repeat(32) },
    ));
  });

  test("the User-Agent identifies the MCP server", async () => {
    await client().createInvoice({ clientId: "cli_2", items: [] });

    assert.equal(
      captured[0].headers["user-agent"],
      "frihet-mcp-server",
      "the default runtime User-Agent ('node' on undici) is indistinguishable from any other script",
    );
  });

  test("the User-Agent carries no version — package.json is the only place a version lives", async () => {
    await client().createInvoice({ clientId: "cli_3", items: [] });

    assert.doesNotMatch(
      captured[0].headers["user-agent"],
      /\d+\.\d+\.\d+/,
      "a hardcoded version in the User-Agent is a second source of truth that silently drifts from package.json on every npm version bump",
    );
  });

  test("the real backend classifier reads the request as 'mcp'", async () => {
    await client().createInvoice({ clientId: "cli_4", items: [] });

    assert.equal(
      detectApiInvoiceSource(captured[0].headers),
      "mcp",
      "detectApiInvoiceSource still classifies the create as 'api'",
    );
  });

  // -- the load-bearing one ------------------------------------------------
  //
  // On the DEFAULT baseUrl the request does not reach the Cloud Function as
  // sent: workers/api-proxy/worker.js rebuilds it from ALLOWED_REQUEST_HEADERS,
  // which drops x-frihet-source. If the only marker were that header, this
  // case would classify as 'api' — the header set, stripped at the edge, and
  // the metric still dark. It FAILS on a fix that adds X-Frihet-Source alone.

  test("classification survives the api-proxy Worker allowlist (default baseUrl path)", async () => {
    await client().createInvoice({ clientId: "cli_5", items: [] });

    const atCloudFunction = throughApiProxy(captured[0].headers);
    assert.equal(
      atCloudFunction["x-frihet-source"],
      undefined,
      "the proxy allowlist changed — re-check workers/api-proxy/worker.js ALLOWED_REQUEST_HEADERS",
    );
    assert.equal(
      detectApiInvoiceSource(atCloudFunction),
      "mcp",
      "every marker the client sends is stripped by the edge proxy — the source header is a phantom and MCP invoices still land as source:'api'",
    );
  });

  test("a request carrying no markers still classifies as 'api' (the predicate is not vacuously true)", () => {
    assert.equal(
      detectApiInvoiceSource({
        "x-api-key": "fri_test_key",
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "node",
      }),
      "api",
    );
  });
});
