/**
 * Shared PII / credential redaction policy for the Frihet MCP server.
 *
 * Single source of truth for the set of field names that must never leave the
 * process in cleartext — government IDs (NIF/CIF/VAT), banking identifiers,
 * identity documents, internal trace/user identifiers, webhook signing secrets,
 * and auth tokens.
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

const MAX_SERVER_REMEDIATION_CHARS = 500;
const SERVER_REMEDIATION_PROSE_ALPHABET = /^[\p{L}\p{N} .,;:!?'"()_/*+\-]+$/u;
const LIVE_EINVOICE_SCOPE_REMEDIATION =
  "This API key requires the einvoice:read or einvoice:write scope to access e-invoicing endpoints. Add the scope when creating or updating the key.";
const OWNER_ACCESS_REMEDIATION = /^(?:Ask (?:a|the|your) workspace owner to (?:grant (?:you )?access to (?:this|the) (?:resource|feature|action)|grant (?:the )?required (?:scope|permission))|Contact (?:a|the|your) workspace owner to request access to (?:this|the) (?:resource|feature|action))\.$/iu;
const GENERIC_REMEDIATION_MESSAGES = new Set([
  "forbidden",
  "access denied",
  "access forbidden",
  "authorization failed",
  "not authorized",
]);

/**
 * Allowlist short, single-line human remediation prose for agent display.
 *
 * Server text is omitted unless it matches one of two explicit semantics: an
 * API-key scope instruction matching the ERP contract, or a conservative
 * workspace-owner access instruction. A small character alphabet and the
 * structural checks below are defense in depth. Rejection is intentional: an
 * omitted hint is safer than attempting to redact arbitrary backend prose.
 */
export function sanitizeServerRemediation(
  value: unknown,
  errorCode = "",
): string | undefined {
  if (typeof value !== "string") return undefined;
  const remediation = value.trim();
  if (!remediation || remediation.length > MAX_SERVER_REMEDIATION_CHARS) return undefined;
  if (!SERVER_REMEDIATION_PROSE_ALPHABET.test(remediation)) return undefined;

  const normalized = remediation.toLowerCase();
  if (
    normalized === errorCode.trim().toLowerCase()
    || GENERIC_REMEDIATION_MESSAGES.has(normalized)
  ) {
    return undefined;
  }
  if (
    remediation !== LIVE_EINVOICE_SCOPE_REMEDIATION
    && !OWNER_ACCESS_REMEDIATION.test(remediation)
  ) {
    return undefined;
  }

  const credentialOrInternalShape = [
    // Frihet API keys are `fri_` plus 32 random bytes encoded base64url (43 chars).
    /\bfri_[A-Za-z0-9_-]{32,128}(?=$|[^A-Za-z0-9_-])/u,
    // Header name is not required for a leaked bearer/basic credential to be dangerous.
    /\b(?:bearer|basic)\s+[A-Za-z0-9+/_-]{8,}={0,2}(?:\s|[.,;!?]|$)/iu,
    /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|client[_ -]?secret|password)\s*(?::|=|\bis\b|\bwas\b)\s*["']?\S+/iu,
    /\b(?:whsec_[A-Za-z0-9_-]+|ya29\.[A-Za-z0-9._-]+)\b/u,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
    /(?:^|\s)at\s+(?:async\s+)?[^\s]+\s*\([^)]*:\d+(?::\d+)?\)/u,
    // Any whitespace-delimited absolute path is outside the remediation contract.
    /(?:^|[\s("'])\/(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/u,
    /(?:^|[\s("'])[A-Za-z]:\\/u,
    // Relative application/source paths (for example `src/auth.ts`).
    /(?:^|\s)(?:(?:\.\.?\/)?(?:src|lib|dist|build|node_modules|functions|workers)\/)[A-Za-z0-9_./-]+/iu,
    /\b[A-Za-z0-9_./-]+\.(?:c|m)?(?:j|t)sx?(?::\d+(?::\d+)?)?\b/u,
    /\b(?:node_modules|file:\/\/)/iu,
  ];
  if (credentialOrInternalShape.some((pattern) => pattern.test(remediation))) return undefined;
  return remediation;
}

/**
 * Field names whose VALUES must never appear in logs, traces, or any surface
 * outside the process boundary. Includes snake_case + locale synonyms because
 * the Frihet API may return any of them via `.passthrough()` schemas.
 */
export const SENSITIVE_FIELD_NAMES: readonly string[] = [
  "taxId", "tax_id",              // Primary field name + snake_case variant
  "clientTaxId", "client_tax_id", // Per-document client government tax ID
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
  "requestId", "request_id", "traceId", "trace_id",
  "sessionId", "session_id", "userId", "user_id",
  "verifactuHash", "verifactu_hash",
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
