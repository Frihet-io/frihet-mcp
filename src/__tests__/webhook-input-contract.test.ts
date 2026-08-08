/**
 * GAP-10 — create_webhook / update_webhook INPUT contract vs the deployed backend.
 *
 * create_webhook could never succeed: the deployed POST /v1/webhooks body schema
 * (erp-main/functions/src/publicApi.ts:5143-5151) is `.strict()`, REQUIRES `name`,
 * and has no `active` key — while the tool omitted `name` and sent `active`, so
 * every call 400'd on two counts at once. update_webhook had the same `active`
 * defect against publicApi.ts:5199-5206 (whose key is `status`, incl. 'paused').
 *
 * Second half of the gap: the event catalogue was retyped into prose and drifted.
 * It advertised `invoice.deleted` and `expense.deleted`, which do not exist in the
 * backend's vocabulary and are emitted by nothing. The REST route does NOT validate
 * the events array (publicApi.ts:5147 accepts any string), so subscribing to a
 * fictional event returns 201 and then silently never fires. The enum in the tool
 * is therefore the ONLY place that failure can be caught.
 *
 * These assertions pin the tool schema against a checked-in transcription of the
 * backend contract. Every constant below carries its erp-main file:line.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { captureRegisteredTools } from "./schema-parity.gate.js";
import { WEBHOOK_EVENTS } from "../tools/webhooks.js";
import type { IFrihetClient } from "../client-interface.js";

/* --- Transcribed backend contract (the SoT lives in erp-main) ------------- */

/** erp-main/functions/src/publicApi.ts:5143-5151 — POST /v1/webhooks, `.strict()`. */
const BACKEND_CREATE_KEYS = ["name", "url", "secret", "events", "status", "metadata"] as const;
const BACKEND_CREATE_REQUIRED = ["name", "url", "events"] as const;
const BACKEND_CREATE_STATUS = ["active", "inactive"] as const;

/** erp-main/functions/src/publicApi.ts:5199-5206 — PUT/PATCH /v1/webhooks/:id, `.strict()`. */
const BACKEND_UPDATE_KEYS = ["name", "url", "secret", "events", "status", "metadata"] as const;
const BACKEND_UPDATE_STATUS = ["active", "inactive", "paused"] as const;

/**
 * erp-main/functions/src/webhooks.ts:27-45 — VALID_WEBHOOK_EVENTS, the backend's
 * own "single source of truth for validation". Transcribed verbatim 2026-08-08.
 * If this array and `WEBHOOK_EVENTS` ever disagree, the tool is advertising a
 * capability the platform does not have (or hiding one it does).
 */
const BACKEND_VALID_WEBHOOK_EVENTS = [
  "invoice.created", "invoice.updated", "invoice.generated", "invoice.one_off_created",
  "invoice.paid", "invoice.overdue", "invoice.voided", "invoice.payment_status_updated",
  "invoice.payment_failure",
  "payment.succeeded", "payment.requires_action", "payment_receipt.created",
  "credit_note.created", "credit_note.generated",
  "quote.created", "quote.updated", "quote.accepted", "quote.rejected", "quote.expired",
  "expense.created", "expense.updated",
  "client.created", "client.updated", "client.vies_check",
  "product.created", "product.updated",
  "dunning.finished",
  "reservation.created", "reservation.updated", "reservation.cancelled",
  "reservation.checked_in", "reservation.checked_out",
  "property.created", "property.updated",
  "guest.compliance_completed",
  "cleaning_task.created", "cleaning_task.completed",
  "settlement.generated",
  "channel.sync_completed",
] as const;

/* --- Harness ------------------------------------------------------------- */

const stubClient = new Proxy({}, { get: () => async () => ({}) }) as IFrihetClient;
const tools = captureRegisteredTools(stubClient);

function inputShape(tool: string): Record<string, { isOptional?: () => boolean; safeParse: (v: unknown) => { success: boolean } }> {
  const config = tools.get(tool)?.config;
  assert.ok(config, `${tool} is not registered`);
  const schema = config.inputSchema as Record<string, never> | undefined;
  assert.ok(schema && typeof schema === "object", `${tool} declares no inputSchema`);
  return schema as unknown as Record<string, { isOptional?: () => boolean; safeParse: (v: unknown) => { success: boolean } }>;
}

/** A field is required when zod rejects `undefined`. */
function isRequired(field: { safeParse: (v: unknown) => { success: boolean } }): boolean {
  return !field.safeParse(undefined).success;
}

function description(tool: string): string {
  return String(tools.get(tool)?.config.description ?? "");
}

/** Event-shaped tokens in prose — `invoice.paid`, `expense.deleted`, … (never URLs). */
function eventsMentionedIn(text: string): string[] {
  const RESOURCES =
    "invoice|expense|client|quote|product|payment|payment_receipt|credit_note|dunning|" +
    "reservation|property|guest|cleaning_task|settlement|channel";
  const matches = text.match(new RegExp(`\\b(?:${RESOURCES})\\.[a-z_]+\\b`, "g")) ?? [];
  return [...new Set(matches)];
}

/* --- create_webhook ------------------------------------------------------ */

describe("create_webhook input schema matches the deployed POST /v1/webhooks contract", () => {
  test("declares every key the backend REQUIRES", () => {
    const shape = inputShape("create_webhook");
    for (const key of BACKEND_CREATE_REQUIRED) {
      assert.ok(key in shape, `create_webhook must send \`${key}\` — the backend schema requires it`);
      assert.ok(isRequired(shape[key]!), `\`${key}\` must be REQUIRED in the tool schema, not optional`);
    }
  });

  test("sends no key the backend's .strict() schema would reject", () => {
    const shape = inputShape("create_webhook");
    const extra = Object.keys(shape).filter((k) => !(BACKEND_CREATE_KEYS as readonly string[]).includes(k));
    assert.deepEqual(
      extra,
      [],
      `these keys 400 against the .strict() backend schema (publicApi.ts:5143-5151): ${extra.join(", ")}`,
    );
  });

  test("uses `status`, not the non-existent `active` flag", () => {
    const shape = inputShape("create_webhook");
    assert.ok(!("active" in shape), "`active` is not a backend key — it 400s under .strict()");
    assert.ok("status" in shape, "the backend key is `status`");
    for (const value of BACKEND_CREATE_STATUS) {
      assert.ok(shape["status"]!.safeParse(value).success, `status='${value}' must be accepted`);
    }
    assert.equal(shape["status"]!.safeParse("paused").success, false, "POST accepts only active|inactive");
  });

  test("events are constrained to the backend's catalogue, not free strings", () => {
    const shape = inputShape("create_webhook");
    assert.ok(shape["events"]!.safeParse(["invoice.paid"]).success, "a real event must be accepted");
    assert.equal(
      shape["events"]!.safeParse(["invoice.deleted"]).success,
      false,
      "invoice.deleted does not exist: the REST route stores it with 201 and it never fires",
    );
    assert.equal(shape["events"]!.safeParse(["totally.made.up"]).success, false);
    assert.equal(shape["events"]!.safeParse([]).success, false, "at least one event is required");
  });
});

/* --- update_webhook ------------------------------------------------------ */

describe("update_webhook input schema matches the deployed PATCH /v1/webhooks/:id contract", () => {
  test("sends no key the backend's .strict() schema would reject", () => {
    const shape = inputShape("update_webhook");
    const extra = Object.keys(shape)
      .filter((k) => k !== "id") // path param, not a body key
      .filter((k) => !(BACKEND_UPDATE_KEYS as readonly string[]).includes(k));
    assert.deepEqual(extra, [], `these keys 400 under .strict(): ${extra.join(", ")}`);
  });

  test("uses `status` (incl. 'paused'), not `active`", () => {
    const shape = inputShape("update_webhook");
    assert.ok(!("active" in shape), "`active` 400s under the .strict() update schema");
    assert.ok("status" in shape);
    for (const value of BACKEND_UPDATE_STATUS) {
      assert.ok(shape["status"]!.safeParse(value).success, `status='${value}' must be accepted on update`);
    }
  });
});

/* --- the event catalogue ------------------------------------------------- */

describe("webhook event catalogue is single-sourced, not retyped in prose", () => {
  test("WEBHOOK_EVENTS equals the backend's VALID_WEBHOOK_EVENTS", () => {
    assert.deepEqual(
      [...WEBHOOK_EVENTS].sort(),
      [...BACKEND_VALID_WEBHOOK_EVENTS].sort(),
      "the MCP catalogue drifted from erp-main/functions/src/webhooks.ts VALID_WEBHOOK_EVENTS",
    );
  });

  test("no *.deleted event is advertised — nothing emits one", () => {
    assert.deepEqual(WEBHOOK_EVENTS.filter((e) => e.endsWith(".deleted")), []);
  });

  test("every event named in create_webhook / update_webhook prose really exists", () => {
    for (const tool of ["create_webhook", "update_webhook"]) {
      for (const event of eventsMentionedIn(description(tool))) {
        assert.ok(
          (WEBHOOK_EVENTS as readonly string[]).includes(event),
          `${tool} advertises '${event}', which is not in the backend catalogue`,
        );
      }
    }
  });
});
