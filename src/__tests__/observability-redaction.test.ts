/**
 * Trust test — no government ID, credential, or banking identifier may ever
 * reach the external Langfuse observability service.
 *
 * Regression guard for the P0 finding (Codex audit 2026-06-22): the Langfuse
 * tracer captured the RAW tool output BEFORE the OpenAI profile redaction
 * wrapper ran, so taxId/secret/IBAN leaked into traces in every profile mode.
 * The fix moved redaction INTO buildTracePayload, so the trace copy is redacted
 * unconditionally. This test fails if any sensitive value survives into the
 * serialized ingestion batch.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildTracePayload } from "../observability.js";
import { redactClone, SENSITIVE_FIELD_NAMES } from "../redaction.js";

const SECRETS = {
  taxId: "B12345678",
  nif: "12345678Z",
  secret: "whsec_live_DEADBEEFCAFE",
  iban: "ES9121000418450200051332",
  passport: "PAX9988776",
  apiKey: "fri_live_TOPSECRET",
  accessToken: "ya29.A0ARrdaM-TOKEN",
  password: "hunter2",
};
const SECRET_VALUES = Object.values(SECRETS);

/** A realistic MCP tool result: structuredContent + a serialized JSON text block. */
function mcpResultWithSecrets() {
  return {
    content: [{ type: "text", text: JSON.stringify({ id: "cli_1", ...SECRETS }) }],
    structuredContent: {
      client: { id: "cli_1", name: "Acme", ...SECRETS },
      webhooks: [{ id: "wh_1", url: "https://x.test", secret: SECRETS.secret }],
    },
  };
}

function assertNoSecrets(serialized: string): void {
  for (const v of SECRET_VALUES) {
    assert.ok(
      !serialized.includes(v),
      `sensitive value leaked into trace payload: ${v}`,
    );
  }
}

describe("observability redaction", () => {
  test("buildTracePayload strips PII/credentials from output (success path)", () => {
    const now = new Date("2026-06-22T10:00:00.000Z");
    const batch = buildTracePayload({
      toolName: "get_client",
      input: { id: "cli_1", taxId: SECRETS.taxId },
      output: mcpResultWithSecrets(),
      isError: false,
      startTime: now,
      endTime: now,
      traceId: "trace_1",
      spanId: "span_1",
      stub: null,
    });
    assertNoSecrets(JSON.stringify(batch));
  });

  test("buildTracePayload strips PII from input args even on the error path", () => {
    const now = new Date("2026-06-22T10:00:00.000Z");
    const batch = buildTracePayload({
      toolName: "create_client",
      input: { name: "Acme", ...SECRETS },
      output: undefined,
      isError: true,
      // an error message that echoes the request body must not leak either
      errorMessage: `Backend rejected payload: {"taxId":"${SECRETS.taxId}","secret":"${SECRETS.secret}"}`,
      startTime: now,
      endTime: now,
      traceId: "trace_2",
      spanId: "span_2",
      stub: null,
    });
    assertNoSecrets(JSON.stringify(batch));
  });

  test("redactClone never mutates its argument", () => {
    const original = mcpResultWithSecrets();
    const before = JSON.stringify(original);
    redactClone(original);
    assert.equal(JSON.stringify(original), before, "redactClone must not mutate input");
  });

  test("redactClone preserves non-sensitive fields", () => {
    const cloned = redactClone({ id: "cli_1", name: "Acme", total: 100, taxId: SECRETS.taxId }) as Record<string, unknown>;
    assert.equal(cloned.id, "cli_1");
    assert.equal(cloned.name, "Acme");
    assert.equal(cloned.total, 100);
    assert.notEqual(cloned.taxId, SECRETS.taxId);
  });

  test("the sensitive field set covers the critical Trust fields", () => {
    for (const f of ["taxId", "secret", "iban", "apiKey", "accessToken", "password"]) {
      assert.ok(SENSITIVE_FIELD_NAMES.includes(f), `missing critical sensitive field: ${f}`);
    }
  });
});
