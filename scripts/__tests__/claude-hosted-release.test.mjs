import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertClaudeWorkerIsolation,
  assertErpCeilingDeployed,
  erpCeilingRoutes,
  readClaudeConfiguration,
} from "../check-claude-hosted-release.mjs";

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

const { routes: CONTRACT_ROUTES } = JSON.parse(readFileSync(new URL("../../src/__tests__/fixtures/claude-write-route-contract.json", import.meta.url), "utf8"));

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function signed(receipt) {
  const { receiptSha256: _ignored, ...unsigned } = receipt;
  return { ...unsigned, receiptSha256: createHash("sha256").update(JSON.stringify(stable(unsigned))).digest("hex") };
}

/** A throwaway ERP checkout with one commit, plus the release receipt that deployed it. */
function erpRelease({ routes = CONTRACT_ROUTES, wired = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "erp-ceiling-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  mkdirSync(join(root, "functions/src/publicApi"), { recursive: true });
  writeFileSync(join(root, "functions/src/publicApi.ts"), wired
    ? "if (!isClaudeWriteRouteAllowed(req.method, pathParts)) deny();\n"
    : "import { isClaudeWriteRouteAllowed } from './publicApi/claudeWriteRoutes';\n");
  writeFileSync(join(root, "functions/src/publicApi/claudeWriteRoutes.ts"), [
    "/** Mentions CLAUDE_WRITE_ROUTES.join('\\n') before the list. */",
    "export const CLAUDE_WRITE_ROUTES: ReadonlyArray<string> = Object.freeze([",
    ...routes.map((route) => `  '${route}',`),
    "]);",
    "",
  ].join("\n"));
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "release");
  const sourceSha = git("rev-parse", "HEAD");
  const receipt = signed({
    schemaVersion: 1,
    kind: "frihet-production-firebase-release-receipt",
    status: "deployed",
    operation: "deploy",
    sourceSha,
    functionsTree: git("rev-parse", "HEAD:functions"),
    functions: {
      mutations: [{
        target: "publicApi",
        region: "europe-west1",
        action: "UPDATE",
        candidateSourceSha256: "a".repeat(64),
        after: { presence: "present", sourceSha256: "a".repeat(64) },
      }],
    },
  });
  return { root, receipt, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("ERP route list parsing reads only the exported ceiling list", () => {
  assert.deepEqual(erpCeilingRoutes([
    "// CLAUDE_WRITE_ROUTES = 'not this'",
    "export const CLAUDE_WRITE_ROUTES: ReadonlyArray<string> = Object.freeze([",
    "  'DELETE /a/:id',",
    "  'POST /b',",
    "]);",
  ].join("\n")), ["DELETE /a/:id", "POST /b"]);
  assert.throws(() => erpCeilingRoutes("const unrelated = [];"), /no CLAUDE_WRITE_ROUTES list/u);
});

test("Claude deploy requires a verified ERP release receipt that deployed the matching ceiling", () => {
  const release = erpRelease();
  try {
    assert.doesNotThrow(() => assertErpCeilingDeployed(release.receipt, release.root, CONTRACT_ROUTES));
    for (const [label, mutate, pattern] of [
      ["kind", (r) => signed({ ...r, kind: "other-receipt" }), /receipt kind/u],
      ["status", (r) => signed({ ...r, status: "in_progress" }), /receipt status/u],
      ["operation", (r) => signed({ ...r, operation: "rollback" }), /receipt operation/u],
      ["digest", (r) => ({ ...r, status: "deployed", sourceSha: r.sourceSha, functionsTree: "0".repeat(40) }), /receipt digest/u],
      ["no publicApi", (r) => signed({ ...r, functions: { mutations: [{ ...r.functions.mutations[0], target: "otherFunction" }] } }), /no post-verified publicApi deploy/u],
      ["unverified source", (r) => signed({ ...r, functions: { mutations: [{ ...r.functions.mutations[0], after: { presence: "present", sourceSha256: "b".repeat(64) } }] } }), /no post-verified publicApi deploy/u],
      ["tree", (r) => signed({ ...r, functionsTree: "0".repeat(40) }), /functions tree/u],
      ["unknown commit", (r) => signed({ ...r, sourceSha: "f".repeat(40) }), /./u],
    ]) {
      assert.throws(() => assertErpCeilingDeployed(mutate(release.receipt), release.root, CONTRACT_ROUTES), pattern, label);
    }
  } finally {
    release.cleanup();
  }

  for (const [label, options, pattern] of [
    ["unwired publicApi", { wired: false }, /does not reference the Claude ceiling/u],
    ["route drift", { routes: CONTRACT_ROUTES.slice(1) }, /differ from the Claude contract fixture/u],
  ]) {
    const drifted = erpRelease(options);
    try {
      assert.throws(() => assertErpCeilingDeployed(drifted.receipt, drifted.root, CONTRACT_ROUTES), pattern, label);
    } finally {
      drifted.cleanup();
    }
  }
});
