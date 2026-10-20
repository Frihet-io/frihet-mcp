#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const plugin = join(root, "plugins/claude/frihet-erp");
export const claudeSource = join(root, "plugins/claude/operational");

export function filesIn(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Plugin files must not be symlinks: ${relative}`);
    if (entry.isDirectory()) return filesIn(join(directory, entry.name), relative);
    if (!entry.isFile()) throw new Error(`Unsupported plugin entry: ${relative}`);
    return [relative];
  }).sort();
}

export function exportedFiles() {
  const sharedPaths = [".claude-plugin/icon.png", "LICENSE"];
  const claudePaths = [".claude-plugin/plugin.json", "README.md", ...filesIn(join(claudeSource, "skills")).map((path) => `skills/${path}`)];
  return new Map([
    ...sharedPaths.map((path) => [path, readFileSync(join(root, path))]),
    ...claudePaths.map((path) => [path, readFileSync(join(claudeSource, path))]),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes("--write");
  for (const [path, bytes] of exportedFiles()) {
    const target = join(plugin, path);
    if (write) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    } else if (!readFileSync(target).equals(bytes)) {
      throw new Error(`Claude plugin export drift: ${path}; run node scripts/sync-claude-plugin.mjs --write`);
    }
  }
  console.log(`Claude plugin export ${write ? "written" : "matches source"}`);
}
