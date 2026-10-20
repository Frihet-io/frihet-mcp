#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unstable_readConfig } from "../workers/remote-mcp/node_modules/wrangler/wrangler-dist/cli.js";
import { CLAUDE_ERP_RECEIPT_KIND, verifyClaudeErpSourceRelease } from "./verify-claude-erp-source-release.mjs";

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
const ERP_PROJECT = "gen-lang-client-0335716041";
const ERP_REGION = "europe-west1";
const WRITE_ROUTE_FIXTURE = fileURLToPath(new URL("../src/__tests__/fixtures/claude-write-route-contract.json", import.meta.url));
const CANDIDATE_FIXTURE = fileURLToPath(new URL("../src/__tests__/fixtures/claude-candidate-contract.json", import.meta.url));
const CREDENTIAL_CEILING_SHA256 = "bcf2185915523c60468afc380d1e2456a5c0da5cb2ca4b4820e74886b06b928f";

/** Product scope and pilot admission are separate. This proves source scope only. */
export function assertClaudeOperationalSurface(candidate, ceiling) {
  const names = (tools) => tools.map(({ name }) => name).sort();
  const full = candidate.tools.full;
  const grouped = candidate.tools.grouped;
  const aliases = Object.keys(candidate.catalogue.aliases);
  const canonical = full.filter(({ name }) => !aliases.includes(name));
  assert.equal(candidate.catalogue.canonicalOperations, 125);
  assert.equal(canonical.length, 125);
  assert.equal(new Set(names(full)).size, full.length, "duplicate tool names");
  assert.equal(aliases.length, 4);
  assert.deepEqual(names(grouped), [...names(full), "describe_tool", "list_tool_groups", "search_tools"].sort());
  assert.equal(candidate.groups.totalTools, 125);
  assert.equal(candidate.groups.totalGroups, 11);
  assert.equal(candidate.groups.groups.reduce((sum, group) => sum + group.toolCount, 0), 125);
  assert.equal(Object.keys(candidate.exclusions.tools).length, 31);
  for (const tool of grouped) {
    assert.ok(tool.title?.trim(), `${tool.name} needs a title`);
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assert.equal(typeof tool.annotations?.[hint], "boolean", `${tool.name}.${hint}`);
    }
    if (!tool.annotations.readOnlyHint) {
      assert.equal(tool.annotations.destructiveHint, true, `${tool.name} must require Claude write confirmation`);
    }
    assert.ok(!(tool.name in candidate.exclusions.tools), `${tool.name} is excluded`);
    const capability = tool._meta?.["io.frihet/capability"];
    assert.ok(capability, `${tool.name} needs capability metadata`);
    assert.ok(!["deferred", "unavailable"].includes(capability.callability), `${tool.name} is not callable`);
    assert.ok(!capability.externalSideEffects.includes("money_movement"), `${tool.name} transfers funds`);
  }
  assert.deepEqual(full.filter((tool) => !tool.annotations.readOnlyHint).map(({ name }) => name).sort(), Object.keys(ceiling.tools).sort(), "operational writes must match the existing ERP credential ceiling");
  for (const [alias, target] of Object.entries(candidate.catalogue.aliases)) {
    assert.ok(canonical.some(({ name }) => name === target), `${alias} lacks its canonical operation`);
    assert.ok(full.some(({ name }) => name === alias), `${alias} is missing`);
  }
  for (const kind of ["local", "remote"]) assert.deepEqual(candidate.resources[kind].map(({ uri }) => uri), ["frihet://config/currencies"]);
  assert.deepEqual(names(candidate.prompts), ["invoice-aging-review", "overdue-followup"]);
  assert.deepEqual(names(candidate.promptContent), names(candidate.prompts));
  assert.equal(ceiling.sha256, CREDENTIAL_CEILING_SHA256);
  assert.equal(createHash("sha256").update(ceiling.routes.join("\n")).digest("hex"), CREDENTIAL_CEILING_SHA256);
}

// Historical nine-tool contract: retained for old receipts and offline tests.
const CONSULTATION_CORE = Object.freeze(["list_clients", "list_expenses", "list_invoices", "list_products", "list_quotes", "list_vendors"]);
const CONSULTATION_DISCOVERY = Object.freeze(["describe_tool", "list_tool_groups", "search_tools"]);

/** The served surface is a separate exact contract, never a replacement ERP ceiling. */
export function assertClaudeConsultationSurface(candidate, served) {
  const tools = Object.fromEntries([...CONSULTATION_CORE, ...CONSULTATION_DISCOVERY].sort().map((name) => [name,
    CONSULTATION_CORE.includes(name) ? [`GET /${name.slice("list_".length)}`] : []]));
  const routes = Object.values(tools).flat().sort();
  assert.deepEqual(served, {
    schemaVersion: 1, kind: "frihet-claude-consultation-served-route-contract", accessProfile: "claude",
    sha256: createHash("sha256").update(routes.join("\n")).digest("hex"), routes, tools,
    resources: ["frihet://config/currencies"], prompts: [],
  }, "served Claude route contract must be the exact six GET handlers and three discovery handlers");
  const names = (descriptors) => descriptors.map((tool) => tool.name).sort();
  assert.deepEqual(names(candidate.tools.full), [...CONSULTATION_CORE], "Claude full surface differs from the consultation core");
  assert.deepEqual(names(candidate.tools.grouped), Object.keys(tools), "Claude grouped surface differs from the nine consultation tools");
  for (const descriptor of [...candidate.tools.full, ...candidate.tools.grouped]) {
    assert.equal(descriptor.annotations?.readOnlyHint, true, `${descriptor.name} must be read-only`);
    assert.equal(descriptor.annotations?.destructiveHint, false, `${descriptor.name} must not be destructive`);
  }
  assert.deepEqual(candidate.prompts, [], "consultation must register no prompts");
  assert.deepEqual(candidate.promptContent, [], "consultation must retain no prompt handlers");
  for (const kind of ["local", "remote"]) assert.deepEqual(candidate.resources[kind].map((resource) => resource.uri), served.resources, `${kind} resource surface`);
  assert.equal(candidate.groups.totalTools, 6, "discovery must describe only six core operations");
  assert.equal(candidate.catalogue.canonicalOperations, 6);
  assert.deepEqual(candidate.catalogue.aliases, {}, "consultation must expose no fiscal aliases");
}

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
 * direct-source deploy whose digest verifies, whose functions tree is the tree
 * of its source commit, and which records a post-verified publicApi deploy in
 * the exact production project/region. Restricted releases with a runtimeSource
 * recipe are not accepted: their sourceSha identifies control code, not the
 * assembled deployed artifact, which requires a separate artifact verifier.
 * At the direct-source commit,
 * publicApi.ts must reference `isClaudeWriteRouteAllowed(` (a text check) and
 * claudeWriteRoutes.ts must list exactly the routes of the frozen credential
 * ceiling fixture. The operational Claude write set must match this existing
 * ceiling; source scope never claims backend credential revocation.
 * A receipt proves that a release deployed the ceiling, not
 * that no later release replaced publicApi: pass the latest release that
 * deployed it.
 */
export function assertErpCeilingDeployed(receipt, erpRoot, contractRoutes) {
  assert.equal(receipt?.schemaVersion, 1, "ERP release receipt schema");
  assert.equal(receipt.kind, RELEASE_RECEIPT_KIND, "ERP release receipt kind");
  assert.equal(receipt.operation, "deploy", "ERP release receipt operation");
  assert.equal(receipt.status, "deployed", "ERP release receipt status");
  assert.equal(receipt.project, ERP_PROJECT, "ERP release receipt project");
  const { receiptSha256, ...unsigned } = receipt;
  assert.equal(receiptSha256, createHash("sha256").update(JSON.stringify(stable(unsigned))).digest("hex"), "ERP release receipt digest");
  // receiptBase emits none of these fields for direct-source releases. The
  // p0-fiscal-source-20260930 variant instead assembles a runtime recipe, even
  // when its build.repositorySha happens to equal its control sourceSha.
  assert.ok(
    !["runtimeSource", "scope", "target"].some((key) => Object.hasOwn(receipt, key)),
    "ERP release receipt runtime provenance requires a direct-source release; split runtime recipes are not verified",
  );
  assert.match(receipt.functions?.candidate?.sha256 ?? "", /^[0-9a-f]{64}$/u, "ERP release receipt candidate artifact digest");
  assert.ok(
    (receipt.functions?.mutations ?? []).some((mutation) =>
      mutation?.target === "publicApi"
      && mutation.region === ERP_REGION
      && (mutation.action === "UPDATE" || mutation.action === "CREATE")
      && mutation.after?.presence === "present"
      && mutation.candidateSourceSha256 === receipt.functions.candidate.sha256
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

/** Authenticate the dedicated hybrid lane; other runtime recipes remain refused. */
export async function verifyErpCeilingDeployed(receipt, erpRoot, contractRoutes, options) {
  if (receipt?.kind !== CLAUDE_ERP_RECEIPT_KIND) {
    assertErpCeilingDeployed(receipt, erpRoot, contractRoutes);
    return;
  }
  const source = await verifyClaudeErpSourceRelease(receipt, erpRoot, options);
  assert.ok(source.publicApiSource.includes("isClaudeWriteRouteForbidden(apiKeyAccessProfile, req.method, pathParts)"), "Rebuilt publicApi does not enforce the Claude ceiling");
  assert.deepEqual(erpCeilingRoutes(source.ceilingSource), contractRoutes, "Rebuilt ERP ceiling routes differ from the Claude contract fixture");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { config, sharedNamespaceIds } = readClaudeConfiguration();
  const sourceOnly = process.argv.includes("--source-only");
  assertClaudeWorkerIsolation(config, sharedNamespaceIds, sourceOnly);
  const ceiling = JSON.parse(readFileSync(WRITE_ROUTE_FIXTURE, "utf8"));
  assertClaudeOperationalSurface(JSON.parse(readFileSync(CANDIDATE_FIXTURE, "utf8")), ceiling);
  assert.equal(ceiling.sha256, CREDENTIAL_CEILING_SHA256, "historical ERP credential ceiling digest must remain unchanged");
  assert.equal(createHash("sha256").update(ceiling.routes.join("\n")).digest("hex"), CREDENTIAL_CEILING_SHA256, "historical ERP credential ceiling routes must remain unchanged");
  if (!sourceOnly) {
    const { FRIHET_ERP_ROOT: erpRoot, FRIHET_ERP_RELEASE_RECEIPT: receiptPath } = process.env;
    assert.ok(erpRoot && receiptPath, "Set FRIHET_ERP_ROOT and FRIHET_ERP_RELEASE_RECEIPT: the ERP Claude ceiling must be deployed first");
    await verifyErpCeilingDeployed(JSON.parse(readFileSync(receiptPath, "utf8")), erpRoot, ceiling.routes);
  }
  console.log(sourceOnly ? "Claude source topology passes; deployment and hosted acceptance are not established" : "Claude deployment target isolation and the ERP ceiling receipt pass; hosted acceptance is not established");
}
