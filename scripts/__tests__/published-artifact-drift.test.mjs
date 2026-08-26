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
  VERDICTS,
  classifyDrift,
  compareVersions,
  isPublishedSurface,
} from "../published-artifact-drift.mjs";
import { classifyPublishAnchor } from "../assert-publish-anchor.mjs";

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
      ["package.json", "tsconfig.json", "README.md", "LICENSE", "scripts/postinstall.js"],
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
    const covered = new Set(["dist", "README.md", "LICENSE", "scripts/postinstall.js"]);
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
  test("a clean tree passes", () => {
    const result = classifyPublishAnchor({ porcelain: "", headSha: HEAD, headOnRemote: true });
    assert.equal(result.fatal, null);
    assert.deepEqual(result.warnings, []);
  });

  test("a modified tracked file is fatal", () => {
    const result = classifyPublishAnchor({
      porcelain: " M src/index.ts\n",
      headSha: HEAD,
      headOnRemote: true,
    });
    assert.deepEqual(result.fatal, [" M src/index.ts"]);
  });

  test("an untracked file under a shipped path is fatal too", () => {
    // npm packs by `files`, not by git: an untracked src/ file reaches the tarball
    // while being invisible to the commit npm stamps as gitHead.
    const result = classifyPublishAnchor({
      porcelain: "?? src/backdoor.ts\n",
      headSha: HEAD,
      headOnRemote: true,
    });
    assert.deepEqual(result.fatal, ["?? src/backdoor.ts"]);
  });

  test("trailing whitespace and blank lines do not fabricate a dirty tree", () => {
    const result = classifyPublishAnchor({ porcelain: "\n  \n", headSha: HEAD, headOnRemote: true });
    assert.equal(result.fatal, null);
  });

  test("publishing off origin/main warns without blocking", () => {
    const result = classifyPublishAnchor({ porcelain: "", headSha: HEAD, headOnRemote: false });
    assert.equal(result.fatal, null);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /not reachable from origin\/main/);
  });
});
