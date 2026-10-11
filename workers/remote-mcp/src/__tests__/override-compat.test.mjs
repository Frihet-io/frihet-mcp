import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Pins the #161 runtime overrides: `ai` and `@ai-sdk/gateway` pin
// @ai-sdk/provider-utils exactly, so an unbounded override (">=4.0.33")
// resolved a different major than they were built against and broke
// `import("ai")` while every other test stayed green.
const pkg = (name) => JSON.parse(readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), "utf8"));
const major = (v) => Number(String(v).split(".")[0]);

test("provider-utils resolves to the major that ai was built against", () => {
  const ai = pkg("ai");
  const utils = (() => {
    try { return pkg("ai/node_modules/@ai-sdk/provider-utils"); } catch { return pkg("@ai-sdk/provider-utils"); }
  })();
  assert.equal(major(utils.version), major(ai.dependencies["@ai-sdk/provider-utils"]));
});

test("ai still imports under the runtime overrides", async () => {
  const mod = await import("ai");
  assert.equal(typeof mod, "object");
});
