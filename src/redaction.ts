/**
 * Shared PII / credential redaction policy for the Frihet MCP server.
 *
 * Single source of truth for the set of field names that must never leave the
 * process in cleartext — government IDs (NIF/CIF/VAT), banking identifiers,
 * identity documents, webhook signing secrets, and auth tokens.
 *
 * Two consumers:
 *   - openai-profile.ts — strips these from tool I/O in OpenAI-safe mode
 *     (in-place DELETE of the live response the user receives).
 *   - observability.ts  — redacts these from every Langfuse trace payload
 *     (non-mutating CLONE) so an external observability service never stores a
 *     taxId / secret / IBAN, regardless of profile mode.
 *
 * Zero runtime deps — safe in both Node.js (stdio) and Cloudflare Workers (edge).
 */

/** Sentinel left in place of a redacted value in cloned (tracing) payloads. */
export const REDACTED = "[redacted]";

/**
 * Field names whose VALUES must never appear in logs, traces, or any surface
 * outside the process boundary. Includes snake_case + locale synonyms because
 * the Frihet API may return any of them via `.passthrough()` schemas.
 */
export const SENSITIVE_FIELD_NAMES: readonly string[] = [
  "taxId", "tax_id",              // Primary field name + snake_case variant
  "nif", "cif", "vatNumber",      // Spanish/EU synonyms for government tax ID
  "vat_number", "vatId", "vat_id",
  "secret",                       // Webhook signing credential
  "iban", "bankAccount",          // Banking identifiers
  "bank_account", "accountNumber",
  "idDocument", "documentNumber", // Guest/customer government document fields
  "passport", "passportNumber",
  "dni", "nationalId", "national_id",
  "ssn", "socialSecurityNumber", "social_security_number",
  "apiKey", "api_key",
  "accessToken", "access_token", "refreshToken", "refresh_token",
  "password", "mfa", "otp",
];

/** Recursively removes named fields from an object/array tree, IN PLACE. */
export function deepRedact(obj: unknown, fields: readonly string[] = SENSITIVE_FIELD_NAMES): void {
  if (obj === null || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) deepRedact(item, fields);
    return;
  }

  const record = obj as Record<string, unknown>;
  for (const field of fields) {
    if (field in record) delete record[field];
  }
  for (const value of Object.values(record)) {
    deepRedact(value, fields);
  }
}

/** Best-effort redaction of JSON field patterns from display / serialized text. */
export function redactText(text: string, fields: readonly string[] = SENSITIVE_FIELD_NAMES): string {
  let result = text;
  for (const field of fields) {
    // Remove "field": "value", or "field": value patterns
    result = result.replace(
      new RegExp(
        `\\s*"${field}"\\s*:\\s*(?:"[^"]*"|null|true|false|\\d+(?:\\.\\d+)?)\\s*,?`,
        "g",
      ),
      "",
    );
  }
  // Clean up trailing commas before } or ] left by removals
  return result.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Returns a deep CLONE of `value` with sensitive field values replaced by the
 * REDACTED sentinel (objects/arrays) and JSON field patterns stripped from any
 * string leaf (covers the serialized MCP `content[].text` block).
 *
 * Unlike {@link deepRedact} this never mutates its argument — required for
 * tracing, where the original object is the live response returned to the
 * caller. A depth guard bounds pathological / cyclic structures.
 */
export function redactClone(
  value: unknown,
  fields: readonly string[] = SENSITIVE_FIELD_NAMES,
  depth = 0,
): unknown {
  if (depth > 16) return REDACTED; // cycle / pathological-depth guard
  if (typeof value === "string") return redactText(value, fields);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactClone(v, fields, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = fields.includes(k) ? REDACTED : redactClone(v, fields, depth + 1);
  }
  return out;
}
