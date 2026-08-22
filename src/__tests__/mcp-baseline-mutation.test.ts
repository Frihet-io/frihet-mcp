/**
 * Adversarial Mutation Tests for the MCP Compatibility & Baseline Harness.
 *
 * Verifies that the compatibility harness and baseline assertion engine
 * deterministically turn RED under all required mutation proofs:
 *   1. Remove one canonical tool → RED
 *   2. Duplicate tool name → RED
 *   3. Pagination drops page 2 → RED
 *   4. Structured content is malformed → RED
 *   5. Input schema drift → RED
 *   6. Wrong error shape → RED
 *   7. Resource or prompt count drift → RED
 *   8. Action annotation drift → RED
 *
 * Run: npm test (after build)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  assertMcpBaseline,
  runMcpBaseline,
  type McpBaselineReport,
} from "../canary/mcp-harness.js";

describe("MCP Compatibility Lab — Mutation Proofs", () => {
  let goldenBaseline: McpBaselineReport;

  test("fixture setup: capture valid baseline", async () => {
    goldenBaseline = await runMcpBaseline();
    assert.equal(goldenBaseline.summary.overallStatus, "PASS_WITH_GAPS");
    assert.equal(goldenBaseline.summary.totalTools, 162);
    assert.equal(goldenBaseline.summary.canonicalOperations, 157);
    assert.equal(goldenBaseline.summary.resources, 11);
    assert.equal(goldenBaseline.summary.prompts, 10);
    assert.equal(goldenBaseline.summary.checks.pass, 21);
    assert.equal(goldenBaseline.summary.checks.notExercised, 2);
    assert.equal(goldenBaseline.summary.checks.fail, 0);
  });

  test("mutation proof 1: remove one canonical tool → RED", () => {
    const mutated = structuredClone(goldenBaseline);
    mutated.tools = mutated.tools.filter((t) => t.name !== "create_invoice");
    mutated.summary.totalTools = mutated.tools.length;
    mutated.summary.canonicalOperations = 156;

    assert.throws(
      () => assertMcpBaseline(mutated, goldenBaseline),
      /Tool count drift|Missing expected tool/i,
      "Harness must turn RED when a canonical tool is removed",
    );
  });

  test("mutation proof 2: duplicate tool → RED", () => {
    const mutated = structuredClone(goldenBaseline);
    const firstTool = mutated.tools[0]!;
    mutated.tools.push(structuredClone(firstTool));
    mutated.summary.totalTools = mutated.tools.length;

    assert.throws(
      () => assertMcpBaseline(mutated, goldenBaseline),
      /Duplicate tool detected|Tool count drift/i,
      "Harness must turn RED when duplicate tools exist",
    );
  });

  test("mutation proof 3: pagination drops page 2 → RED", () => {
    const mutated = structuredClone(goldenBaseline);
    mutated.summary.overallStatus = "FAIL";
    mutated.summary.checks.fail = 1;
    const paginationCheck = mutated.checkMatrix.find((c) => c.id === "pagination.cursor_and_limits");
    assert.ok(paginationCheck);
    paginationCheck.status = "FAIL";
    paginationCheck.detail = "Simulated pagination failure: page 2 dropped during offset/cursor paging";

    assert.throws(
      () => assertMcpBaseline(mutated, goldenBaseline),
      /Baseline failed with.*errors/i,
      "Harness must turn RED when pagination drops a page",
    );
  });

  test("mutation proof 4: structuredContent malformed → RED", () => {
    const mutated = structuredClone(goldenBaseline);
    mutated.summary.overallStatus = "FAIL";
    mutated.summary.checks.fail = 1;
    const readCheck = mutated.checkMatrix.find((c) => c.id === "reads.list_invoices");
    assert.ok(readCheck);
    readCheck.status = "FAIL";
    readCheck.detail = "Invalid payload shape: structuredContent omitted required total field";

    assert.throws(
      () => assertMcpBaseline(mutated, goldenBaseline),
      /Baseline failed with.*errors/i,
      "Harness must turn RED when structuredContent is malformed",
    );
  });

  test("mutation proof 5: input schema drift → RED", () => {
    const mutated = structuredClone(goldenBaseline);
    const invoiceTool = mutated.tools.find((t) => t.name === "get_invoice");
    assert.ok(invoiceTool);
    invoiceTool.inputSchema = { type: "object", properties: {} };

    assert.throws(
      () => assertMcpBaseline(mutated, goldenBaseline),
      /Input schema drift on tool get_invoice/i,
      "Harness must turn RED when an input schema drifts",
    );
  });

  test("mutation proof 6: wrong error shape → RED", () => {
    const mutated = structuredClone(goldenBaseline);
    mutated.summary.overallStatus = "FAIL";
    mutated.summary.checks.fail = 1;
    const errorCheck = mutated.checkMatrix.find((c) => c.id === "errors.unknown_tool");
    assert.ok(errorCheck);
    errorCheck.status = "FAIL";
    errorCheck.detail = "Unknown tool call returned 200 OK instead of typed -32601 error";

    assert.throws(
      () => assertMcpBaseline(mutated, goldenBaseline),
      /Baseline failed with.*errors/i,
      "Harness must turn RED when error shape is wrong",
    );
  });

  test("mutation proof 7: resource or prompt count drift → RED", () => {
    const mutatedRes = structuredClone(goldenBaseline);
    mutatedRes.resources = mutatedRes.resources.slice(1);
    mutatedRes.summary.resources = mutatedRes.resources.length;

    assert.throws(
      () => assertMcpBaseline(mutatedRes, goldenBaseline),
      /Resource count drift/i,
      "Harness must turn RED when resources are dropped",
    );

    const mutatedPrompt = structuredClone(goldenBaseline);
    mutatedPrompt.prompts = mutatedPrompt.prompts.slice(1);
    mutatedPrompt.summary.prompts = mutatedPrompt.prompts.length;

    assert.throws(
      () => assertMcpBaseline(mutatedPrompt, goldenBaseline),
      /Prompt count drift/i,
      "Harness must turn RED when prompts are dropped",
    );
  });

  test("mutation proof 8: action annotation drift → RED", () => {
    const mutated = structuredClone(goldenBaseline);
    const invoiceTool = mutated.tools.find((t) => t.name === "create_invoice");
    assert.ok(invoiceTool);
    invoiceTool.annotations = { ...invoiceTool.annotations, readOnlyHint: true };

    assert.throws(
      () => assertMcpBaseline(mutated, goldenBaseline),
      /Annotation drift on tool create_invoice/i,
      "Harness must turn RED when action annotations drift",
    );
  });
});
