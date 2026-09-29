#!/usr/bin/env node
/**
 * OpenAI release — Worker targeting under the Worker-locked Wrangler.
 *
 * These tests read `workers/remote-mcp/node_modules/wrangler`, so they run
 * only where the Worker dependencies are installed (root `npm test` in CI and
 * in the OpenAI release gates). They execute the resolver functions of that
 * exact CLI against every Wrangler invocation in the OpenAI release workflow,
 * and pin the CLI facts the topology bootstrap runbook states.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const OPENAI_WORKFLOW = ".github/workflows/deploy-openai-mcp.yml";
const OPENAI_BOOTSTRAP_GUIDE = "docs/openai-topology-bootstrap.md";
const OPENAI_TOPOLOGY = "marketplace/openai/cloudflare-topology-baseline.json";
const OPENAI_WRANGLER = "workers/remote-mcp/wrangler.toml";
const WORKER_LOCK = "workers/remote-mcp/package-lock.json";
const WRANGLER_PACKAGE = "workers/remote-mcp/node_modules/wrangler/package.json";
const WRANGLER_CLI = "workers/remote-mcp/node_modules/wrangler/wrangler-dist/cli.js";

function lockedWranglerSource() {
  const lock = JSON.parse(readFileSync(WORKER_LOCK, "utf8"));
  const installed = JSON.parse(readFileSync(WRANGLER_PACKAGE, "utf8"));
  assert.equal(
    installed.version,
    lock.packages["node_modules/wrangler"].version,
    "the installed Wrangler must be the Worker-locked version",
  );
  return readFileSync(WRANGLER_CLI, "utf8");
}

function topLevelFunctionSource(source, name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}$`, "m"));
  assert.ok(match, `locked Wrangler no longer defines ${name}; re-review Worker name resolution`);
  return match[0];
}

function wranglerTableName(toml, table) {
  let current = "";
  for (const line of toml.split("\n")) {
    const header = line.match(/^\s*\[\[?\s*([^\]\s]+)\s*\]\]?\s*$/);
    if (header) {
      current = header[1];
    } else if (current === table) {
      const name = line.match(/^\s*name\s*=\s*"([^"]+)"\s*$/);
      if (name) return name[1];
    }
  }
  return undefined;
}

/** Executable shell text: comment lines dropped, `\\` line continuations joined. */
function executableShellText(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .replace(/\\\n\s*/g, " ");
}

/** Every executable Wrangler invocation in `text`, one per joined line. */
function wranglerInvocations(text) {
  return [...executableShellText(text).matchAll(/\bwrangler [^\n]*/g)].map((match) => match[0]);
}

const WORKER_NAME_USE = /\bwrangler [^\n]*\$\{?WORKER_NAME\b/;
const WORKER_NAME_DERIVATION = `WORKER_NAME="$(jq -r '.workerName // ""' "$CONTRACT")"`;
const TOPOLOGY_CONTRACT_ASSIGNMENT = "CONTRACT=../../marketplace/openai/cloudflare-topology-baseline.json";

/**
 * Returns "proven" when a step's `$WORKER_NAME` provably equals `expected` at
 * its first Wrangler use, otherwise the reason it does not. Proven means:
 * strict mode, the topology contract selected, exactly one write (the
 * contract derivation), and a standalone literal `test` of the expected name,
 * in that order and all before the first use.
 */
function workerNameProof(stepText, expected) {
  const lines = stepText.split("\n").map((line) => line.trim());
  const use = lines.findIndex((line) => WORKER_NAME_USE.test(line));
  const strict = lines.indexOf("set -euo pipefail");
  const contract = lines.indexOf(TOPOLOGY_CONTRACT_ASSIGNMENT);
  const derivation = lines.indexOf(WORKER_NAME_DERIVATION);
  const proof = lines.indexOf(`test "$WORKER_NAME" = "${expected}"`);
  const writes = [...stepText.matchAll(/(?<!\$|\$\{)\bWORKER_NAME\b/g)].length;
  if (derivation < 0) return "WORKER_NAME is not derived from the topology contract";
  if (proof < 0) return `no standalone literal test of "${expected}"`;
  if (strict < 0 || strict > proof) return "no strict mode before the literal test";
  if (lines.slice(0, use).some((line) => /^set \+[a-z]*e/.test(line))) return "strict mode disabled before use";
  if (contract < 0 || contract > derivation) return "topology contract not selected before the derivation";
  if (writes !== 1) return `WORKER_NAME written ${writes} times; only the contract derivation may write it`;
  if (proof < derivation || proof > use) return "the literal test is not between the derivation and the first use";
  return "proven";
}

/**
 * Resolves every Worker-selecting Wrangler invocation in the workflow with the
 * locked resolvers. `$WORKER_NAME` is replaced by the reviewed name only inside
 * a step that proves it; any other use is a violation.
 */
function workflowWorkerTargetViolations(workflow, { resolvers, configFor, workerName }) {
  const errors = [];
  const seen = { legacy: 0, plain: 0 };
  let provenSteps = 0;
  for (const step of workflow.split(/^      - name: /m)) {
    const title = step.split("\n")[0];
    const text = executableShellText(step);
    const usesWorkerName = WORKER_NAME_USE.test(text);
    const proof = usesWorkerName ? workerNameProof(text, workerName) : undefined;
    if (proof === "proven") provenSteps += 1;
    else if (usesWorkerName) errors.push(`${title}: ${proof}`);
    for (const invocation of wranglerInvocations(text)) {
      const env = commandFlag(invocation, "--env");
      let name = commandFlag(invocation, "--name");
      const kind = WRANGLER_WORKER_INVOCATIONS.find(({ pattern }) => pattern.test(invocation));
      if (!kind) {
        if ((env ?? name) !== undefined) errors.push(`unclassified Worker-selecting subcommand: ${invocation}`);
        continue;
      }
      if (name === "$WORKER_NAME" || name === "${WORKER_NAME}") {
        if (proof !== "proven") continue;
        name = workerName;
      }
      if (env !== "openai") errors.push(`not the reviewed environment: ${invocation}`);
      else if (resolvers[kind.resolution]({ name, env }, configFor(env)) !== workerName) {
        errors.push(`resolves to a different Worker than the one the release deploys: ${invocation}`);
      }
      seen[kind.resolution] += 1;
    }
  }
  if (provenSteps < 3) errors.push(`only ${provenSteps} steps prove $WORKER_NAME; expected the capture, deploy and recovery steps`);
  if (seen.legacy === 0) errors.push("the release no longer inventories the reviewed Worker's secret names");
  if (seen.plain === 0) errors.push("the release no longer deploys and reads back the reviewed Worker");
  return errors;
}

function commandFlag(command, flag) {
  const match = command.match(new RegExp(`\\s${flag}(?:=|\\s+)("[^"]*"|'[^']*'|\\S+)`));
  return match ? match[1].replace(/^(["'])(.*)\1$/, "$2") : undefined;
}

// How each Worker-selecting subcommand of the locked Wrangler resolves its
// target. Worker-secret commands append `-<env>` to an explicit `--name`; the
// deploy, deployment and version commands use an explicit name as given.
const WRANGLER_LEGACY_NAME_COMMANDS = Object.freeze([
  "secretPutCommand",
  "secretDeleteCommand",
  "secretListCommand",
  "secretBulkCommand",
  "versionsSecretPutCommand",
  "versionsSecretDeleteCommand",
  "versionsSecretsListCommand",
  "versionsSecretBulkCommand",
]);
const WRANGLER_INLINE_NAME_COMMANDS = Object.freeze([
  "deploymentsStatusCommand",
  "versionsViewCommand",
  "versionsDeployCommand",
]);
const WRANGLER_WORKER_INVOCATIONS = Object.freeze([
  { pattern: /^wrangler (?:versions )?secret [a-z]+\b/, resolution: "legacy" },
  { pattern: /^wrangler deploy\b/, resolution: "plain" },
  { pattern: /^wrangler deployments status\b/, resolution: "plain" },
  { pattern: /^wrangler versions (?:view|deploy)\b/, resolution: "plain" },
]);

function wranglerCommandSegment(source, command) {
  const start = source.indexOf(`    ${command} = createCommand(`);
  assert.ok(start >= 0, `locked Wrangler no longer defines ${command}`);
  return source.slice(start, source.indexOf("createCommand(", start + command.length + 20));
}

test("OpenAI release workflow — every Wrangler command addresses the reviewed Worker under locked resolution", () => {
  const source = lockedWranglerSource();
  // Pin the upstream behavior this invariant depends on. A Wrangler upgrade
  // that changes any of it must fail here and be reviewed, not pass silently.
  assert.match(
    source,
    /const useServiceEnvironments2 = !\(args\["legacy-env"\] \?\? rawConfig\.legacy_env \?\? true\);/,
    "legacy (non-service) environments must remain the default",
  );
  assert.match(
    source,
    /\(rawEnv !== topLevelEnv \? rawEnv\[field\] : void 0\) \?\? transformFn\(topLevelEnv\?\.\[field\]\)/,
    "a name declared inside [env.<name>] must still win over the suffixed top-level name",
  );
  for (const command of WRANGLER_LEGACY_NAME_COMMANDS) {
    assert.match(wranglerCommandSegment(source, command), /getLegacyScriptName\(args, config\)/, `${command} resolution changed`);
  }
  const deploy = wranglerCommandSegment(source, "deployCommand");
  assert.match(deploy, /let name2 = getScriptName\(args, config\);/, "deploy resolution changed");
  assert.doesNotMatch(deploy, /getLegacyScriptName/, "deploy resolution changed");
  for (const command of WRANGLER_INLINE_NAME_COMMANDS) {
    const segment = wranglerCommandSegment(source, command);
    assert.match(segment, /const workerName = args\.name \?\? config\.name;/, `${command} resolution changed`);
    assert.doesNotMatch(segment, /getLegacyScriptName/, `${command} resolution changed`);
  }
  const getScriptNameSource = topLevelFunctionSource(source, "getScriptName");
  assert.match(getScriptNameSource, /^  return args\.name \?\? config\.name;$/m, "getScriptName changed");
  // Evaluates only resolver functions of the lockfile-pinned Wrangler bundle
  // that the release job itself executes; no repository or runtime input is
  // interpolated.
  const resolvers = new Function(
    `${topLevelFunctionSource(source, "useServiceEnvironments")}\n`
      + `${topLevelFunctionSource(source, "getLegacyScriptName")}\n`
      + `${getScriptNameSource}\n`
      + "return { legacy: getLegacyScriptName, plain: getScriptName };",
  )();

  const toml = readFileSync(OPENAI_WRANGLER, "utf8");
  assert.doesNotMatch(toml, /^\s*legacy_env\s*=/m, "the resolution below assumes Wrangler's default legacy environments");
  const workerName = JSON.parse(readFileSync(OPENAI_TOPOLOGY, "utf8")).workerName;
  assert.equal(workerName, "frihet-openai-mcp");
  assert.equal(
    wranglerTableName(toml, "env.openai"),
    workerName,
    "[env.openai] must name the reviewed Worker so `--env openai` alone addresses it",
  );
  const configFor = (environment) => ({
    name: wranglerTableName(toml, environment ? `env.${environment}` : ""),
    legacy_env: true,
    legacy: {},
  });
  // The trap itself, executed against the locked resolvers.
  assert.equal(resolvers.legacy({ name: workerName, env: "openai" }, configFor("openai")), `${workerName}-openai`);
  assert.equal(resolvers.plain({ name: workerName, env: "openai" }, configFor("openai")), workerName);

  const workflow = readFileSync(OPENAI_WORKFLOW, "utf8");
  const context = { resolvers, configFor, workerName };
  assert.deepEqual(workflowWorkerTargetViolations(workflow, context), []);

  // Mutants: each must be reported, so the proof above is not vacuous.
  const proofLine = `test "$WORKER_NAME" = "${workerName}"`;
  const mutants = {
    "proof lines deleted": workflow.replaceAll(`          ${proofLine}\n`, ""),
    "full-host Worker without a proof": workflow
      .replaceAll(WORKER_NAME_DERIVATION, "WORKER_NAME=frihet-remote-mcp")
      .replaceAll(`          ${proofLine}\n`, ""),
    "full-host Worker reassigned after the proof": workflow.replaceAll(
      `          ${proofLine}\n`,
      `          ${proofLine}\n          WORKER_NAME=frihet-remote-mcp\n`,
    ),
    "proof neutralized": workflow.replaceAll(proofLine, `${proofLine} || true`),
    "proof of the full-host name": workflow.replaceAll(proofLine, 'test "$WORKER_NAME" = "frihet-remote-mcp"'),
    "secret inventory with an explicit name": workflow.replace(
      "--env openai --format json",
      '--env openai --name "$WORKER_NAME" --format json',
    ),
  };
  for (const [label, mutant] of Object.entries(mutants)) {
    assert.notEqual(mutant, workflow, `${label}: mutant must apply`);
    assert.notDeepEqual(workflowWorkerTargetViolations(mutant, context), [], `${label} must be reported`);
  }
});

test("OpenAI topology bootstrap — the locked Wrangler facts the runbook states still hold", () => {
  const source = lockedWranglerSource();
  const guide = readFileSync(OPENAI_BOOTSTRAP_GUIDE, "utf8");

  // "has no deploy option that uploads secret values"
  assert.equal(source.includes("secrets-file"), false, "re-review the secret step if Wrangler gains this option");
  const deployArgs = [...wranglerCommandSegment(source, "deployCommand").matchAll(/^ {8}"?([a-z][a-z-]*)"?: \{$/gm)]
    .map((match) => match[1]);
  assert.ok(deployArgs.includes("dry-run") && deployArgs.includes("var"), "deploy argument list not found");
  assert.deepEqual(deployArgs.filter((arg) => /secret/.test(arg)), [], "deploy must still have no secret-value option");
  assert.match(guide, /has no deploy option that uploads secret values/);

  // "the `put` subcommand, when the value is piped, creates that Worker without asking"
  assert.match(
    wranglerCommandSegment(source, "secretPutCommand"),
    /if \(isWorkerNotFoundError\(e9\)\) \{\s+const result = await createDraftWorker\(/,
  );
  assert.match(topLevelFunctionSource(source, "createDraftWorker"), /\{ defaultValue: true, fallbackValue: true \}/);
  assert.match(topLevelFunctionSource(source, "confirm"), /if \(isNonInteractiveOrCI\(\)\) \{[\s\S]*?return fallbackValue;/);
  assert.match(guide, /creates that Worker without asking/);
});
