#!/usr/bin/env node
// Publish-time guard for the anchor that scripts/published-artifact-drift.mjs relies on.
//
// npm stamps the packument with `gitHead` = `git rev-parse HEAD` at publish time, but
// the tarball is built from the WORKING TREE. Publish from a dirty checkout and npm
// records a commit that does not describe the bytes it shipped. npm 10 also omits
// `gitHead` when publishing from a linked worktree because `.git` is a file there.
// Either case destroys the anchor that the drift detector relies on.
//
// The invariant is stated above and enforced below, in the same file: a rule that lives
// only in prose is a rule nobody runs.
//
// Wired into `prepublishOnly`, first, before the build.
//
// Exit codes:
//   0 = clean full clone; safe to publish
//   1 = stale/non-main HEAD, dirty tree, linked worktree, or prebuilt dist;
//       gitHead would be false, absent, or would not name the released main commit

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pure verdict, so the rule is testable without a dirty checkout.
 * `porcelain` is raw `git status --porcelain` output. Untracked files count:
 * `npm publish` packs by `files`/`.npmignore`, not by git, so an untracked file
 * under a shipped path reaches users while being invisible to `gitHead`.
 */
export function classifyPublishAnchor({
  porcelain,
  headSha,
  headMatchesRemote = true,
  gitMetadataIsDirectory = true,
  buildTreePresent = false,
}) {
  const dirty = String(porcelain ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (!gitMetadataIsDirectory) {
    dirty.unshift(
      ".git is not a directory; publish from a full clone because npm may omit gitHead",
    );
  }
  if (!headMatchesRemote) {
    dirty.unshift(
      `HEAD ${String(headSha).slice(0, 7)} is not the exact origin/main release commit`,
    );
  }
  if (buildTreePresent) {
    dirty.unshift(
      "dist exists before prepublish build; use a fresh full clone to exclude stale ignored bytes",
    );
  }
  const warnings = [];
  return { fatal: dirty.length > 0 ? dirty : null, warnings };
}

export function parseRemoteMain(output) {
  const matches = String(output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.match(/^([a-f0-9]{40})\s+refs\/heads\/main$/u))
    .filter(Boolean);

  if (matches.length !== 1) {
    throw new Error("origin did not return exactly one refs/heads/main commit");
  }
  return matches[0][1];
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

function main() {
  const headSha = git(["rev-parse", "HEAD"]);
  let remoteHead;
  try {
    remoteHead = parseRemoteMain(
      git(["ls-remote", "--exit-code", "origin", "refs/heads/main"]),
    );
  } catch (error) {
    console.error(
      `publish-anchor RED — cannot prove ${headSha.slice(0, 7)} is the current origin/main: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  const { fatal, warnings } = classifyPublishAnchor({
    porcelain: git(["status", "--porcelain"]),
    headSha,
    headMatchesRemote: remoteHead === headSha,
    gitMetadataIsDirectory: lstatSync(join(REPO, ".git")).isDirectory(),
    buildTreePresent: existsSync(join(REPO, "dist")),
  });

  for (const warning of warnings) console.warn(`publish-anchor WARN — ${warning}`);

  if (fatal) {
    console.error(
      `publish-anchor RED — npm cannot create a trustworthy gitHead anchor at ` +
        `${headSha.slice(0, 7)}:`,
    );
    for (const entry of fatal.slice(0, 20)) console.error(`  ${entry}`);
    if (fatal.length > 20) console.error(`  … ${fatal.length - 20} more`);
    console.error("Use a clean full clone at the exact release commit before publishing.");
    process.exit(1);
  }

  console.log(`publish-anchor GREEN — clean tree at ${headSha.slice(0, 7)}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
