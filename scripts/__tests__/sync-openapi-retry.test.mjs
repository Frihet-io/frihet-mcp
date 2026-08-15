import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const preload = String.raw`
import { readFileSync } from "node:fs";

const mode = process.env.OPENAPI_FETCH_TEST_MODE;
const canonical = readFileSync("workers/remote-mcp/public/openapi.json", "utf8");
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, _delay, ...args) => realSetTimeout(callback, 0, ...args);

let attempts = 0;
let previousSignal;
globalThis.fetch = async (_url, options) => {
  attempts += 1;
  const fresh = attempts === 1 || options.signal !== previousSignal;
  previousSignal = options.signal;
  console.error("MOCK_FETCH attempt=" + attempts + " freshSignal=" + fresh);

  if (mode === "http-4xx") {
    return {
      status: 403,
      ok: false,
      text: async () => {
        console.error("MOCK_BODY_READ");
        return "forbidden";
      },
    };
  }

  if (mode === "malformed") {
    return { status: 200, ok: true, text: async () => "{" };
  }

  if (mode === "non-spec") {
    return { status: 200, ok: true, text: async () => '{"error":"Not found"}' };
  }

  if (mode === "body-reset" && attempts === 1) {
    return {
      status: 200,
      ok: true,
      text: async () => {
        throw new TypeError("terminated while reading body");
      },
    };
  }

  if (mode === "body-reset-exhausted") {
    return {
      status: 200,
      ok: true,
      text: async () => {
        throw new DOMException("body timed out", "TimeoutError");
      },
    };
  }

  return { status: 200, ok: true, text: async () => canonical };
};
`;

function run(mode) {
  return spawnSync(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, "scripts/sync-openapi.mjs", "--check"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, OPENAPI_FETCH_TEST_MODE: mode },
    },
  );
}

test("a body reset retries the complete transfer with a fresh signal", () => {
  const result = run("body-reset");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /MOCK_FETCH attempt=1 freshSignal=true/);
  assert.match(result.stderr, /MOCK_FETCH attempt=2 freshSignal=true/);
  assert.match(result.stdout, /workers\/remote-mcp\/public\/openapi\.json matches canonical/);
});

test("exhausted body timeouts are classified as origin unavailable", () => {
  const result = run("body-reset-exhausted");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /MOCK_FETCH attempt=3 freshSignal=true/);
  assert.match(result.stderr, /ORIGIN_UNAVAILABLE: canonical spec unreachable after retries/);
});

test("completed malformed JSON and non-spec JSON fail semantically without retry", () => {
  for (const mode of ["malformed", "non-spec"]) {
    const result = run(mode);
    assert.equal(result.status, 1, `${mode}: ${result.stderr}`);
    assert.match(result.stderr, /MOCK_FETCH attempt=1 freshSignal=true/);
    assert.doesNotMatch(result.stderr, /MOCK_FETCH attempt=2/);
    assert.doesNotMatch(result.stderr, /ORIGIN_UNAVAILABLE/);
  }
});

test("completed HTTP 4xx fails without retrying or reading its body", () => {
  const result = run("http-4xx");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /GET .*openapi\.json → HTTP 403/);
  assert.doesNotMatch(result.stderr, /MOCK_FETCH attempt=2/);
  assert.doesNotMatch(result.stderr, /MOCK_BODY_READ/);
  assert.doesNotMatch(result.stderr, /ORIGIN_UNAVAILABLE/);
});
