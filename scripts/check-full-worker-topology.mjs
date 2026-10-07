#!/usr/bin/env node
// Fail-closed topology gate for the full-profile Worker deploy. Sibling of
// check-openai-worker-topology.mjs (reused for the live Cloudflare projection);
// the OpenAI checker is not modified. See docs/full-topology-bootstrap.md.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareTopology, topologyFingerprint } from "./check-openai-worker-topology.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_CONFIG = `${ROOT}/workers/remote-mcp/wrangler.toml`;
const DEFAULT_CONTRACT = `${ROOT}/workers/remote-mcp/full-topology-baseline.json`;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stable(child)]));
  }
  return value;
};
const same = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));

function tables(toml, header, arrayTable = false) {
  const marker = arrayTable ? `[[${header}]]` : `[${header}]`;
  const lines = toml.split(/\r?\n/u);
  const bodies = [];
  lines.forEach((line, index) => {
    if (line.trim() !== marker) return;
    const end = lines.findIndex((next, cursor) => cursor > index && /^\s*\[\[?[^\]]+\]\]?\s*$/u.test(next));
    bodies.push(lines.slice(index + 1, end < 0 ? undefined : end).join("\n"));
  });
  return bodies;
}
const str = (body, key) => body.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"\\s*$`, "mu"))?.[1] ?? "";
const strList = (body, key) => [...(body.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, "mu"))?.[1] ?? "")
  .matchAll(/"([^"]+)"/gu)].map((match) => match[1]).sort();
const inline = (value) => [...value.matchAll(/\{([^}]*)\}/gu)].map((match) => Object.fromEntries(
  [...match[1].matchAll(/([a-z_]+)\s*=\s*"([^"]*)"/gu)].map((entry) => [entry[1], entry[2]])));

const keysOf = (body) => [...body.matchAll(/^([A-Za-z_][\w.-]*)\s*=/gmu)].map((match) => match[1]).sort();
const inlineKeys = (value) => [...value.matchAll(/\{([^}]*)\}/gu)]
  .map((match) => [...match[1].matchAll(/([a-z_]+)\s*=/gu)].map((entry) => entry[1]).sort());
const ROOT_KEYS = ["compatibility_date", "compatibility_flags", "main", "name", "routes"];
// Closed set of top-level tables and keys (r2_buckets, services, d1, ... are rejected).
// Limit: the parse is line-based regex over canonical TOML formatting. Indented keys,
// quoted keys inside tables and table headers with trailing comments are NOT detected.
// A follow-up issue tracks replacing it with Wrangler's own config reader.
// [env.openai*] tables belong to the OpenAI Worker's own gate.
const TABLES = new Set(["alias", "assets", "dev", "durable_objects", "kv_namespaces", "migrations",
  "observability", "vars"]);
const ENV_TABLES = new Set(["env.openai", "env.openai.assets", "env.openai.durable_objects",
  "env.openai.kv_namespaces", "env.openai.vars"]);

function configShapeIssues(toml, root) {
  const issues = [];
  const exact = (actual, expected, label) => {
    if (!same(actual, [...expected].sort())) issues.push(`${label}:FIELDS`);
  };
  exact(keysOf(root), ROOT_KEYS, "root");
  if (/^\s*["']/mu.test(root)) issues.push("root:QUOTED_KEY");
  for (const match of toml.matchAll(/^\s*\[\[?\s*([^\]\s]+)\s*\]\]?\s*$/gmu)) {
    if (!TABLES.has(match[1]) && !ENV_TABLES.has(match[1])) issues.push(`UNEXPECTED_SECTION:${match[1]}`);
  }
  tables(toml, "migrations", true).forEach((body) => exact(keysOf(body), ["new_sqlite_classes", "tag"], "migrations"));
  tables(toml, "kv_namespaces", true).forEach((body) => exact(keysOf(body), ["binding", "id"], "kv_namespaces"));
  tables(toml, "durable_objects").forEach((body) => {
    exact(keysOf(body), ["bindings"], "durable_objects");
    inlineKeys(body).forEach((keys) => exact(keys, ["class_name", "name"], "durable_objects.bindings"));
  });
  inlineKeys(root.match(/^routes\s*=\s*\[([^\]]*)\]/mu)?.[1] ?? "")
    .forEach((keys) => exact(keys, ["pattern", "zone_name"], "routes"));
  tables(toml, "assets").forEach((body) => exact(keysOf(body), ["binding", "directory"], "assets"));
  for (const header of ["assets", "durable_objects", "vars"]) {
    if (tables(toml, header).length !== 1) issues.push(`${header}:COUNT`);
  }
  return issues.sort();
}

// Top-level (default environment) topology only: [env.*] tables are other Workers.
export function deriveFullTargetTopology(toml) {
  const firstTable = toml.search(/^\s*\[/mu);
  const root = firstTable < 0 ? toml : toml.slice(0, firstTable);
  const byName = (key) => (left, right) => left[key].localeCompare(right[key]);
  return {
    workerName: str(root, "name"),
    entrypoint: str(root, "main"),
    compatibilityDate: str(root, "compatibility_date"),
    compatibilityFlags: strList(root, "compatibility_flags"),
    routes: inline(root.match(/^routes\s*=\s*\[([^\]]*)\]/mu)?.[1] ?? "")
      .map((route) => ({ pattern: route.pattern ?? "", zoneName: route.zone_name ?? "" })).sort(byName("pattern")),
    migrations: tables(toml, "migrations", true)
      .map((body) => ({ tag: str(body, "tag"), newSqliteClasses: strList(body, "new_sqlite_classes") })),
    durableObjects: inline(tables(toml, "durable_objects")[0] ?? "")
      .map((entry) => ({ binding: entry.name ?? "", className: entry.class_name ?? "" })).sort(byName("binding")),
    kvNamespaces: tables(toml, "kv_namespaces", true)
      .map((body) => ({ binding: str(body, "binding"), namespaceId: str(body, "id") })).sort(byName("binding")),
    assets: { binding: str(tables(toml, "assets")[0] ?? "", "binding"), directory: str(tables(toml, "assets")[0] ?? "", "directory") },
    vars: Object.fromEntries([...(tables(toml, "vars")[0] ?? "").matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"\s*$/gmu)]
      .map((match) => [match[1], match[2]])),
    configShapeIssues: configShapeIssues(toml, root),
  };
}

export function validateFullConfigAgainstContract(toml, contract) {
  const errors = [];
  const { configShapeIssues: shape, ...derived } = deriveFullTargetTopology(toml);
  errors.push(...shape);
  if ((tables(toml, "vars")[0] ?? "") && !same(keysOf(tables(toml, "vars")[0]), Object.keys(derived.vars).sort())) {
    errors.push("vars:FIELDS");
  }
  const { migrationTag: _tag, ...expected } = { workerName: contract?.workerName, ...contract?.targetTopology };
  if (!same(derived, expected)) errors.push("TARGET_TOPOLOGY_DRIFT");
  if (contract?.targetTopology?.migrationTag !== derived.migrations.at(-1)?.tag || !derived.migrations.length) {
    errors.push("TARGET_MIGRATION_TAG_DRIFT");
  }
  if (contract?.schemaVersion !== 1) errors.push("BASELINE_SCHEMA_UNSUPPORTED");
  if (!["pending-bootstrap", "established"].includes(contract?.status)) errors.push("BASELINE_STATUS_INVALID");
  if (contract?.status === "pending-bootstrap" && contract.baseline !== null) errors.push("PENDING_BASELINE_MUST_BE_EMPTY");
  if (contract?.recovery?.strategy !== "forward-only") errors.push("UNSAFE_RECOVERY_STRATEGY");
  return errors;
}

// The only way past "pending-bootstrap": an established baseline whose recorded
// live topology still equals the 100%-active Cloudflare version right now.
export function validateFullLiveAgainstBaseline(contract, { deploymentView, versionView }) {
  if (contract?.status !== "established") return ["BASELINE_PENDING_BOOTSTRAP"];
  const baseline = contract.baseline;
  if (!baseline || typeof baseline !== "object" || !baseline.topology) return ["BASELINE_MISSING"];
  const errors = [];
  if (!SHA256_PATTERN.test(baseline.topologySha256 ?? "") ||
    baseline.topologySha256 !== topologyFingerprint(baseline.topology)) errors.push("BASELINE_FINGERPRINT_INVALID");
  const live = cloudflareTopology(versionView);
  if (!live.migrationTag || live.migrationTag !== contract.targetTopology?.migrationTag) errors.push("LIVE_MIGRATION_TAG_MISMATCH");
  if (!same(live, baseline.topology)) errors.push("LIVE_TOPOLOGY_ANCHOR_MISMATCH");
  const versions = deploymentView?.versions;
  if (!Array.isArray(versions) || versions.length !== 1 || versions[0]?.percentage !== 100 ||
    !versionView?.id || versions[0]?.version_id !== versionView.id) errors.push("LIVE_DEPLOYMENT_NOT_SINGLE_ACTIVE_VERSION");
  return errors;
}

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredJson(flag, errors) {
  try {
    const value = JSON.parse(readFileSync(arg(flag), "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) return value;
  } catch { /* falls through */ }
  errors.push(`INPUT_INVALID:${flag}`);
  return {};
}

function runCli() {
  const errors = [];
  let contract = {};
  try {
    contract = JSON.parse(readFileSync(arg("--contract") ?? DEFAULT_CONTRACT, "utf8"));
    errors.push(...validateFullConfigAgainstContract(readFileSync(arg("--config") ?? DEFAULT_CONFIG, "utf8"), contract));
  } catch {
    errors.push("CONTRACT_OR_CONFIG_UNREADABLE");
  }
  if (process.argv.includes("--require-established")) {
    if (contract?.status !== "established") errors.push("BASELINE_PENDING_BOOTSTRAP");
  }
  if (process.argv.includes("--require-live-match")) {
    errors.push(...validateFullLiveAgainstBaseline(contract, {
      deploymentView: requiredJson("--active-deployment", errors), versionView: requiredJson("--live-version", errors),
    }));
  }
  if (errors.length) {
    console.error(`Full Worker topology gate: BLOCK (${[...new Set(errors)].join(", ")})`);
    process.exitCode = 1;
    return;
  }
  console.log(`Full Worker topology gate: PASS (${contract.status})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runCli();
