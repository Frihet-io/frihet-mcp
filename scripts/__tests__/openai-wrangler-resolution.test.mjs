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

/** Every executable Wrangler invocation, with shell line continuations joined. */
function wranglerInvocations(yaml) {
  const joined = yaml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .replace(/\\\n\s*/g, " ");
  return [...joined.matchAll(/\bwrangler [^\n]*/g)].map((match) => match[0]);
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

  // `$WORKER_NAME` stands for the reviewed Worker only where the same step
  // derives it from the topology contract and asserts it before any use.
  const workflow = readFileSync(OPENAI_WORKFLOW, "utf8");
  for (const step of workflow.split(/^      - name: /m).slice(1)) {
    const firstUse = step.search(/wrangler [^\n]*\$\{?WORKER_NAME/);
    if (firstUse < 0) continue;
    const proof = step.indexOf('test "$WORKER_NAME" = "frihet-openai-mcp"');
    assert.ok(
      step.includes("WORKER_NAME=\"$(jq -r '.workerName // \"\"' \"$CONTRACT\")\"") && proof >= 0 && proof < firstUse,
      `step "${step.split("\n")[0]}" uses $WORKER_NAME before proving it`,
    );
  }

  const seen = { legacy: 0, plain: 0 };
  for (const invocation of wranglerInvocations(workflow)) {
    const env = commandFlag(invocation, "--env");
    let name = commandFlag(invocation, "--name");
    const kind = WRANGLER_WORKER_INVOCATIONS.find(({ pattern }) => pattern.test(invocation));
    if (!kind) {
      assert.equal(env ?? name, undefined, `${invocation} selects a Worker through an unclassified subcommand`);
      continue;
    }
    if (name === "$WORKER_NAME" || name === "${WORKER_NAME}") name = workerName;
    assert.equal(env, "openai", `${invocation} must select the reviewed environment`);
    assert.equal(
      resolvers[kind.resolution]({ name, env }, configFor(env)),
      workerName,
      `${invocation} resolves to a different Worker than the one the release deploys`,
    );
    seen[kind.resolution] += 1;
  }
  assert.ok(seen.legacy > 0, "the release must inventory the reviewed Worker's secret names");
  assert.ok(seen.plain > 0, "the release must deploy and read back the reviewed Worker");
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
