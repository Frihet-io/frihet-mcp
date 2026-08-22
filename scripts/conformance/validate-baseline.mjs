#!/usr/bin/env node
/**
 * Anti-false-green gate for the Phase 0 baseline (issue #1578).
 *
 * A conformance baseline is only worth having if it can go RED. Every rule below
 * exists because there is a specific way this artifact could report success it
 * did not earn — an empty run, an unreadable file, a failure quietly relabelled,
 * or a matrix with no versions attached to say what it even measured.
 *
 * Exit 0 = the baseline is trustworthy as a record. It says nothing about whether
 * the results in it are good; that is what the matrix is for.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFORMANCE_VERSION, INSPECTOR_VERSION } from "./pinned-versions.mjs";

export const REQUIRED_VERSION_FIELDS = Object.freeze([
  "serverSha",
  "serverPackageVersion",
  "sdkVersion",
  "protocolVersion",
  "conformanceVersion",
  "inspectorVersion",
  "nodeVersion",
]);

const TERMINAL_OUTCOMES = new Set([
  "PASS",
  "FAIL_SERVER",
  "FAIL_HARNESS",
  "NOT_APPLICABLE",
  "NOT_EXERCISED",
]);

/**
 * @param baseline  the parsed baseline.json
 * @param evidence  the parsed evidence.json, when available. Without it the
 *                  evidence cross-check (R8) cannot run and is reported as a
 *                  violation rather than skipped — a gate that quietly drops a
 *                  rule when its input is missing is the failure mode this whole
 *                  file exists to prevent.
 */
export function validateBaseline(baseline, evidence = null) {
  const violations = [];
  const fail = (rule, detail) => violations.push({ rule, detail });

  if (typeof baseline !== "object" || baseline === null) {
    return { ok: false, violations: [{ rule: "R0-shape", detail: "baseline is not an object" }] };
  }

  // R4 — a matrix with no version metadata cannot be compared to anything, so it
  // is not a baseline. Checked first because everything else is meaningless without it.
  const versions = baseline.versions ?? {};
  for (const field of REQUIRED_VERSION_FIELDS) {
    const value = versions[field];
    if (typeof value !== "string" || value.trim() === "" || value === "unknown") {
      fail("R4-version-metadata-missing", `versions.${field} is missing or unknown`);
    }
  }

  // Present-and-wrong is worse than absent: R4 above only proves a string is
  // there. These prove it is the right one.
  if (versions.conformanceVersion && versions.conformanceVersion !== CONFORMANCE_VERSION) {
    fail(
      "R4-version-metadata-missing",
      `baseline says conformance ${versions.conformanceVersion}, pinned-versions.mjs says ${CONFORMANCE_VERSION}`,
    );
  }
  if (versions.inspectorVersion && versions.inspectorVersion !== INSPECTOR_VERSION) {
    fail(
      "R4-version-metadata-missing",
      `baseline says Inspector ${versions.inspectorVersion}, pinned-versions.mjs says ${INSPECTOR_VERSION}`,
    );
  }
  if (versions.serverSha && !/^[0-9a-f]{40}$/.test(versions.serverSha)) {
    fail("R4-version-metadata-missing", `versions.serverSha "${versions.serverSha}" is not a 40-hex commit sha`);
  }

  const matrix = baseline.conformance?.matrix;
  if (!Array.isArray(matrix)) {
    fail("R2-parser-failure", "conformance.matrix is missing or not an array");
    return { ok: false, violations };
  }

  // R1 — an empty run is the most convincing-looking green there is.
  if (matrix.length === 0) {
    fail("R1-zero-scenarios", "conformance matrix contains zero scenarios");
  }
  const declared = baseline.conformance?.declaredScenarios;
  if (!Array.isArray(declared) || declared.length === 0) {
    fail("R1-zero-scenarios", "conformance.declaredScenarios is empty — nothing was even enumerated");
  } else if (matrix.length !== declared.length) {
    fail(
      "R5-coverage-gap",
      `matrix has ${matrix.length} rows for ${declared.length} declared scenarios — a scenario was dropped`,
    );
  }

  // R1 continued. `matrix.length > 0` is satisfied by 32 rows that all say
  // "declared-but-not-run" — which is what a run produces if the bridge dies
  // right after the inventory probe. Rows without a harness verdict behind them
  // are not coverage.
  const withVerdict = matrix.filter((r) => Array.isArray(r?.rawStatuses) && r.rawStatuses.length > 0);
  if (matrix.length > 0 && withVerdict.length === 0) {
    fail("R1-zero-scenarios", "no scenario has a raw harness status — nothing was actually executed");
  }
  const notRun = matrix.filter((r) => r?.reason === "declared-but-not-run");
  if (notRun.length > 0) {
    fail(
      "R1-zero-scenarios",
      `${notRun.length} declared scenario(s) produced no result: ${notRun.map((r) => r.scenario).join(", ")}`,
    );
  }

  // R5 by set difference, not by counting. Equal lengths hid a renamed row.
  if (Array.isArray(declared)) {
    const declaredSet = new Set(declared);
    const matrixSet = new Set(matrix.map((r) => r?.scenario));
    const missing = declared.filter((s) => !matrixSet.has(s));
    const extra = [...matrixSet].filter((s) => !declaredSet.has(s));
    if (missing.length > 0) fail("R5-coverage-gap", `declared but absent from the matrix: ${missing.join(", ")}`);
    if (extra.length > 0) fail("R5-coverage-gap", `in the matrix but never declared: ${extra.join(", ")}`);
  }

  const seen = new Set();
  for (const row of matrix) {
    const id = row?.scenario;
    if (typeof id !== "string" || id === "") {
      fail("R2-parser-failure", "matrix row has no scenario name");
      continue;
    }
    if (seen.has(id)) fail("R2-parser-failure", `duplicate matrix row for ${id}`);
    seen.add(id);

    if (!TERMINAL_OUTCOMES.has(row.outcome)) {
      fail("R3-relabelled-result", `${id}: outcome "${row.outcome}" is not one of the five allowed outcomes`);
      continue;
    }

    const statuses = Array.isArray(row.rawStatuses) ? row.rawStatuses : [];

    // R3 — the core anti-false-green rule. A raw FAILURE that comes out as PASS
    // is a lie; a raw FAILURE softened to NOT_APPLICABLE without evidence is the
    // same lie wearing a hat.
    if (row.outcome === "PASS") {
      if (statuses.length === 0) {
        fail("R3-relabelled-result", `${id}: PASS with no raw harness status behind it`);
      }
      if (statuses.includes("FAILURE")) {
        fail("R3-relabelled-result", `${id}: harness reported FAILURE but the row says PASS`);
      }
      // Absence of FAILURE is not presence of SUCCESS: a run of only INFO/WARNING
      // notes has nothing to relabel and equally nothing to pass on.
      if (!statuses.includes("SUCCESS")) {
        fail("R3-relabelled-result", `${id}: PASS with no SUCCESS among the raw harness statuses`);
      }
      if (row.reason === "bridge-under-test") {
        fail("R6-bridge-cannot-pass", `${id}: a transport scenario measures the relay and can never be a server PASS`);
      }
      // R9 — the false green this run actually produced: a scenario scored
      // SUCCESS while the harness was asking for a fixture the server does not
      // expose, so the assertion was satisfied by a not-found error.
      //
      // The field must be PRESENT, not merely empty. If the runner loses the
      // transcript the detector goes blind, every row comes back without the
      // field, and `unknownFixtures?.length > 0` would wave through exactly the
      // two scenarios it was written to catch.
      if (!Array.isArray(row.unknownFixtures)) {
        fail("R9-pass-on-missing-fixture", `${id}: PASS with no unknownFixtures field — the fixture detector did not run`);
      }
      // An empty `unknownFixtures` is ambiguous on its own: it reads the same
      // whether the detector checked and found nothing, or never saw a single
      // message. The relayed count disambiguates. Zero means the scenario was
      // never observed, so nothing about it was verified.
      if (typeof row.relayedMessages !== "number") {
        fail("R9-pass-on-missing-fixture", `${id}: PASS with no relayedMessages count — the transcript was not attributed`);
      } else if (row.relayedMessages === 0) {
        fail(
          "R9-pass-on-missing-fixture",
          `${id}: PASS with zero relayed messages attributed to it — the fixture detector saw nothing`,
        );
      }
      if (Array.isArray(row.unknownFixtures) && row.unknownFixtures.length > 0) {
        fail(
          "R9-pass-on-missing-fixture",
          `${id}: PASS although the harness requested ${row.unknownFixtures.join(", ")}, which the server does not expose`,
        );
      }
    }

    if (row.outcome === "NOT_APPLICABLE") {
      if (!row.reason) {
        fail("R7-unexplained-na", `${id}: NOT_APPLICABLE without a reason`);
      }
      if (row.reason !== "bridge-under-test" && !String(row.evidence ?? "").trim()) {
        fail("R7-unexplained-na", `${id}: NOT_APPLICABLE without evidence from the harness output`);
      }
    }

    if (row.outcome === "NOT_EXERCISED" && !row.reason) {
      fail("R7-unexplained-na", `${id}: NOT_EXERCISED without a reason`);
    }
  }

  if (Array.isArray(baseline.conformance?.undeclared) && baseline.conformance.undeclared.length > 0) {
    fail(
      "R5-coverage-gap",
      `results for scenarios the harness never declared: ${baseline.conformance.undeclared.join(", ")}`,
    );
  }

  // R2 — parse failures must survive into the artifact as FAIL_HARNESS rows, not
  // be swallowed. A recorded parseErrors list with no matching row is a swallow.
  const parseErrors = baseline.conformance?.parseErrors ?? [];
  if (!Array.isArray(parseErrors)) {
    fail("R2-parser-failure", "conformance.parseErrors is not an array");
  } else {
    for (const entry of parseErrors) {
      const row = matrix.find((r) => r.scenario === entry?.scenario);
      if (!row || row.outcome !== "FAIL_HARNESS") {
        fail("R2-parser-failure", `parse error for ${entry?.scenario} is not reflected as FAIL_HARNESS`);
      }
    }
  }

  // R8 — the evidence recorded for a NOT_APPLICABLE row must actually appear in
  // the harness output for that scenario. Without this the row's `evidence` was
  // the rule's own `requiresEvidence` echoed back: proof that a rule asked for a
  // string, never that the harness produced it.
  if (!evidence) {
    fail("R8-evidence-unverifiable", "evidence.json was not supplied, so no NOT_APPLICABLE row could be checked against the harness output");
  } else {
    const failingTextByScenario = new Map(
      (evidence.scenarios ?? []).map((s) => [
        s.scenario,
        (s.checks ?? [])
          .filter((c) => c.status === "FAILURE")
          .map((c) => `${c.errorMessage ?? ""} ${c.details?.json ?? ""}`)
          .join(" \n"),
      ]),
    );
    for (const row of matrix) {
      if (row?.outcome !== "NOT_APPLICABLE" || row.reason === "bridge-under-test") continue;
      const needle = row.evidenceRequired;
      if (!needle) continue;
      const text = failingTextByScenario.get(row.scenario);
      if (text === undefined) {
        fail("R8-evidence-unverifiable", `${row.scenario}: no entry in evidence.json to check its evidence against`);
        continue;
      }
      if (!text.includes(needle)) {
        fail(
          "R8-evidence-unverifiable",
          `${row.scenario}: rule required "${needle}" but no failing check in evidence.json contains it`,
        );
      }
    }
  }

  // R11 — the relay reporting its own errors is only useful if something reads
  // them. A run with dropped messages must not produce a green baseline.
  const relayErrors = baseline.relayErrors;
  if (!Array.isArray(relayErrors)) {
    fail("R11-relay-errors", "baseline does not record the relay's error list");
  } else if (relayErrors.length > 0) {
    fail("R11-relay-errors", `the relay reported ${relayErrors.length} error(s): ${JSON.stringify(relayErrors).slice(0, 300)}`);
  }

  // The Inspector smoke is a separate surface with the same relabelling risk.
  const smoke = baseline.inspector?.cases;
  if (!Array.isArray(smoke) || smoke.length === 0) {
    fail("R1-zero-scenarios", "inspector smoke recorded zero cases");
  } else {
    for (const c of smoke) {
      if (!TERMINAL_OUTCOMES.has(c?.status)) {
        fail("R3-relabelled-result", `inspector case ${c?.id}: status "${c?.status}" is not allowed`);
      }
      if (c?.status === "PASS" && typeof c.exitCode !== "number") {
        fail("R3-relabelled-result", `inspector case ${c?.id}: PASS with no recorded exit code`);
      }
      if (c?.status === "PASS" && c.provesServerBehavior === false) {
        fail(
          "R3-relabelled-result",
          `inspector case ${c?.id}: PASS although the case does not reach the server`,
        );
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const path = process.argv[2] ?? "docs/conformance/phase0/baseline.json";
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`RED — baseline unreadable at ${path}: ${String(error)}`);
    process.exit(1);
  }
  let evidence = null;
  try {
    evidence = JSON.parse(readFileSync(join(dirname(path), "evidence.json"), "utf8"));
  } catch {
    // Left null on purpose: validateBaseline turns that into an R8 violation
    // rather than silently skipping the cross-check.
  }
  const { ok, violations } = validateBaseline(baseline, evidence);
  if (ok) {
    const counts = baseline.conformance?.counts ?? {};
    console.log(
      `GREEN — baseline valid: ${baseline.conformance.matrix.length} scenarios ` +
        `(${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")})`,
    );
    process.exit(0);
  }
  console.error(`RED — ${violations.length} anti-false-green violation(s):`);
  for (const v of violations) console.error(`  [${v.rule}] ${v.detail}`);
  process.exit(1);
}
