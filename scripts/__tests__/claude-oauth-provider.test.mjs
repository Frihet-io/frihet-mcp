import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

import {
  LOCKED_OAUTH_PROVIDER_SHA256,
  LOCKED_OAUTH_PROVIDER_VERSION,
  patchClaudeOAuthProvider,
} from "../prepare-claude-oauth-provider.mjs";

const workerDir = new URL("../../workers/remote-mcp/", import.meta.url);
const sdkDir = new URL("node_modules/@cloudflare/workers-oauth-provider/", workerDir);
const source = readFileSync(new URL("dist/oauth-provider.js", sdkDir), "utf8");
const version = JSON.parse(readFileSync(new URL("package.json", sdkDir), "utf8")).version;
const patched = patchClaudeOAuthProvider(source, version);

function sdkRedirectHelpers(providerSource) {
  const start = providerSource.indexOf("function isLoopbackUri(uri) {");
  const stop = providerSource.indexOf("function base64UrlEncode(str) {", start);
  assert.ok(start > 0 && stop > start);
  return vm.runInNewContext(`${providerSource.slice(start, stop)}\n({ isLoopbackUri, isValidRedirectUri });`, { URL });
}

const stock = sdkRedirectHelpers(source);
const claude = sdkRedirectHelpers(patched);

test("Claude build patch pins the actual locked SDK source and changes exactly one line", () => {
  const lock = JSON.parse(readFileSync(new URL("package-lock.json", workerDir), "utf8"));
  assert.equal(version, "0.3.0");
  assert.equal(lock.packages["node_modules/@cloudflare/workers-oauth-provider"].version, version);
  assert.equal(version, LOCKED_OAUTH_PROVIDER_VERSION);
  assert.equal(createHash("sha256").update(source).digest("hex"), LOCKED_OAUTH_PROVIDER_SHA256);
  const inserted = '\t\tif (host === "localhost") return true;\n';
  assert.equal(patched.split(inserted).length, 2);
  assert.equal(patched.replace(inserted, ""), source);
  assert.throws(() => patchClaudeOAuthProvider(source, "0.3.1"), /audited SDK version/u);
  assert.throws(() => patchClaudeOAuthProvider(`${source}\n`, version), /audited SDK SHA256/u);
  assert.throws(() => patchClaudeOAuthProvider(patched, version), /audited SDK SHA256/u);
  assert.equal(readFileSync(new URL("dist/oauth-provider.js", sdkDir), "utf8"), source);
});

test("Claude permits localhost with a changed port only; stock SDK behavior stays unchanged", () => {
  const registered = "http://localhost:8080/oauth/callback?client=claude-code";
  const callback = "http://localhost:49152/oauth/callback?client=claude-code";
  assert.equal(stock.isLoopbackUri(registered), false);
  assert.equal(stock.isValidRedirectUri(callback, [registered]), false);
  assert.equal(claude.isLoopbackUri(registered), true);
  assert.equal(claude.isValidRedirectUri(callback, [registered]), true);
  for (const rejected of [
    "http://localhost.evil:49152/oauth/callback?client=claude-code",
    "http://localhost.:49152/oauth/callback?client=claude-code",
    "http://127.0.0.1:49152/oauth/callback?client=claude-code",
    "http://[::1]:49152/oauth/callback?client=claude-code",
    "https://localhost:49152/oauth/callback?client=claude-code",
    "http://localhost:49152/other?client=claude-code",
    "http://localhost:49152/oauth/callback/?client=claude-code",
    "http://localhost:49152/oauth/callback?client=foreign",
    "http://localhost:49152/oauth/callback",
  ]) {
    assert.equal(claude.isValidRedirectUri(rejected, [registered]), false, rejected);
  }
  assert.equal(claude.isValidRedirectUri("http://localhost.evil:49152/callback", ["http://localhost.evil:8080/callback"]), false);
});

test("Claude preserves exact external redirects and existing 127/8 and IPv6 loopback matching", () => {
  for (const helper of [stock, claude]) {
    const external = "https://claude.ai/api/mcp/auth_callback";
    assert.equal(helper.isValidRedirectUri(external, [external]), true);
    for (const rejected of [
      "https://claude.ai:443/api/mcp/auth_callback",
      "https://claude.ai:49152/api/mcp/auth_callback",
      "https://claude.ai/api/mcp/auth_callback?extra=1",
      "https://claude.ai.evil.example/api/mcp/auth_callback",
    ]) assert.equal(helper.isValidRedirectUri(rejected, [external]), false, rejected);
    for (const host of ["127.0.0.1", "127.0.0.2", "[::1]"]) {
      assert.equal(helper.isValidRedirectUri(`http://${host}:49152/callback?a=1`, [`http://${host}:8080/callback?a=1`]), true);
      assert.equal(helper.isValidRedirectUri(`http://${host}:49152/other?a=1`, [`http://${host}:8080/callback?a=1`]), false);
      assert.equal(helper.isValidRedirectUri(`http://${host}:49152/callback?a=2`, [`http://${host}:8080/callback?a=1`]), false);
      assert.equal(helper.isValidRedirectUri(`https://${host}:49152/callback?a=1`, [`http://${host}:8080/callback?a=1`]), false);
    }
    assert.equal(helper.isValidRedirectUri("http://127.0.0.2:49152/callback", ["http://127.0.0.1:8080/callback"]), false);
  }
});
