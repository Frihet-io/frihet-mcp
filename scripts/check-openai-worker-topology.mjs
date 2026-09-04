#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_CONFIG = `${ROOT}/workers/remote-mcp/wrangler.toml`;
const DEFAULT_CONTRACT = `${ROOT}/marketplace/openai/cloudflare-topology-baseline.json`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ROUTE_ID_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const ACCOUNT_PATTERN = /^[0-9a-f]{32}$/u;
const NAMESPACE_PATTERN = /^[0-9a-f]{32}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const CLOCK_SKEW_MS = 5_000;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export function topologyFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function textFingerprint(value) {
  return createHash("sha256").update(value).digest("hex");
}

function tableBodies(toml, header, arrayTable = false) {
  const marker = arrayTable ? `[[${header}]]` : `[${header}]`;
  const lines = toml.split(/\r?\n/u);
  const bodies = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== marker) continue;
    const body = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^\s*\[\[?[^\]]+\]\]?\s*$/u.test(lines[cursor])) break;
      body.push(lines[cursor]);
    }
    bodies.push(body.join("\n"));
  }
  return bodies;
}

function section(toml, header, arrayTable = false) {
  return tableBodies(toml, header, arrayTable)[0] ?? "";
}

function stringValue(body, key) {
  return body.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"\\s*$`, "mu"))?.[1] ?? "";
}

function booleanValue(body, key) {
  const value = body.match(new RegExp(`^${key}\\s*=\\s*(true|false)\\s*$`, "mu"))?.[1];
  return value === undefined ? null : value === "true";
}

function stringArrayValue(body, key) {
  const raw = body.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]\\s*$`, "mu"))?.[1];
  return raw === undefined ? [] : [...raw.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

function inlineObjects(value) {
  return [...value.matchAll(/\{([^}]*)\}/gu)].map((match) => Object.fromEntries(
    [...match[1].matchAll(/([a-z_]+)\s*=\s*"([^"]*)"/gu)].map((entry) => [entry[1], entry[2]]),
  ));
}

function inlineObjectAssignmentKeys(value) {
  return [...value.matchAll(/\{([^}]*)\}/gu)].map((match) =>
    [...match[1].matchAll(/([a-z_]+)\s*=/gu)].map((entry) => entry[1]).sort());
}

function objectEntries(value) {
  return inlineObjects(value)
    .map((entry) => ({ binding: entry.name ?? "", className: entry.class_name ?? "" }))
    .sort((left, right) => left.binding.localeCompare(right.binding));
}

function inlineRoutes(body) {
  const raw = body.match(/^routes\s*=\s*\[([^\]]*)\]\s*$/mu)?.[1] ?? "";
  return inlineObjects(raw)
    .map((entry) => ({ pattern: entry.pattern ?? "", zoneName: entry.zone_name ?? "" }))
    .sort((left, right) => left.pattern.localeCompare(right.pattern));
}

function stringAssignments(body) {
  return Object.fromEntries([...body.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"\s*$/gmu)]
    .map((match) => [match[1], match[2]])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function assignmentKeys(body) {
  return [...body.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/gmu)].map((match) => match[1]).sort();
}

function openAIConfigShapeIssues(toml, sections) {
  const issues = [];
  const exactKeys = (body, expected, label) => {
    if (!same(assignmentKeys(body), [...expected].sort())) issues.push(`${label}:FIELDS`);
  };
  const exactCount = (header, expected, arrayTable = false) => {
    if (tableBodies(toml, header, arrayTable).length !== expected) issues.push(`${header}:COUNT`);
  };
  exactCount("env.openai", 1);
  exactCount("env.openai.assets", 1);
  exactCount("env.openai.durable_objects", 1);
  exactCount("env.openai.vars", 1);
  exactCount("env.openai.kv_namespaces", 1, true);
  exactKeys(sections.openai, ["name", "preview_urls", "routes", "workers_dev"], "env.openai");
  exactKeys(sections.assets, ["binding", "directory", "run_worker_first"], "env.openai.assets");
  exactKeys(sections.durableObjects, ["bindings"], "env.openai.durable_objects");
  exactKeys(sections.vars, ["FRIHET_OPENAI_MODE", "FRIHET_TOOL_MODE"], "env.openai.vars");
  for (const body of sections.kvNamespaces) exactKeys(body, ["binding", "id"], "env.openai.kv_namespaces");
  for (const body of sections.migrations) exactKeys(body, ["new_sqlite_classes", "tag"], "migrations");
  const routeKeys = inlineObjectAssignmentKeys(
    sections.openai.match(/^routes\s*=\s*\[([^\]]*)\]\s*$/mu)?.[1] ?? "",
  );
  if (routeKeys.some((keys) => !same(keys, ["pattern", "zone_name"]))) issues.push("env.openai.routes:FIELDS");
  const durableObjectKeys = inlineObjectAssignmentKeys(
    sections.durableObjects.match(/^bindings\s*=\s*\[([^\]]*)\]\s*$/mu)?.[1] ?? "",
  );
  if (durableObjectKeys.some((keys) => !same(keys, ["class_name", "name"]))) {
    issues.push("env.openai.durable_objects.bindings:FIELDS");
  }
  const allowedHeaders = new Set([
    "env.openai", "env.openai.assets", "env.openai.durable_objects",
    "env.openai.kv_namespaces", "env.openai.vars",
  ]);
  for (const match of toml.matchAll(/^\s*\[\[?([^\]]+)\]\]?\s*$/gmu)) {
    if (match[1].startsWith("env.openai") && !allowedHeaders.has(match[1])) {
      issues.push(`UNEXPECTED_SECTION:${match[1]}`);
    }
  }
  return issues.sort();
}

export function deriveOpenAITargetTopology(toml) {
  const firstTable = toml.search(/^\s*\[/mu);
  const root = firstTable < 0 ? toml : toml.slice(0, firstTable);
  const openai = section(toml, "env.openai");
  const assets = section(toml, "env.openai.assets");
  const durableObjects = section(toml, "env.openai.durable_objects");
  const vars = section(toml, "env.openai.vars");
  const kvNamespaces = tableBodies(toml, "env.openai.kv_namespaces", true);
  const migrations = tableBodies(toml, "migrations", true).map((body) => ({
    tag: stringValue(body, "tag"),
    newSqliteClasses: stringArrayValue(body, "new_sqlite_classes").sort(),
  }));
  const migrationClasses = migrations.flatMap((migration) => migration.newSqliteClasses).sort();
  return {
    environment: "openai",
    workerName: stringValue(openai, "name"),
    entrypoint: stringValue(root, "main"),
    compatibilityDate: stringValue(root, "compatibility_date"),
    compatibilityFlags: stringArrayValue(root, "compatibility_flags").sort(),
    routes: inlineRoutes(openai),
    workersDev: booleanValue(openai, "workers_dev"),
    previewUrls: booleanValue(openai, "preview_urls"),
    migrations,
    migrationTag: migrations.at(-1)?.tag ?? "",
    migrationClasses,
    durableObjectExports: migrationClasses.map((className) => ({ className, state: "created", storage: "sqlite" }))
      .sort((left, right) => left.className.localeCompare(right.className)),
    durableObjects: objectEntries(durableObjects),
    kvNamespaces: kvNamespaces.map((body) => ({
      binding: stringValue(body, "binding"), namespaceId: stringValue(body, "id"),
    })).sort((left, right) => left.binding.localeCompare(right.binding)),
    assets: {
      binding: stringValue(assets, "binding"),
      directory: stringValue(assets, "directory"),
      runWorkerFirst: stringArrayValue(assets, "run_worker_first"),
    },
    vars: stringAssignments(vars),
    configShapeIssues: openAIConfigShapeIssues(toml, {
      openai, assets, durableObjects, vars, kvNamespaces, migrations: tableBodies(toml, "migrations", true),
    }),
  };
}

function contractTarget(contract) {
  const expected = contract.targetTopology ?? {};
  return {
    environment: contract.environment,
    workerName: contract.workerName,
    entrypoint: expected.entrypoint,
    compatibilityDate: expected.compatibilityDate,
    compatibilityFlags: [...(expected.compatibilityFlags ?? [])].sort(),
    routes: [...(expected.routes ?? [])].sort((left, right) => left.pattern.localeCompare(right.pattern)),
    workersDev: expected.workersDev,
    previewUrls: expected.previewUrls,
    migrations: expected.migrations ?? [],
    migrationTag: expected.migrationTag,
    migrationClasses: (expected.durableObjects ?? []).map((binding) => binding.className).sort(),
    durableObjectExports: [...(expected.durableObjectExports ?? [])]
      .sort((left, right) => left.className.localeCompare(right.className)),
    durableObjects: [...(expected.durableObjects ?? [])]
      .sort((left, right) => left.binding.localeCompare(right.binding)),
    kvNamespaces: [...(expected.kvNamespaces ?? [])]
      .sort((left, right) => left.binding.localeCompare(right.binding)),
    assets: expected.assets,
    vars: stable(expected.vars ?? {}),
    configShapeIssues: [],
  };
}

export function validateConfigAgainstContract(toml, contract) {
  const errors = [];
  if (!same(deriveOpenAITargetTopology(toml), contractTarget(contract))) errors.push("TARGET_TOPOLOGY_DRIFT");
  if (contract.schemaVersion !== 2) errors.push("BASELINE_SCHEMA_UNSUPPORTED");
  if (!["pending-bootstrap", "established"].includes(contract.status)) errors.push("BASELINE_STATUS_INVALID");
  if (contract.status === "pending-bootstrap" && contract.baseline !== null) errors.push("PENDING_BASELINE_MUST_BE_EMPTY");
  if (contract.recovery?.strategy !== "compatible-version-roll-forward") errors.push("UNSAFE_RECOVERY_STRATEGY");
  if (contract.recovery?.requiresExactTopologyReceipt !== true) errors.push("EXACT_TOPOLOGY_RECEIPT_NOT_REQUIRED");
  if (contract.recovery?.requiresJitPrestate !== true) errors.push("JIT_PRESTATE_NOT_REQUIRED");
  if (!Number.isInteger(contract.jitPolicy?.maxAgeSeconds) ||
    contract.jitPolicy.maxAgeSeconds > 300 || contract.jitPolicy.maxAgeSeconds < 1) {
    errors.push("JIT_FRESHNESS_POLICY_INVALID");
  }
  if (!same(contract.targetTopology?.secretNames, [...(contract.targetTopology?.secretNames ?? [])].sort())) {
    errors.push("TARGET_SECRET_SET_NOT_CANONICAL");
  }
  if ((contract.targetTopology?.routes ?? []).length !== 1) errors.push("TARGET_ROUTE_SET_INVALID");
  return errors;
}

function normalizedBinding(binding) {
  switch (binding?.type) {
    case "durable_object_namespace":
      return { type: binding.type, binding: binding.name ?? "", className: binding.class_name ?? "",
        namespaceId: binding.namespace_id ?? "", scriptName: binding.script_name ?? null };
    case "kv_namespace":
      return { type: binding.type, binding: binding.name ?? "", namespaceId: binding.namespace_id ?? "" };
    case "assets": return { type: binding.type, binding: binding.name ?? "" };
    case "plain_text": return { type: binding.type, binding: binding.name ?? "", value: binding.text ?? "" };
    case "secret_text": return { type: binding.type, binding: binding.name ?? "" };
    default: return { type: binding?.type ?? "", binding: binding?.name ?? "" };
  }
}

export function cloudflareTopology(versionView) {
  const resources = versionView?.resources ?? {};
  const bindings = Array.isArray(resources.bindings) ? resources.bindings.map(normalizedBinding) : [];
  const byType = (type) => bindings.filter((binding) => binding.type === type);
  const exports = resources.script_runtime?.exports ?? {};
  const publicVars = Object.fromEntries(byType("plain_text").map((binding) => [binding.binding, binding.value])
    .filter(([name]) => !["RELEASE_SOURCE_SHA", "RELEASE_VERSION"].includes(name))
    .sort(([left], [right]) => left.localeCompare(right)));
  return {
    resourceKeys: Object.keys(resources).sort(),
    compatibilityDate: resources.script_runtime?.compatibility_date ?? "",
    compatibilityFlags: [...(resources.script_runtime?.compatibility_flags ?? [])].sort(),
    migrationTag: resources.script_runtime?.migration_tag ?? "",
    handlers: [...(resources.script?.handlers ?? [])].sort(),
    workerEntrypoints: Object.entries(exports).filter(([, value]) => value?.type === "worker")
      .map(([name]) => name).sort(),
    durableObjectExports: Object.entries(exports).filter(([, value]) => value?.type === "durable-object")
      .map(([className, value]) => ({ className, state: value.state ?? "created", storage: value.storage ?? "" }))
      .sort((left, right) => left.className.localeCompare(right.className)),
    unexpectedExports: Object.entries(exports).filter(([, value]) => !["worker", "durable-object"].includes(value?.type))
      .map(([name, value]) => ({ name, type: value?.type ?? "" })).sort((left, right) => left.name.localeCompare(right.name)),
    durableObjects: byType("durable_object_namespace").map(({ type: _type, ...binding }) => binding)
      .sort((left, right) => left.binding.localeCompare(right.binding)),
    kvNamespaces: byType("kv_namespace").map(({ type: _type, ...binding }) => binding)
      .sort((left, right) => left.binding.localeCompare(right.binding)),
    assets: byType("assets").map(({ type: _type, ...binding }) => binding)
      .sort((left, right) => left.binding.localeCompare(right.binding)),
    vars: publicVars,
    secretNames: byType("secret_text").map((binding) => binding.binding).sort(),
    unexpectedBindings: bindings.filter((binding) => ![
      "durable_object_namespace", "kv_namespace", "assets", "plain_text", "secret_text",
    ].includes(binding.type)).sort((left, right) => `${left.type}:${left.binding}`.localeCompare(`${right.type}:${right.binding}`)),
    duplicateBindingNames: bindings.map((binding) => binding.binding)
      .filter((name, index, names) => names.indexOf(name) !== index).sort(),
  };
}

function versionProvenance(versionView) {
  const vars = Object.fromEntries((versionView?.resources?.bindings ?? [])
    .filter((binding) => binding?.type === "plain_text")
    .map((binding) => [binding.name ?? "", binding.text ?? ""]));
  return {
    id: versionView?.id ?? "",
    number: versionView?.number ?? null,
    createdOn: versionView?.metadata?.created_on ?? "",
    source: versionView?.metadata?.source ?? "",
    scriptEtag: versionView?.resources?.script?.etag ?? "",
    releaseSha: vars.RELEASE_SOURCE_SHA ?? "",
    releaseVersion: vars.RELEASE_VERSION ?? "",
    releaseSource: vars.RELEASE_SOURCE_SHA && vars.RELEASE_VERSION ? "wrangler-var" : "",
  };
}

function deploymentProjection(view) {
  const version = Array.isArray(view?.versions) ? view.versions[0] : undefined;
  return { id: view?.id ?? "", createdOn: view?.created_on ?? "", source: view?.source ?? "",
    strategy: view?.strategy ?? "", versionId: version?.version_id ?? "", percentage: version?.percentage ?? null };
}

function healthProjection(health) {
  return { status: health?.status ?? null, version: health?.version ?? null,
    releaseSha: health?.releaseSha ?? null, releaseVersion: health?.releaseVersion ?? null,
    releaseSource: health?.releaseSource ?? null };
}

function zoneProjection(view) {
  return { id: view?.id ?? "", name: view?.name ?? "", accountId: view?.account?.id ?? view?.accountId ?? "",
    status: view?.status ?? "" };
}

function routeProjection(routesView, workerName) {
  return (Array.isArray(routesView) ? routesView : []).filter((route) => route?.script === workerName)
    .map((route) => ({ id: route.id ?? "", pattern: route.pattern ?? "", script: route.script ?? "" }))
    .sort((left, right) => `${left.pattern}:${left.id}`.localeCompare(`${right.pattern}:${right.id}`));
}

function subdomainProjection(view) {
  return { enabled: view?.enabled ?? null,
    previewsEnabled: view?.previews_enabled ?? view?.previewsEnabled ?? null };
}

function validateExecutionIdentity(contract, { accountId, workerName, environment, identityView, zoneView }) {
  const errors = [];
  if (!ACCOUNT_PATTERN.test(accountId ?? "")) errors.push("CLOUDFLARE_ACCOUNT_ID_INVALID");
  if (contract.status === "established" && accountId !== contract.baseline?.accountId) {
    errors.push("CLOUDFLARE_ACCOUNT_RECEIPT_MISMATCH");
  }
  if (workerName !== contract.workerName) errors.push("CLOUDFLARE_SCRIPT_RECEIPT_MISMATCH");
  if (environment !== contract.environment) errors.push("CLOUDFLARE_ENVIRONMENT_RECEIPT_MISMATCH");
  if (identityView) {
    if (identityView.loggedIn !== true) errors.push("CLOUDFLARE_IDENTITY_NOT_AUTHENTICATED");
    const accounts = Array.isArray(identityView.accounts) ? identityView.accounts : [];
    if (!accounts.some((account) => account?.id === accountId)) errors.push("CLOUDFLARE_TOKEN_ACCOUNT_MISMATCH");
  }
  if (zoneView) {
    const zone = zoneProjection(zoneView);
    if (!ACCOUNT_PATTERN.test(zone.accountId) || zone.accountId !== accountId) errors.push("CLOUDFLARE_ZONE_ACCOUNT_MISMATCH");
  }
  return errors;
}

function validateTopologyAgainstTarget(contract, topology) {
  const errors = [];
  const expected = contract.targetTopology ?? {};
  if (!same(topology.resourceKeys, ["bindings", "script", "script_runtime"])) errors.push("LIVE_RESOURCE_SET_DRIFT");
  if (topology.compatibilityDate !== expected.compatibilityDate) errors.push("LIVE_COMPATIBILITY_DATE_DRIFT");
  if (!same(topology.compatibilityFlags, expected.compatibilityFlags)) errors.push("LIVE_COMPATIBILITY_FLAGS_DRIFT");
  if (topology.migrationTag !== expected.migrationTag) errors.push("LIVE_MIGRATION_TAG_DRIFT");
  if (!same(topology.handlers, ["fetch"])) errors.push("LIVE_HANDLER_SET_DRIFT");
  if (!same(topology.workerEntrypoints, ["default"])) errors.push("LIVE_WORKER_EXPORT_SET_DRIFT");
  if (!same(topology.durableObjectExports, expected.durableObjectExports)) errors.push("LIVE_DURABLE_OBJECT_EXPORT_SET_DRIFT");
  if (topology.unexpectedExports.length !== 0) errors.push("LIVE_UNEXPECTED_EXPORT");
  const expectedDurableObjects = [...(expected.durableObjects ?? [])]
    .sort((left, right) => left.binding.localeCompare(right.binding));
  if (topology.durableObjects.length !== expectedDurableObjects.length || topology.durableObjects.some((actual, index) => {
    const wanted = expectedDurableObjects[index];
    return actual.binding !== wanted?.binding || actual.className !== wanted?.className ||
      !NAMESPACE_PATTERN.test(actual.namespaceId) || actual.scriptName !== null;
  })) errors.push("LIVE_DURABLE_OBJECT_SET_DRIFT");
  if (!same(topology.kvNamespaces, expected.kvNamespaces)) errors.push("LIVE_KV_SET_DRIFT");
  if (!same(topology.assets, [{ binding: expected.assets?.binding }])) errors.push("LIVE_ASSETS_SET_DRIFT");
  if (!same(topology.vars, expected.vars ?? {})) errors.push("LIVE_PROFILE_VAR_SET_DRIFT");
  if (!same(topology.secretNames, expected.secretNames)) errors.push("LIVE_SECRET_SET_DRIFT");
  if (topology.unexpectedBindings.length !== 0) errors.push("LIVE_UNEXPECTED_BINDING");
  if (topology.duplicateBindingNames.length !== 0) errors.push("LIVE_DUPLICATE_BINDING");
  return errors;
}

function instant(value) {
  if (!ISO_INSTANT_PATTERN.test(value ?? "")) return Number.NaN;
  return Date.parse(value);
}

function trustedNowMs(now) {
  return now instanceof Date ? now.getTime() : new Date(now).getTime();
}

function validateVersionProvenance(provenance, { sourceSha, sourceVersion, now = new Date() }) {
  const errors = [];
  if (!UUID_PATTERN.test(provenance.id)) errors.push("VERSION_ID_INVALID");
  if (!Number.isInteger(provenance.number) || provenance.number < 1) errors.push("VERSION_NUMBER_INVALID");
  const createdOn = instant(provenance.createdOn);
  const nowMs = trustedNowMs(now);
  if (!Number.isFinite(createdOn)) errors.push("VERSION_CREATED_ON_INVALID");
  else if (!Number.isFinite(nowMs) || createdOn > nowMs + CLOCK_SKEW_MS) errors.push("VERSION_CREATED_ON_IN_FUTURE");
  if (typeof provenance.source !== "string" || provenance.source.length === 0) errors.push("VERSION_SOURCE_INVALID");
  if (typeof provenance.scriptEtag !== "string" || provenance.scriptEtag.length === 0 || provenance.scriptEtag.length > 256) {
    errors.push("VERSION_SCRIPT_ETAG_INVALID");
  }
  if (!SHA_PATTERN.test(sourceSha ?? "")) errors.push("SOURCE_SHA_INVALID");
  if (!SEMVER_PATTERN.test(sourceVersion ?? "")) errors.push("SOURCE_VERSION_INVALID");
  if (provenance.releaseSha !== sourceSha || provenance.releaseVersion !== sourceVersion || provenance.releaseSource !== "wrangler-var") {
    errors.push("VERSION_SOURCE_PROVENANCE_DRIFT");
  }
  return errors;
}

function validateDeployment(deployment, expectedVersionId, { versionCreatedOn, now = new Date() } = {}) {
  const errors = [];
  if (!UUID_PATTERN.test(deployment.id)) errors.push("DEPLOYMENT_ID_INVALID");
  const createdOn = instant(deployment.createdOn);
  const versionCreatedAt = instant(versionCreatedOn);
  const nowMs = trustedNowMs(now);
  if (!Number.isFinite(createdOn)) errors.push("DEPLOYMENT_CREATED_ON_INVALID");
  else if (!Number.isFinite(nowMs) || createdOn > nowMs + CLOCK_SKEW_MS) errors.push("DEPLOYMENT_CREATED_ON_IN_FUTURE");
  if (Number.isFinite(createdOn) && Number.isFinite(versionCreatedAt) && createdOn + CLOCK_SKEW_MS < versionCreatedAt) {
    errors.push("DEPLOYMENT_PRECEDES_VERSION");
  }
  if (typeof deployment.source !== "string" || deployment.source.length === 0) errors.push("DEPLOYMENT_SOURCE_INVALID");
  if (deployment.strategy !== "percentage") errors.push("DEPLOYMENT_STRATEGY_INVALID");
  if (deployment.versionId !== expectedVersionId || deployment.percentage !== 100) errors.push("ACTIVE_VERSION_INVALID");
  return errors;
}

function expectedRoute(contract) {
  const route = contract.targetTopology?.routes?.[0];
  return route ? { pattern: route.pattern, script: contract.workerName } : null;
}

function validateNetworkSurface(contract, { zoneView, routesView, subdomainView }) {
  const errors = [];
  const targetRoute = contract.targetTopology?.routes?.[0];
  const zone = zoneProjection(zoneView);
  const routes = routeProjection(routesView, contract.workerName);
  const subdomain = subdomainProjection(subdomainView);
  if (!ACCOUNT_PATTERN.test(zone.id) || zone.name !== targetRoute?.zoneName || zone.status !== "active") {
    errors.push("CLOUDFLARE_ZONE_DRIFT");
  }
  if (routes.length !== 1 || !ROUTE_ID_PATTERN.test(routes[0]?.id ?? "") || !same(
    routes.map(({ id: _id, ...route }) => route), targetRoute ? [expectedRoute(contract)] : [],
  )) errors.push("CLOUDFLARE_ROUTE_SET_DRIFT");
  if (!same(subdomain, { enabled: contract.targetTopology?.workersDev,
    previewsEnabled: contract.targetTopology?.previewUrls })) errors.push("CLOUDFLARE_SUBDOMAIN_DRIFT");
  return errors;
}

export function validateCompatibleVersion(contract, versionView, options) {
  const topology = cloudflareTopology(versionView);
  const provenance = versionProvenance(versionView);
  const deployment = deploymentProjection(options.deploymentView);
  return [...new Set([
    ...validateExecutionIdentity(contract, options),
    ...validateTopologyAgainstTarget(contract, topology),
    ...validateVersionProvenance(provenance, {
      sourceSha: options.sourceSha, sourceVersion: options.sourceVersion, now: options.now ?? new Date(),
    }),
    ...validateDeployment(deployment, provenance.id, {
      versionCreatedOn: provenance.createdOn,
      now: options.now ?? new Date(),
    }),
  ])];
}

function validateAnchorShape(contract, now = new Date()) {
  const errors = [];
  const baseline = contract.baseline;
  if (contract.status !== "established" || !baseline) return ["BASELINE_NOT_ESTABLISHED"];
  const exactKeys = (value, keys, error) => {
    if (!value || !same(Object.keys(value).sort(), [...keys].sort())) errors.push(error);
  };
  exactKeys(baseline, ["accountId", "capturedAt", "deployment", "environment", "publicProvenance", "route",
    "source", "subdomain", "targetConfigSha256", "topology", "topologySha256", "version", "workerName", "zone"],
  "BASELINE_RECEIPT_FIELDS_INVALID");
  exactKeys(baseline.zone, ["id", "name"], "BASELINE_ZONE_FIELDS_INVALID");
  exactKeys(baseline.route, ["id", "pattern", "script"], "BASELINE_ROUTE_FIELDS_INVALID");
  exactKeys(baseline.subdomain, ["enabled", "previewsEnabled"], "BASELINE_SUBDOMAIN_FIELDS_INVALID");
  exactKeys(baseline.deployment, ["createdOn", "id", "percentage", "source", "strategy", "versionId"],
    "BASELINE_DEPLOYMENT_FIELDS_INVALID");
  exactKeys(baseline.version, ["createdOn", "id", "number", "scriptEtag", "source"], "BASELINE_VERSION_FIELDS_INVALID");
  exactKeys(baseline.source, ["releaseSource", "sha", "version"], "BASELINE_SOURCE_FIELDS_INVALID");
  exactKeys(baseline.publicProvenance, ["releaseSha", "releaseSource", "releaseVersion", "status", "version"],
    "BASELINE_PUBLIC_PROVENANCE_FIELDS_INVALID");
  if (!ACCOUNT_PATTERN.test(baseline.accountId ?? "")) errors.push("BASELINE_ACCOUNT_ID_INVALID");
  if (baseline.workerName !== contract.workerName) errors.push("BASELINE_SCRIPT_NAME_INVALID");
  if (baseline.environment !== contract.environment) errors.push("BASELINE_ENVIRONMENT_INVALID");
  if (!ISO_INSTANT_PATTERN.test(baseline.capturedAt ?? "")) errors.push("BASELINE_CAPTURE_TIME_INVALID");
  else {
    const capturedAt = Date.parse(baseline.capturedAt);
    const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    if (!Number.isFinite(nowMs) || capturedAt > nowMs + 5_000) errors.push("BASELINE_CAPTURE_TIME_IN_FUTURE");
  }
  if (!ACCOUNT_PATTERN.test(baseline.zone?.id ?? "") || baseline.zone?.name !== contract.targetTopology?.routes?.[0]?.zoneName) {
    errors.push("BASELINE_ZONE_INVALID");
  }
  if (!ROUTE_ID_PATTERN.test(baseline.route?.id ?? "") || !same(
    baseline.route && { pattern: baseline.route.pattern, script: baseline.route.script }, expectedRoute(contract),
  )) errors.push("BASELINE_ROUTE_INVALID");
  if (!same(baseline.subdomain, { enabled: false, previewsEnabled: false })) errors.push("BASELINE_SUBDOMAIN_INVALID");
  errors.push(...validateDeployment(baseline.deployment ?? {}, baseline.version?.id, {
    versionCreatedOn: baseline.version?.createdOn,
    now,
  }));
  const baselineProvenance = { ...(baseline.version ?? {}), releaseSha: baseline.source?.sha,
    releaseVersion: baseline.source?.version, releaseSource: baseline.source?.releaseSource };
  errors.push(...validateVersionProvenance(baselineProvenance, {
    sourceSha: baseline.source?.sha, sourceVersion: baseline.source?.version, now,
  }));
  const capturedAt = instant(baseline.capturedAt);
  const deploymentCreatedAt = instant(baseline.deployment?.createdOn);
  if (Number.isFinite(capturedAt) && Number.isFinite(deploymentCreatedAt) &&
    deploymentCreatedAt > capturedAt + CLOCK_SKEW_MS) errors.push("BASELINE_CAPTURE_PRECEDES_DEPLOYMENT");
  if (baseline.deployment?.versionId !== baseline.version?.id) errors.push("BASELINE_VERSION_DEPLOYMENT_MISMATCH");
  const targetConfigSha256 = topologyFingerprint(contractTarget(contract));
  if (!SHA256_PATTERN.test(baseline.targetConfigSha256 ?? "") || baseline.targetConfigSha256 !== targetConfigSha256) {
    errors.push("BASELINE_TARGET_CONFIG_RECEIPT_INVALID");
  }
  if (!baseline.topology || !SHA256_PATTERN.test(baseline.topologySha256 ?? "") ||
    topologyFingerprint(baseline.topology) !== baseline.topologySha256) {
    errors.push("BASELINE_TOPOLOGY_RECEIPT_INVALID");
  } else errors.push(...validateTopologyAgainstTarget(contract, baseline.topology));
  const expectedHealth = { status: "ok", version: baseline.source?.version, releaseSha: baseline.source?.sha,
    releaseVersion: baseline.source?.version, releaseSource: "wrangler-var" };
  if (baseline.source?.releaseSource !== "wrangler-var" || !same(baseline.publicProvenance, expectedHealth)) {
    errors.push("BASELINE_PUBLIC_PROVENANCE_INVALID");
  }
  return [...new Set(errors)];
}

export function createJitPrestate(
  contract,
  observations,
  snapshotStartedAt = new Date(),
  observedAt = new Date(),
) {
  const topology = cloudflareTopology(observations.versionView);
  const provenance = versionProvenance(observations.versionView);
  const deployment = deploymentProjection(observations.deploymentView);
  const zone = zoneProjection(observations.zoneView);
  const routes = routeProjection(observations.routesView, contract.workerName);
  const subdomain = subdomainProjection(observations.subdomainView);
  return {
    schemaVersion: 2,
    snapshotStartedAt: (snapshotStartedAt instanceof Date ? snapshotStartedAt : new Date(snapshotStartedAt)).toISOString(),
    observedAt: (observedAt instanceof Date ? observedAt : new Date(observedAt)).toISOString(),
    accountId: observations.accountId,
    workerName: observations.workerName,
    environment: observations.environment,
    zone: { id: zone.id, name: zone.name },
    route: routes[0] ?? null,
    subdomain,
    deployment,
    version: { id: provenance.id, number: provenance.number, createdOn: provenance.createdOn,
      source: provenance.source, scriptEtag: provenance.scriptEtag },
    source: { sha: provenance.releaseSha, version: provenance.releaseVersion, releaseSource: provenance.releaseSource },
    targetConfigSha256: topologyFingerprint(contractTarget(contract)),
    topology,
    topologySha256: topologyFingerprint(topology),
    publicProvenance: healthProjection(observations.health),
  };
}

function validateJitFreshness(contract, jit, now = new Date()) {
  const snapshotStartedAt = instant(jit?.snapshotStartedAt);
  const observedAt = instant(jit?.observedAt);
  const nowMs = trustedNowMs(now);
  if (!Number.isFinite(snapshotStartedAt) || !Number.isFinite(observedAt) || !Number.isFinite(nowMs)) {
    return ["JIT_CAPTURE_TIME_INVALID"];
  }
  const errors = [];
  const budgetMs = (contract.jitPolicy?.maxAgeSeconds ?? 0) * 1_000;
  if (snapshotStartedAt > nowMs + CLOCK_SKEW_MS || observedAt > nowMs + CLOCK_SKEW_MS) {
    errors.push("JIT_CAPTURE_TIME_IN_FUTURE");
  }
  if (observedAt + CLOCK_SKEW_MS < snapshotStartedAt) errors.push("JIT_CAPTURE_ORDER_INVALID");
  if (observedAt - snapshotStartedAt > budgetMs) errors.push("JIT_CAPTURE_DURATION_EXCEEDED");
  if (nowMs - snapshotStartedAt > budgetMs) errors.push("JIT_PRESTATE_STALE");
  return errors;
}

function validateJitAgainstAnchor(contract, jit, now = new Date()) {
  const errors = [...validateAnchorShape(contract, now)];
  const baseline = contract.baseline;
  if (!baseline) return errors;
  if (jit?.accountId !== baseline.accountId) errors.push("JIT_ACCOUNT_ANCHOR_MISMATCH");
  if (jit?.workerName !== baseline.workerName) errors.push("JIT_SCRIPT_ANCHOR_MISMATCH");
  if (jit?.environment !== baseline.environment) errors.push("JIT_ENVIRONMENT_ANCHOR_MISMATCH");
  if (!same(jit?.zone, baseline.zone)) errors.push("JIT_ZONE_ANCHOR_MISMATCH");
  if (!same(jit?.route, baseline.route)) errors.push("JIT_ROUTE_ANCHOR_MISMATCH");
  if (!same(jit?.subdomain, baseline.subdomain)) errors.push("JIT_SUBDOMAIN_ANCHOR_MISMATCH");
  if (jit?.deployment?.versionId !== jit?.version?.id) errors.push("JIT_VERSION_DEPLOYMENT_MISMATCH");
  errors.push(...validateDeployment(jit?.deployment ?? {}, jit?.version?.id, {
    versionCreatedOn: jit?.version?.createdOn,
    now,
  }));
  errors.push(...validateVersionProvenance({
    ...(jit?.version ?? {}),
    releaseSha: jit?.source?.sha,
    releaseVersion: jit?.source?.version,
    releaseSource: jit?.source?.releaseSource,
  }, { sourceSha: jit?.source?.sha, sourceVersion: jit?.source?.version, now }));
  const observationCompletedAt = instant(jit?.observedAt);
  const versionCreatedAt = instant(jit?.version?.createdOn);
  const deploymentCreatedAt = instant(jit?.deployment?.createdOn);
  if (Number.isFinite(observationCompletedAt) && Number.isFinite(versionCreatedAt) &&
    versionCreatedAt > observationCompletedAt + CLOCK_SKEW_MS) errors.push("JIT_OBSERVATION_PRECEDES_VERSION");
  if (Number.isFinite(observationCompletedAt) && Number.isFinite(deploymentCreatedAt) &&
    deploymentCreatedAt > observationCompletedAt + CLOCK_SKEW_MS) errors.push("JIT_OBSERVATION_PRECEDES_DEPLOYMENT");
  if (jit?.targetConfigSha256 !== baseline.targetConfigSha256) errors.push("JIT_TARGET_CONFIG_ANCHOR_MISMATCH");
  if (!same(jit?.topology, baseline.topology)) errors.push("JIT_TOPOLOGY_ANCHOR_MISMATCH");
  if (!SHA256_PATTERN.test(jit?.topologySha256 ?? "") ||
    topologyFingerprint(jit?.topology) !== jit?.topologySha256) errors.push("JIT_TOPOLOGY_DIGEST_INVALID");
  const expectedHealth = { status: "ok", version: jit?.source?.version, releaseSha: jit?.source?.sha,
    releaseVersion: jit?.source?.version, releaseSource: "wrangler-var" };
  if (!same(jit?.publicProvenance, expectedHealth)) errors.push("JIT_PUBLIC_PROVENANCE_INVALID");
  return errors;
}

export function validateEstablishedBaseline(contract, observations) {
  const { deploymentView, versionView, health, now = new Date() } = observations;
  const topology = cloudflareTopology(versionView);
  const provenance = versionProvenance(versionView);
  const liveZone = zoneProjection(observations.zoneView);
  const liveRoutes = routeProjection(observations.routesView, contract.workerName);
  const liveSubdomain = subdomainProjection(observations.subdomainView);
  const errors = [
    ...validateAnchorShape(contract, now),
    ...validateExecutionIdentity(contract, observations),
    ...validateNetworkSurface(contract, observations),
    ...validateTopologyAgainstTarget(contract, topology),
    ...validateVersionProvenance(provenance, {
      sourceSha: provenance.releaseSha, sourceVersion: provenance.releaseVersion, now,
    }),
    ...validateDeployment(deploymentProjection(deploymentView), provenance.id, {
      versionCreatedOn: provenance.createdOn,
      now,
    }),
  ];
  if (!contract.baseline) return [...new Set(errors)];
  if (!same({ id: liveZone.id, name: liveZone.name }, contract.baseline.zone)) {
    errors.push("LIVE_ZONE_ANCHOR_MISMATCH");
  }
  if (!same(liveRoutes, [contract.baseline.route])) errors.push("LIVE_ROUTE_ANCHOR_MISMATCH");
  if (!same(liveSubdomain, contract.baseline.subdomain)) errors.push("LIVE_SUBDOMAIN_ANCHOR_MISMATCH");
  if (!same(topology, contract.baseline.topology)) errors.push("LIVE_TOPOLOGY_ANCHOR_MISMATCH");
  if (!same(healthProjection(health), { status: "ok", version: provenance.releaseVersion,
    releaseSha: provenance.releaseSha, releaseVersion: provenance.releaseVersion, releaseSource: "wrangler-var" })) {
    errors.push("LIVE_PUBLIC_PROVENANCE_VERSION_MISMATCH");
  }
  errors.push(...validateJitFreshness(contract, createJitPrestate(contract, observations, now, now), now));
  return [...new Set(errors)];
}

export function validateRecoveryTarget(contract, versionView, options) {
  const topology = cloudflareTopology(versionView);
  const provenance = versionProvenance(versionView);
  const liveZone = zoneProjection(options.zoneView);
  const liveRoutes = routeProjection(options.routesView, contract.workerName);
  const liveSubdomain = subdomainProjection(options.subdomainView);
  const errors = [
    ...validateAnchorShape(contract, options.now ?? new Date()),
    ...validateExecutionIdentity(contract, options),
    ...validateNetworkSurface(contract, options),
    ...validateTopologyAgainstTarget(contract, topology),
    ...validateVersionProvenance(provenance, {
      sourceSha: options.expectedSourceSha, sourceVersion: options.expectedSourceVersion,
      now: options.now ?? new Date(),
    }),
  ];
  if (provenance.id !== options.expectedVersionId) errors.push("RECOVERY_VERSION_JIT_MISMATCH");
  if (contract.baseline && !same({ id: liveZone.id, name: liveZone.name }, contract.baseline.zone)) {
    errors.push("RECOVERY_ZONE_ANCHOR_MISMATCH");
  }
  if (contract.baseline && !same(liveRoutes, [contract.baseline.route])) {
    errors.push("RECOVERY_ROUTE_ANCHOR_MISMATCH");
  }
  if (contract.baseline && !same(liveSubdomain, contract.baseline.subdomain)) {
    errors.push("RECOVERY_SUBDOMAIN_ANCHOR_MISMATCH");
  }
  if (textFingerprint(provenance.scriptEtag) !== options.expectedScriptEtagSha256) errors.push("RECOVERY_ETAG_JIT_MISMATCH");
  if (topologyFingerprint(topology) !== options.expectedTopologySha256) errors.push("RECOVERY_TOPOLOGY_JIT_MISMATCH");
  if (contract.baseline && !same(topology, contract.baseline.topology)) errors.push("RECOVERY_TOPOLOGY_ANCHOR_MISMATCH");
  return [...new Set(errors)];
}

export function validateJitPrestates(contract, before, after, now = new Date()) {
  const errors = [];
  const expectedKeys = ["accountId", "deployment", "environment", "observedAt", "publicProvenance", "route",
    "schemaVersion", "snapshotStartedAt", "source", "subdomain", "targetConfigSha256", "topology",
    "topologySha256", "version", "workerName", "zone"];
  for (const [label, jit] of [["BEFORE", before], ["AFTER", after]]) {
    if (!jit || jit.schemaVersion !== 2 || !same(Object.keys(jit).sort(), [...expectedKeys].sort())) {
      errors.push(`JIT_${label}_SHAPE_INVALID`);
      continue;
    }
    errors.push(...validateJitFreshness(contract, jit, now).map((error) => `${label}:${error}`));
    errors.push(...validateJitAgainstAnchor(contract, jit, now).map((error) => `${label}:${error}`));
  }
  const withoutCaptureTimes = (jit) => {
    const { observedAt: _observedAt, snapshotStartedAt: _snapshotStartedAt, ...rest } = jit ?? {};
    return rest;
  };
  if (!same(withoutCaptureTimes(before), withoutCaptureTimes(after))) errors.push("JIT_PRESTATE_CHANGED_BETWEEN_READS");
  const beforeStartedAt = instant(before?.snapshotStartedAt);
  const beforeAt = Date.parse(before?.observedAt ?? "");
  const afterStartedAt = instant(after?.snapshotStartedAt);
  const afterAt = Date.parse(after?.observedAt ?? "");
  const nowMs = trustedNowMs(now);
  const budgetMs = (contract.jitPolicy?.maxAgeSeconds ?? 0) * 1_000;
  if (!Number.isFinite(beforeStartedAt) || !Number.isFinite(beforeAt) ||
    !Number.isFinite(afterStartedAt) || !Number.isFinite(afterAt) || !Number.isFinite(nowMs) ||
    beforeAt + CLOCK_SKEW_MS < beforeStartedAt || afterStartedAt + CLOCK_SKEW_MS < beforeAt ||
    afterAt + CLOCK_SKEW_MS < afterStartedAt ||
    afterAt - beforeStartedAt > budgetMs || nowMs - beforeStartedAt > budgetMs) {
    errors.push("JIT_DOUBLE_READ_WINDOW_INVALID");
  }
  return [...new Set(errors)];
}

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredJson(flag, errors) {
  const path = arg(flag);
  if (!path) {
    errors.push(`INPUT_REQUIRED:${flag}`);
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    errors.push(`INPUT_INVALID_JSON:${flag}`);
    return {};
  }
}

function observationInputs(errors) {
  return {
    deploymentView: requiredJson("--active-deployment", errors),
    versionView: requiredJson("--live-version", errors),
    health: requiredJson("--health", errors),
    identityView: requiredJson("--identity", errors),
    zoneView: requiredJson("--zone", errors),
    routesView: requiredJson("--routes", errors),
    subdomainView: requiredJson("--subdomain", errors),
    accountId: arg("--account-id"), workerName: arg("--worker-name"), environment: arg("--environment"),
  };
}

function runCli() {
  const configPath = arg("--config") ?? DEFAULT_CONFIG;
  const contractPath = arg("--contract") ?? DEFAULT_CONTRACT;
  const toml = readFileSync(configPath, "utf8");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  const errors = validateConfigAgainstContract(toml, contract);
  const snapshotStartOutput = arg("--write-snapshot-start");
  const jitOutput = arg("--write-jit-prestate");
  const snapshotStartedAtFile = arg("--snapshot-started-at-file");
  let snapshotStartedAt;
  if (jitOutput) {
    if (!snapshotStartedAtFile) errors.push("INPUT_REQUIRED:--snapshot-started-at-file");
    else {
      try {
        snapshotStartedAt = readFileSync(snapshotStartedAtFile, "utf8").trim();
        if (!Number.isFinite(instant(snapshotStartedAt))) errors.push("SNAPSHOT_START_TIME_INVALID");
      } catch {
        errors.push("INPUT_INVALID:--snapshot-started-at-file");
      }
    }
  }
  let observations;
  if (process.argv.includes("--require-established") || jitOutput) {
    observations = observationInputs(errors);
    errors.push(...validateEstablishedBaseline(contract, observations));
  }
  if (process.argv.includes("--require-compatible")) {
    const versionView = requiredJson("--live-version", errors);
    errors.push(...validateCompatibleVersion(contract, versionView, {
      sourceSha: arg("--expected-source-sha"), sourceVersion: arg("--expected-source-version"),
      deploymentView: requiredJson("--active-deployment", errors),
      accountId: arg("--account-id"), workerName: arg("--worker-name"), environment: arg("--environment"),
    }));
  }
  if (process.argv.includes("--require-recovery-target")) {
    const versionView = requiredJson("--live-version", errors);
    errors.push(...validateRecoveryTarget(contract, versionView, {
      identityView: requiredJson("--identity", errors), zoneView: requiredJson("--zone", errors),
      routesView: requiredJson("--routes", errors), subdomainView: requiredJson("--subdomain", errors),
      accountId: arg("--account-id"), workerName: arg("--worker-name"), environment: arg("--environment"),
      expectedVersionId: arg("--expected-version-id"), expectedSourceSha: arg("--expected-source-sha"),
      expectedSourceVersion: arg("--expected-source-version"),
      expectedScriptEtagSha256: arg("--expected-script-etag-sha256"),
      expectedTopologySha256: arg("--expected-topology-sha256"),
    }));
  }
  if (process.argv.includes("--require-jit-unchanged")) {
    errors.push(...validateJitPrestates(contract, requiredJson("--jit-before", errors), requiredJson("--jit-after", errors)));
  }
  const freshJitPath = arg("--require-jit-fresh");
  if (freshJitPath) {
    const freshJit = requiredJson("--require-jit-fresh", errors);
    const expectedKeys = ["accountId", "deployment", "environment", "observedAt", "publicProvenance", "route",
      "schemaVersion", "snapshotStartedAt", "source", "subdomain", "targetConfigSha256", "topology",
      "topologySha256", "version", "workerName", "zone"];
    if (freshJit?.schemaVersion !== 2 || !same(Object.keys(freshJit ?? {}).sort(), expectedKeys.sort())) {
      errors.push("JIT_SHAPE_INVALID");
    } else {
      errors.push(...validateJitFreshness(contract, freshJit));
      errors.push(...validateJitAgainstAnchor(contract, freshJit));
    }
  }
  if (errors.length) {
    console.error(`OpenAI Cloudflare topology gate: BLOCK (${[...new Set(errors)].join(", ")})`);
    process.exitCode = 1;
    return;
  }
  if (snapshotStartOutput) {
    writeFileSync(snapshotStartOutput, `${new Date().toISOString()}\n`, { mode: 0o600 });
  }
  if (jitOutput && observations) {
    writeFileSync(jitOutput, `${JSON.stringify(createJitPrestate(
      contract,
      observations,
      snapshotStartedAt,
      new Date(),
    ), null, 2)}\n`, { mode: 0o600 });
  }
  console.log(`OpenAI Cloudflare topology gate: PASS (${contract.status})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runCli();
