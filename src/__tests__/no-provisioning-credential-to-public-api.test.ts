/**
 * The provisioning service credential never reaches the public API.
 *
 * The credential authorizes the OAuth API-key provisioning endpoints only.
 * Attaching it to tool-call traffic (`x-frihet-oauth-key`) gave the public API
 * a credential it never reads, widening exposure with no function. This spy
 * test runs representative calls through both HTTP paths of the client (JSON
 * `request` and binary `fetchRaw`) against both trusted public API bases and
 * asserts that no request carries the header or the secret value anywhere:
 * headers, URL, query or body.
 *
 * The client is constructed with the credential through an untyped option so
 * the test keeps compiling (and keeps asserting) whatever the constructor
 * surface looks like: a regression that re-adds the option fails here.
 *
 * Run: npm test (after build)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FrihetClient } from "../client.js";

const SECRET = "provisioning-credential-".padEnd(40, "z");
const HEADER = "x-frihet-oauth-key";

const PUBLIC_API_BASES = [
  "https://api.frihet.io/v1",
  "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/publicApi/api/v1",
];

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: string;
}

async function withSpy(run: () => Promise<void>): Promise<Seen[]> {
  const seen: Seen[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    seen.push({
      url: input instanceof Request ? input.url : String(input),
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/pdf")) {
      return new Response("%PDF-1.4\n%%EOF", {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }
    if (init?.method === "GET" && url.pathname.endsWith("/invoices")) {
      return Response.json({ data: [], total: 0, limit: 20, offset: 0 });
    }
    return Response.json({ data: { id: "inv_1" }, meta: {} }, { status: 200 });
  };
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return seen;
}

function assertNoCredential(seen: Seen[], label: string): void {
  assert.ok(seen.length > 0, `${label}: the spy saw no request`);
  for (const req of seen) {
    const where = `${label}: ${req.url}`;
    assert.equal(req.headers[HEADER], undefined, `${where} carries ${HEADER}`);
    for (const [name, value] of Object.entries(req.headers)) {
      assert.ok(!value.includes(SECRET), `${where} leaks the secret in header ${name}`);
    }
    assert.ok(!req.url.includes(SECRET), `${where} leaks the secret in the URL`);
    assert.ok(!req.body.includes(SECRET), `${where} leaks the secret in the body`);
  }
}

describe("provisioning credential stays off public API traffic", () => {
  for (const base of PUBLIC_API_BASES) {
    test(`no ${HEADER} on JSON and binary calls to ${new URL(base).host}`, async () => {
      const seen = await withSpy(async () => {
        // The untyped option is the regression vector under test.
        const options = { oauthServiceSecret: SECRET } as never;
        const client = new FrihetClient("fri_oauth_key", base, options);
        await client.listInvoices({ limit: 1 });
        await client.getInvoice("inv_1");
        await client.createInvoice({ clientId: "cli_1", items: [] });
        await client.getInvoicePdf("inv_pdf");
      });

      assert.equal(seen.length, 4);
      assertNoCredential(seen, base);
    });
  }
});
