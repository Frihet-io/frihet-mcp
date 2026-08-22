#!/usr/bin/env node
/**
 * Official MCP Inspector CLI smoke, run as a SEPARATE interoperability surface
 * from the conformance suite (issue #1578, Phase 0).
 *
 * Unlike the conformance harness this speaks stdio natively, so it reaches the
 * Frihet server with no relay in between and can exercise the things the
 * conformance fixtures cannot: real Frihet resource URIs, real Frihet prompts,
 * and a real read-only tool call.
 *
 * Every case declares `provesServerBehavior`. Cases where the Inspector answers
 * on its own (it pre-checks tools/list, so an unknown tool never reaches the
 * server) are marked false and are reported as NOT_EXERCISED for server
 * behaviour rather than counted as evidence.
 *
 * Read-only by construction: FRIHET_DEMO=1, no FRIHET_API_KEY, and the only
 * tool invoked is get_business_context.
 */
import { spawn } from "node:child_process";

const INSPECTOR_PKG = "@modelcontextprotocol/inspector";

/** Inspector CLI exit codes observed and pinned by this harness. */
export const EXIT = {
  OK: 0,
  MCP_ERROR: 1,
  TOOL_NOT_FOUND: 5,
};

export const CASES = [
  {
    id: "tools-list",
    intent: "tools/list over stdio",
    args: ["--method", "tools/list"],
    expectExit: EXIT.OK,
    assert: (r) => Array.isArray(r?.result?.tools) && r.result.tools.length > 0,
    provesServerBehavior: true,
  },
  {
    id: "resources-list",
    intent: "resources/list over stdio",
    args: ["--method", "resources/list"],
    expectExit: EXIT.OK,
    assert: (r) => Array.isArray(r?.result?.resources) && r.result.resources.length > 0,
    provesServerBehavior: true,
  },
  {
    id: "prompts-list",
    intent: "prompts/list over stdio",
    args: ["--method", "prompts/list"],
    expectExit: EXIT.OK,
    assert: (r) => Array.isArray(r?.result?.prompts) && r.result.prompts.length > 0,
    provesServerBehavior: true,
  },
  {
    id: "resources-read-real-uri",
    intent: "resources/read on a real Frihet URI — the gap the conformance fixtures leave open",
    args: ["--method", "resources/read", "--uri", "frihet://tax/rates"],
    expectExit: EXIT.OK,
    assert: (r) => Array.isArray(r?.result?.contents) && r.result.contents.length > 0,
    provesServerBehavior: true,
  },
  {
    id: "prompts-get-no-args",
    intent: "prompts/get on a real Frihet prompt with no arguments",
    args: ["--method", "prompts/get", "--prompt-name", "overdue-followup"],
    expectExit: EXIT.OK,
    assert: (r) => Array.isArray(r?.result?.messages) && r.result.messages.length > 0,
    provesServerBehavior: true,
  },
  {
    id: "prompts-get-with-args",
    intent: "prompts/get with required arguments",
    args: ["--method", "prompts/get", "--prompt-name", "monthly-close", "--prompt-args", "month=2026-07"],
    expectExit: EXIT.OK,
    assert: (r) => Array.isArray(r?.result?.messages) && r.result.messages.length > 0,
    provesServerBehavior: true,
  },
  {
    id: "tools-call-safe-read",
    intent: "tools/call on a read-only tool against demo fixtures",
    args: ["--method", "tools/call", "--tool-name", "get_business_context"],
    expectExit: EXIT.OK,
    assert: (r) => Array.isArray(r?.result?.content) && r.result.isError !== true,
    provesServerBehavior: true,
  },
  {
    id: "negative-unknown-resource",
    intent: "resources/read on an unknown URI must be an error, not empty success",
    args: ["--method", "resources/read", "--uri", "frihet://__does_not_exist__"],
    expectExit: EXIT.MCP_ERROR,
    assertStderr: (s) => s.includes("-32602") && s.includes("not found"),
    provesServerBehavior: true,
  },
  {
    id: "negative-unknown-prompt",
    intent: "prompts/get on an unknown prompt must be an error",
    args: ["--method", "prompts/get", "--prompt-name", "__does_not_exist__"],
    expectExit: EXIT.MCP_ERROR,
    assertStderr: (s) => s.includes("-32602") && s.includes("not found"),
    provesServerBehavior: true,
  },
  {
    // `monthly-close` is deliberately NOT used here: its `month` argument is
    // declared required:false and defaults to the previous month, so accepting
    // the call is correct behaviour. `year-end-close.year` is required:true.
    id: "negative-missing-required-prompt-arg",
    intent: "prompts/get without a required argument must be rejected",
    args: ["--method", "prompts/get", "--prompt-name", "year-end-close"],
    expectExit: EXIT.MCP_ERROR,
    assertStderr: (s) => s.includes("-32602") && s.includes("Invalid arguments"),
    provesServerBehavior: true,
  },
  {
    id: "negative-unknown-tool",
    intent: "tools/call on an unknown tool",
    args: ["--method", "tools/call", "--tool-name", "__does_not_exist__"],
    expectExit: EXIT.TOOL_NOT_FOUND,
    assertStderr: (s) => s.includes("tool_not_found"),
    // The Inspector checks tools/list first and refuses locally, so the request
    // never reaches Frihet. Server-side unknown-tool handling is evidenced by the
    // conformance transcript instead, not by this case.
    provesServerBehavior: false,
    serverBehaviorNote:
      "Inspector rejects client-side (exit 5); server-side unknown-tool handling is NOT_EXERCISED here.",
  },
];

export async function runCase(testCase, { inspectorVersion, serverEntry }) {
  const argv = [
    "--yes",
    `${INSPECTOR_PKG}@${inspectorVersion}`,
    "--cli",
    process.execPath,
    serverEntry,
    "-e",
    "FRIHET_DEMO=1",
    ...testCase.args,
    "--format",
    "json",
  ];

  const { code, stdout, stderr } = await new Promise((resolve) => {
    const child = spawn("npx", argv, {
      // A real key must be impossible to pick up, not merely unused.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (c) => resolve({ code: c, stdout: out, stderr: err }));
  });

  let parsed;
  let parseError;
  if (stdout.trim().length > 0) {
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      parseError = String(error);
    }
  }

  return { code, parsed, parseError, stderr };
}

/**
 * Pure verdict for one executed case. Kept separate from execution so the
 * anti-false-green tests can drive it with synthetic input.
 */
export function judgeCase(testCase, execution) {
  const reasons = [];
  if (execution.parseError) {
    return { id: testCase.id, status: "FAIL_HARNESS", reasons: [`unparseable stdout: ${execution.parseError}`] };
  }
  if (execution.code !== testCase.expectExit) {
    reasons.push(`exit ${execution.code}, expected ${testCase.expectExit}`);
  }
  if (testCase.assert && !testCase.assert(execution.parsed)) {
    reasons.push("response assertion failed");
  }
  if (testCase.assertStderr && !testCase.assertStderr(execution.stderr ?? "")) {
    reasons.push("stderr assertion failed");
  }
  if (reasons.length > 0) {
    return { id: testCase.id, status: "FAIL_SERVER", reasons };
  }
  return {
    id: testCase.id,
    status: testCase.provesServerBehavior ? "PASS" : "NOT_EXERCISED",
    reasons: testCase.provesServerBehavior ? [] : [testCase.serverBehaviorNote],
  };
}
