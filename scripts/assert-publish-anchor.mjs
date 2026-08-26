#!/usr/bin/env node
// Publish-time guard for the anchor that scripts/published-artifact-drift.mjs relies on.
//
// npm stamps the packument with `gitHead` = `git rev-parse HEAD` at publish time, but
// the tarball is built from the WORKING TREE. Publish from a dirty checkout and npm
// records a commit that does not describe the bytes it shipped — after which the drift
// detector compares `main` against a commit whose tarball nobody can reproduce, and
// reports GREEN over a divergence. The whole gate rests on this being true.
//
// The invariant is stated above and enforced below, in the same file: a rule that lives
// only in prose is a rule nobody runs.
//
// Wired into `prepublishOnly`, first, before the build.
//
// Exit codes:
//   0 = clean tree; safe to publish
//   1 = dirty working tree; the recorded gitHead would not describe the tarball

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pure verdict, so the rule is testable without a dirty checkout.
 * `porcelain` is raw `git status --porcelain` output. Untracked files count:
 * `npm publish` packs by `files`/`.npmignore`, not by git, so an untracked file
 * under a shipped path reaches users while being invisible to `gitHead`.
 */
export function classifyPublishAnchor({ porcelain, headSha, headOnRemote }) {
  const dirty = String(porcelain ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const warnings = [];
  if (headOnRemote === false) {
    warnings.push(
      `HEAD ${String(headSha).slice(0, 7)} is not reachable from origin/main. npm will ` +
        `record it as gitHead; if it is never merged, the anchor becomes unresolvable.`,
    );
  }
  return { fatal: dirty.length > 0 ? dirty : null, warnings };
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

function main() {
  const headSha = git(["rev-parse", "HEAD"]);
  let headOnRemote = null;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", headSha, "origin/main"], { cwd: REPO });
    headOnRemote = true;
  } catch {
    headOnRemote = false;
  }

  const { fatal, warnings } = classifyPublishAnchor({
    porcelain: git(["status", "--porcelain"]),
    headSha,
    headOnRemote,
  });

  for (const warning of warnings) console.warn(`publish-anchor WARN — ${warning}`);

  if (fatal) {
    console.error(
      `publish-anchor RED — working tree is dirty; npm would stamp gitHead ` +
        `${headSha.slice(0, 7)} onto a tarball built from different bytes:`,
    );
    for (const entry of fatal.slice(0, 20)) console.error(`  ${entry}`);
    if (fatal.length > 20) console.error(`  … ${fatal.length - 20} more`);
    console.error("Commit, stash or clean before publishing.");
    process.exit(1);
  }

  console.log(`publish-anchor GREEN — clean tree at ${headSha.slice(0, 7)}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
