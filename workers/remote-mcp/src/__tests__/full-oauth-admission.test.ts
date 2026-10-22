import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { authHandler } from "../auth-handler.ts";

// Exercise the real routes without any cloud access. The source release
// deliberately has no separate full-profile credential authority yet.
const release = JSON.parse(readFileSync(new URL("../../full-oauth-release-contract.json", import.meta.url), "utf8"));

test("full OAuth hold is disclosed before consent, state allocation or credentials", async () => {
  assert.equal(release.status, "hold");
  assert.equal(release.authorityUrl, null);
  const env = new Proxy({ FRIHET_OPENAI_MODE: "false", FRIHET_CLAUDE_MODE: "false" }, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      throw new Error(`OAuth hold must not access ${String(key)}`);
    },
  });
  for (const scope of ["read", "write", "read write", "", "openid email frihet:workspace.manage"]) {
    const request = new Request(`https://mcp.frihet.io/authorize?scope=${encodeURIComponent(scope)}`);
    const response = await authHandler.fetch(request, env as unknown as Env);
    assert.equal(response.status, 503, `scope=${scope}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.error, "temporarily_unavailable");
    assert.match(String(body.error_description), /New OAuth connections/);
    assert.match(String(body.error_description), /No permissions have been granted/);
    assert.doesNotMatch(JSON.stringify(body), /full access|broad read and write|<form/i);
  }
  const callback = await authHandler.fetch(new Request("https://mcp.frihet.io/callback", {
    method: "POST",
    body: JSON.stringify({ stateKey: "previous-state", idToken: "must-not-be-processed" }),
    headers: { "Content-Type": "application/json" },
  }), env as unknown as Env);
  assert.equal(callback.status, 503);
  assert.equal((await callback.json() as Record<string, unknown>).error, "temporarily_unavailable");
});

test("reviewed Claude and OpenAI requests still reach their existing request validator", async () => {
  for (const profile of ["openai", "claude"] as const) {
    const response = await authHandler.fetch(new Request(`https://${profile}-mcp.frihet.io/authorize`), {
      FRIHET_OPENAI_MODE: String(profile === "openai"),
      FRIHET_CLAUDE_MODE: String(profile === "claude"),
    } as Env);
    assert.equal(response.status, 400);
    assert.equal((await response.json() as Record<string, unknown>).error, "invalid_request");
  }
});
