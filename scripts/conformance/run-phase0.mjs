#!/usr/bin/env node
/**
 * Phase 0 of issue #1578 — official external conformance baseline for the
 * CURRENT Frihet MCP v1 server, before any SDK v2 work.
 *
 *   node scripts/conformance/run-phase0.mjs            # run and rewrite the baseline
 *   node scripts/conformance/run-phase0.mjs --check    # run and fail if the baseline moved
 *
 * Requires network (npx fetches the pinned harnesses) and spawns processes, so it
 * is a local/manual gate. The committed artifact is what CI validates offline via
 * `npm run gate:conformance-baseline`.
 *
 * Isolation: the server under test always runs with FRIHET_DEMO=1 and a scrubbed
 * env with no FRIHET_API_KEY, so it serves fixtures and cannot reach the API.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFORMANCE_PKG, CONFORMANCE_VERSION, INSPECTOR_PKG, INSPECTOR_VERSION } from "./pinned-versions.mjs";
import { compareIgnoringProvenance } from "./provenance.mjs";
import { buildMatrix, parseChecks, summarise, ParseError } from "./classify.mjs";
import { validateBaseline } from "./validate-baseline.mjs";
import { CASES, judgeCase, runCase } from "./inspector-smoke.mjs";
import { buildEvidence } from "./evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const OUT_DIR = join(REPO, "docs", "conformance", "phase0");
const RAW_DIR = join(OUT_DIR, "raw");
const SERVER_ENTRY = join(REPO, "dist", "index.js");
const CHECK_MODE = process.argv.includes("--check");

const SCRUBBED_ENV = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

function sh(command, args, options = {}) {
  return new Promise((res) => {
    const child = spawn(command, args, { env: SCRUBBED_ENV, stdio: ["ignore", "pipe", "pipe"], ...options });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => res({ code, stdout: out, stderr: err }));
  });
}

const npxConformance = (...args) =>
  sh("npx", ["--yes", `${CONFORMANCE_PKG}@${CONFORMANCE_VERSION}`, ...args]);

/**
 * The registry integrity hash of the exact tarball the harness ran from.
 *
 * Recording the version string alone would pin a name, not an artifact: a
 * republished 0.1.16 would be invisible. This is what makes "conformanceVersion"
 * mean something a year from now. `null` if the registry is unreachable — the
 * run still completes, and the null is visible in the baseline rather than
 * papered over with a guess.
 */
async function tarballIntegrity(spec) {
  const { code, stdout } = await sh("npm", ["view", spec, "dist.integrity"]);
  if (code !== 0) return null;
  const value = stdout.trim();
  return value.startsWith("sha") ? value : null;
}

async function waitForFile(path, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${path}`);
}

/** `conformance list --server` is the authority on what exists; never hardcode it. */
function parseDeclaredScenarios(stdout) {
  const scenarios = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*-\s+([a-z0-9-]+)\s+\[/.exec(line);
    if (match) scenarios.push(match[1]);
  }
  if (scenarios.length === 0) {
    throw new ParseError("could not parse any scenario from `conformance list --server`");
  }
  return scenarios;
}

/** Collect checks.json from every `<suite>/server-<scenario>-<timestamp>/` directory. */
function collectResults(dir, declared) {
  const results = [];
  const parseErrors = [];
  if (!existsSync(dir)) return { results, parseErrors };
  for (const entry of readdirSync(dir)) {
    const scenario = declared.find(
      (s) => entry === `server-${s}` || entry.startsWith(`server-${s}-20`),
    );
    if (!scenario) continue;
    const file = join(dir, entry, "checks.json");
    try {
      results.push({ scenario, checks: parseChecks(scenario, readFileSync(file, "utf8")) });
    } catch (error) {
      const detail = String(error instanceof Error ? error.message : error);
      parseErrors.push({ scenario, detail });
      results.push({ scenario, parseError: detail });
    }
  }
  return { results, parseErrors };
}

/** One JSON-RPC round trip over the bridge, used for the initialize probe and the inventory. */
async function rpc(url, sessionId, body) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  const messages = [];
  for (const line of text.split("\n")) {
    const payload = line.startsWith("data: ") ? line.slice(6) : line;
    if (!payload.trim()) continue;
    try {
      messages.push(JSON.parse(payload));
    } catch {
      /* SSE framing lines are not all JSON */
    }
  }
  return { sessionId: response.headers.get("mcp-session-id") ?? sessionId, messages };
}

/**
 * What the server actually exposes. Without this the runner cannot tell a real
 * exercise from the harness poking at a fixture that does not exist here.
 */
async function probeInventory(url) {
  const init = await rpc(url, undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "frihet-phase0-probe", version: "0" },
    },
  });
  const initializeResult = init.messages.find((m) => m.result?.protocolVersion)?.result;
  if (!initializeResult) throw new ParseError("initialize probe returned no parsable result");
  const sid = init.sessionId;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  const pick = async (id, method, key, field) => {
    const r = await rpc(url, sid, { jsonrpc: "2.0", id, method, params: {} });
    const list = r.messages.find((m) => m.result?.[key])?.result?.[key];
    if (!Array.isArray(list)) throw new ParseError(`${method} returned no ${key}`);
    return list.map((x) => x[field]);
  };

  return {
    initializeResult,
    inventory: {
      tools: await pick(2, "tools/list", "tools", "name"),
      resources: await pick(3, "resources/list", "resources", "uri"),
      prompts: await pick(4, "prompts/list", "prompts", "name"),
    },
  };
}

async function main() {
  if (!existsSync(SERVER_ENTRY)) {
    console.error(`Build first — ${SERVER_ENTRY} does not exist (npm run build).`);
    process.exit(2);
  }
  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(join(RAW_DIR, "conformance"), { recursive: true });

  const git = await sh("git", ["rev-parse", "HEAD"], { cwd: REPO });
  const serverSha = git.stdout.trim();
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const sdkVersion = JSON.parse(
    readFileSync(join(REPO, "node_modules", "@modelcontextprotocol", "sdk", "package.json"), "utf8"),
  ).version;

  // Confirm the harness that ran is the harness we pinned, rather than assuming
  // npx honoured the spec.
  const conformanceSelfReport = await npxConformance("--version");
  const observedConformanceVersion = conformanceSelfReport.stdout.trim();
  if (observedConformanceVersion !== CONFORMANCE_VERSION) {
    console.error(
      `RED — pinned conformance ${CONFORMANCE_VERSION} but the CLI reports "${observedConformanceVersion}".`,
    );
    process.exit(1);
  }
  // The Inspector CLI has no version flag — `--version` is parsed as a target and
  // hangs waiting to connect — so its identity is pinned by tarball hash only.
  const harnessIntegrity = {
    conformance: await tarballIntegrity(`${CONFORMANCE_PKG}@${CONFORMANCE_VERSION}`),
    inspector: await tarballIntegrity(`${INSPECTOR_PKG}@${INSPECTOR_VERSION}`),
  };

  const readyFile = join(RAW_DIR, ".bridge-ready.json");
  const transcriptFile = join(RAW_DIR, "bridge-transcript.json");
  rmSync(readyFile, { force: true });
  // Deleted before the run, required after it. Without both, the fixture
  // detector fails OPEN: a missing transcript silently produced `segments = {}`,
  // every row lost its `unknownFixtures`, and the two scenarios the harness
  // false-greens (`tools-call-simple-text`, `tools-call-error`) walked back in
  // as PASS with the baseline still reporting GREEN. A stale transcript from a
  // previous run was the quieter version of the same failure.
  rmSync(transcriptFile, { force: true });

  const bridge = spawn(
    process.execPath,
    [
      join(HERE, "http-bridge.mjs"),
      "--port", "0",
      "--server-entry", SERVER_ENTRY,
      "--ready-file", readyFile,
      "--transcript", transcriptFile,
    ],
    { env: SCRUBBED_ENV, stdio: ["ignore", "pipe", "pipe"], cwd: REPO },
  );
  let bridgeStopped = false;
  let bridgeLog = "";
  bridge.stdout.on("data", (d) => (bridgeLog += d));
  bridge.stderr.on("data", (d) => (bridgeLog += d));

  const commands = [];
  let baseline;
  let evidence;
  let relayErrors = [];
  let relayedTotal = 0;
  try {
    const { url } = await waitForFile(readyFile);

    const { initializeResult, inventory } = await probeInventory(url);

    const list = await npxConformance("list", "--server");
    commands.push({ id: "conformance-list", argv: `${CONFORMANCE_PKG}@${CONFORMANCE_VERSION} list --server`, exitCode: list.code });
    const declared = parseDeclaredScenarios(list.stdout);
    writeFileSync(join(RAW_DIR, "conformance-list.txt"), list.stdout);

    const results = [];
    const parseErrors = [];
    // One scenario per invocation. The suite runner is faster, but it interleaves
    // every scenario's traffic into one transcript, and without per-scenario
    // attribution a fixture-only "pass" is invisible.
    for (const scenario of declared) {
      await fetch(`${url.replace(/\/mcp$/, "")}/_mark?tag=${encodeURIComponent(scenario)}`, { method: "POST" });
      const scenarioDir = join(RAW_DIR, "conformance", scenario);
      rmSync(scenarioDir, { recursive: true, force: true });
      const run = await npxConformance("server", "--url", url, "--scenario", scenario, "-o", scenarioDir);
      commands.push({
        id: `conformance-${scenario}`,
        argv: `${CONFORMANCE_PKG}@${CONFORMANCE_VERSION} server --url <bridge> --scenario ${scenario} -o raw/conformance/${scenario}`,
        exitCode: run.code,
      });
      writeFileSync(join(RAW_DIR, "conformance", `${scenario}.log`), run.stdout + run.stderr);
      const collected = collectResults(scenarioDir, [scenario]);
      results.push(...collected.results);
      parseErrors.push(...collected.parseErrors);
    }
    await fetch(`${url.replace(/\/mcp$/, "")}/_mark?tag=post-run`, { method: "POST" });

    const rules = JSON.parse(readFileSync(join(HERE, "applicability.json"), "utf8")).rules;

    // The bridge only flushes its transcript on shutdown, so the segments are
    // read back after the harness runs but before the matrix is built.
    bridge.kill("SIGTERM");
    bridgeStopped = true;
    await new Promise((r) => setTimeout(r, 900));
    if (!existsSync(transcriptFile)) {
      throw new Error(
        `the relay wrote no transcript at ${transcriptFile} — without it the missing-fixture detector is blind and every result would be unattributable`,
      );
    }
    const relayed = JSON.parse(readFileSync(transcriptFile, "utf8"));
    relayErrors = relayed.relayErrors ?? [];
    const segments = {};
    for (const message of relayed.transcript) {
      (segments[message.tag] ??= []).push(message);
    }
    if (relayed.transcript.length === 0) {
      throw new Error("the relay transcript is empty — no message reached the server");
    }
    relayedTotal = relayed.transcript.length;

    const { matrix, undeclared } = buildMatrix({
      declaredScenarios: declared,
      results,
      rules,
      capabilities: initializeResult.capabilities ?? {},
      segments,
      inventory,
    });

    const inspectorCases = [];
    for (const testCase of CASES) {
      const execution = await runCase(testCase, {
        inspectorVersion: INSPECTOR_VERSION,
        serverEntry: SERVER_ENTRY,
      });
      const verdict = judgeCase(testCase, execution);
      inspectorCases.push({
        id: testCase.id,
        intent: testCase.intent,
        status: verdict.status,
        exitCode: execution.code,
        expectedExitCode: testCase.expectExit,
        provesServerBehavior: testCase.provesServerBehavior,
        reasons: verdict.reasons.filter(Boolean),
      });
      commands.push({
        id: `inspector-${testCase.id}`,
        argv: `${INSPECTOR_PKG}@${INSPECTOR_VERSION} --cli node dist/index.js -e FRIHET_DEMO=1 ${testCase.args.join(" ")}`,
        exitCode: execution.code,
      });
    }

    evidence = buildEvidence({
      declaredScenarios: declared,
      results,
      segments,
      versions: {
        serverSha,
        conformanceVersion: CONFORMANCE_VERSION,
        inspectorVersion: INSPECTOR_VERSION,
      },
    });

    baseline = {
      issue: "berthelius/Frihet-ERP#1578 Phase 0",
      generatedBy: "scripts/conformance/run-phase0.mjs",
      deterministic:
        "No timestamps, ports, session ids or durations are recorded — rerunning on the same SHA must produce a byte-identical file.",
      versions: {
        serverSha,
        serverPackageVersion: pkg.version,
        sdkVersion,
        sdkDeclaredRange: pkg.dependencies?.["@modelcontextprotocol/sdk"] ?? "unknown",
        protocolVersion: initializeResult.protocolVersion,
        conformanceVersion: CONFORMANCE_VERSION,
        inspectorVersion: INSPECTOR_VERSION,
        nodeVersion: process.version,
      },
      harnessIntegrity,
      target: {
        transport: "stdio",
        mode: "FRIHET_DEMO=1 (fixtures, no network, no FRIHET_API_KEY present)",
        reachedVia:
          "scripts/conformance/http-bridge.mjs — verbatim JSON-RPC relay, required because the official server harness speaks Streamable HTTP only",
        advertisedCapabilities: initializeResult.capabilities ?? {},
        serverInfoName: initializeResult.serverInfo?.name,
        inventoryCounts: {
          tools: inventory.tools.length,
          resources: inventory.resources.length,
          prompts: inventory.prompts.length,
        },
      },
      conformance: {
        relayedMessages: relayedTotal,
        declaredScenarios: declared,
        matrix: matrix.sort((a, b) => a.scenario.localeCompare(b.scenario)),
        counts: summarise(matrix),
        parseErrors,
        undeclared,
      },
      inspector: { cases: inspectorCases },
      relayErrors,
      commands,
    };
  } finally {
    if (!bridgeStopped) {
      bridge.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 700));
    }
    writeFileSync(join(RAW_DIR, "bridge.log"), bridgeLog);
    rmSync(readyFile, { force: true });
  // Deleted before the run, required after it. Without both, the fixture
  // detector fails OPEN: a missing transcript silently produced `segments = {}`,
  // every row lost its `unknownFixtures`, and the two scenarios the harness
  // false-greens (`tools-call-simple-text`, `tools-call-error`) walked back in
  // as PASS with the baseline still reporting GREEN. A stale transcript from a
  // previous run was the quieter version of the same failure.
  rmSync(transcriptFile, { force: true });
  }

  const { ok, violations } = validateBaseline(baseline, evidence);
  const artifacts = [
    { file: "baseline.json", body: `${JSON.stringify(baseline, null, 2)}\n`, value: baseline },
    { file: "evidence.json", body: `${JSON.stringify(evidence, null, 2)}\n`, value: evidence },
  ];

  const provenanceNotes = [];

  for (const { file, body, value } of artifacts) {
    const target = join(OUT_DIR, file);
    if (!CHECK_MODE) {
      writeFileSync(target, body);
      continue;
    }
    if (!existsSync(target)) {
      writeFileSync(join(RAW_DIR, `${file}.actual`), body);
      console.error(`RED — ${file} is not committed. Diff raw/${file}.actual against ${file}.`);
      process.exit(1);
    }

    // Compare the RESULT, not the identity of the run. `versions.serverSha` is
    // `git rev-parse HEAD`, so a byte comparison turns red on every commit —
    // including one that changes nothing the harness can observe. Everything
    // else, including the SDK/protocol/harness versions, the inventory counts
    // and the full scenario matrix, is still compared byte for byte.
    // See scripts/conformance/provenance.mjs.
    const committedValue = JSON.parse(readFileSync(target, "utf8"));
    const { equal, provenance } = compareIgnoringProvenance(value, committedValue);
    if (!equal) {
      writeFileSync(join(RAW_DIR, `${file}.actual`), body);
      console.error(`RED — ${file} drifted. Diff raw/${file}.actual against ${file}.`);
      process.exit(1);
    }
    for (const entry of provenance) {
      if (entry.observed !== entry.committed) {
        provenanceNotes.push(`${file}:${entry.pointer} captured at ${entry.committed}, ran at ${entry.observed}`);
      }
    }
  }

  if (!ok) {
    console.error(`RED — ${violations.length} anti-false-green violation(s):`);
    for (const v of violations) console.error(`  [${v.rule}] ${v.detail}`);
    process.exit(1);
  }
  const c = baseline.conformance.counts;
  console.log(
    `GREEN — ${baseline.conformance.matrix.length} official scenarios ` +
      `(PASS=${c.PASS} FAIL_SERVER=${c.FAIL_SERVER} FAIL_HARNESS=${c.FAIL_HARNESS} ` +
      `NOT_APPLICABLE=${c.NOT_APPLICABLE} NOT_EXERCISED=${c.NOT_EXERCISED}), ` +
      `${baseline.inspector.cases.length} inspector cases.`,
  );
  // Not a failure, but not discarded either: the operator should be able to see
  // that the committed baseline was captured at a different commit.
  for (const note of provenanceNotes) console.log(`  provenance — ${note}`);
}

main().catch((error) => {
  console.error(`RED — Phase 0 run failed: ${String(error?.stack ?? error)}`);
  process.exit(1);
});
