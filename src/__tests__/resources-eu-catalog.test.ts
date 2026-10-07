import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { registerAllResources } from "../resources/register-all.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ResourceHandler = (uri: string) => Promise<{ contents: Array<{ text: string }> }>;

class StubMcpServer {
  handlers = new Map<string, ResourceHandler>();

  registerResource(_name: string, uri: string, _config: unknown, handler: ResourceHandler): void {
    this.handlers.set(uri, handler);
  }
}

async function readJson<T>(uri: string): Promise<T> {
  const server = new StubMcpServer();
  registerAllResources(server as unknown as McpServer);
  const handler = server.handlers.get(uri);
  assert.ok(handler, `${uri} must be registered`);
  const result = await handler(uri);
  return JSON.parse(result.contents[0].text) as T;
}

interface Country {
  code: string;
  defaultTaxRate: number;
  currency: string;
}

interface Currency {
  countries: string[];
}

describe("EU catalog pinning (verified 2026-10-07)", () => {
  test("standard VAT rates: FI 25.5 (2024-09-01), SK 23 (2025-01-01), EE 24 (2025-07-01), RO 21 (2025-08-01)", async () => {
    const countries = await readJson<Country[]>("frihet://config/countries");
    const rate = (code: string) => countries.find((c) => c.code === code)?.defaultTaxRate;

    assert.equal(rate("FI"), 25.5);
    assert.equal(rate("SK"), 23);
    assert.equal(rate("EE"), 24);
    assert.equal(rate("RO"), 21);
  });

  test("Bulgaria uses EUR since 2026-01-01; BGN stays for historical documents with no active country", async () => {
    const countries = await readJson<Country[]>("frihet://config/countries");
    const currencies = await readJson<Record<string, Currency>>("frihet://config/currencies");

    assert.equal(countries.find((c) => c.code === "BG")?.currency, "EUR");
    assert.ok(currencies.EUR.countries.includes("BG"), "EUR must list BG");
    assert.ok(currencies.BGN, "BGN entry must be kept for historical documents");
    assert.deepEqual(currencies.BGN.countries, []);
  });
});
