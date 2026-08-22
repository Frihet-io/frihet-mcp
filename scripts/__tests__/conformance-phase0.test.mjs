/**
 * Anti-false-green tests for the Phase 0 conformance baseline (issue #1578).
 *
 * The artifact in docs/conformance/phase0/baseline.json is only worth committing
 * if the gate around it can go RED. Every test below drives a synthetic
 * deviation through the real modules and asserts the RED; the last block asserts
 * the shipped artifact is still GREEN, so neither half can rot unnoticed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import {
  OUTCOMES,
  ParseError,
  buildMatrix,
  classifyScenario,
  evidenceText,
  hasCapability,
  parseChecks,
  summarise,
  unknownFixturesTouched,
} from "../conformance/classify.mjs";
import { REQUIRED_VERSION_FIELDS, validateBaseline } from "../conformance/validate-baseline.mjs";
import { CASES, EXIT, judgeCase } from "../conformance/inspector-smoke.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (relative) => JSON.parse(readFileSync(join(REPO, relative), "utf8"));

const SHIPPED = readJson("docs/conformance/phase0/baseline.json");
const SHIPPED_EVIDENCE = readJson("docs/conformance/phase0/evidence.json");
const RULES = readJson("scripts/conformance/applicability.json").rules;

/**
 * The smallest baseline that is genuinely valid. Each test deep-clones it and
 * states exactly one deviation, so a RED can only come from that deviation.
 * Row 2 carries reason `bridge-under-test` with no evidence on purpose: a
 * transport scenario measures the relay, so there is no harness evidence about
 * the server to quote, and it is the one exemption from the evidence rule.
 */
function validBaseline() {
  return {
    versions: {
      serverSha: "37b0e59947eff3f2ddf0c380d739ee9fc8fcbdb8",
      serverPackageVersion: "1.16.6",
      sdkVersion: "1.30.0",
      protocolVersion: "2025-11-25",
      conformanceVersion: "0.1.16",
      inspectorVersion: "2.3.0",
      nodeVersion: "v22.22.2",
    },
    conformance: {
      declaredScenarios: ["ping", "resources-subscribe", "dns-rebinding-protection"],
      matrix: [
        {
          scenario: "ping",
          outcome: "PASS",
          reason: "harness-success",
          evidence: "",
          unknownFixtures: [],
          relayedMessages: 6,
          rawStatuses: ["SUCCESS"],
        },
        {
          scenario: "resources-subscribe",
          outcome: "NOT_APPLICABLE",
          reason: "capability-absent",
          evidence: "MCP error -32601: Method not found",
          evidenceRequired: "-32601",
          unknownFixtures: [],
          relayedMessages: 6,
          rawStatuses: ["FAILURE"],
        },
        {
          scenario: "dns-rebinding-protection",
          outcome: "NOT_APPLICABLE",
          reason: "bridge-under-test",
          evidence: "",
          unknownFixtures: [],
          relayedMessages: 8,
          rawStatuses: ["FAILURE"],
        },
      ],
      parseErrors: [],
      undeclared: [],
    },
    relayErrors: [],
    inspector: {
      cases: [
        { id: "tools-list", status: "PASS", exitCode: 0, provesServerBehavior: true, reasons: [] },
        { id: "negative-unknown-tool", status: "NOT_EXERCISED", exitCode: 5, provesServerBehavior: false, reasons: ["x"] },
      ],
    },
  };
}

/**
 * Evidence matching `validBaseline()`. Supplied to every mutation so R8 (the
 * cross-check that a row's evidence really appears in the harness output) is
 * satisfied by default — each test then isolates its own single deviation
 * instead of tripping R8 as a side effect.
 */
function validEvidence() {
  return {
    scenarios: [
      { scenario: "ping", checks: [{ status: "SUCCESS", errorMessage: "", details: null }] },
      {
        scenario: "resources-subscribe",
        checks: [{ status: "FAILURE", errorMessage: "Failed: MCP error -32601: Method not found", details: null }],
      },
      {
        scenario: "dns-rebinding-protection",
        checks: [{ status: "FAILURE", errorMessage: "Expected HTTP 4xx, got 200", details: null }],
      },
    ],
  };
}

const mutate = (fn, evidence = validEvidence()) => {
  const baseline = structuredClone(validBaseline());
  fn(baseline);
  return validateBaseline(baseline, evidence);
};

function assertViolation(result, rule, detail) {
  assert.equal(result.ok, false, "expected the gate to go RED");
  const hit = result.violations.find((v) => v.rule === rule && (detail === undefined || detail.test(v.detail)));
  assert.ok(hit, `no ${rule} violation matching ${detail}; got ${JSON.stringify(result.violations)}`);
}

const check = (status, errorMessage = "", details = null) => ({ id: "c", status, errorMessage, details });
const request = (fields) => ({ direction: "harness->server", ...fields });

const SUBSCRIBE_RULE = Object.freeze({
  scenario: "resources-subscribe",
  outcome: "NOT_APPLICABLE",
  reason: "capability-absent",
  requiresCapabilityAbsent: "resources.subscribe",
  requiresEvidence: "-32601",
  note: "resources capability is advertised, but without subscribe.",
});
const METHOD_NOT_FOUND = [check("FAILURE", "Method not found (-32601)")];
const INVENTORY = { tools: ["get_business_context"], resources: ["frihet://tax/rates"], prompts: ["monthly-close"] };

test("the reference baseline this suite mutates is itself valid", () => {
  assert.deepEqual(validateBaseline(validBaseline(), validEvidence()).violations, []);
});

describe("property 1 — zero scenarios goes RED", () => {
  test("an empty matrix is RED", () => {
    assertViolation(mutate((b) => (b.conformance.matrix = [])), "R1-zero-scenarios", /zero scenarios/);
  });

  test("an empty declaredScenarios list is RED", () => {
    assertViolation(
      mutate((b) => (b.conformance.declaredScenarios = [])),
      "R1-zero-scenarios",
      /declaredScenarios is empty/,
    );
  });

  test("an inspector smoke with zero cases is RED", () => {
    assertViolation(mutate((b) => (b.inspector.cases = [])), "R1-zero-scenarios", /inspector smoke recorded zero/);
  });

  test("zero checks throws instead of reading as nothing-failed", () => {
    assert.throws(() => parseChecks("ping", "[]"), ParseError);
    assert.throws(() => parseChecks("ping", []), ParseError);
  });
});

describe("property 2 — a parser failure goes RED", () => {
  test("parseChecks throws on invalid JSON, on a non-array and on an entry with no status", () => {
    assert.throws(() => parseChecks("ping", "{not json"), ParseError);
    assert.throws(() => parseChecks("ping", '{"status":"SUCCESS"}'), ParseError);
    assert.throws(() => parseChecks("ping", '[{"id":"a"}]'), ParseError);
    assert.throws(() => parseChecks("ping", "[null]"), ParseError);
    assert.throws(() => parseChecks("ping", '[{"status":1}]'), ParseError);
  });

  test("a well-formed checks.json is normalised rather than rejected", () => {
    const parsed = parseChecks("ping", '[{"status":"SUCCESS","errorMessage":"","details":{"a":1}}]');
    assert.deepEqual(parsed, [{ id: "ping", status: "SUCCESS", errorMessage: "", details: { a: 1 } }]);
  });

  test("a result carrying a parseError becomes a FAIL_HARNESS row, never a dropped scenario", () => {
    const { matrix } = buildMatrix({
      declaredScenarios: ["ping", "tools-list"],
      results: [
        { scenario: "ping", parseError: "ping: checks.json is not an array" },
        { scenario: "tools-list", checks: [check("SUCCESS")] },
      ],
      rules: [],
      capabilities: {},
    });
    assert.equal(matrix.length, 2);
    assert.equal(matrix[0].outcome, "FAIL_HARNESS");
    assert.equal(matrix[0].reason, "parse-error");
    assert.match(matrix[0].note, /not an array/);
  });

  test("a recorded parse error whose row is not FAIL_HARNESS is RED", () => {
    assertViolation(
      mutate((b) => (b.conformance.parseErrors = [{ scenario: "ping", detail: "not an array" }])),
      "R2-parser-failure",
      /parse error for ping is not reflected as FAIL_HARNESS/,
    );
  });

  test("the same parse error IS accepted once the row says FAIL_HARNESS", () => {
    const result = mutate((b) => {
      b.conformance.parseErrors = [{ scenario: "ping", detail: "not an array" }];
      b.conformance.matrix[0] = { scenario: "ping", outcome: "FAIL_HARNESS", reason: "parse-error", evidence: "", rawStatuses: [] };
    });
    assert.deepEqual(result.violations, []);
  });

  test("a parse error recorded for a scenario with no row at all is RED", () => {
    assertViolation(
      mutate((b) => (b.conformance.parseErrors = [{ scenario: "ghost", detail: "unreadable" }])),
      "R2-parser-failure",
      /ghost/,
    );
  });

  test("a matrix that is not an array, a nameless row and a duplicated row are RED", () => {
    assertViolation(mutate((b) => (b.conformance.matrix = null)), "R2-parser-failure", /not an array/);
    assertViolation(mutate((b) => delete b.conformance.matrix[0].scenario), "R2-parser-failure", /no scenario name/);
    assertViolation(
      mutate((b) => (b.conformance.matrix[1] = structuredClone(b.conformance.matrix[0]))),
      "R2-parser-failure",
      /duplicate matrix row for ping/,
    );
  });
});

describe("property 3 — a failure relabelled as PASS or SKIP goes RED", () => {
  test("a raw FAILURE behind a PASS row is RED", () => {
    assertViolation(
      mutate((b) => (b.conformance.matrix[0].rawStatuses = ["SUCCESS", "FAILURE"])),
      "R3-relabelled-result",
      /harness reported FAILURE but the row says PASS/,
    );
  });

  test("any outcome outside the five allowed values is RED", () => {
    for (const outcome of ["SKIP", "SKIPPED", "UNKNOWN", "pass", "", null]) {
      assertViolation(
        mutate((b) => (b.conformance.matrix[0].outcome = outcome)),
        "R3-relabelled-result",
        /is not one of the five allowed outcomes/,
      );
    }
  });

  test("each of the five outcomes is accepted, so classify and validate cannot drift apart", () => {
    for (const outcome of OUTCOMES) {
      const result = mutate((b) => {
        b.conformance.matrix[0] = { scenario: "ping", outcome, reason: "r", evidence: "e", rawStatuses: ["SUCCESS"] };
      });
      assert.ok(
        !result.violations.some((v) => /not one of the five allowed outcomes/.test(v.detail)),
        `${outcome} was rejected by the validator`,
      );
    }
  });

  test("a PASS with no raw harness status behind it is RED", () => {
    assertViolation(mutate((b) => (b.conformance.matrix[0].rawStatuses = [])), "R3-relabelled-result", /no raw harness status/);
    assertViolation(mutate((b) => delete b.conformance.matrix[0].rawStatuses), "R3-relabelled-result", /no raw harness status/);
  });

  test("NOT_APPLICABLE without a reason is RED", () => {
    assertViolation(mutate((b) => delete b.conformance.matrix[1].reason), "R7-unexplained-na", /without a reason/);
  });

  test("NOT_APPLICABLE with a reason but no harness evidence is RED", () => {
    assertViolation(mutate((b) => (b.conformance.matrix[1].evidence = "")), "R7-unexplained-na", /without evidence/);
    assertViolation(mutate((b) => (b.conformance.matrix[1].evidence = "   ")), "R7-unexplained-na", /without evidence/);
    assertViolation(mutate((b) => delete b.conformance.matrix[1].evidence), "R7-unexplained-na", /without evidence/);
  });

  test("bridge-under-test is the one NOT_APPLICABLE exempt from the evidence requirement", () => {
    // The relay is what the transport scenarios measure, so there is no harness
    // evidence *about the server* to quote — but the reason itself is mandatory.
    const exempt = mutate((b) => (b.conformance.matrix[2].evidence = ""));
    assert.deepEqual(exempt.violations, []);
    assertViolation(
      mutate((b) => {
        b.conformance.matrix[2].reason = "capability-absent";
        b.conformance.matrix[2].evidence = "";
      }),
      "R7-unexplained-na",
      /without evidence/,
    );
  });

  test("a transport scenario can never be recorded as a server PASS", () => {
    assertViolation(
      mutate((b) => {
        b.conformance.matrix[0].reason = "bridge-under-test";
      }),
      "R6-bridge-cannot-pass",
      /can never be a server PASS/,
    );
  });

  test("a PASS that touched a fixture the server does not expose is RED", () => {
    assertViolation(
      mutate((b) => (b.conformance.matrix[0].unknownFixtures = ["tool:test_simple_text"])),
      "R9-pass-on-missing-fixture",
      /test_simple_text/,
    );
  });

  test("NOT_EXERCISED without a reason is RED", () => {
    assertViolation(
      mutate((b) => {
        b.conformance.matrix[0] = { scenario: "ping", outcome: "NOT_EXERCISED", evidence: "", rawStatuses: [] };
      }),
      "R7-unexplained-na",
      /NOT_EXERCISED without a reason/,
    );
  });

  test("an inspector PASS that never reached the server is RED", () => {
    assertViolation(
      mutate((b) => (b.inspector.cases[0].provesServerBehavior = false)),
      "R3-relabelled-result",
      /does not reach the server/,
    );
  });

  test("an inspector PASS with no numeric exit code is RED", () => {
    for (const exitCode of [undefined, null, "0"]) {
      assertViolation(
        mutate((b) => (b.inspector.cases[0].exitCode = exitCode)),
        "R3-relabelled-result",
        /PASS with no recorded exit code/,
      );
    }
  });

  test("an inspector status outside the five outcomes is RED", () => {
    assertViolation(mutate((b) => (b.inspector.cases[0].status = "SKIPPED")), "R3-relabelled-result", /is not allowed/);
  });
});

describe("property 4 — missing version metadata goes RED", () => {
  test("the required-field list is not empty, so the loops below cannot pass vacuously", () => {
    assert.ok(REQUIRED_VERSION_FIELDS.length > 0);
  });

  test("deleting any single required version field is RED and names that field", () => {
    for (const field of REQUIRED_VERSION_FIELDS) {
      const result = mutate((b) => delete b.versions[field]);
      assertViolation(result, "R4-version-metadata-missing", new RegExp(`versions\\.${field} `));
      assert.equal(
        result.violations.filter((v) => v.rule === "R4-version-metadata-missing").length,
        1,
        `${field}: exactly one field was removed`,
      );
    }
  });

  test("a placeholder version is rejected exactly like an absent one", () => {
    for (const field of REQUIRED_VERSION_FIELDS) {
      for (const value of ["", "   ", "unknown", null, 0, {}]) {
        assertViolation(
          mutate((b) => (b.versions[field] = value)),
          "R4-version-metadata-missing",
          new RegExp(`versions\\.${field} `),
        );
      }
    }
  });

  test("a baseline with no versions object at all fails once per required field", () => {
    const result = mutate((b) => delete b.versions);
    assert.equal(
      result.violations.filter((v) => v.rule === "R4-version-metadata-missing").length,
      REQUIRED_VERSION_FIELDS.length,
    );
  });

  test("a baseline that is not an object is RED without throwing", () => {
    for (const value of [null, "baseline", 7]) {
      const result = validateBaseline(value);
      assert.equal(result.ok, false);
      assert.equal(result.violations[0].rule, "R0-shape");
    }
  });
});

describe("classifier — a SUCCESS on a fixture the server lacks is not a pass", () => {
  test("only harness->server requests count, unknown names are deduped, known ones are ignored", () => {
    const segment = [
      request({ method: "tools/call", toolName: "test_simple_text" }),
      request({ method: "tools/call", toolName: "test_simple_text" }),
      request({ method: "resources/read", resourceUri: "test://static-text" }),
      request({ method: "prompts/get", promptName: "test_simple_prompt" }),
      request({ method: "tools/call", toolName: "get_business_context" }),
      { direction: "server->harness", toolName: "test_never_requested" },
    ];
    assert.deepEqual(unknownFixturesTouched(segment, INVENTORY), [
      "tool:test_simple_text",
      "resource:test://static-text",
      "prompt:test_simple_prompt",
    ]);
  });

  test("a SUCCESS earned by calling a tool the server does not expose is NOT_APPLICABLE", () => {
    const segment = [request({ method: "tools/call", toolName: "test_error_handling" })];
    const unknownFixtures = unknownFixturesTouched(segment, INVENTORY);
    const row = classifyScenario({
      scenario: "tools-call-error",
      checks: [check("SUCCESS")],
      rule: undefined,
      capabilities: {},
      unknownFixtures,
    });
    assert.equal(row.outcome, "NOT_APPLICABLE");
    assert.equal(row.reason, "harness-false-green-on-missing-fixture");
    assert.deepEqual(row.unknownFixtures, ["tool:test_error_handling"]);
    assert.match(row.evidence, /test_error_handling/);
  });

  test("the same missing fixture on a FAILURE is plain harness-fixture, not a false green", () => {
    const row = classifyScenario({
      scenario: "tools-call-image",
      checks: [check("FAILURE", "No image content found")],
      rule: { scenario: "tools-call-image", outcome: "NOT_APPLICABLE", reason: "harness-fixture", note: "n" },
      capabilities: {},
      unknownFixtures: ["tool:test_image_content"],
    });
    assert.equal(row.outcome, "NOT_APPLICABLE");
    assert.equal(row.reason, "harness-fixture");
  });

  test("buildMatrix wires the transcript segment to the inventory end to end", () => {
    const { matrix } = buildMatrix({
      declaredScenarios: ["tools-call-simple-text"],
      results: [{ scenario: "tools-call-simple-text", checks: [check("SUCCESS")] }],
      rules: [],
      capabilities: {},
      segments: { "tools-call-simple-text": [request({ method: "tools/call", toolName: "test_simple_text" })] },
      inventory: INVENTORY,
    });
    assert.equal(matrix[0].outcome, "NOT_APPLICABLE");
    assert.equal(matrix[0].reason, "harness-false-green-on-missing-fixture");
  });

  test("the same scenario with a real tool stays a PASS", () => {
    const { matrix } = buildMatrix({
      declaredScenarios: ["tools-call-simple-text"],
      results: [{ scenario: "tools-call-simple-text", checks: [check("SUCCESS")] }],
      rules: [],
      capabilities: {},
      segments: { "tools-call-simple-text": [request({ method: "tools/call", toolName: "get_business_context" })] },
      inventory: INVENTORY,
    });
    assert.equal(matrix[0].outcome, "PASS");
    assert.equal(matrix[0].reason, "harness-success");
  });
});

describe("classifier — rules explain, they do not outlive their premise", () => {
  test("hasCapability reads dotted paths and treats an explicit false as absent", () => {
    assert.equal(hasCapability({ resources: { subscribe: true } }, "resources.subscribe"), true);
    assert.equal(hasCapability({ resources: { subscribe: false } }, "resources.subscribe"), false);
    assert.equal(hasCapability({ resources: { listChanged: true } }, "resources.subscribe"), false);
    assert.equal(hasCapability({ tools: {} }, "resources.subscribe"), false);
    assert.equal(hasCapability({}, "logging"), false);
    assert.equal(hasCapability({ logging: {} }, "logging"), true);
    assert.equal(hasCapability(undefined, "logging"), false);
  });

  test("a capability-absent rule stops applying once the capability is advertised", () => {
    const advertised = classifyScenario({
      scenario: "resources-subscribe",
      checks: METHOD_NOT_FOUND,
      rule: SUBSCRIBE_RULE,
      capabilities: { resources: { subscribe: true } },
    });
    assert.equal(advertised.outcome, "FAIL_SERVER");
    assert.equal(advertised.reason, "capability-advertised-but-unimplemented");
  });

  test("subscribe:false is absence, so the rule still applies", () => {
    for (const capabilities of [{ resources: { subscribe: false } }, { resources: { listChanged: true } }, {}]) {
      const row = classifyScenario({
        scenario: "resources-subscribe",
        checks: METHOD_NOT_FOUND,
        rule: SUBSCRIBE_RULE,
        capabilities,
      });
      assert.equal(row.outcome, "NOT_APPLICABLE", JSON.stringify(capabilities));
      assert.equal(row.reason, "capability-absent");
    }
  });

  test("a rule whose required evidence is absent stops explaining the failure", () => {
    const row = classifyScenario({
      scenario: "resources-subscribe",
      checks: [check("FAILURE", "socket hang up")],
      rule: SUBSCRIBE_RULE,
      capabilities: {},
    });
    assert.equal(row.outcome, "FAIL_SERVER");
    assert.equal(row.reason, "evidence-missing");
    assert.match(row.note, /-32601/);
  });

  test("evidence is matched against error messages and details together", () => {
    assert.match(evidenceText([check("FAILURE", "boom", { code: -32601 })]), /boom .*-32601/);
    const row = classifyScenario({
      scenario: "resources-subscribe",
      checks: [check("FAILURE", "rejected", { code: -32601 })],
      rule: SUBSCRIBE_RULE,
      capabilities: {},
    });
    assert.equal(row.outcome, "NOT_APPLICABLE");
  });

  test("a failure no rule covers is attributed to the server", () => {
    const row = classifyScenario({
      scenario: "tools-list",
      checks: [check("FAILURE", "tools/list returned 500")],
      rule: undefined,
      capabilities: {},
    });
    assert.equal(row.outcome, "FAIL_SERVER");
    assert.equal(row.reason, "unexplained-failure");
    assert.match(row.evidence, /returned 500/);
  });

  test("a rule that claims non-PASS while the harness reported SUCCESS is a harness failure", () => {
    const row = classifyScenario({
      scenario: "resources-subscribe",
      checks: [check("SUCCESS")],
      rule: SUBSCRIBE_RULE,
      capabilities: {},
    });
    assert.equal(row.outcome, "FAIL_HARNESS");
    assert.equal(row.reason, "rule-contradicts-result");
  });

  test("a transport scenario is pinned to NOT_APPLICABLE even on SUCCESS", () => {
    const row = classifyScenario({
      scenario: "server-sse-multiple-streams",
      checks: [check("SUCCESS"), check("SUCCESS")],
      rule: { scenario: "server-sse-multiple-streams", outcome: "NOT_APPLICABLE", reason: "bridge-under-test", note: "n" },
      capabilities: {},
    });
    assert.equal(row.outcome, "NOT_APPLICABLE");
    assert.equal(row.reason, "bridge-under-test");
    assert.deepEqual(row.rawStatuses, ["SUCCESS", "SUCCESS"]);
  });

  // Regression pin. This used to yield PASS: the rule branch returned
  // rule.outcome verbatim, and validate-baseline had nothing to catch it with
  // because rawStatuses carried no "FAILURE" — absence of failure was reading as
  // presence of success.
  test("a rule can never turn a run with no SUCCESS into a PASS", () => {
    const row = classifyScenario({
      scenario: "server-sse-polling",
      checks: [check("INFO"), check("WARNING")],
      rule: { scenario: "server-sse-polling", outcome: "PASS", reason: "harness-success" },
      capabilities: {},
    });
    assert.notEqual(row.outcome, "PASS");
  });
});

describe("classifier — a verdict requires something decisive", () => {
  test("only INFO/WARNING checks is NOT_EXERCISED, not a pass and not a defect", () => {
    const row = classifyScenario({
      scenario: "server-sse-polling",
      checks: [check("INFO"), check("WARNING", "recommended, not required")],
      capabilities: {},
    });
    assert.equal(row.outcome, "NOT_EXERCISED");
    assert.equal(row.reason, "no-decisive-checks");
  });

  test("a rule claiming PASS over a real FAILURE is a harness fault, not a pass", () => {
    const row = classifyScenario({
      scenario: "tools-list",
      checks: [check("FAILURE", "boom")],
      rule: { scenario: "tools-list", outcome: "PASS", reason: "harness-success" },
      capabilities: {},
    });
    assert.equal(row.outcome, "FAIL_HARNESS");
    assert.equal(row.reason, "invalid-rule-outcome");
  });

  test("a PASS row whose raw statuses hold no SUCCESS is RED", () => {
    const b = validBaseline();
    b.conformance.matrix[0].rawStatuses = ["INFO", "WARNING"];
    const { ok, violations } = validateBaseline(b);
    assert.equal(ok, false);
    assert.ok(violations.some((v) => v.rule === "R3-relabelled-result" && /no SUCCESS/.test(v.detail)));
  });
});

describe("classifier — coverage gaps are rows, not silence", () => {
  test("a declared scenario with no result is an explicit NOT_EXERCISED row", () => {
    const { matrix } = buildMatrix({
      declaredScenarios: ["ping", "tools-list"],
      results: [{ scenario: "ping", checks: [check("SUCCESS")] }],
      rules: [],
      capabilities: {},
    });
    assert.equal(matrix.length, 2);
    const row = matrix.find((r) => r.scenario === "tools-list");
    assert.equal(row.outcome, "NOT_EXERCISED");
    assert.equal(row.reason, "declared-but-not-run");
  });

  test("a result for a scenario the harness never declared is surfaced and RED", () => {
    const { matrix, undeclared } = buildMatrix({
      declaredScenarios: ["ping"],
      results: [
        { scenario: "ping", checks: [check("SUCCESS")] },
        { scenario: "ghost-scenario", checks: [check("SUCCESS")] },
      ],
      rules: [],
      capabilities: {},
    });
    assert.deepEqual(undeclared, ["ghost-scenario"]);
    assert.equal(matrix.length, 1);
    assertViolation(
      mutate((b) => (b.conformance.undeclared = ["ghost-scenario"])),
      "R5-coverage-gap",
      /never declared: ghost-scenario/,
    );
  });

  test("a matrix shorter than the declared list is RED", () => {
    assertViolation(mutate((b) => b.conformance.matrix.pop()), "R5-coverage-gap", /a scenario was dropped/);
  });

  test("summarise counts every outcome and invents none", () => {
    const counts = summarise([
      { outcome: "PASS" },
      { outcome: "PASS" },
      { outcome: "NOT_APPLICABLE" },
      { outcome: "FAIL_SERVER" },
    ]);
    assert.deepEqual(counts, { PASS: 2, FAIL_SERVER: 1, FAIL_HARNESS: 0, NOT_APPLICABLE: 1, NOT_EXERCISED: 0 });
  });
});

describe("inspector smoke verdicts", () => {
  const toolsList = CASES.find((c) => c.id === "tools-list");
  const unknownTool = CASES.find((c) => c.id === "negative-unknown-tool");
  const goodToolsList = { code: EXIT.OK, parsed: { result: { tools: [{ name: "get_business_context" }] } }, stderr: "" };

  test("the cases this block pins still exist", () => {
    assert.ok(toolsList && unknownTool);
  });

  test("an unexpected exit code is a server failure", () => {
    const verdict = judgeCase(toolsList, { ...goodToolsList, code: EXIT.MCP_ERROR });
    assert.equal(verdict.status, "FAIL_SERVER");
    assert.match(verdict.reasons[0], /exit 1, expected 0/);
  });

  test("a response that fails the case assertion is a server failure", () => {
    const verdict = judgeCase(toolsList, { code: EXIT.OK, parsed: { result: { tools: [] } }, stderr: "" });
    assert.equal(verdict.status, "FAIL_SERVER");
    assert.deepEqual(verdict.reasons, ["response assertion failed"]);
  });

  test("a missing stderr signature is a server failure", () => {
    const unknownResource = CASES.find((c) => c.id === "negative-unknown-resource");
    const verdict = judgeCase(unknownResource, { code: EXIT.MCP_ERROR, parsed: undefined, stderr: "boom" });
    assert.equal(verdict.status, "FAIL_SERVER");
    assert.deepEqual(verdict.reasons, ["stderr assertion failed"]);
  });

  test("unparseable stdout is a harness failure, not a verdict about the server", () => {
    const verdict = judgeCase(toolsList, { code: EXIT.OK, parseError: "SyntaxError: Unexpected token", stderr: "" });
    assert.equal(verdict.status, "FAIL_HARNESS");
    assert.match(verdict.reasons[0], /unparseable stdout/);
  });

  test("a fully matching case the Inspector answered by itself is NOT_EXERCISED, not PASS", () => {
    const verdict = judgeCase(unknownTool, { code: EXIT.TOOL_NOT_FOUND, parsed: undefined, stderr: "tool_not_found" });
    assert.equal(verdict.status, "NOT_EXERCISED");
    assert.deepEqual(verdict.reasons, [unknownTool.serverBehaviorNote]);
  });

  test("a matching case that does reach the server is a PASS", () => {
    assert.equal(judgeCase(toolsList, goodToolsList).status, "PASS");
  });

  test("every case declares whether it proves server behaviour, and says why when it does not", () => {
    for (const testCase of CASES) {
      assert.equal(typeof testCase.provesServerBehavior, "boolean", testCase.id);
      assert.equal(typeof testCase.expectExit, "number", testCase.id);
      if (!testCase.provesServerBehavior) assert.ok(testCase.serverBehaviorNote, testCase.id);
    }
  });
});

/**
 * Each of these is a falsifying case an adversarial review actually executed
 * against an earlier version of this gate and got GREEN out of. They are pinned
 * here so the gate cannot quietly return to waving them through.
 */
describe("attacks that used to pass the gate", () => {
  test("a PASS the fixture detector never observed is RED even though unknownFixtures is empty", () => {
    // Losing the transcript made every row come back with `unknownFixtures: []`,
    // which reads identically to "checked, found nothing" — and the two
    // scenarios the harness false-greens walked back in as PASS. The relayed
    // count is what tells the two apart.
    assertViolation(
      mutate((b) => {
        b.conformance.matrix[0].relayedMessages = 0;
      }),
      "R9-pass-on-missing-fixture",
      /zero relayed messages/,
    );
    assertViolation(
      mutate((b) => {
        delete b.conformance.matrix[0].relayedMessages;
      }),
      "R9-pass-on-missing-fixture",
      /no relayedMessages/,
    );
  });

  test("a full matrix in which nothing was executed is RED", () => {
    const result = mutate((b) => {
      b.conformance.matrix = b.conformance.declaredScenarios.map((scenario) => ({
        scenario,
        outcome: "NOT_EXERCISED",
        reason: "declared-but-not-run",
        evidence: "",
        unknownFixtures: [],
        relayedMessages: 0,
        rawStatuses: [],
      }));
    });
    assertViolation(result, "R1-zero-scenarios", /produced no result/);
    assertViolation(result, "R1-zero-scenarios", /nothing was actually executed/);
  });

  test("a rule cannot excuse a real failure with evidence the harness never produced", () => {
    assertViolation(
      mutate((b) => {
        Object.assign(b.conformance.matrix[0], {
          outcome: "NOT_APPLICABLE",
          reason: "harness-fixture",
          evidence: "e",
          evidenceRequired: "e",
          rawStatuses: ["FAILURE"],
        });
      }),
      "R8-evidence-unverifiable",
      /no failing check in evidence\.json contains it/,
    );
  });

  test("a renamed row is RED even though the row count still matches", () => {
    assertViolation(
      mutate((b) => {
        b.conformance.matrix[1].scenario = "made-up";
      }),
      "R5-coverage-gap",
      /declared but absent/,
    );
  });

  test("version metadata that is present but wrong is RED", () => {
    assertViolation(
      mutate((b) => {
        b.versions.conformanceVersion = "0.0.1-never-ran";
      }),
      "R4-version-metadata-missing",
      /pinned-versions\.mjs says/,
    );
    assertViolation(
      mutate((b) => {
        b.versions.serverSha = "not-a-sha";
      }),
      "R4-version-metadata-missing",
      /not a 40-hex commit sha/,
    );
  });

  test("a relay that dropped messages cannot produce a green baseline", () => {
    assertViolation(
      mutate((b) => {
        b.relayErrors = [{ direction: "to-server", error: "EPIPE" }];
      }),
      "R11-relay-errors",
    );
    assertViolation(
      mutate((b) => {
        delete b.relayErrors;
      }),
      "R11-relay-errors",
      /does not record/,
    );
  });
});

describe("classifier — a rule explains only the failures it actually matches", () => {
  test("a passing check cannot supply the evidence for a failing one", () => {
    // `tools-call-with-logging` is a two-phase scenario: a SUCCESS reading
    // "-32601 as expected" must not explain an unrelated phase-2 failure.
    const row = classifyScenario({
      scenario: "tools-call-with-logging",
      checks: [
        check("SUCCESS", "logging/setLevel -32601 as expected"),
        check("FAILURE", "tools/call returned malformed content"),
      ],
      rule: {
        scenario: "tools-call-with-logging",
        outcome: "NOT_APPLICABLE",
        reason: "capability-absent",
        requiresCapabilityAbsent: "logging",
        requiresEvidence: "-32601",
      },
      capabilities: {},
    });
    assert.equal(row.outcome, "FAIL_SERVER");
    assert.equal(row.reason, "evidence-missing");
  });

  test("the recorded evidence is the harness's text, not the rule's own assertion", () => {
    const row = classifyScenario({
      scenario: "resources-subscribe",
      checks: [check("FAILURE", "Failed: MCP error -32601: Method not found")],
      rule: SUBSCRIBE_RULE,
      capabilities: { resources: { listChanged: true } },
    });
    assert.equal(row.outcome, "NOT_APPLICABLE");
    assert.notEqual(row.evidence, "-32601");
    assert.match(row.evidence, /Method not found/);
    assert.equal(row.evidenceRequired, "-32601");
  });
});

describe("the shipped Phase 0 artifact", () => {
  test("passes its own gate, with its own evidence bundle behind it", () => {
    const result = validateBaseline(SHIPPED, SHIPPED_EVIDENCE);
    assert.deepEqual(result.violations, []);
    assert.equal(result.ok, true);
  });

  // The evidence cross-check must be the reason the shipped artifact passes, not
  // a formality: without evidence.json the same baseline has to go RED.
  test("the shipped baseline cannot be validated without its evidence bundle", () => {
    const result = validateBaseline(SHIPPED, null);
    assertViolation(result, "R8-evidence-unverifiable");
  });

  test("has exactly one matrix row per declared scenario", () => {
    const declared = SHIPPED.conformance.declaredScenarios;
    const scenarios = SHIPPED.conformance.matrix.map((r) => r.scenario);
    assert.equal(scenarios.length, declared.length);
    assert.deepEqual([...scenarios].sort(), [...declared].sort());
  });

  test("every outcome is one of the five", () => {
    for (const row of SHIPPED.conformance.matrix) assert.ok(OUTCOMES.includes(row.outcome), row.scenario);
    for (const c of SHIPPED.inspector.cases) assert.ok(OUTCOMES.includes(c.status), c.id);
  });

  test("every applicability rule names a scenario the harness actually declared", () => {
    assert.ok(RULES.length > 0);
    for (const rule of RULES) {
      assert.ok(
        SHIPPED.conformance.declaredScenarios.includes(rule.scenario),
        `applicability rule for ${rule.scenario} names no declared scenario`,
      );
      assert.notEqual(rule.outcome, "PASS", `${rule.scenario}: a rule may explain a failure, never grant a PASS`);
    }
  });

  test("the recorded counts are the counts of the matrix", () => {
    assert.deepEqual(SHIPPED.conformance.counts, summarise(SHIPPED.conformance.matrix));
  });

  test("no PASS rests on a missing fixture, a transport scenario or an absent status", () => {
    for (const row of SHIPPED.conformance.matrix.filter((r) => r.outcome === "PASS")) {
      assert.deepEqual(row.unknownFixtures ?? [], [], row.scenario);
      assert.notEqual(row.reason, "bridge-under-test", row.scenario);
      assert.ok(row.rawStatuses.length > 0 && !row.rawStatuses.includes("FAILURE"), row.scenario);
    }
  });
});
