/**
 * Anti-defang tests for the published-artifact drift detector (issue #154).
 *
 * A gate whose surface list can be widened is a gate that can be switched off in
 * a one-line diff nobody reads. So the surface list is pinned to its exact
 * contents here, and every RED class is driven through the real comparator.
 *
 * The historical case is reproduced verbatim at the bottom: npm 1.16.6 published
 * at 40222f4, package.json still 1.16.6, 23 commits ahead. The detector must go
 * RED on that input, or it does not earn its place in CI.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import {
  PACKAGE_NAME,
  PUBLISHED_SURFACE,
  REMOTE_HEALTH_URL,
  VERDICTS,
  classifyDrift,
  compareVersions,
  formatReport,
  isPublishedSurface,
  lookupRemote,
} from "../published-artifact-drift.mjs";
import {
  classifyPublishAnchor,
  parseRemoteMain,
} from "../assert-publish-anchor.mjs";
import {
  ISSUE_TITLE_PREFIX,
  applyIssuePlan,
  listOpenIssues,
  parseVerdict,
  planIssue,
} from "../published-drift-issue.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));

const HEAD = "a59633895a5aef4a335728de4f61732face272fc";
const PUBLISHED_SHA = "40222f4e136f2ee0d4a7549b5c497fe724e5a6df";

/** Agreement on every axis. Each test deviates in exactly one place. */
function agreed(overrides = {}) {
  return {
    localVersion: "1.17.0",
    headSha: HEAD,
    npm: { version: "1.17.0", gitHead: HEAD },
    anchor: { known: true, isAncestor: true, commitsAhead: 0, changedPaths: [] },
    registry: { version: "1.17.0" },
    remote: { version: "1.17.0" },
    errors: [],
    ...overrides,
  };
}

const ids = (result) => result.findings.map((f) => f.id);

describe("surface list is pinned", () => {
  test("the exact contents are frozen — widening requires editing this assertion", () => {
    assert.deepEqual([...PUBLISHED_SURFACE.prefixes], ["src/", "assets/"]);
    assert.deepEqual(
      [...PUBLISHED_SURFACE.exact],
      [
        "package.json",
        "tsconfig.json",
        "README.md",
        "LICENSE",
        "scripts/postinstall.js",
        "docs/agent-onboarding.json",
      ],
    );
    assert.deepEqual([...PUBLISHED_SURFACE.excludedPrefixes], ["src/__tests__/"]);
    assert.ok(Object.isFrozen(PUBLISHED_SURFACE));
    assert.ok(Object.isFrozen(PUBLISHED_SURFACE.prefixes));
    assert.ok(Object.isFrozen(PUBLISHED_SURFACE.exact));
    assert.ok(Object.isFrozen(PUBLISHED_SURFACE.excludedPrefixes));
  });

  test("every package.json `files` entry that can carry source is represented", () => {
    // dist/ is compiled from src/, so src/ standing in for it is the contract.
    // If `files` grows a new shipped path, this fails until the surface list agrees.
    const shipped = PKG.files.filter((f) => !f.startsWith("!"));
    const covered = new Set([
      "dist",
      "README.md",
      "LICENSE",
      "scripts/postinstall.js",
      "docs/agent-onboarding.json",
    ]);
    for (const entry of shipped) {
      const known = covered.has(entry) || entry.startsWith("assets/");
      assert.ok(known, `package.json files[] entry "${entry}" is not covered by PUBLISHED_SURFACE`);
    }
  });

  test("shipped source counts, test source does not", () => {
    assert.equal(isPublishedSurface("src/index.ts"), true);
    assert.equal(isPublishedSurface("src/api-origin.ts"), true);
    assert.equal(isPublishedSurface("src/tools/invoices.ts"), true);
    assert.equal(isPublishedSurface("package.json"), true);
    assert.equal(isPublishedSurface("tsconfig.json"), true);
    assert.equal(isPublishedSurface("README.md"), true);
    assert.equal(isPublishedSurface("scripts/postinstall.js"), true);
    assert.equal(isPublishedSurface("assets/banner.svg"), true);

    assert.equal(isPublishedSurface("src/__tests__/contract.test.ts"), false);
    assert.equal(isPublishedSurface("src/__tests__/fixtures/x.json"), false);
    assert.equal(isPublishedSurface(".github/workflows/ci.yml"), false);
    assert.equal(isPublishedSurface("docs/observability.md"), false);
    assert.equal(isPublishedSurface("scripts/audit-mcp-refs.mjs"), false);
    assert.equal(isPublishedSurface("workers/remote-mcp/src/index.ts"), false);
    assert.equal(isPublishedSurface("CHANGELOG.md"), false);
    assert.equal(isPublishedSurface(""), false);
    assert.equal(isPublishedSurface(undefined), false);
  });
});

describe("version comparison", () => {
  test("orders releases", () => {
    assert.equal(compareVersions("1.16.6", "1.16.6"), 0);
    assert.equal(compareVersions("1.17.0", "1.16.6"), 1);
    assert.equal(compareVersions("1.16.6", "1.17.0"), -1);
    assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
    assert.equal(compareVersions("1.16.10", "1.16.9"), 1, "numeric, not lexicographic");
  });

  test("a prerelease sorts below its release", () => {
    assert.equal(compareVersions("1.12.0-beta.1", "1.12.0"), -1);
    assert.equal(compareVersions("1.12.0", "1.12.0-beta.1"), 1);
  });

  test("an unparseable version throws rather than comparing equal", () => {
    assert.throws(() => compareVersions("latest", "1.0.0"), TypeError);
    assert.throws(() => compareVersions("1.0", "1.0.0"), TypeError);
  });
});

describe("agreement is the only green", () => {
  test("all three axes agreeing is GREEN", () => {
    const result = classifyDrift(agreed());
    assert.deepEqual(result.findings, []);
    assert.equal(result.exitCode, VERDICTS.OK);
  });

  test("non-published churn since the publish is still GREEN", () => {
    const result = classifyDrift(
      agreed({
        anchor: {
          known: true,
          isAncestor: true,
          commitsAhead: 4,
          changedPaths: [
            "docs/observability.md",
            ".github/workflows/ci.yml",
            "src/__tests__/contract.test.ts",
            "CHANGELOG.md",
          ],
        },
      }),
    );
    assert.deepEqual(result.findings, []);
    assert.equal(result.exitCode, VERDICTS.OK);
  });
});

describe("each drift class turns it RED", () => {
  test("PUBLISHED_SURFACE_DRIFT — same version, shipped source moved", () => {
    const result = classifyDrift(
      agreed({
        anchor: {
          known: true,
          isAncestor: true,
          commitsAhead: 1,
          changedPaths: ["src/api-origin.ts", "docs/observability.md"],
        },
      }),
    );
    assert.deepEqual(ids(result), ["PUBLISHED_SURFACE_DRIFT"]);
    assert.equal(result.exitCode, VERDICTS.PUBLISHED_SURFACE_DRIFT);
    assert.deepEqual(result.findings[0].paths, ["src/api-origin.ts"]);
  });

  test("UNPUBLISHED_VERSION — bump landed, publish never ran", () => {
    const result = classifyDrift(
      agreed({ localVersion: "1.17.0", npm: { version: "1.16.6", gitHead: PUBLISHED_SHA } }),
    );
    assert.ok(ids(result).includes("UNPUBLISHED_VERSION"));
    assert.equal(result.exitCode, VERDICTS.UNPUBLISHED_VERSION);
  });

  test("REPO_BEHIND_NPM — npm serves a version this repo never reached", () => {
    const result = classifyDrift(
      agreed({ localVersion: "1.16.6", npm: { version: "1.17.0", gitHead: HEAD } }),
    );
    assert.ok(ids(result).includes("REPO_BEHIND_NPM"));
  });

  test("REGISTRY_BEHIND_NPM — publish without a GitHub release", () => {
    const result = classifyDrift(agreed({ registry: { version: "1.16.3" } }));
    assert.deepEqual(ids(result), ["REGISTRY_BEHIND_NPM"]);
    assert.equal(result.exitCode, VERDICTS.REGISTRY_BEHIND_NPM);
  });

  test("registry AHEAD of npm is not this gate's business", () => {
    const result = classifyDrift(agreed({ registry: { version: "1.18.0" } }));
    assert.deepEqual(result.findings, []);
  });
});

describe("unmeasurable is not green", () => {
  test("a lookup failure is UNVERIFIABLE, never a pass", () => {
    const result = classifyDrift(
      agreed({ npm: null, errors: ["npm registry unreachable after 3 attempts: ETIMEDOUT"] }),
    );
    assert.deepEqual(ids(result), ["UNVERIFIABLE"]);
    assert.equal(result.exitCode, VERDICTS.UNVERIFIABLE);
  });

  test("no npm data and no recorded error is still UNVERIFIABLE", () => {
    const result = classifyDrift(agreed({ npm: null, errors: [] }));
    assert.deepEqual(ids(result), ["UNVERIFIABLE"]);
  });

  test("a published version with no gitHead cannot be measured", () => {
    const result = classifyDrift(agreed({ npm: { version: "1.17.0", gitHead: null } }));
    assert.ok(ids(result).includes("UNVERIFIABLE"));
    assert.match(result.findings[0].detail, /no gitHead/);
  });

  test("a gitHead absent from this repository is UNVERIFIABLE, not clean", () => {
    const result = classifyDrift(
      agreed({
        npm: { version: "1.17.0", gitHead: "0".repeat(40) },
        anchor: { known: false, isAncestor: false, commitsAhead: 0, changedPaths: [] },
      }),
    );
    assert.ok(ids(result).includes("UNVERIFIABLE"));
    assert.match(result.findings[0].detail, /not an object in this repository/);
  });

  test("a gitHead off this history is UNVERIFIABLE, not clean", () => {
    const result = classifyDrift(
      agreed({
        npm: { version: "1.17.0", gitHead: "b".repeat(40) },
        anchor: { known: true, isAncestor: false, commitsAhead: 0, changedPaths: [] },
      }),
    );
    assert.ok(ids(result).includes("UNVERIFIABLE"));
    assert.match(result.findings[0].detail, /not an ancestor/);
  });

  test("a missing registry entry is UNVERIFIABLE, not clean", () => {
    const result = classifyDrift(agreed({ registry: null }));
    assert.deepEqual(ids(result), ["UNVERIFIABLE"]);
  });
});

describe("several findings report together and exit on the most severe", () => {
  test("surface drift plus a stale registry keeps both, exits 1", () => {
    const result = classifyDrift(
      agreed({
        registry: { version: "1.16.3" },
        anchor: {
          known: true,
          isAncestor: true,
          commitsAhead: 2,
          changedPaths: ["src/index.ts"],
        },
      }),
    );
    assert.deepEqual(ids(result), ["PUBLISHED_SURFACE_DRIFT", "REGISTRY_BEHIND_NPM"]);
    assert.equal(result.exitCode, VERDICTS.PUBLISHED_SURFACE_DRIFT);
  });
});

describe("the #154 case, reproduced", () => {
  // Live state on 26 Aug 2026: npm 'latest' 1.16.6 built at 40222f4, package.json
  // still 1.16.6, 23 commits ahead including c566ad1 and d758473 (fix(security)),
  // MCP Registry serving 1.16.3.
  const historical = {
    localVersion: "1.16.6",
    headSha: HEAD,
    npm: { version: "1.16.6", gitHead: PUBLISHED_SHA },
    anchor: {
      known: true,
      isAncestor: true,
      commitsAhead: 23,
      changedPaths: [
        "src/api-origin.ts",
        "src/observability.ts",
        "src/index.ts",
        "src/tools/fiscal.ts",
        "docs/observability.md",
        ".github/workflows/ci.yml",
      ],
    },
    registry: { version: "1.16.3" },
    // The remote axis did not exist on 26 Aug and was not measured then. It is
    // set equal to npm so this case keeps isolating the axes that were.
    remote: { version: "1.16.6" },
    errors: [],
  };

  test("goes RED on both the npm and the registry axis", () => {
    const result = classifyDrift(historical);
    assert.deepEqual(ids(result), ["PUBLISHED_SURFACE_DRIFT", "REGISTRY_BEHIND_NPM"]);
    assert.equal(result.exitCode, VERDICTS.PUBLISHED_SURFACE_DRIFT);
    assert.equal(result.facts.commitsAhead, 23);
  });

  test("names the security file the published tarball is missing", () => {
    const result = classifyDrift(historical);
    assert.ok(result.findings[0].paths.includes("src/api-origin.ts"));
  });

  test("the very first published-surface commit after the publish is enough", () => {
    // The detector must not need 23 commits of drift to speak. One does it.
    const result = classifyDrift({
      ...historical,
      anchor: { known: true, isAncestor: true, commitsAhead: 1, changedPaths: ["src/tools/fiscal.ts"] },
      registry: { version: "1.16.6" },
    });
    assert.deepEqual(ids(result), ["PUBLISHED_SURFACE_DRIFT"]);
  });
});

describe("the package it guards", () => {
  test("is the one the README tells users to install", () => {
    assert.equal(PACKAGE_NAME, PKG.name);
    const readme = readFileSync(join(REPO, "README.md"), "utf8");
    assert.ok(readme.includes(PACKAGE_NAME), "README must reference the guarded package");
  });
});

// --- publish-time anchor guard --------------------------------------------
// The detector's anchor is only honest if the tarball was built from the commit
// npm recorded. scripts/assert-publish-anchor.mjs enforces that; these pin it.

describe("publish anchor guard", () => {
  test("parses the exact remote main ref returned by git ls-remote", () => {
    assert.equal(parseRemoteMain(`${HEAD}\trefs/heads/main\n`), HEAD);
  });

  test("rejects an absent or ambiguous remote main ref", () => {
    assert.throws(() => parseRemoteMain(""), /exactly one refs\/heads\/main/u);
    assert.throws(
      () => parseRemoteMain(`${HEAD}\trefs/heads/main\n${PUBLISHED_SHA}\trefs/heads/main\n`),
      /exactly one refs\/heads\/main/u,
    );
  });

  test("a clean tree passes", () => {
    const result = classifyPublishAnchor({
      porcelain: "",
      headSha: HEAD,
      headMatchesRemote: true,
      gitMetadataIsDirectory: true,
      buildTreePresent: false,
    });
    assert.equal(result.fatal, null);
    assert.deepEqual(result.warnings, []);
  });

  test("a linked worktree is fatal because npm may omit gitHead", () => {
    const result = classifyPublishAnchor({
      porcelain: "",
      headSha: HEAD,
      headMatchesRemote: true,
      gitMetadataIsDirectory: false,
    });
    assert.deepEqual(result.fatal, [
      ".git is not a directory; publish from a full clone because npm may omit gitHead",
    ]);
  });

  test("a branch or stale commit is fatal even when it is reachable from main", () => {
    const result = classifyPublishAnchor({
      porcelain: "",
      headSha: HEAD,
      headMatchesRemote: false,
      gitMetadataIsDirectory: true,
      buildTreePresent: false,
    });
    assert.deepEqual(result.fatal, [
      `HEAD ${HEAD.slice(0, 7)} is not the exact origin/main release commit`,
    ]);
  });

  test("an ignored pre-existing dist tree is fatal", () => {
    const result = classifyPublishAnchor({
      porcelain: "",
      headSha: HEAD,
      headMatchesRemote: true,
      gitMetadataIsDirectory: true,
      buildTreePresent: true,
    });
    assert.deepEqual(result.fatal, [
      "dist exists before prepublish build; use a fresh full clone to exclude stale ignored bytes",
    ]);
  });

  test("a modified tracked file is fatal", () => {
    const result = classifyPublishAnchor({
      porcelain: " M src/index.ts\n",
      headSha: HEAD,
      headMatchesRemote: true,
    });
    assert.deepEqual(result.fatal, [" M src/index.ts"]);
  });

  test("an untracked file under a shipped path is fatal too", () => {
    // npm packs by `files`, not by git: an untracked src/ file reaches the tarball
    // while being invisible to the commit npm stamps as gitHead.
    const result = classifyPublishAnchor({
      porcelain: "?? src/backdoor.ts\n",
      headSha: HEAD,
      headMatchesRemote: true,
    });
    assert.deepEqual(result.fatal, ["?? src/backdoor.ts"]);
  });

  test("trailing whitespace and blank lines do not fabricate a dirty tree", () => {
    const result = classifyPublishAnchor({
      porcelain: "\n  \n",
      headSha: HEAD,
      headMatchesRemote: true,
    });
    assert.equal(result.fatal, null);
  });
});

// --- remote axis ------------------------------------------------------------
// mcp.frihet.io is a third distribution surface. It reported 1.16.6 on 7 Nov 2026
// while npm served 1.17.0, and no gate could see it.

/** A fetch stub that serves `responses` in order and records every URL asked for. */
function stubFetch(responses) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  };
  return { impl, calls };
}

describe("remote axis", () => {
  test("a remote that agrees with npm is GREEN", () => {
    const result = classifyDrift(agreed());
    assert.deepEqual(result.findings, []);
    assert.equal(result.facts.remoteVersion, "1.17.0");
  });

  test("REMOTE_VERSION_DRIFT — the hosted server is behind npm", () => {
    const result = classifyDrift(agreed({ remote: { version: "1.16.6" } }));
    assert.deepEqual(ids(result), ["REMOTE_VERSION_DRIFT"]);
    assert.equal(result.exitCode, VERDICTS.REMOTE_VERSION_DRIFT);
    assert.match(result.findings[0].detail, /reports 1\.16\.6; npm 'latest' is 1\.17\.0/);
    assert.match(result.findings[0].detail, /behind/);
  });

  test("REMOTE_VERSION_DRIFT — ahead of npm is drift too", () => {
    const result = classifyDrift(agreed({ remote: { version: "1.18.0" } }));
    assert.deepEqual(ids(result), ["REMOTE_VERSION_DRIFT"]);
    assert.match(result.findings[0].detail, /ahead of/);
  });

  test("a caller that forgets the remote gets RED, not GREEN", () => {
    const input = agreed();
    delete input.remote;
    const result = classifyDrift(input);
    assert.deepEqual(ids(result), ["REMOTE_UNVERIFIABLE"]);
    assert.equal(result.exitCode, VERDICTS.REMOTE_UNVERIFIABLE);
  });

  test("an unreachable remote is REMOTE_UNVERIFIABLE with its own code", () => {
    const result = classifyDrift(
      agreed({ remote: { error: "remote MCP health unreachable after 3 attempts: ETIMEDOUT" } }),
    );
    assert.deepEqual(ids(result), ["REMOTE_UNVERIFIABLE"]);
    assert.notEqual(VERDICTS.REMOTE_UNVERIFIABLE, VERDICTS.UNVERIFIABLE);
    assert.match(result.findings[0].detail, /ETIMEDOUT/);
  });

  test("an unparseable remote version is REMOTE_UNVERIFIABLE, never equal", () => {
    const result = classifyDrift(agreed({ remote: { version: "latest" } }));
    assert.deepEqual(ids(result), ["REMOTE_UNVERIFIABLE"]);
  });

  test("the live state on 7 Nov 2026 is RED on the version and remote axes", () => {
    const result = classifyDrift(
      agreed({
        localVersion: "2.0.0",
        npm: { version: "1.17.0", gitHead: PUBLISHED_SHA },
        registry: { version: "1.17.0" },
        remote: { version: "1.16.6" },
      }),
    );
    assert.deepEqual(ids(result), ["UNPUBLISHED_VERSION", "REMOTE_VERSION_DRIFT"]);
    assert.equal(result.exitCode, VERDICTS.UNPUBLISHED_VERSION);
  });
});

describe("remote lookup (stubbed fetch)", () => {
  test("reads `version` from the health endpoint and nothing else", async () => {
    const { impl, calls } = stubFetch([{ status: 200, body: { status: "ok", version: "1.16.6" } }]);
    assert.deepEqual(await lookupRemote({ fetchImpl: impl, retryDelayMs: 0 }), { version: "1.16.6" });
    assert.deepEqual(calls, [REMOTE_HEALTH_URL]);
    assert.equal(REMOTE_HEALTH_URL, "https://mcp.frihet.io/health");
  });

  test("a network failure on every attempt is an error, not a version", async () => {
    const { impl, calls } = stubFetch([new Error("getaddrinfo ENOTFOUND mcp.frihet.io")]);
    const remote = await lookupRemote({ fetchImpl: impl, retryDelayMs: 0 });
    assert.equal(remote.version, undefined);
    assert.match(remote.error, /unreachable after 3 attempts: getaddrinfo ENOTFOUND/);
    assert.equal(calls.length, 3);
    assert.deepEqual(ids(classifyDrift(agreed({ remote }))), ["REMOTE_UNVERIFIABLE"]);
  });

  test("a transient failure followed by an answer is measured", async () => {
    const { impl } = stubFetch([new Error("ECONNRESET"), { status: 200, body: { version: "1.17.0" } }]);
    assert.deepEqual(await lookupRemote({ fetchImpl: impl, retryDelayMs: 0 }), { version: "1.17.0" });
  });

  test("a non-2xx answer is an error", async () => {
    const { impl } = stubFetch([{ status: 503, body: { version: "1.17.0" } }]);
    const remote = await lookupRemote({ fetchImpl: impl, retryDelayMs: 0 });
    assert.match(remote.error, /HTTP 503/);
  });

  test("an answer without a version is an error", async () => {
    for (const body of [{ status: "ok" }, { version: "" }, { version: 116 }, null, "1.17.0"]) {
      const { impl } = stubFetch([{ status: 200, body }]);
      const remote = await lookupRemote({ fetchImpl: impl, retryDelayMs: 0 });
      assert.equal(remote.version, undefined, JSON.stringify(body));
      assert.equal(typeof remote.error, "string", JSON.stringify(body));
    }
  });
});

describe("exit-code table in the header stays true", () => {
  test("every verdict appears in the header with its exact code", () => {
    const header = readFileSync(join(REPO, "scripts/published-artifact-drift.mjs"), "utf8").split(
      "\nimport ",
    )[0];
    for (const [id, code] of Object.entries(VERDICTS)) {
      assert.match(header, new RegExp(`//\\s+${code} = ${id}\\b`), `${code} = ${id} missing from header`);
    }
    assert.equal(new Set(Object.values(VERDICTS)).size, Object.keys(VERDICTS).length, "codes are distinct");
  });
});

describe("text report", () => {
  test("names every surface and prints each finding as a RED line", () => {
    const lines = formatReport(classifyDrift(agreed({ remote: { version: "1.16.6" } })));
    assert.ok(lines.some((l) => /^ {2}remote {4}1\.16\.6$/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => l.startsWith("RED [REMOTE_VERSION_DRIFT] ")));
  });

  test("green prints GREEN and no RED line", () => {
    const lines = formatReport(classifyDrift(agreed()));
    assert.ok(lines.some((l) => l.startsWith("GREEN")));
    assert.equal(lines.some((l) => l.startsWith("RED")), false);
  });
});

// --- issue on red ---------------------------------------------------------------
// The detector was red on every one of its 177 runs (26 Aug to 7 Nov 2026) and
// nobody noticed: a red scheduled run notifies no one. scripts/published-drift-issue.mjs
// turns that red into one open issue and closes it on the next green run.

const RUN = "https://github.com/Frihet-io/frihet-mcp/actions/runs/1";
const RUN2 = "https://github.com/Frihet-io/frihet-mcp/actions/runs/2";
const red = classifyDrift(
  agreed({ localVersion: "2.0.0", npm: { version: "1.17.0", gitHead: PUBLISHED_SHA } }),
);
const green = classifyDrift(agreed());
const issue = (number, title, extra = {}) => ({ number, title, ...extra });
const unrelated = [
  issue(3, "Add support for X"),
  issue(4, `${ISSUE_TITLE_PREFIX}: UNPUBLISHED_VERSION`, { pull_request: { url: "x" } }),
];

describe("issue plan", () => {
  test("red with no open issue opens one, labelled, with the RED lines and the run URL", () => {
    const plan = planIssue({ verdict: red, openIssues: unrelated, runUrl: RUN });
    assert.equal(plan.action, "open");
    assert.equal(plan.title, `${ISSUE_TITLE_PREFIX}: UNPUBLISHED_VERSION`);
    assert.deepEqual(plan.labels, ["bug"]);
    assert.ok(plan.body.includes(RUN));
    assert.ok(plan.body.includes("RED [UNPUBLISHED_VERSION] package.json is 2.0.0; npm 'latest' is 1.17.0"));
  });

  test("red with our issue already open updates it — never a second one", () => {
    const open = [...unrelated, issue(9, `${ISSUE_TITLE_PREFIX}: UNPUBLISHED_VERSION`)];
    const plan = planIssue({ verdict: red, openIssues: open, runUrl: RUN2 });
    assert.equal(plan.action, "update");
    assert.equal(plan.number, 9);
    assert.ok(plan.body.includes(RUN2));
    assert.equal(plan.comment, null, "same findings: refresh the body, no comment");
  });

  test("a change in findings retitles the issue and comments once", () => {
    const open = [issue(9, `${ISSUE_TITLE_PREFIX}: UNPUBLISHED_VERSION`)];
    const both = classifyDrift(
      agreed({
        localVersion: "2.0.0",
        npm: { version: "1.17.0", gitHead: PUBLISHED_SHA },
        remote: { version: "1.16.6" },
      }),
    );
    const plan = planIssue({ verdict: both, openIssues: open, runUrl: RUN2 });
    assert.equal(plan.title, `${ISSUE_TITLE_PREFIX}: UNPUBLISHED_VERSION, REMOTE_VERSION_DRIFT`);
    assert.match(plan.comment, /REMOTE_VERSION_DRIFT/);
    assert.ok(plan.comment.includes(RUN2));
  });

  test("duplicates left by an old race: the oldest is updated", () => {
    const open = [issue(12, `${ISSUE_TITLE_PREFIX}: X`), issue(7, `${ISSUE_TITLE_PREFIX}: Y`)];
    assert.equal(planIssue({ verdict: red, openIssues: open, runUrl: RUN }).number, 7);
  });

  test("green closes every open drift issue and touches nothing else", () => {
    const open = [...unrelated, issue(9, `${ISSUE_TITLE_PREFIX}: A`), issue(11, `${ISSUE_TITLE_PREFIX}: B`)];
    const plan = planIssue({ verdict: green, openIssues: open, runUrl: RUN2 });
    assert.equal(plan.action, "close");
    assert.deepEqual(plan.numbers, [9, 11]);
    assert.ok(plan.comment.includes(RUN2));
  });

  test("green with nothing open does nothing", () => {
    assert.deepEqual(planIssue({ verdict: green, openIssues: unrelated, runUrl: RUN }), { action: "none" });
  });

  test("no verdict at all (detector crashed, job died) is RED, not silence", () => {
    for (const raw of [undefined, "", "   ", "{not json", "null", '{"exitCode":"0","findings":[]}', '{"exitCode":0}']) {
      const verdict = parseVerdict(raw);
      assert.equal(verdict, null, String(raw));
      const plan = planIssue({ verdict, openIssues: [], runUrl: RUN });
      assert.equal(plan.action, "open", String(raw));
      assert.equal(plan.title, `${ISSUE_TITLE_PREFIX}: NO_VERDICT`);
      assert.ok(plan.body.includes("RED [NO_VERDICT]"));
    }
  });

  test("an exit code of 0 that still carries findings is RED", () => {
    const inconsistent = { ...red, exitCode: 0 };
    assert.equal(planIssue({ verdict: inconsistent, openIssues: [], runUrl: RUN }).action, "open");
  });

  test("the verdict round-trips through the compact JSON the workflow passes along", () => {
    const raw = JSON.stringify(red);
    assert.equal(raw.includes("\n"), false, "one line, so it fits a $GITHUB_OUTPUT line");
    assert.deepEqual(parseVerdict(raw), red);
  });

  test("backticks in a finding cannot break out of the code block", () => {
    const hostile = classifyDrift(agreed({ remote: { error: "```\n@someone <img src=x>" } }));
    const plan = planIssue({ verdict: hostile, openIssues: [], runUrl: RUN });
    const fenced = plan.body.split("```text\n")[1].split("\n```")[0];
    assert.equal(fenced.includes("`"), false);
  });

  test("a huge verdict is truncated, with a pointer to the run log", () => {
    const paths = Array.from({ length: 500 }, (_, i) => `src/f${i}.ts`);
    const huge = classifyDrift(
      agreed({ anchor: { known: true, isAncestor: true, commitsAhead: 1, changedPaths: paths } }),
    );
    huge.findings[0].detail = "x".repeat(70_000);
    const plan = planIssue({ verdict: huge, openIssues: [], runUrl: RUN });
    assert.ok(plan.body.length < 65_536, "GitHub rejects issue bodies over 65536 characters");
    assert.ok(plan.body.includes(RUN));
  });
});

describe("issue plan execution (stubbed GitHub API)", () => {
  const recorder = (pages = []) => {
    const calls = [];
    const request = async (method, path, body) => {
      calls.push(body === undefined ? [method, path] : [method, path, body]);
      return method === "GET" ? (pages.shift() ?? []) : {};
    };
    return { calls, request };
  };

  test("open is one POST to /issues", async () => {
    const { calls, request } = recorder();
    await applyIssuePlan({ action: "open", title: "t", body: "b", labels: ["bug"] }, request);
    assert.deepEqual(calls, [["POST", "/issues", { title: "t", body: "b", labels: ["bug"] }]]);
  });

  test("update edits in place and comments only when asked", async () => {
    const quiet = recorder();
    await applyIssuePlan({ action: "update", number: 9, title: "t", body: "b", comment: null }, quiet.request);
    assert.deepEqual(quiet.calls, [["PATCH", "/issues/9", { title: "t", body: "b" }]]);
    const loud = recorder();
    await applyIssuePlan({ action: "update", number: 9, title: "t", body: "b", comment: "c" }, loud.request);
    assert.deepEqual(loud.calls, [
      ["PATCH", "/issues/9", { title: "t", body: "b" }],
      ["POST", "/issues/9/comments", { body: "c" }],
    ]);
  });

  test("close comments, then closes as completed", async () => {
    const { calls, request } = recorder();
    await applyIssuePlan({ action: "close", numbers: [9, 11], comment: "c" }, request);
    assert.deepEqual(calls, [
      ["POST", "/issues/9/comments", { body: "c" }],
      ["PATCH", "/issues/9", { state: "closed", state_reason: "completed" }],
      ["POST", "/issues/11/comments", { body: "c" }],
      ["PATCH", "/issues/11", { state: "closed", state_reason: "completed" }],
    ]);
  });

  test("none makes no call", async () => {
    const { calls, request } = recorder();
    await applyIssuePlan({ action: "none" }, request);
    assert.deepEqual(calls, []);
  });

  test("listing walks every page of open issues", async () => {
    const full = Array.from({ length: 100 }, (_, i) => issue(i + 1, "x"));
    const { calls, request } = recorder([full, [issue(101, `${ISSUE_TITLE_PREFIX}: A`)]]);
    const all = await listOpenIssues(request);
    assert.equal(all.length, 101);
    assert.deepEqual(calls, [
      ["GET", "/issues?state=open&per_page=100&page=1"],
      ["GET", "/issues?state=open&per_page=100&page=2"],
    ]);
  });

  test("a failing API call propagates, so the reporter job goes red too", async () => {
    const request = async () => {
      throw new Error("POST /issues: HTTP 403");
    };
    await assert.rejects(
      applyIssuePlan({ action: "open", title: "t", body: "b", labels: [] }, request),
      /HTTP 403/,
    );
  });
});
