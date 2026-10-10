import assert from "node:assert/strict";
import { test } from "node:test";
import { assertClaudeWorkerIsolation, readClaudeConfiguration } from "../check-claude-hosted-release.mjs";

test("source config isolates Claude and refuses deployment before namespace bootstrap", () => {
  const { config, sharedNamespaceIds } = readClaudeConfiguration();
  assert.doesNotThrow(() => assertClaudeWorkerIsolation(config, sharedNamespaceIds, true));
  assert.throws(() => assertClaudeWorkerIsolation(config, sharedNamespaceIds), /bootstrap is pending/u);
  for (const mutate of [
    (c) => { c.name = "frihet-remote-mcp"; },
    (c) => { c.routes[0].pattern = "mcp.frihet.io/*"; },
    (c) => { c.vars.FRIHET_OPENAI_MODE = "true"; },
    (c) => { c.vars.FRIHET_CLAUDE_MODE = "false"; },
    (c) => { c.workers_dev = true; },
    (c) => { c.preview_urls = true; },
    (c) => { delete c.alias["@cloudflare/workers-oauth-provider"]; },
    (c) => { c.build.command = "echo skipped"; },
    (c) => { c.durable_objects.bindings[0].script_name = "frihet-remote-mcp"; },
    (c) => { c.kv_namespaces[0].id = sharedNamespaceIds[0]; },
    (c) => { c.kv_namespaces[0].id = sharedNamespaceIds[1]; },
  ]) {
    const candidate = structuredClone(config);
    mutate(candidate);
    assert.throws(() => assertClaudeWorkerIsolation(candidate, sharedNamespaceIds, true));
  }
});
