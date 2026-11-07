#!/usr/bin/env node
// Published-artifact drift detector (issue #154).
//
// The defect class this exists for: every internal gate stays green while what
// `npx -y @frihet/mcp-server` actually runs diverges from this repo. `audit:mcp-refs`
// cannot see it — it checks that the repo's own refs match package.json, which is
// internal consistency. Both sides said 1.16.6 for 23 commits, two of them
// `fix(security)`, and nothing went red for 20 days.
//
// The anchor is npm's `gitHead`: the packument records the commit HEAD pointed at
// when the tarball was built. Verified for 1.16.6 on 26 Aug 2026 — the published
// tarball's 50 dist/*.js files are byte-identical to a rebuild at 40222f4, so the
// field is load-bearing here, not decorative. When it is absent or unreachable in
// this repo's history the detector says UNVERIFIABLE rather than guessing.
//
// The hosted server at mcp.frihet.io is the third surface: its /health `version` is
// compared with npm 'latest', because a remote that lags npm serves different code
// to remote users than `npx` users get.
//
// Usage:
//   node scripts/published-artifact-drift.mjs                    # live check (exit != 0 on drift)
//   node scripts/published-artifact-drift.mjs --json             # machine-readable
//   node scripts/published-artifact-drift.mjs --json-out <file>  # text report, plus the
//       verdict as one-line JSON in <file> (read by scripts/published-drift-issue.mjs)
//
// Exit codes (lowest wins when several findings apply):
//   0 = OK
//   1 = PUBLISHED_SURFACE_DRIFT — package.json version equals the published version
//       while commits touching the published surface have landed since. The version
//       number is lying about its content. This is #154.
//   2 = UNPUBLISHED_VERSION — repo version is ahead of npm. A release was cut and
//       never published; users still get the old bytes.
//   3 = REGISTRY_BEHIND_NPM — the MCP Registry serves an older version than npm.
//       `publish-mcp-registry.yml` fires on `release: published`, so a publish
//       without a GitHub release leaves the registry behind silently.
//   4 = REPO_BEHIND_NPM — npm serves a version this repo has never reached.
//   5 = UNVERIFIABLE — network failure, missing gitHead, or an anchor commit that
//       is not in this repo's history. Fail-closed: an unmeasurable surface is not
//       a green one.
//   6 = REMOTE_VERSION_DRIFT — https://mcp.frihet.io/health reports a version other
//       than npm 'latest' (behind or ahead).
//   7 = REMOTE_UNVERIFIABLE — the health endpoint was unreachable after retries,
//       answered non-2xx, or carried no parseable `version`. Fail-closed, and kept
//       apart from 5 so an outage of the hosted server is not read as an npm or
//       registry lookup failure.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PACKAGE_NAME = "@frihet/mcp-server";
export const REGISTRY_SERVER_NAME = "io.frihet/erp";
export const REMOTE_HEALTH_URL = "https://mcp.frihet.io/health";

// Paths whose content ends up in — or changes — the published tarball.
// Derived from package.json `files`: dist (built from src/), scripts/postinstall.js,
// assets/, README.md, LICENSE. tsconfig.json and package.json are here because they
// change the emitted bytes or the consumer's install, not because they are shipped.
//
// Frozen and pinned by scripts/__tests__/published-artifact-drift.test.mjs. Widening
// this list is how a gate gets quietly neutered, so the test asserts the exact
// contents — extending it requires editing the assertion in the same diff.
export const PUBLISHED_SURFACE = Object.freeze({
  prefixes: Object.freeze(["src/", "assets/"]),
  exact: Object.freeze([
    "package.json",
    "tsconfig.json",
    "README.md",
    "LICENSE",
    "scripts/postinstall.js",
    // Added by the #152 fan-in: `docs/agent-onboarding.json` is listed in
    // package.json `files`, so it is bytes a consumer installs. A commit that
    // regenerates the descriptor changes the tarball without touching src/,
    // and without this entry that change would be invisible to the detector.
    "docs/agent-onboarding.json",
  ]),
  // dist/__tests__ is excluded from the tarball by package.json `files`, so changes
  // under src/__tests__ cannot reach a consumer.
  excludedPrefixes: Object.freeze(["src/__tests__/"]),
});

export const VERDICTS = Object.freeze({
  OK: 0,
  PUBLISHED_SURFACE_DRIFT: 1,
  UNPUBLISHED_VERSION: 2,
  REGISTRY_BEHIND_NPM: 3,
  REPO_BEHIND_NPM: 4,
  UNVERIFIABLE: 5,
  REMOTE_VERSION_DRIFT: 6,
  REMOTE_UNVERIFIABLE: 7,
});

/** True when `path` would change the published tarball. */
export function isPublishedSurface(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  for (const excluded of PUBLISHED_SURFACE.excludedPrefixes) {
    if (path.startsWith(excluded)) return false;
  }
  if (PUBLISHED_SURFACE.exact.includes(path)) return true;
  for (const prefix of PUBLISHED_SURFACE.prefixes) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Compare two `x.y.z` versions. Prerelease tags sort below their release
 * (`1.17.0-beta.1` < `1.17.0`) but are not ordered against each other beyond a
 * plain string compare — this repo has published exactly one prerelease ever and
 * the gate never needs finer resolution than "is it ahead".
 * Returns -1, 0 or 1. Throws on an unparseable version rather than guessing.
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      String(v),
    );
    if (!match) throw new TypeError(`unparseable version: ${JSON.stringify(v)}`);
    return {
      nums: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] ?? null,
    };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] < right.nums[i] ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/**
 * The comparator. Pure: every live lookup is an input, so the whole verdict table
 * is exercisable offline by the test suite.
 *
 * @param {object} input
 * @param {string} input.localVersion            package.json version on this checkout
 * @param {string} input.headSha                 git rev-parse HEAD
 * @param {{version: string, gitHead: string|null}|null} input.npm  npm `latest` dist-tag
 * @param {{known: boolean, isAncestor: boolean, commitsAhead: number,
 *          changedPaths: string[]}|null} input.anchor  history between gitHead and HEAD
 * @param {{version: string}|null} input.registry       MCP Registry `isLatest` entry
 * @param {{version: string}|{error: string}|undefined} input.remote  hosted /health
 *        version, or why it could not be read. Absent counts as unverifiable.
 * @param {string[]} [input.errors]              lookup failures collected by the caller
 * @returns {{exitCode: number, findings: Array, facts: object}}
 */
export function classifyDrift(input) {
  const findings = [];
  const errors = input.errors ?? [];
  const add = (id, detail) => findings.push({ id, code: VERDICTS[id], detail });

  for (const error of errors) add("UNVERIFIABLE", error);

  if (!input.npm) {
    if (errors.length === 0) add("UNVERIFIABLE", `no npm 'latest' dist-tag for ${PACKAGE_NAME}`);
    return finish(findings, input);
  }

  // --- version axis -------------------------------------------------------
  let versionOrder = null;
  try {
    versionOrder = compareVersions(input.localVersion, input.npm.version);
  } catch (error) {
    add("UNVERIFIABLE", `version comparison failed: ${error.message}`);
  }

  if (versionOrder === 1) {
    add(
      "UNPUBLISHED_VERSION",
      `package.json is ${input.localVersion}; npm 'latest' is ${input.npm.version}. ` +
        `A version bump landed but was never published — users still install ${input.npm.version}.`,
    );
  } else if (versionOrder === -1) {
    add(
      "REPO_BEHIND_NPM",
      `npm 'latest' is ${input.npm.version}, ahead of package.json ${input.localVersion}. ` +
        `Either a publish happened off this branch or package.json was reverted.`,
    );
  }

  // --- content axis -------------------------------------------------------
  // Only meaningful when the version numbers agree: if they differ, the version
  // number is already telling the truth about the divergence.
  if (versionOrder === 0) {
    if (!input.npm.gitHead) {
      add(
        "UNVERIFIABLE",
        `npm ${PACKAGE_NAME}@${input.npm.version} carries no gitHead — content drift ` +
          `cannot be measured against a commit.`,
      );
    } else if (!input.anchor || !input.anchor.known) {
      add(
        "UNVERIFIABLE",
        `published gitHead ${short(input.npm.gitHead)} is not an object in this repository.`,
      );
    } else if (!input.anchor.isAncestor) {
      add(
        "UNVERIFIABLE",
        `published gitHead ${short(input.npm.gitHead)} is not an ancestor of HEAD ` +
          `${short(input.headSha)} — the published tarball was built off this history.`,
      );
    } else {
      const drifted = (input.anchor.changedPaths ?? []).filter(isPublishedSurface);
      if (drifted.length > 0) {
        add(
          "PUBLISHED_SURFACE_DRIFT",
          `package.json and npm both say ${input.localVersion}, but ` +
            `${input.anchor.commitsAhead} commit(s) since ${short(input.npm.gitHead)} changed ` +
            `${drifted.length} published-surface file(s). What users install is not what this ` +
            `repo contains. Bump the version and publish.`,
        );
        findings[findings.length - 1].paths = drifted;
      }
    }
  }

  // --- registry axis ------------------------------------------------------
  if (input.registry) {
    let registryOrder = null;
    try {
      registryOrder = compareVersions(input.registry.version, input.npm.version);
    } catch (error) {
      add("UNVERIFIABLE", `registry version comparison failed: ${error.message}`);
    }
    if (registryOrder === -1) {
      add(
        "REGISTRY_BEHIND_NPM",
        `MCP Registry serves ${input.registry.version}; npm serves ${input.npm.version}. ` +
          `publish-mcp-registry.yml fires on 'release: published' — cut a GitHub release.`,
      );
    }
  } else {
    add("UNVERIFIABLE", `no 'isLatest' entry for ${REGISTRY_SERVER_NAME} in the MCP Registry.`);
  }

  // --- remote axis --------------------------------------------------------
  const remote = input.remote;
  if (typeof remote?.version !== "string") {
    add("REMOTE_UNVERIFIABLE", remote?.error || `no version was read from ${REMOTE_HEALTH_URL}.`);
  } else {
    let remoteOrder = null;
    try {
      remoteOrder = compareVersions(remote.version, input.npm.version);
    } catch (error) {
      add("REMOTE_UNVERIFIABLE", `remote version comparison failed: ${error.message}`);
    }
    if (remoteOrder !== null && remoteOrder !== 0) {
      add(
        "REMOTE_VERSION_DRIFT",
        `${REMOTE_HEALTH_URL} reports ${remote.version}; npm 'latest' is ${input.npm.version}. ` +
          `The hosted server is ${remoteOrder < 0 ? "behind" : "ahead of"} what npm users install.`,
      );
    }
  }

  return finish(findings, input);
}

function finish(findings, input) {
  const exitCode = findings.length === 0 ? VERDICTS.OK : Math.min(...findings.map((f) => f.code));
  findings.sort((a, b) => a.code - b.code);
  return {
    exitCode,
    findings,
    facts: {
      localVersion: input.localVersion,
      headSha: input.headSha,
      npmVersion: input.npm?.version ?? null,
      npmGitHead: input.npm?.gitHead ?? null,
      registryVersion: input.registry?.version ?? null,
      remoteVersion: typeof input.remote?.version === "string" ? input.remote.version : null,
      commitsAhead: input.anchor?.commitsAhead ?? null,
    },
  };
}

const short = (sha) => (typeof sha === "string" ? sha.slice(0, 7) : String(sha));

// === live lookups ==========================================================

const FETCH_ATTEMPTS = 3;

async function fetchJson(url, errors, label, { fetchImpl = globalThis.fetch, retryDelayMs = 500 } = {}) {
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === FETCH_ATTEMPTS) {
        errors.push(`${label} unreachable after ${FETCH_ATTEMPTS} attempts: ${error.message}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
    }
  }
  return null;
}

/**
 * Reads the hosted server's version from its health endpoint. Never throws:
 * returns `{version}` or `{error}`, and classifyDrift treats `{error}` as RED.
 * `fetchImpl` and `retryDelayMs` exist so the test suite can stub the network.
 */
export async function lookupRemote(options = {}) {
  const errors = [];
  const health = await fetchJson(REMOTE_HEALTH_URL, errors, "remote MCP health", options);
  if (health === null || typeof health !== "object") {
    return { error: errors[0] ?? `${REMOTE_HEALTH_URL} did not answer with a JSON object.` };
  }
  if (typeof health.version !== "string" || health.version.length === 0) {
    return { error: `${REMOTE_HEALTH_URL} answered without a 'version' string.` };
  }
  return { version: health.version };
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

async function collect() {
  const errors = [];
  const localVersion = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
  const headSha = git(["rev-parse", "HEAD"]);

  const packument = await fetchJson(
    `https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2f")}`,
    errors,
    "npm registry",
  );
  let npm = null;
  if (packument) {
    const latest = packument["dist-tags"]?.latest;
    const manifest = latest ? packument.versions?.[latest] : null;
    if (latest && manifest) npm = { version: latest, gitHead: manifest.gitHead ?? null };
    else errors.push(`npm packument for ${PACKAGE_NAME} has no usable 'latest' manifest`);
  }

  let anchor = null;
  if (npm?.gitHead) {
    let known = false;
    try {
      known = git(["cat-file", "-t", npm.gitHead]) === "commit";
    } catch {
      known = false;
    }
    if (known) {
      let isAncestor = false;
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", npm.gitHead, headSha], { cwd: REPO });
        isAncestor = true;
      } catch {
        isAncestor = false;
      }
      const range = `${npm.gitHead}..${headSha}`;
      anchor = {
        known: true,
        isAncestor,
        commitsAhead: isAncestor ? Number(git(["rev-list", "--count", range])) : 0,
        changedPaths: isAncestor
          ? git(["diff", "--name-only", npm.gitHead, headSha]).split("\n").filter(Boolean)
          : [],
      };
    } else {
      anchor = { known: false, isAncestor: false, commitsAhead: 0, changedPaths: [] };
    }
  }

  const registryPayload = await fetchJson(
    `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(
      REGISTRY_SERVER_NAME,
    )}&version=latest`,
    errors,
    "MCP Registry",
  );
  let registry = null;
  if (registryPayload) {
    const entry = (registryPayload.servers ?? []).find(
      (s) => s.server?.name === REGISTRY_SERVER_NAME,
    );
    if (entry?.server?.version) registry = { version: entry.server.version };
  }

  const remote = await lookupRemote();

  return { localVersion, headSha, npm, anchor, registry, remote, errors };
}

/** The human-readable report, one array entry per line. Also the issue body's source. */
export function formatReport(result) {
  const f = result.facts;
  const lines = [
    `published-artifact-drift — ${PACKAGE_NAME}`,
    `  repo      ${f.localVersion} @ ${short(f.headSha)}`,
    `  npm       ${f.npmVersion ?? "?"} @ ${short(f.npmGitHead ?? "?")}` +
      (f.commitsAhead === null ? "" : `  (${f.commitsAhead} commit(s) behind HEAD)`),
    `  registry  ${f.registryVersion ?? "?"}`,
    `  remote    ${f.remoteVersion ?? "?"}`,
    "",
  ];
  if (result.findings.length === 0) {
    lines.push("GREEN — the published artifact, the registry, the hosted server and this repo agree.");
    return lines;
  }
  for (const finding of result.findings) {
    lines.push(`RED [${finding.id}] ${finding.detail}`);
    if (finding.paths) {
      for (const path of finding.paths.slice(0, 12)) lines.push(`       ${path}`);
      if (finding.paths.length > 12) lines.push(`       … ${finding.paths.length - 12} more`);
    }
  }
  lines.push("");
  lines.push("Remedy: bump the version and cut a release. Exit-code table: header of this file.");
  return lines;
}

async function main() {
  const json = process.argv.includes("--json");
  const outAt = process.argv.indexOf("--json-out");
  const outPath = outAt === -1 ? null : process.argv[outAt + 1];
  if (outAt !== -1 && (!outPath || outPath.startsWith("--"))) {
    throw new Error("--json-out needs a file path");
  }
  const result = classifyDrift(await collect());

  // Compact on purpose: one line, so the workflow can hand it on as a step output.
  if (outPath) writeFileSync(outPath, JSON.stringify(result));
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log(formatReport(result).join("\n"));
  }
  process.exit(result.exitCode);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`published-artifact-drift crashed: ${error.stack ?? error.message}`);
    process.exit(VERDICTS.UNVERIFIABLE);
  });
}
