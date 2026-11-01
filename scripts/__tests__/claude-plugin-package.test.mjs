import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { claudeSource, exportedFiles, filesIn, plugin, root } from "../sync-claude-plugin.mjs";

test("remote preview is a self-contained export of the Claude operational skills", () => {
  const source = exportedFiles();
  const files = filesIn(plugin);
  assert.deepEqual(files.filter((path) => !path.startsWith("evals/")), [...source.keys(), ".gitignore", ".mcp.json"].sort());
  for (const [path, bytes] of source) {
    assert.deepEqual(readFileSync(join(plugin, path)), bytes, `Export drift: ${path}`);
  }
  assert.ok(files.length <= 512);
  for (const path of files) {
    assert.ok(readFileSync(join(plugin, path)).length < 256 * 1024, `${path} exceeds inspectable size`);
    assert.doesNotMatch(path, /(^|\/)(?:bin|hooks|agents|node_modules|\.DS_Store|__MACOSX)(?:\/|$)/u);
  }
  const manifest = JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.name, "frihet-erp");
  assert.equal(manifest.version, "1.18.0-preview.4");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.author.name, "Frihet");
  assert.equal(manifest.author.email, "hello@frihet.io");
  assert.equal(manifest.privacyPolicyUrl, "https://www.frihet.io/es/privacy");
  // Directory listing fields (code.claude.com/docs/en/plugins-reference#directory-listing-fields).
  assert.equal(manifest.icon, "./.claude-plugin/icon.png");
  assert.ok(files.includes(manifest.icon.slice(2)), "icon must ship inside the plugin");
  assert.equal(manifest.documentationUrl, "https://docs.frihet.io/desarrolladores/mcp-server");
  assert.equal(manifest.supportUrl, "https://claude-mcp.frihet.io/support");
  assert.equal(manifest.termsOfServiceUrl, "https://www.frihet.io/es/terms");
  assert.deepEqual(JSON.parse(readFileSync(join(plugin, ".mcp.json"), "utf8")), {
    mcpServers: { frihet: { type: "http", url: "https://claude-mcp.frihet.io/mcp" } },
  });
  const readme = readFileSync(join(plugin, "README.md"), "utf8");
  assert.ok(readme.replace(/```[\s\S]*?```/gu, "").split(/\s+/u).length >= 40);
  assert.deepEqual(files.filter((path) => path.endsWith("/SKILL.md")).map((path) => path.split("/")[1]).sort(),
    ["clientes", "cobros", "documentos", "frihet-mcp", "gastos", "operaciones", "revision-mensual", "tesoreria"]);
  for (const path of files.filter((path) => path.endsWith(".md") && !path.startsWith("evals/"))) {
    const markdown = readFileSync(join(plugin, path), "utf8");
    for (const [, target] of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      if (/^(?:https?:|mailto:|#)/u.test(target)) continue;
      assert.ok(existsSync(join(dirname(join(plugin, path)), target.split("#")[0])), `Broken package link: ${path} -> ${target}`);
    }
  }
});

test("Claude operational model scenarios use exact real schemas for their bounded tool subset", () => {
  assert.deepEqual(filesIn(claudeSource), [...exportedFiles().keys()].filter((path) => ![".claude-plugin/icon.png", "LICENSE"].includes(path)).sort());
  const mocks = JSON.parse(readFileSync(join(plugin, "evals/mocks/frihet/_tools.json"), "utf8"));
  const candidate = JSON.parse(readFileSync(join(root, "src/__tests__/fixtures/claude-candidate-contract.json"), "utf8"));
  const names = mocks.tools.map((tool) => tool.name).sort();
  assert.equal(new Set(names).size, names.length);
  for (const name of ["get_business_context", "get_invoice", "create_invoice", "create_expense", "get_expense", "list_transactions", "match_transaction_to_invoice"]) {
    assert.ok(names.includes(name), `${name} scenario schema missing`);
  }
  for (const mock of mocks.tools) {
    const descriptor = candidate.tools.grouped.find((tool) => tool.name === mock.name);
    assert.ok(descriptor, `Unknown mock tool: ${mock.name}`);
    assert.deepEqual(mock, descriptor, `Mock schema drift: ${mock.name}`);
  }
  for (const path of filesIn(join(plugin, "evals")).filter((path) => /(?:^|\/)mocks\/frihet\//u.test(path) && path.endsWith(".md"))) {
    assert.ok(names.includes(path.split("/").at(-1).slice(0, -3)), `Mock for unavailable tool: ${path}`);
  }
});

test("skill/ (declared source of truth) is byte-identical to skills/frihet-mcp", () => {
  const sourceDir = join(root, "skill");
  const copyDir = join(root, "skills/frihet-mcp");
  const source = filesIn(sourceDir).filter((path) => path !== "CANONICAL.md");
  assert.deepEqual(source, filesIn(copyDir));
  for (const path of source) {
    assert.deepEqual(readFileSync(join(copyDir, path)), readFileSync(join(sourceDir, path)), `skill/ drift: ${path}`);
  }
});
