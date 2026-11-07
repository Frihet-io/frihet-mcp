#!/usr/bin/env node
// Turns the published-drift verdict into one GitHub issue.
//
// Why: scripts/published-artifact-drift.mjs failed every one of its 177 runs
// (26 Aug to 7 Nov 2026, each with a real finding) and nobody noticed, because a red scheduled run
// notifies no one. This reporter runs after it in .github/workflows/published-drift.yml:
//
//   red   -> open one issue titled "published-artifact drift: <codes>", or update the
//            one already open (body refreshed; a comment only when the codes change)
//   green -> comment and close every open issue carrying that title prefix
//   no verdict (detector crashed, job died, malformed JSON) -> red, code NO_VERDICT
//
// Idempotent: the open issue is found by its title prefix, so a re-run updates
// rather than duplicates. The workflow serializes runs with a concurrency group.
//
// Environment (set by the workflow):
//   GITHUB_TOKEN       workflow token; the job grants it `issues: write` and read-only contents
//   GITHUB_REPOSITORY  owner/repo
//   DRIFT_VERDICT      one-line JSON written by `published-artifact-drift.mjs --json-out`
//   DRIFT_RUN_URL      URL of the run, linked from the issue
//
// Imports only node: builtins and the detector, like the detector itself.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatReport } from "./published-artifact-drift.mjs";

export const ISSUE_TITLE_PREFIX = "published-artifact drift";
export const ISSUE_LABELS = Object.freeze(["bug"]);

// GitHub rejects issue bodies over 65536 characters; stay well below.
const MAX_BODY_CHARS = 60_000;

/** Parses the detector's JSON. Anything unusable is null, which plans as RED. */
export function parseVerdict(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let verdict;
  try {
    verdict = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    verdict === null ||
    typeof verdict !== "object" ||
    !Number.isInteger(verdict.exitCode) ||
    !Array.isArray(verdict.findings) ||
    verdict.facts === null ||
    typeof verdict.facts !== "object"
  ) {
    return null;
  }
  return verdict;
}

const isOurs = (issue) =>
  !issue.pull_request &&
  typeof issue.title === "string" &&
  issue.title.startsWith(`${ISSUE_TITLE_PREFIX}:`);

/**
 * Pure: decides what to do from the verdict and the repo's open issues.
 * @returns {{action: "none"} | {action: "open", title, body, labels} |
 *           {action: "update", number, title, body, comment: string|null} |
 *           {action: "close", numbers: number[], comment: string}}
 */
export function planIssue({ verdict, openIssues, runUrl }) {
  const ours = openIssues.filter(isOurs).sort((a, b) => a.number - b.number);
  const green = verdict !== null && verdict.exitCode === 0 && verdict.findings.length === 0;

  if (green) {
    if (ours.length === 0) return { action: "none" };
    return {
      action: "close",
      numbers: ours.map((issue) => issue.number),
      comment: `GREEN again in ${runUrl}: npm, the MCP Registry, the hosted server and main agree. Closing.`,
    };
  }

  const codes = verdict ? [...new Set(verdict.findings.map((f) => String(f.id)))] : [];
  if (codes.length === 0) codes.push("NO_VERDICT");
  const title = `${ISSUE_TITLE_PREFIX}: ${codes.join(", ")}`;
  const lines = verdict
    ? formatReport(verdict)
    : [
        "RED [NO_VERDICT] the drift detector produced no usable verdict (it crashed, " +
          "its job failed before writing one, or the JSON was malformed). Unmeasured is not green.",
      ];
  const body = renderBody(lines, runUrl);

  if (ours.length === 0) return { action: "open", title, body, labels: [...ISSUE_LABELS] };
  const [current] = ours;
  return {
    action: "update",
    number: current.number,
    title,
    body,
    comment: current.title === title ? null : `Findings changed in ${runUrl}: now ${codes.join(", ")}.`,
  };
}

function renderBody(lines, runUrl) {
  const head = [
    "The `published-drift` check is RED on `main`.",
    "",
    `Latest run: ${runUrl}`,
    "",
    "This issue is opened and refreshed by `.github/workflows/published-drift.yml` " +
      "and closed by the first green run. Exit-code table and remedies: header of " +
      "`scripts/published-artifact-drift.mjs`.",
    "",
    "```text",
  ].join("\n");
  const tail = "\n```\n";
  // Backticks are the only way out of the fence; mentions inside it do not notify.
  let report = lines.map((line) => String(line).replaceAll("`", "'")).join("\n");
  const room = MAX_BODY_CHARS - head.length - tail.length - 200;
  if (report.length > room) {
    report = `${report.slice(0, room)}\n… truncated; the full report is in the run log: ${runUrl}`;
  }
  return `${head}\n${report}${tail}`;
}

/** Every open issue (pull requests included; planIssue drops them). */
export async function listOpenIssues(request) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const batch = await request("GET", `/issues?state=open&per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

/** Executes a plan. Any failed call throws, so the reporter job turns red. */
export async function applyIssuePlan(plan, request) {
  switch (plan.action) {
    case "none":
      return;
    case "open":
      await request("POST", "/issues", { title: plan.title, body: plan.body, labels: plan.labels });
      return;
    case "update":
      await request("PATCH", `/issues/${plan.number}`, { title: plan.title, body: plan.body });
      if (plan.comment) await request("POST", `/issues/${plan.number}/comments`, { body: plan.comment });
      return;
    case "close":
      for (const number of plan.numbers) {
        await request("POST", `/issues/${number}/comments`, { body: plan.comment });
        await request("PATCH", `/issues/${number}`, { state: "closed", state_reason: "completed" });
      }
      return;
    default:
      throw new Error(`unknown plan action: ${plan.action}`);
  }
}

async function main() {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, DRIFT_VERDICT, DRIFT_RUN_URL } = process.env;
  for (const [name, value] of Object.entries({ GITHUB_TOKEN, GITHUB_REPOSITORY, DRIFT_RUN_URL })) {
    if (!value) throw new Error(`${name} is not set`);
  }
  const api = `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${GITHUB_REPOSITORY}`;
  const request = async (method, path, body) => {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${GITHUB_TOKEN}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    // Status only: never echo a response body or a header into the log.
    if (!response.ok) throw new Error(`${method} ${path.split("?")[0]}: HTTP ${response.status}`);
    return response.json();
  };

  const verdict = parseVerdict(DRIFT_VERDICT);
  const plan = planIssue({ verdict, openIssues: await listOpenIssues(request), runUrl: DRIFT_RUN_URL });
  await applyIssuePlan(plan, request);
  const target = plan.number ?? plan.numbers?.join(", ") ?? "";
  console.log(`published-drift-issue: ${plan.action}${target ? ` #${target}` : ""}${plan.title ? ` — ${plan.title}` : ""}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`published-drift-issue failed: ${error.message}`);
    process.exit(1);
  });
}
