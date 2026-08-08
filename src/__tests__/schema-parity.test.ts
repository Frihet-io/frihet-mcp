/**
 * The schema-parity gate, run as a test — plus the gate's OWN selftest.
 *
 * Two jobs:
 *
 * 1. REGRESSION — every checked-in backend-response fixture must validate
 *    against the outputSchema its tool declares. This is the failing-first test
 *    for C8/C9/C10/C11/C12/C13/C14/C-EXTRA: before the fix it goes red on
 *    list_webhooks (missing limit/offset), payroll_checklist / payroll_export /
 *    overtime_report / period_close_status (leaked {data,meta} envelope),
 *    list_vendors / get_vendor (string address rejected), and
 *    permissions_me / permissions_matrix (envelope leak that the all-optional
 *    schema was validating VACUOUSLY).
 *
 * 2. SELFTEST — a gate nobody tested is a gate nobody can trust. Three injected
 *    drifts must each turn it red: a rejected response, an envelope leak, and an
 *    undocumented phantom key. If these ever pass, the gate has stopped gating.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  runSchemaParityGate,
  formatReport,
  loadFixtures,
  loadCoverageFloor,
  type ParityFixture,
} from "./schema-parity.gate.js";

describe("schema parity — real backend responses vs declared MCP outputSchemas", () => {
  test("every fixture validates against its tool's outputSchema", async () => {
    const report = await runSchemaParityGate();
    assert.equal(
      report.failures.length,
      0,
      `\n${formatReport(report)}\n`,
    );
  });

  test("the report names its scan scope (no whole-surface claim from a subset)", async () => {
    const report = await runSchemaParityGate();
    assert.ok(report.toolsWithOutputSchema > report.toolsCovered, "there are still uncovered tools");
    assert.equal(
      report.uncovered.length,
      report.toolsWithOutputSchema - report.toolsCovered,
      "every uncovered tool must be listed by name, not just counted",
    );
    const text = formatReport(report);
    assert.match(text, /checked \d+ of \d+ tools/);
    assert.match(text, /UNCOVERED/);
    assert.match(text, /This proves NOTHING about the \d+ uncovered tools/);
  });

  test("coverage floor is met and every fixture targets a registered tool", async () => {
    const report = await runSchemaParityGate();
    assert.ok(
      report.toolsCovered >= loadCoverageFloor(),
      `covered ${report.toolsCovered} < floor ${report.coverageFloor}`,
    );
    assert.equal(report.toolsCovered, loadFixtures().length, "one fixture file per covered tool");
  });

  test("at least one LEGACY-shaped fixture is exercised", async () => {
    const report = await runSchemaParityGate();
    assert.ok(
      report.legacyCasesChecked > 0,
      "a schema that rejects live legacy production data is the bug — keep legacy fixtures",
    );
  });
});

describe("schema parity gate SELFTEST — injected drift must turn it red", () => {
  const vendorFixture = (): ParityFixture => ({
    tool: "get_vendor",
    provenance: "selftest",
    cases: [
      {
        name: "injected",
        args: { id: "vend_1" },
        routes: {
          "GET /vendors/vend_1": {
            data: { id: "vend_1", name: "AWS EMEA SARL" },
            meta: { requestId: "r" },
          },
        },
      },
    ],
  });

  test("a response the schema rejects is reported", async () => {
    const broken = vendorFixture();
    // `name` is required by vendorItemOutput; a real response missing it is drift.
    broken.cases[0]!.routes["GET /vendors/vend_1"] = { data: { id: "vend_1" }, meta: {} };
    const report = await runSchemaParityGate({ fixtures: [broken], coverageFloor: 0 });
    const kinds = report.failures.map((f) => f.kind);
    assert.ok(kinds.includes("schema-rejected-real-response"), formatReport(report));
  });

  test("a leaked { data, meta } envelope is reported even though the schema would pass it", async () => {
    const leaking = vendorFixture();
    // Double envelope: requestUnwrapped strips ONE level, so the tool still ships
    // { data, meta } — exactly the shape a forgotten requestUnwrapped produces.
    leaking.cases[0]!.routes["GET /vendors/vend_1"] = {
      data: { data: { id: "vend_1", name: "AWS EMEA SARL" }, meta: { requestId: "r" } },
      meta: { requestId: "r" },
    };
    const report = await runSchemaParityGate({ fixtures: [leaking], coverageFloor: 0 });
    const kinds = report.failures.map((f) => f.kind);
    assert.ok(kinds.includes("envelope-leak"), formatReport(report));
  });

  test("a declared key no real response carries is reported as a phantom", async () => {
    const phantom = vendorFixture();
    // vendorItemOutput declares email/phone/taxId/address/createdAt/updatedAt;
    // this fixture exercises none of them and documents none of them.
    const report = await runSchemaParityGate({ fixtures: [phantom], coverageFloor: 0 });
    const kinds = report.failures.map((f) => f.kind);
    assert.ok(kinds.includes("undocumented-phantom-key"), formatReport(report));
  });

  test("documenting a key in declaredKeysNotInFixtures silences the phantom check", async () => {
    const documented = vendorFixture();
    documented.declaredKeysNotInFixtures = {
      email: "not exercised", phone: "not exercised", taxId: "not exercised",
      address: "not exercised", createdAt: "not exercised", updatedAt: "not exercised",
    };
    const report = await runSchemaParityGate({ fixtures: [documented], coverageFloor: 0 });
    assert.equal(report.failures.length, 0, formatReport(report));
  });

  test("a fixture whose routes do not cover the call is reported, never silently passed", async () => {
    const unrouted = vendorFixture();
    unrouted.cases[0]!.routes = { "GET /vendors/some-other-id": { data: {}, meta: {} } };
    const report = await runSchemaParityGate({ fixtures: [unrouted], coverageFloor: 0 });
    const kinds = report.failures.map((f) => f.kind);
    assert.ok(
      kinds.includes("unrouted-request") || kinds.includes("tool-error"),
      formatReport(report),
    );
  });

  test("a fixture naming an unregistered tool is reported", async () => {
    const ghost: ParityFixture = { tool: "no_such_tool", provenance: "selftest", cases: [] };
    const report = await runSchemaParityGate({ fixtures: [ghost], coverageFloor: 0 });
    assert.equal(report.failures[0]!.kind, "unknown-tool");
  });

  test("coverage dropping below the committed floor is reported", async () => {
    const report = await runSchemaParityGate({ fixtures: [], coverageFloor: 11 });
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0]!.kind, "coverage-floor");
  });
});
