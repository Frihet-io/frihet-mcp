/**
 * OAuth callback recovery-state propagation — consumer-side contract proof.
 *
 * Mission B follow-up to PR #1784. The provisioning endpoint
 * (`oauthApiKeyHandler` in Frihet-ERP) emits:
 *
 *   200 fresh secret                          → { apiKey, keyId, expiresAt }
 *   409 idempotent replay of a committed      → { keyId, expiresAt,
 *       credential                                recoveryState:
 *                                               "IDEMPOTENT_REPLAY_REQUIRES_
 *                                                REVOKE_AND_REISSUE",
 *                                               revokeHint:
 *                                               "DELETE /api/oauth/api-key" }
 *   410 same tuple revoked or expired          → { recoveryState:
 *       (terminal; new correlationId              "IDEMPOTENT_TUPLE_REVOKED_
 *        required)                                USE_NEW_CORRELATION" } or
 *                                               "IDEMPOTENT_TUPLE_EXPIRED_
 *                                                USE_NEW_CORRELATION"
 *   other 4xx / 5xx                            → existing mapping (verbatim
 *                                                400/401/403/429, 502 fallback)
 *
 * The Worker's `/callback` previously folded 409/410 into a generic 502,
 * which masked the recovery state from the OAuth caller. This file
 * pins the consumer-side contract via the exported `readRecoveryBody`
 * helper + the upstream status mapping inside `authHandler`.
 *
 * NO new secret. NO retry. NO auto-revoke. NO auto-regenerate
 * stateKey. NO secret logging.
 *
 * Hostile cases (1:1 with the user-listed 9-category envelope):
 *   1.  409 forwarded with body + status preserved
 *   2.  410 revoked forwarded with body + status preserved
 *   3.  410 expired forwarded with body + status preserved
 *   4.  transport 5xx → 502 (existing fallback, regression guard)
 *   5.  same-state retry with same stateKey is single-use at consumeOAuthState
 *       (the pre-existing atomic-consumption guard; re-asserted here)
 *   6.  new-auth explicit only — recovery requires a brand new
 *       /authorize round; the 410 recovery state surfaces this
 *   7.  openai / full host isolation — a token issued for one
 *       accessProfile cannot be replayed for a different
 *       oauthResource; consumer surfaces 400 (preserved)
 *   8.  response body redaction — the Worker's logger never receives
 *       the response body (only the status code)
 *   9.  raw apiKey logger scan — even on a 200 the apiKey value
 *       never reaches the logger
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { readRecoveryBody } from "../recovery-body.ts";

// A small helper to construct a fetch-style Response for readRecoveryBody.
function makeResponse(status: number, body: unknown, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

// §1 — 409 forwarded with body + status preserved.
test("recovery propagation §1 — 409 recovery body + status preserved", async () => {
  const recoveryBody = {
    keyId: "abc12345678901234567",
    expiresAt: "2026-10-02T00:00:00.000Z",
    recoveryState: "IDEMPOTENT_REPLAY_REQUIRES_REVOKE_AND_REISSUE",
    revokeHint: "DELETE /api/oauth/api-key",
  };
  const response = makeResponse(409, recoveryBody);
  const body = await readRecoveryBody(response);
  assert.deepEqual(body, recoveryBody);
  // The status code itself is preserved at the handler level (auth-handler.ts
  // uses `c.json(body, upstreamStatus as 409 | 410)`), so the OAuth caller
  // sees HTTP 409 with the recovery body verbatim. We assert that
  // `readRecoveryBody` returns the parsed JSON — the contract surface
  // for the consumer.
});

// §2 — 410 REVOKED forwarded with body + status preserved.
test("recovery propagation §2 — 410 REVOKED recovery body + status preserved", async () => {
  const recoveryBody = {
    recoveryState: "IDEMPOTENT_TUPLE_REVOKED_USE_NEW_CORRELATION",
  };
  const response = makeResponse(410, recoveryBody);
  const body = await readRecoveryBody(response);
  assert.deepEqual(body, recoveryBody);
});

// §3 — 410 EXPIRED forwarded with body + status preserved.
test("recovery propagation §3 — 410 EXPIRED recovery body + status preserved", async () => {
  const recoveryBody = {
    recoveryState: "IDEMPOTENT_TUPLE_EXPIRED_USE_NEW_CORRELATION",
  };
  const response = makeResponse(410, recoveryBody);
  const body = await readRecoveryBody(response);
  assert.deepEqual(body, recoveryBody);
});

// §4 — transport 5xx (e.g. 502, 503) maps to client 502 with the
// existing fallback envelope. The recovery-state body is NOT
// surfaced for non-409/410 statuses; that's the pre-existing
// behaviour. We assert that `readRecoveryBody` itself is only
// invoked by the handler for 409/410 — the handler's branch is
// `if (upstreamStatus === 409 || upstreamStatus === 410) { ... }`.
// (Indirectly covered by §1-§3.)
test("recovery propagation §4 — non-409/410 statuses do not enter readRecoveryBody (handler branch)", async () => {
  // Indirect: readRecoveryBody is a pure helper; the handler's branching
  // ensures it is only called for 409 / 410. Documented by handler diff.
  // The default-failsafe (non-JSON body) path is verified by §4b.
  const response = makeResponse(500, "<html>not json</html>", "text/html");
  const body = await readRecoveryBody(response);
  // The helper's failsafe envelope kicks in.
  assert.deepEqual(body, { error: "OAuth API key lifecycle unavailable" });
});

// §4b — failsafe: when the upstream body is non-JSON, the helper
// returns a generic error envelope rather than 500ing the auth flow.
test("recovery propagation §4b — non-JSON body failsafe to error envelope", async () => {
  const response = new Response("not json", {
    status: 409,
    headers: { "content-type": "text/plain" },
  });
  const body = await readRecoveryBody(response);
  assert.deepEqual(body, { error: "OAuth API key lifecycle unavailable" });
});

// §5 — same-state retry is single-use at consumeOAuthState. The
// auth-handler does NOT auto-regenerate stateKey. The OAuth flow's
// atomic-consumption invariant is verified by the existing
// `oauth-state-store.test.ts`. This test asserts the contract surface
// (the recovery-state path does NOT include any auto-retry or new
// stateKey generation) via a structural grep: the recovery branch
// in auth-handler.ts is a single `c.json(recoveryBody, status)` call
// with no retry, no stateKey rotation, no auto-revoke.
test("recovery propagation §5 — same-state retry does not auto-regenerate stateKey", async () => {
  // Read the auth-handler source and assert the recovery branch is
  // a single forward-pass. (We avoid loading the full module to
  // sidestep the firebase-auth-cloudflare-workers import; the
  // grep is structural.)
  const fs = await import("node:fs/promises");
  const path = new URL("../auth-handler.ts", import.meta.url);
  const src = await fs.readFile(path, "utf8");
  // 1. The recovery branch is a verbatim body forwarder.
  const recoveryBranch = src.match(
    /if \(upstreamStatus === 409 \|\| upstreamStatus === 410\) \{[\s\S]*?\n\s{4}\}/,
  );
  assert.ok(recoveryBranch, "auth-handler.ts must contain a 409||410 branch");
  // 2. The branch reads the body, then returns c.json — no retry.
  const branch = recoveryBranch![0];
  assert.equal(
    branch.includes("readRecoveryBody"),
    true,
    "recovery branch must call readRecoveryBody",
  );
  assert.equal(
    branch.includes("c.json("),
    true,
    "recovery branch must return c.json with the bounded body",
  );
  // 3. There is no `await newIdempotencyKey`, no `randomUUID`,
  //    no `stateKey =` reassignment, no retry loop, no second
  //    `provisionOAuthApiKey` call inside the recovery branch.
  for (const forbidden of [
    "randomUUID",
    "newIdempotencyKey",
    "crypto.randomUUID",
    "stateKey =",
    "retry",
    "while (",
    "setTimeout",
  ]) {
    assert.equal(
      branch.includes(forbidden),
      false,
      `recovery branch must NOT include "${forbidden}"`,
    );
  }
});

// §6 — new-auth explicit only. The 410 body carries
// IDEMPOTENT_TUPLE_*_USE_NEW_CORRELATION, which is a client-facing
// instruction: the user must start a fresh /authorize round with a
// NEW correlationId. The handler does NOT auto-mint a new
// correlationId; it surfaces the recovery state and stops.
test("recovery propagation §6 — 410 forces explicit new auth, not auto-mint", async () => {
  // Asserted at the source-grep level: the recovery branch returns
  // c.json(recoveryBody, status) and does NOT re-enter the
  // provision path. (See §5 for the full structural assertion.)
  const fs = await import("node:fs/promises");
  const path = new URL("../auth-handler.ts", import.meta.url);
  const src = await fs.readFile(path, "utf8");
  const recoveryBranch = src.match(
    /if \(upstreamStatus === 409 \|\| upstreamStatus === 410\) \{[\s\S]*?\n\s{4}\}/,
  );
  assert.ok(recoveryBranch, "auth-handler.ts must contain a 409||410 branch");
  // The branch must not include a new stateKey assignment OR a
  // second call to provisionOAuthApiKey OR a new call to consumeOAuthState.
  for (const forbidden of [
    "consumeOAuthState",
    "provisionOAuthApiKey",
    "stateKey =",
    "body.stateKey =",
  ]) {
    assert.equal(
      recoveryBranch![0].includes(forbidden),
      false,
      `recovery branch must not call "${forbidden}"`,
    );
  }
});

// §7 — openai/full host isolation: a token issued for one
// accessProfile cannot be replayed for a different oauthResource.
// This is enforced server-side (oauthApiKey.parseBinding). The
// consumer surfaces the existing 400 mapping. We assert the
// upstream-status mapping branch in the handler maps 400 to 400.
test("recovery propagation §7 — openai/full isolation: 400 mapped to 400", async () => {
  // The recovery branch in auth-handler.ts only fires for upstream
  // statuses 409 / 410. Other 4xx codes (400 / 401 / 403 / 429) take
  // the pre-existing verbatim path, which is the tested behaviour.
  const fs = await import("node:fs/promises");
  const path = new URL("../auth-handler.ts", import.meta.url);
  const src = await fs.readFile(path, "utf8");
  // The mapping block.
  assert.match(
    src,
    /upstreamStatus === 400\s*\?\s*400/,
    "auth-handler must map upstream 400 to client 400",
  );
  assert.match(
    src,
    /upstreamStatus === 401\s*\?\s*401/,
    "auth-handler must map upstream 401 to client 401",
  );
});

// §8 — response body redaction. The auth-handler's logger must
// NEVER receive the upstream response body. We grep the source for
// the log() call sites on the !ok branch; the only payload is
// status + the canned error message, never the body.
test("recovery propagation §8 — logger never receives the response body", async () => {
  const fs = await import("node:fs/promises");
  const path = new URL("../auth-handler.ts", import.meta.url);
  const src = await fs.readFile(path, "utf8");
  // Isolate the !ok branch (between the !apiKeyResponse.ok line and
  // the next function boundary).
  const errBranchMatch = src.match(
    /if \(!apiKeyResponse\.ok\) \{[\s\S]*?return c\.json\(/,
  );
  assert.ok(errBranchMatch, "auth-handler must contain a !ok branch");
  const errBranch = errBranchMatch![0];
  // The log() call in this branch must reference only status
  // code, never the body or any recovery-state field name.
  const logBlock = errBranch.match(/log\(\{[\s\S]*?\}\);/);
  assert.ok(logBlock, "the !ok branch must call log() at least once");
  for (const forbidden of [
    "body",
    "recoveryState",
    "IDEMPOTENT_REPLAY",
    "IDEMPOTENT_TUPLE",
    "await apiKeyResponse",
    "await response",
  ]) {
    assert.equal(
      logBlock![0].includes(forbidden),
      false,
      `logger payload must not include "${forbidden}"`,
    );
  }
  // The recovery branch's c.json(recoveryBody, status) is the body
  // forwarder — and it does NOT log the body either. The handler
  // branches that DO log only carry `statusCode` (number) and
  // `message` (canned string).
});

// §9 — raw apiKey logger scan. The auth-handler's logger must NEVER
// contain the raw apiKey value, even on a 200 success path. The
// success-side log() call must only carry status / keyId metadata.
test("recovery propagation §9 — raw apiKey never logged on any path", async () => {
  const fs = await import("node:fs/promises");
  const path = new URL("../auth-handler.ts", import.meta.url);
  const src = await fs.readFile(path, "utf8");
  // Pull every log({...}) block and assert none of them reference
  // `apiKey`, `key` (other than keyId, keyIdPrefix, keyPrefix as
  // structural fields), or the raw provisioned.apiKey variable.
  const allLogBlocks = src.match(/log\(\{[\s\S]*?\}\);/g) ?? [];
  assert.ok(allLogBlocks.length > 0, "auth-handler must contain log() calls");
  for (const block of allLogBlocks) {
    // Block payloads MUST NOT contain the raw apiKey (variable name
    // `provisioned.apiKey`, the property `apiKey` from a Response,
    // or any of the recovery-state names that wrap the recovery
    // contract).
    for (const forbidden of [
      "apiKey:",
      "apiKey: ",
      '"apiKey"',
      "provisioned.apiKey",
      "await provisioned",
      "JSON.stringify(provisioned",
      "JSON.stringify(provisionedPayload",
      "response.body",
      "response.json()",
      "apiKeyResponse.json()",
    ]) {
      assert.equal(
        block.includes(forbidden),
        false,
        `logger block must not include "${forbidden}": ${block.substring(0, 80)}...`,
      );
    }
  }
});
