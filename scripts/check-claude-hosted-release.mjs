#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

const RELEASE_RECEIPT_KIND = "frihet-production-firebase-release-receipt";
const WRITE_ROUTE_FIXTURE = fileURLToPath(new URL("../src/__tests__/fixtures/claude-write-route-contract.json", import.meta.url));

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

/** The method + route templates listed in Frihet-ERP functions/src/publicApi/claudeWriteRoutes.ts. */
export function erpCeilingRoutes(source) {
  const list = source.match(/export const CLAUDE_WRITE_ROUTES\b[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/u);
  assert.ok(list, "claudeWriteRoutes.ts has no CLAUDE_WRITE_ROUTES list");
  return [...list[1].matchAll(/'([^'\n]*)'/gu)].map((match) => match[1]);
}

/**
 * Deploy prerequisite: the ERP write-route ceiling for keys stored with
 * accessProfile "claude" was deployed. `receipt` is the Frihet-ERP Firebase
 * production release receipt that deployed `publicApi`; `erpRoot` is a local
 * Frihet-ERP checkout holding its source commit. The receipt must be a finalized
 * deploy whose digest verifies, whose functions tree is the tree of its source
 * commit, and which records a post-verified publicApi deploy. At that commit,
 * publicApi.ts must reference `isClaudeWriteRouteAllowed(` (a text check) and
 * claudeWriteRoutes.ts must list exactly the routes of the committed Claude
 * contract fixture. A receipt proves that a release deployed the ceiling, not
 * that no later release replaced publicApi: pass the latest release that
 * deployed it.
 */
export function assertErpCeilingDeployed(receipt, erpRoot, contractRoutes) {
  assert.equal(receipt?.schemaVersion, 1, "ERP release receipt schema");
  assert.equal(receipt.kind, RELEASE_RECEIPT_KIND, "ERP release receipt kind");
  assert.equal(receipt.operation, "deploy", "ERP release receipt operation");
  assert.equal(receipt.status, "deployed", "ERP release receipt status");
  const { receiptSha256, ...unsigned } = receipt;
  assert.equal(receiptSha256, createHash("sha256").update(JSON.stringify(stable(unsigned))).digest("hex"), "ERP release receipt digest");
  assert.ok(
    (receipt.functions?.mutations ?? []).some((mutation) =>
      mutation?.target === "publicApi"
      && (mutation.action === "UPDATE" || mutation.action === "CREATE")
      && mutation.after?.presence === "present"
      && typeof mutation.candidateSourceSha256 === "string"
      && mutation.after.sourceSha256 === mutation.candidateSourceSha256),
    "ERP release receipt records no post-verified publicApi deploy",
  );
  assert.match(receipt.sourceSha ?? "", /^[0-9a-f]{40}$/u, "ERP release receipt source commit");
  const git = (...args) => execFileSync("git", ["-C", erpRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(git("rev-parse", `${receipt.sourceSha}:functions`).trim(), receipt.functionsTree, "ERP release receipt functions tree");
  assert.ok(
    git("show", `${receipt.sourceSha}:functions/src/publicApi.ts`).includes("isClaudeWriteRouteAllowed("),
    "publicApi.ts at the deployed commit does not reference the Claude ceiling",
  );
  assert.deepEqual(
    erpCeilingRoutes(git("show", `${receipt.sourceSha}:functions/src/publicApi/claudeWriteRoutes.ts`)),
    contractRoutes,
    "deployed ERP ceiling routes differ from the Claude contract fixture",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { config, sharedNamespaceIds } = readClaudeConfiguration();
  const sourceOnly = process.argv.includes("--source-only");
  assertClaudeWorkerIsolation(config, sharedNamespaceIds, sourceOnly);
  if (!sourceOnly) {
    const { FRIHET_ERP_ROOT: erpRoot, FRIHET_ERP_RELEASE_RECEIPT: receiptPath } = process.env;
    assert.ok(erpRoot && receiptPath, "Set FRIHET_ERP_ROOT and FRIHET_ERP_RELEASE_RECEIPT: the ERP Claude ceiling must be deployed first");
    const { routes } = JSON.parse(readFileSync(WRITE_ROUTE_FIXTURE, "utf8"));
    assertErpCeilingDeployed(JSON.parse(readFileSync(receiptPath, "utf8")), erpRoot, routes);
  }
  console.log(sourceOnly ? "Claude source topology passes; deployment and hosted acceptance are not established" : "Claude deployment target isolation and the ERP ceiling receipt pass; hosted acceptance is not established");
}
