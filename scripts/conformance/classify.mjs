#!/usr/bin/env node
/**
 * Pure classification of official conformance output into the Phase 0 matrix.
 *
 * Nothing here talks to a network or a process, so the anti-false-green tests can
 * drive every branch with synthetic input. The one rule that matters: a PASS is
 * only ever derived from a SUCCESS the official harness reported. Rules in
 * applicability.json can downgrade or explain, never promote.
 */

export const OUTCOMES = Object.freeze([
  "PASS",
  "FAIL_SERVER",
  "FAIL_HARNESS",
  "NOT_APPLICABLE",
  "NOT_EXERCISED",
]);

export class ParseError extends Error {}

/** Reads `capabilities` from an initialize result by dotted path, e.g. "resources.subscribe". */
export function hasCapability(capabilities, path) {
  let node = capabilities;
  for (const segment of path.split(".")) {
    if (node === null || typeof node !== "object" || !(segment in node)) return false;
    node = node[segment];
  }
  return node !== false && node !== undefined && node !== null;
}

/**
 * Normalises one scenario's checks.json. Throws ParseError rather than returning
 * something empty, because "no checks" and "could not read checks" must never
 * collapse into the same silent zero.
 */
export function parseChecks(scenario, rawJson) {
  let checks;
  try {
    checks = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
  } catch (error) {
    throw new ParseError(`${scenario}: checks.json is not valid JSON: ${String(error)}`);
  }
  if (!Array.isArray(checks)) {
    throw new ParseError(`${scenario}: checks.json is not an array`);
  }
  if (checks.length === 0) {
    throw new ParseError(`${scenario}: checks.json contains zero checks`);
  }
  for (const check of checks) {
    if (typeof check !== "object" || check === null || typeof check.status !== "string") {
      throw new ParseError(`${scenario}: check entry has no status`);
    }
  }
  return checks.map((check) => ({
    id: String(check.id ?? scenario),
    status: check.status,
    errorMessage: check.errorMessage ?? "",
    details: check.details ?? null,
  }));
}

/** Text a rule's `requiresEvidence` is matched against. */
export function evidenceText(checks) {
  return checks
    .map((c) => `${c.errorMessage} ${c.details ? JSON.stringify(c.details) : ""}`)
    .join(" \n");
}

/**
 * Only the checks that FAILED can justify a rule.
 *
 * Searching the whole scenario let a passing check explain a failing one:
 * `tools-call-with-logging` is a two-phase scenario, and a SUCCESS reading
 * "logging/setLevel -32601 as expected" would satisfy `requiresEvidence: "-32601"`
 * for a completely unrelated phase-2 failure. It cannot bite while Frihet never
 * reaches phase 2; it bites the day logging is half-implemented.
 */
export function failingChecks(checks) {
  return checks.filter((c) => c.status === "FAILURE");
}

/**
 * The real text that satisfied the rule, with surrounding context — not the
 * rule's own `requiresEvidence` string echoed back.
 *
 * Recording the rule's assertion as its own proof made the committed artifact
 * unfalsifiable: `"evidence": "-32601"` said only that a rule asked for
 * "-32601", never that the harness produced it. This returns the surrounding
 * window from the harness output so a reader (and validate-baseline, against
 * evidence.json) can check the match instead of taking it on faith.
 */
export function matchedFragment(text, needle) {
  const index = text.indexOf(needle);
  if (index === -1) return null;
  return text.slice(Math.max(0, index - 60), index + needle.length + 100).trim();
}

/**
 * Names the harness asked for that this server does not expose.
 *
 * This is the check that caught the sharpest false green in the Phase 0 run:
 * `tools-call-simple-text` and `tools-call-error` were reported SUCCESS by the
 * official harness while it was calling `test_simple_text` / `test_error_handling`
 * — tools Frihet has never had. The server answered `isError: true` ("tool not
 * found"), the scenario's assertion was satisfied by that error, and a scenario
 * that exercised nothing would have entered the baseline as a pass.
 *
 * `segment` is the slice of the bridge transcript tagged with this scenario.
 */
export function unknownFixturesTouched(segment, inventory) {
  const unknown = [];
  const known = {
    tools: new Set(inventory.tools ?? []),
    resources: new Set(inventory.resources ?? []),
    prompts: new Set(inventory.prompts ?? []),
  };
  for (const message of segment) {
    if (message.direction !== "harness->server") continue;
    if (message.toolName && !known.tools.has(message.toolName)) unknown.push(`tool:${message.toolName}`);
    if (message.resourceUri && !known.resources.has(message.resourceUri)) {
      unknown.push(`resource:${message.resourceUri}`);
    }
    if (message.promptName && !known.prompts.has(message.promptName)) unknown.push(`prompt:${message.promptName}`);
  }
  return [...new Set(unknown)];
}

/**
 * Decide one scenario.
 *
 * `checks` are the official harness's own verdicts. `rule` is the optional
 * applicability entry. `capabilities` is the live initialize result, which is
 * what keeps a "capability-absent" rule from outliving the capability's absence.
 */
export function classifyScenario({
  scenario,
  checks,
  rule,
  capabilities,
  unknownFixtures = [],
  relayedMessages = 0,
}) {
  const statuses = checks.map((c) => c.status);
  const decisive = statuses.filter((s) => s === "SUCCESS" || s === "FAILURE");
  const anyFailure = decisive.includes("FAILURE");
  const allSuccess = decisive.length > 0 && !anyFailure;

  // Transport scenarios measure the relay. Neither verdict is about Frihet, so
  // they are pinned to NOT_APPLICABLE even when the harness says SUCCESS.
  if (rule?.reason === "bridge-under-test") {
    return {
      scenario,
      outcome: "NOT_APPLICABLE",
      reason: rule.reason,
      note: rule.note,
      evidence: `harness reported ${statuses.join(",")} against the relay, not the server`,
      unknownFixtures: [],
      relayedMessages,
      rawStatuses: statuses,
    };
  }

  // A verdict reached by asking for something this server does not have is not a
  // verdict about this server, whichever way the harness scored it.
  if (unknownFixtures.length > 0) {
    return {
      scenario,
      outcome: "NOT_APPLICABLE",
      reason: allSuccess ? "harness-false-green-on-missing-fixture" : "harness-fixture",
      note: allSuccess
        ? `the harness reported SUCCESS while requesting ${unknownFixtures.join(", ")}, which this server does not expose — the assertion was satisfied by the server's not-found error, so nothing was exercised`
        : (rule?.note ?? "the harness requested a fixture this server does not expose"),
      evidence: `requested ${unknownFixtures.join(", ")}; harness statuses ${statuses.join(",")}`,
      unknownFixtures,
      relayedMessages,
      rawStatuses: statuses,
    };
  }

  // Nothing decisive came back — only INFO/WARNING notes, or an empty run that
  // slipped past parseChecks. That is not a pass and not a failure; saying either
  // would be inventing a verdict.
  if (decisive.length === 0) {
    return {
      scenario,
      outcome: "NOT_EXERCISED",
      reason: "no-decisive-checks",
      note: `the harness returned no SUCCESS or FAILURE check (statuses: ${statuses.join(",") || "none"})`,
      evidence: evidenceText(checks).slice(0, 200),
      unknownFixtures,
      relayedMessages,
      rawStatuses: statuses,
    };
  }

  // A rule may explain or downgrade a result. It may never promote one: PASS is
  // reserved for a SUCCESS the official harness actually reported.
  if (rule?.outcome === "PASS") {
    return {
      scenario,
      outcome: "FAIL_HARNESS",
      reason: "invalid-rule-outcome",
      note: 'applicability rules cannot declare outcome "PASS" — only the harness can',
      evidence: evidenceText(checks).slice(0, 200),
      unknownFixtures,
      relayedMessages,
      rawStatuses: statuses,
    };
  }

  if (allSuccess) {
    if (rule && rule.outcome !== "PASS") {
      // The rule says this cannot be exercised, yet it passed. Something moved;
      // refuse to guess which way.
      return {
        scenario,
        outcome: "FAIL_HARNESS",
        reason: "rule-contradicts-result",
        note: `applicability rule claims ${rule.outcome} (${rule.reason}) but the harness reported SUCCESS`,
        evidence: evidenceText(checks),
        unknownFixtures,
        relayedMessages,
        rawStatuses: statuses,
      };
    }
    return {
      scenario,
      outcome: "PASS",
      reason: "harness-success",
      evidence: "",
      unknownFixtures,
      relayedMessages,
      rawStatuses: statuses,
    };
  }

  if (!rule) {
    return {
      scenario,
      outcome: "FAIL_SERVER",
      reason: "unexplained-failure",
      note: "No applicability rule covers this scenario, so its failure is attributed to the server.",
      evidence: evidenceText(failingChecks(checks)),
      unknownFixtures,
      relayedMessages,
      rawStatuses: statuses,
    };
  }

  const failing = failingChecks(checks);
  const text = evidenceText(failing);

  if (rule.requiresEvidence) {
    // Every failing check must carry the evidence, not just one of them: a rule
    // that explains one failure does not get to cover the others for free.
    const unexplained = failing.filter(
      (c) => !evidenceText([c]).includes(rule.requiresEvidence),
    );
    if (unexplained.length > 0) {
      return {
        scenario,
        outcome: "FAIL_SERVER",
        reason: "evidence-missing",
        note: `rule expected evidence "${rule.requiresEvidence}" in every failing check; ${unexplained.length} of ${failing.length} did not carry it — the rule no longer explains this failure`,
        evidence: text.slice(0, 300),
        unknownFixtures,
        relayedMessages,
        rawStatuses: statuses,
      };
    }
  }

  if (rule.requiresCapabilityAbsent && hasCapability(capabilities, rule.requiresCapabilityAbsent)) {
    return {
      scenario,
      outcome: "FAIL_SERVER",
      reason: "capability-advertised-but-unimplemented",
      note: `server now advertises "${rule.requiresCapabilityAbsent}" yet still fails this scenario`,
      evidence: text.slice(0, 300),
      unknownFixtures,
      relayedMessages,
      rawStatuses: statuses,
    };
  }

  return {
    scenario,
    outcome: rule.outcome,
    reason: rule.reason,
    note: rule.note,
    evidence: rule.requiresEvidence
      ? matchedFragment(text, rule.requiresEvidence)
      : text.slice(0, 200),
    evidenceRequired: rule.requiresEvidence ?? null,
    unknownFixtures,
    relayedMessages,
    rawStatuses: statuses,
  };
}

/**
 * Build the full matrix.
 *
 * `declaredScenarios` is what `conformance list --server` announced. Any declared
 * scenario with no result becomes an explicit NOT_EXERCISED row: a scenario that
 * silently disappears between the list and the summary is exactly the failure
 * this whole exercise exists to catch.
 */
export function buildMatrix({ declaredScenarios, results, rules, capabilities, segments = {}, inventory = {} }) {
  const ruleFor = new Map(rules.map((r) => [r.scenario, r]));
  const resultFor = new Map(results.map((r) => [r.scenario, r]));
  const matrix = [];

  for (const scenario of declaredScenarios) {
    const result = resultFor.get(scenario);
    if (!result) {
      matrix.push({
        scenario,
        outcome: "NOT_EXERCISED",
        reason: "declared-but-not-run",
        note: "listed by the official harness but produced no result in this run",
        evidence: "",
        unknownFixtures: [],
        relayedMessages: 0,
        rawStatuses: [],
      });
      continue;
    }
    if (result.parseError) {
      matrix.push({
        scenario,
        outcome: "FAIL_HARNESS",
        reason: "parse-error",
        note: result.parseError,
        evidence: "",
        unknownFixtures: [],
        relayedMessages: 0,
        rawStatuses: [],
      });
      continue;
    }
    matrix.push(
      classifyScenario({
        scenario,
        checks: result.checks,
        rule: ruleFor.get(scenario),
        capabilities,
        unknownFixtures: unknownFixturesTouched(segments[scenario] ?? [], inventory),
        // How many relayed messages were attributed to this scenario. A row with
        // zero was never observed, so the missing-fixture detector could not have
        // run for it — and validate-baseline refuses to call such a row a PASS.
        // Without this the detector fails silently open when the transcript is
        // lost: every row comes back with `unknownFixtures: []`, which looks
        // exactly like "checked, found nothing".
        relayedMessages: (segments[scenario] ?? []).length,
      }),
    );
  }

  const undeclared = results.filter((r) => !declaredScenarios.includes(r.scenario)).map((r) => r.scenario);
  return { matrix, undeclared };
}

export function summarise(matrix) {
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  for (const row of matrix) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
  return counts;
}
