/**
 * Release-meta tests — the Worker /health endpoint exposes the source SHA
 * the deploy pipeline passed via wrangler var, so the release workflow can
 * prove "Worker on the wire == commit that produced the tarball" after
 * npm byte verification. Without this, a stale Worker or metadata-only
 * follow-up commit can sit on mcp.frihet.io indefinitely after the npm
 * tarball has moved on.
 *
 * What this file pins:
 *   1. Valid 40-hex sha → reported verbatim, source = "wrangler-var"
 *   2. Lowercase normalisation (wrangler preserves case, registry hashes
 *      compare case-insensitive, /health should be canonical)
 *   3. Missing var → "unknown" + source = "fallback-unknown" (regular
 *      wrangler deploys do NOT lie about provenance they cannot prove)
 *   4. Malformed var (too short, too long, non-hex) → "unknown", never
 *      echoes back attacker-controlled string into the release SHA check
 *   5. RELEASE_VERSION is independent, may be absent (var is optional)
 *
 * Run: npm test --prefix workers/remote-mcp (covers this file).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readReleaseMeta } from "../release-meta.ts";

describe("readReleaseMeta — wrangler-var path", () => {
  test("valid 40-hex sha is reported verbatim and source is wrangler-var", () => {
    const meta = readReleaseMeta({
      RELEASE_SOURCE_SHA: "7d7167b0b6e870cb89f595f8a9185a929b3b491a",
      RELEASE_VERSION: "1.18.0",
    });
    assert.equal(meta.releaseSha, "7d7167b0b6e870cb89f595f8a9185a929b3b491a");
    assert.equal(meta.releaseVersion, "1.18.0");
    assert.equal(meta.source, "wrangler-var");
  });

  test("uppercase hex is normalised to lowercase (canonical form)", () => {
    const meta = readReleaseMeta({
      RELEASE_SOURCE_SHA: "7D7167B0B6E870CB89F595F8A9185A929B3B491A",
    });
    assert.equal(meta.releaseSha, "7d7167b0b6e870cb89f595f8a9185a929b3b491a");
    assert.equal(meta.source, "wrangler-var");
  });

  test("releaseVersion may be omitted; releaseSha still reported", () => {
    const meta = readReleaseMeta({
      RELEASE_SOURCE_SHA: "7d7167b0b6e870cb89f595f8a9185a929b3b491a",
    });
    assert.equal(meta.releaseSha, "7d7167b0b6e870cb89f595f8a9185a929b3b491a");
    assert.equal(meta.releaseVersion, null);
  });
});

describe("readReleaseMeta — fallback-unknown path", () => {
  test("missing var reports unknown and does not lie about source", () => {
    const meta = readReleaseMeta({});
    assert.equal(meta.releaseSha, "unknown");
    assert.equal(meta.source, "fallback-unknown");
  });

  test("empty var reports unknown", () => {
    const meta = readReleaseMeta({ RELEASE_SOURCE_SHA: "" });
    assert.equal(meta.releaseSha, "unknown");
    assert.equal(meta.source, "fallback-unknown");
  });

  test("non-string var reports unknown (no echo, no error)", () => {
    const meta = readReleaseMeta({ RELEASE_SOURCE_SHA: 12345 as unknown as string });
    assert.equal(meta.releaseSha, "unknown");
    assert.equal(meta.source, "fallback-unknown");
  });

  test("malformed sha (too short) is rejected", () => {
    const meta = readReleaseMeta({ RELEASE_SOURCE_SHA: "7d7167b" });
    assert.equal(meta.releaseSha, "unknown");
    assert.equal(meta.source, "fallback-unknown");
  });

  test("malformed sha (non-hex characters) is rejected", () => {
    const meta = readReleaseMeta({
      RELEASE_SOURCE_SHA: "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
    });
    assert.equal(meta.releaseSha, "unknown");
    assert.equal(meta.source, "fallback-unknown");
  });

  test("malformed sha (too long) is rejected", () => {
    const meta = readReleaseMeta({
      RELEASE_SOURCE_SHA: "7d7167b0b6e870cb89f595f8a9185a929b3b491aEXTRA",
    });
    assert.equal(meta.releaseSha, "unknown");
    assert.equal(meta.source, "fallback-unknown");
  });
});

describe("readReleaseMeta — invariant", () => {
  test("releaseSha NEVER echoes attacker-controlled string back as-is", () => {
    const cases = [
      "<script>alert(1)</script>",
      "' OR 1=1; --",
      "7d7167b0b6e870cb89f595f8a9185a929b3b491a\nX-Injected: 1",
      "7d7167b0b6e870cb89f595f8a9185a929b3b491a; rm -rf /",
    ];
    for (const bad of cases) {
      const meta = readReleaseMeta({ RELEASE_SOURCE_SHA: bad });
      assert.equal(meta.releaseSha, "unknown", `must reject: ${JSON.stringify(bad)}`);
    }
  });
});
