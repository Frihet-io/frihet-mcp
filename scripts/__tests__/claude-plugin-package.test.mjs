import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { exportedFiles, filesIn, plugin, root } from "../sync-claude-plugin.mjs";

test("remote preview is a small self-contained export of the local plugin skills", () => {
  const source = exportedFiles();
  const files = filesIn(plugin);
  assert.deepEqual(files.filter((path) => !path.startsWith("evals/")), [...source.keys(), ".gitignore", ".mcp.json", "README.md"].sort());
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
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.author.name, "Frihet");
  assert.equal(manifest.author.email, "hola@frihet.io");
  assert.equal(manifest.privacyPolicyUrl, "https://www.frihet.io/es/privacy");
  assert.deepEqual(JSON.parse(readFileSync(join(plugin, ".mcp.json"), "utf8")), {
    mcpServers: { frihet: { type: "http", url: "https://mcp.frihet.io/mcp" } },
  });
  const readme = readFileSync(join(plugin, "README.md"), "utf8");
  assert.ok(readme.replace(/```[\s\S]*?```/gu, "").split(/\s+/u).length >= 40);
  assert.deepEqual(files.filter((path) => path.endsWith("/SKILL.md")).map((path) => path.split("/")[1]).sort(),
    ["cobros", "documentos", "frihet-mcp", "revision-mensual"]);
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
