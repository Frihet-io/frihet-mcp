/**
 * Tests for fiscal `modelo` prefix aliases (issue #50).
 *
 * Coverage:
 *   1. applyFiscalAliases points every alias at the EXACT SAME registered-tool
 *      object as its canonical name (zero semantic divergence) — verified
 *      against the REAL @modelcontextprotocol/sdk McpServer, not a stub, so
 *      this is a true end-to-end check of the SDK-internals assumption.
 *   2. Fail-open: missing/reshaped `_registeredTools` never throws.
 *   3. Never overwrites an existing registration.
 *   4. Regression gate: every `modelo` tool registered under `src/tools/*.ts`
 *      either already uses the `frihet_` prefix or has a `FISCAL_MODELO_ALIASES`
 *      entry pointing to it — so a future modelo tool added with a drifted
 *      prefix and no alias fails this test (issue #50's requested gate).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { applyFiscalAliases, FISCAL_MODELO_ALIASES } from "../fiscal-aliases.js";
import { registerAllTools } from "../tools/register-all.js";
import type { IFrihetClient } from "../client-interface.js";

function makeClient(): IFrihetClient {
  return new Proxy(
    {},
    {
      get: () => async (input?: unknown) => ({ data: [], total: 0, limit: 10, offset: 0, input }),
    },
  ) as IFrihetClient;
}

interface McpServerInternals {
  _registeredTools: Record<string, unknown>;
}

describe("fiscal-aliases: applied against the real SDK McpServer", () => {
  test("each alias resolves to the exact same registered-tool object as its canonical name", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerAllTools(server, makeClient());
    applyFiscalAliases(server);

    const registry = (server as unknown as McpServerInternals)._registeredTools;
    for (const [alias, canonical] of Object.entries(FISCAL_MODELO_ALIASES)) {
      assert.ok(registry[canonical], `canonical tool ${canonical} must be registered`);
      assert.ok(registry[alias], `alias ${alias} must resolve to something`);
      assert.equal(
        registry[alias],
        registry[canonical],
        `${alias} must be the SAME object reference as ${canonical} (zero divergence)`,
      );
    }
  });

  test("tools/call dispatch actually finds the alias (SDK-level, not just object identity)", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerAllTools(server, makeClient());
    applyFiscalAliases(server);

    // Reproduces the SDK's own CallToolRequestSchema lookup
    // (mcp.js: `const tool = this._registeredTools[request.params.name]`).
    const registry = (server as unknown as McpServerInternals)._registeredTools;
    const aliasTool = registry["frihet_modelo_303_summary"] as { enabled?: boolean };
    assert.ok(aliasTool, "alias must be present in the registry the SDK dispatches from");
    assert.notEqual(aliasTool.enabled, false, "alias must not be disabled");
  });
});

describe("fiscal-aliases: fail-open", () => {
  test("does not throw when _registeredTools is missing", () => {
    assert.doesNotThrow(() => applyFiscalAliases({}));
  });

  test("does not throw when _registeredTools is not an object", () => {
    assert.doesNotThrow(() => applyFiscalAliases({ _registeredTools: null }));
    assert.doesNotThrow(() => applyFiscalAliases({ _registeredTools: "nope" }));
  });

  test("silently skips an alias whose canonical tool is not registered (e.g. allow-listed mode)", () => {
    const fake = { _registeredTools: {} as Record<string, unknown> };
    assert.doesNotThrow(() => applyFiscalAliases(fake));
    assert.equal(Object.keys(fake._registeredTools).length, 0);
  });
});

describe("fiscal-aliases: never overwrites an existing registration", () => {
  test("if the alias name is already registered as a real tool, it is left untouched", () => {
    const sentinel = { marker: "pre-existing-real-tool" };
    const fake = {
      _registeredTools: {
        get_modelo_303_summary: { marker: "canonical" },
        frihet_modelo_303_summary: sentinel,
      } as Record<string, unknown>,
    };
    applyFiscalAliases(fake);
    assert.equal(fake._registeredTools.frihet_modelo_303_summary, sentinel);
  });
});

describe("fiscal-aliases: regression gate (issue #50)", () => {
  test("every 'modelo' tool uses the frihet_ prefix or has a tracked alias — no future drift", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const toolsDir = join(here, "..", "..", "src", "tools");
    const aliasedCanonicals = new Set(Object.values(FISCAL_MODELO_ALIASES));

    const modeloNames: string[] = [];
    for (const f of readdirSync(toolsDir)) {
      if (!f.endsWith(".ts")) continue;
      const txt = readFileSync(join(toolsDir, f), "utf8");
      for (const m of txt.matchAll(/registerTool\(\s*"([a-z_0-9]*modelo[a-z_0-9]*)"/g)) {
        modeloNames.push(m[1]);
      }
    }

    // Sanity: the scan itself must find tools (guards against a silent 0-match rot).
    assert.ok(modeloNames.length >= 7, `expected >=7 modelo tools, found ${modeloNames.length}`);

    const undriftedOrAliased = modeloNames.filter(
      (name) => name.startsWith("frihet_") || aliasedCanonicals.has(name),
    );
    assert.deepEqual(
      undriftedOrAliased.sort(),
      modeloNames.sort(),
      "every modelo tool must either use the frihet_ prefix or be listed in FISCAL_MODELO_ALIASES " +
        "(src/fiscal-aliases.ts) — a new drifted-prefix modelo tool needs an alias added in the same PR",
    );
  });

  test("FISCAL_MODELO_ALIASES has no self-referencing or duplicate-target entries", () => {
    const canonicals = Object.values(FISCAL_MODELO_ALIASES);
    assert.equal(new Set(canonicals).size, canonicals.length, "no two aliases should point at the same canonical tool");
    for (const [alias, canonical] of Object.entries(FISCAL_MODELO_ALIASES)) {
      assert.notEqual(alias, canonical, "an alias must not equal its own canonical name");
    }
  });
});
