#!/usr/bin/env node
// Fail-closed topology gate for the full-profile Worker deploy. Sibling of
// check-openai-worker-topology.mjs (reused for the live Cloudflare projection);
// the OpenAI checker is not modified. See docs/full-topology-bootstrap.md.
//
// The Worker config is parsed with the Worker-locked Wrangler's own offline
// reader (`experimental_readRawConfig`) run on a COPY of the file in a temp dir,
// so keys, tables, migrations and bindings are read with Wrangler's TOML and
// raw-config semantics. That is not a proof of what Wrangler resolves at deploy
// time: which file Wrangler reads is pinned separately (`--config wrangler.toml`
// in the workflow plus the redirect-file test). The previous line-based regex
// parse disagreed with Wrangler on indented keys, quoted keys and table headers
// with trailing comments. The reader is resolved ONLY from
// workers/remote-mcp/node_modules (never from an ancestor directory), so the
// version that parses is the version package-lock.json pins; when it is not
// installed the gate blocks (CONFIG_UNREADABLE), it never falls back to a parse
// of its own.

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTopology, topologyFingerprint } from "./check-openai-worker-topology.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKER_DIR = join(ROOT, "workers", "remote-mcp");
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
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keysOf = (value) => (isObject(value) ? Object.keys(value).sort() : []);
const list = (value) => (Array.isArray(value) ? value : []);

let readRawConfig;
function wranglerReader() {
  if (readRawConfig) return readRawConfig;
  const requireFromWorker = createRequire(join(WORKER_DIR, "package.json"));
  let resolved;
  try {
    resolved = requireFromWorker.resolve("wrangler");
  } catch {
    throw new Error("WRANGLER_READER_UNAVAILABLE: run npm ci in workers/remote-mcp");
  }
  if (!resolved.startsWith(join(WORKER_DIR, "node_modules") + sep)) {
    throw new Error("WRANGLER_READER_NOT_WORKER_LOCKED");
  }
  const reader = requireFromWorker("wrangler").experimental_readRawConfig;
  if (typeof reader !== "function") throw new Error("WRANGLER_READER_UNAVAILABLE: experimental_readRawConfig missing");
  readRawConfig = reader;
  return readRawConfig;
}

// Wrangler resolves its config from a path, so the string entry points write the
// TOML to a private temp dir and read it back through the same reader.
function parseToml(toml) {
  const read = wranglerReader();
  const dir = mkdtempSync(join(tmpdir(), "full-topology-"));
  try {
    const path = join(dir, "wrangler.toml");
    writeFileSync(path, toml, "utf8");
    const { rawConfig } = read({ config: path });
    if (!isObject(rawConfig)) throw new Error("WRANGLER_CONFIG_NOT_AN_OBJECT");
    return rawConfig;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Allowlist of top-level tables and keys (r2_buckets, services, d1, ... are rejected).
// [alias], [observability] and [dev] are compared for EXACT content below: an alias
// redirects modules inside the production bundle, so it is part of the contract.
const EXPECTED_ALIAS = {
  zod: "../../node_modules/zod",
  "zod/v4": "../../node_modules/zod/v4",
  "zod/v4-mini": "../../node_modules/zod/v4-mini",
  "zod/v4/core": "../../node_modules/zod/v4/core",
};
const EXPECTED_OBSERVABILITY = { enabled: true };
const EXPECTED_DEV = { port: 8788 };
const ROOT_KEYS = ["compatibility_date", "compatibility_flags", "main", "name", "routes"];
const TABLES = new Set(["alias", "assets", "dev", "durable_objects", "kv_namespaces", "migrations",
  "observability", "vars"]);
// [env.openai*] is the OpenAI Worker's own gate; here only its table SET is closed.
// Any other [env.*], or an unreviewed binding table inside env.openai, is drift.
const ENV_NAMES = new Set(["openai"]);
const ENV_OPENAI_TABLES = new Set(["assets", "durable_objects", "kv_namespaces", "vars"]);
const ENV_OPENAI_NON_TABLE_OBJECT_KEYS = new Set(["routes"]);

function configShapeIssues(config) {
  const issues = [];
  const exact = (actual, expected, label) => {
    if (!same([...actual].sort(), [...expected].sort())) issues.push(`${label}:FIELDS`);
  };
  exact(Object.keys(config).filter((key) => !TABLES.has(key) && key !== "env"), ROOT_KEYS, "root");
  for (const key of Object.keys(config)) {
    if (key !== "env" && !TABLES.has(key) && !ROOT_KEYS.includes(key)) issues.push(`UNEXPECTED_SECTION:${key}`);
  }
  if ("env" in config && !isObject(config.env)) issues.push("env:SHAPE");
  for (const [name, body] of Object.entries(isObject(config.env) ? config.env : {})) {
    if (!ENV_NAMES.has(name) || !isObject(body)) {
      issues.push(`UNEXPECTED_SECTION:env.${name}`);
      continue;
    }
    for (const [key, value] of Object.entries(body)) {
      const tableLike = isObject(value) || list(value).some(isObject);
      if (tableLike && !ENV_OPENAI_TABLES.has(key) && !ENV_OPENAI_NON_TABLE_OBJECT_KEYS.has(key)) {
        issues.push(`UNEXPECTED_SECTION:env.${name}.${key}`);
      }
    }
  }
  const asTable = (key) => {
    if (!(key in config)) return undefined;
    if (!isObject(config[key])) { issues.push(`${key}:COUNT`); return undefined; }
    return config[key];
  };
  const asArrayTable = (key) => {
    if (!(key in config)) return [];
    if (!Array.isArray(config[key]) || !config[key].every(isObject)) { issues.push(`${key}:SHAPE`); return []; }
    return config[key];
  };
  asArrayTable("migrations").forEach((body) => exact(keysOf(body), ["new_sqlite_classes", "tag"], "migrations"));
  asArrayTable("kv_namespaces").forEach((body) => exact(keysOf(body), ["binding", "id"], "kv_namespaces"));
  const durable = asTable("durable_objects");
  if (durable) {
    exact(keysOf(durable), ["bindings"], "durable_objects");
    list(durable.bindings).forEach((binding) => exact(keysOf(binding), ["class_name", "name"], "durable_objects.bindings"));
  }
  list(config.routes).forEach((route) => exact(keysOf(route), ["pattern", "zone_name"], "routes"));
  const assets = asTable("assets");
  if (assets) exact(keysOf(assets), ["binding", "directory"], "assets");
  if (!same(config.alias, EXPECTED_ALIAS)) issues.push("alias:DRIFT");
  if (!same(config.observability, EXPECTED_OBSERVABILITY)) issues.push("observability:DRIFT");
  if (!same(config.dev, EXPECTED_DEV)) issues.push("dev:DRIFT");
  const vars = asTable("vars");
  if (vars && Object.values(vars).some((value) => typeof value !== "string")) issues.push("vars:FIELDS");
  for (const header of ["assets", "durable_objects", "vars"]) {
    if (!(header in config)) issues.push(`${header}:COUNT`);
  }
  return issues.sort();
}

// Top-level (default environment) topology only: [env.*] tables are other Workers.
export function deriveFullTargetTopology(toml) {
  const config = parseToml(toml);
  const byName = (key) => (left, right) => String(left[key]).localeCompare(String(right[key]));
  const text = (value) => (typeof value === "string" ? value : "");
  const strings = (value) => list(value).filter((entry) => typeof entry === "string").sort();
  return {
    workerName: text(config.name),
    entrypoint: text(config.main),
    compatibilityDate: text(config.compatibility_date),
    compatibilityFlags: strings(config.compatibility_flags),
    routes: list(config.routes).filter(isObject)
      .map((route) => ({ pattern: text(route.pattern), zoneName: text(route.zone_name) })).sort(byName("pattern")),
    migrations: list(config.migrations).filter(isObject)
      .map((body) => ({ tag: text(body.tag), newSqliteClasses: strings(body.new_sqlite_classes) })),
    durableObjects: list(config.durable_objects?.bindings).filter(isObject)
      .map((entry) => ({ binding: text(entry.name), className: text(entry.class_name) })).sort(byName("binding")),
    kvNamespaces: list(config.kv_namespaces).filter(isObject)
      .map((body) => ({ binding: text(body.binding), namespaceId: text(body.id) })).sort(byName("binding")),
    assets: { binding: text(config.assets?.binding), directory: text(config.assets?.directory) },
    vars: Object.fromEntries(Object.entries(isObject(config.vars) ? config.vars : {})
      .filter(([, value]) => typeof value === "string")),
    configShapeIssues: configShapeIssues(config),
  };
}

export function validateFullConfigAgainstContract(toml, contract) {
  const errors = [];
  let derived;
  try {
    derived = deriveFullTargetTopology(toml);
  } catch (error) {
    return [`CONFIG_UNREADABLE:${String(error?.message ?? error).split("\n")[0]}`];
  }
  const { configShapeIssues: shape, ...target } = derived;
  errors.push(...shape);
  const { migrationTag: _tag, ...expected } = { workerName: contract?.workerName, ...contract?.targetTopology };
  if (!same(target, expected)) errors.push("TARGET_TOPOLOGY_DRIFT");
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
export function validateFullLiveAgainstBaseline(contract, { deploymentView, versionView, durableObjectNamespacesView }) {
  if (contract?.status !== "established") return ["BASELINE_PENDING_BOOTSTRAP"];
  const baseline = contract.baseline;
  if (!baseline || typeof baseline !== "object" || !baseline.topology) return ["BASELINE_MISSING"];
  const errors = [];
  if (!SHA256_PATTERN.test(baseline.topologySha256 ?? "") ||
    baseline.topologySha256 !== topologyFingerprint(baseline.topology)) errors.push("BASELINE_FINGERPRINT_INVALID");
  const live = cloudflareTopology(versionView, { durableObjectNamespacesView, workerName: contract.workerName });
  if (live.unexpectedExports.length) errors.push("LIVE_EXPORT_PROJECTION_UNVERIFIED");
  if (Object.hasOwn(versionView?.resources?.script ?? {}, "named_handlers")) {
    const exports = (contract.targetTopology?.durableObjects ?? [])
      .map(({ className }) => ({ className, state: "created", storage: "sqlite" }))
      .sort((left, right) => left.className.localeCompare(right.className));
    if (!same(live.workerEntrypoints, ["default"]) || !same(live.durableObjectExports, exports)) {
      errors.push("LIVE_EXPORT_PROJECTION_UNVERIFIED");
    }
  }
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
      durableObjectNamespacesView: arg("--durable-object-namespaces")
        ? requiredJson("--durable-object-namespaces", errors) : undefined,
    }));
  }
  if (errors.length) {
    console.error(`Full Worker topology gate: BLOCK (${[...new Set(errors)].join(", ")})`);
    process.exitCode = 1;
    return;
  }
  console.log(`Full Worker topology gate: PASS (${contract.status})`);
}

// Compare real paths: invoked through a symlink (a /var -> /private/var temp dir, a
// linked worktree) the gate used to match nothing, run nothing and exit 0.
// If argv[1] cannot be resolved the invocation cannot be matched to this file: that is a
// BLOCK (exit 1), never a silent exit 0.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    console.error("Full Worker topology gate: BLOCK (INVOCATION_PATH_UNRESOLVABLE)");
    process.exitCode = 1;
    return false;
  }
}
if (isMainModule()) runCli();
