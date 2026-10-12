#!/usr/bin/env node
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { unstable_readConfig } from "../workers/remote-mcp/node_modules/wrangler/wrangler-dist/cli.js";

const configPath = fileURLToPath(new URL("../workers/remote-mcp/wrangler.claude.toml", import.meta.url));
const sharedPath = fileURLToPath(new URL("../workers/remote-mcp/wrangler.toml", import.meta.url));
export const DRY_RUN_NAMESPACE = "00000000000000000000000000000000";

export function assertClaudeWorkerIsolation(config, sharedNamespaceIds, sourceOnly = false) {
  assert.equal(config.name, "frihet-claude-mcp");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, [{ pattern: "claude-mcp.frihet.io/*", zone_name: "frihet.io" }]);
  assert.equal(config.vars.FRIHET_OPENAI_MODE, "false");
  assert.equal(config.vars.FRIHET_CLAUDE_MODE, "true");
  assert.equal(config.vars.FRIHET_TOOL_MODE, "grouped");
  assert.equal(config.assets, undefined);
  assert.equal(config.alias["@cloudflare/workers-oauth-provider"], "./.wrangler/claude-oauth-provider.js");
  assert.equal(config.build.command, "node ../../scripts/prepare-claude-oauth-provider.mjs");
  assert.deepEqual(config.durable_objects.bindings, [
    { name: "MCP_OBJECT", class_name: "FrihetMCP" },
    { name: "OAUTH_STATE", class_name: "OAuthStateStore" },
  ]);
  assert.deepEqual(config.migrations, [
    { tag: "v1", new_sqlite_classes: ["FrihetMCP"] },
    { tag: "v2", new_sqlite_classes: ["OAuthStateStore"] },
  ]);
  assert.equal(config.kv_namespaces.length, 1);
  const namespace = config.kv_namespaces[0];
  assert.equal(namespace.binding, "OAUTH_KV");
  assert.match(namespace.id, /^[a-f0-9]{32}$/u);
  assert.ok(!sharedNamespaceIds.includes(namespace.id), "Claude must have a separate OAuth KV namespace");
  if (!sourceOnly) assert.notEqual(namespace.id, DRY_RUN_NAMESPACE, "Owner-approved Claude namespace bootstrap is pending");
}

export function readClaudeConfiguration() {
  const options = { hideWarnings: true };
  const config = unstable_readConfig({ config: configPath }, options);
  const full = unstable_readConfig({ config: sharedPath }, options);
  const openai = unstable_readConfig({ config: sharedPath, env: "openai" }, options);
  return { config, sharedNamespaceIds: [...full.kv_namespaces, ...openai.kv_namespaces].map((namespace) => namespace.id) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { config, sharedNamespaceIds } = readClaudeConfiguration();
  const sourceOnly = process.argv.includes("--source-only");
  assertClaudeWorkerIsolation(config, sharedNamespaceIds, sourceOnly);
  console.log(sourceOnly ? "Claude source topology passes; deployment and hosted acceptance are not established" : "Claude deployment target isolation passes; hosted acceptance is not established");
}
