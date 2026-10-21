/** Output-only privacy boundary for Claude. No transport, input or retry policy. */
import { z } from "zod/v4";
import { REDACTED, SENSITIVE_FIELD_NAMES, redactText } from "./redaction.js";

const normalizeField = (field: string) => field.replace(/[^a-z0-9]/giu, "").toLowerCase();
// Claude-only aliases for the same restricted categories. In particular payroll
// returns the Spanish social-security identifier as `nss`.
const sensitiveFields = new Set([...SENSITIVE_FIELD_NAMES,
  "nss", "authorization", "clientSecret", "signingSecret", "privateKey", "credentials", "token", "cookie", "setCookie",
].map(normalizeField));
const isSensitiveField = (field: string) => sensitiveFields.has(normalizeField(field));

const isSearchIndex = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 32
  && value.every((token) => typeof token === "string" && token.length > 0 && token.length <= 200
    && token === token.trim().toLowerCase());

/** Collect copies before deleting fields, including copies embedded in prose. */
function sensitiveValues(value: unknown, values = new Set<string>(), depth = 0, includeIndexTokens = true,
  scan?: { complete: boolean }): Set<string> {
  if (depth > 16) {
    if (scan) scan.complete = false;
    return values;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object") return sensitiveValues(parsed, values, depth + 1, includeIndexTokens, scan);
    } catch { /* ordinary prose */ }
    // Do not grant identity exceptions if structured-looking prose cannot be
    // inspected as JSON (including an embedded/double-encoded response).
    if (scan && /[{}\[\]]/u.test(value)) scan.complete = false;
  }
  if (value === null || typeof value !== "object") return values;
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveField(key) && (includeIndexTokens || normalizeField(key) !== "searchtokens" || !isSearchIndex(item))) {
      const collect = (part: unknown, level: number): void => {
        if (level > 16) {
          if (scan) scan.complete = false;
          return;
        }
        // Tiny identifiers (requestId="x", documentNumber="1") are ambiguous
        // substrings of unrelated IDs/statuses. Their fields are removed, but
        // only sufficiently distinctive values are scrubbed from other text.
        if (typeof part === "string" && part.length >= 8) values.add(part);
        else if (part !== null && typeof part === "object") {
          for (const child of Object.values(part)) collect(child, level + 1);
        }
      };
      collect(item, depth + 1);
    }
    sensitiveValues(item, values, depth + 1, includeIndexTokens, scan);
  }
  return values;
}

/** Only the four client-record contracts expose these exact identity paths.
 * An index token reproduced from that record's name is derived public identity,
 * not evidence that its name/ID is a secret. Never exempt unrelated index values,
 * open/nested fields, other tools, or values also found in a sensitive field.
 * Name tokenization mirrors the backend identityIndex name branch: full lowercase
 * name plus whitespace-split lowercase words, each trimmed and at most 200 chars.
 */
function clientIdentityTokens(value: unknown, toolName?: string): WeakMap<object, ReadonlySet<string>> {
  const identities = new WeakMap<object, ReadonlySet<string>>();
  if (!["get_client", "create_client", "update_client", "list_clients"].includes(toolName ?? "")) return identities;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return identities;
  const root = value as Record<string, unknown>;
  const records = toolName === "list_clients" ? (Array.isArray(root.data) ? root.data : []) : [root];
  const scan = { complete: true };
  const hardValues = sensitiveValues(value, new Set(), 0, false, scan);
  if (!scan.complete) return identities;
  const hardForms = new Set([...hardValues].flatMap((part) => [
    part, part.trim().toLowerCase(), part.replace(/[^a-z0-9]/giu, "").toLowerCase(),
  ]));
  for (const record of records) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
    const item = record as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.name !== "string") continue;
    const indexes = Object.entries(item).filter(([key]) => normalizeField(key) === "searchtokens");
    if (!indexes.length || indexes.some(([, tokens]) => !isSearchIndex(tokens))) continue;
    const nameTokens = new Set([item.name, ...item.name.split(/\s+/u)]
      .map((part) => part.trim().toLowerCase()).filter((part) => part.length > 0 && part.length <= 200));
    identities.set(record, new Set(indexes.flatMap(([, tokens]) => tokens as string[])
      .filter((token) => nameTokens.has(token) && !hardForms.has(token))));
  }
  return identities;
}

function sanitizeValue(value: unknown, copies: readonly string[], depth = 0,
  identities = new WeakMap<object, ReadonlySet<string>>(), preservedTokens?: ReadonlySet<string>): unknown {
  if (depth > 16) return REDACTED;
  if (typeof value === "string") {
    // A string can contain another serialized response. Parse it before
    // redacting; regex removal alone cannot handle escaped/nested JSON.
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object") {
        return JSON.stringify(sanitizeValue(parsed, [...copies, ...sensitiveValues(parsed)], depth + 1));
      }
    } catch { /* ordinary prose */ }
    let text = redactText(value);
    for (const secret of copies) if (!preservedTokens?.has(secret)) text = text.split(secret).join(REDACTED);
    return text;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, copies, depth + 1, identities));
  if (typeof value !== "object") return REDACTED;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) =>
    isSensitiveField(key) ? [] : [[key, sanitizeValue(item, copies, depth + 1, identities,
      key === "id" || key === "name" ? identities.get(value) : undefined)]],
  ));
}

export function sanitizeClaudeOutput(value: unknown, toolName?: string): unknown {
  return sanitizeValue(value, [...sensitiveValues(value)].sort((a, b) => b.length - a.length), 0,
    clientIdentityTokens(value, toolName));
}

/** Keep the existing output shape, including open summaries, but never require
 * or advertise a field removed by the runtime boundary. Inputs are untouched.
 * Open/dynamic values are still sanitized recursively by sanitizeClaudeOutput.
 */
export function claudeOutputSchema(schema: unknown): z.ZodType {
  if (!(schema instanceof z.ZodType)) throw new Error("Unsupported Claude output schema");
  let result: z.ZodType;
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(Object.entries(schema.shape as Record<string, z.ZodType>)
      .filter(([key]) => !isSensitiveField(key))
      .map(([key, child]) => [key, claudeOutputSchema(child)]));
    result = z.object(shape);
    if (schema.def.catchall) result = (result as z.ZodObject).catchall(claudeOutputSchema(schema.def.catchall));
  } else if (schema instanceof z.ZodArray) result = z.array(claudeOutputSchema(schema.element));
  else if (schema instanceof z.ZodOptional) result = claudeOutputSchema(schema.unwrap()).optional();
  else if (schema instanceof z.ZodNullable) result = claudeOutputSchema(schema.unwrap()).nullable();
  else if (schema instanceof z.ZodUnion) result = z.union(schema.options.map((option) => claudeOutputSchema(option)));
  else if (schema instanceof z.ZodRecord) result = z.record(schema.keyType, claudeOutputSchema(schema.valueType));
  else if (
    schema instanceof z.ZodString || schema instanceof z.ZodNumber
    || schema instanceof z.ZodBoolean || schema instanceof z.ZodLiteral
    || schema instanceof z.ZodEnum || schema instanceof z.ZodNull
    || schema instanceof z.ZodNever || schema instanceof z.ZodUnknown
  ) result = schema;
  else throw new Error("Unsupported Claude output schema; review its privacy boundary before exposing it");
  return schema.description ? result.describe(schema.description) : result;
}

const SAFE_META_FLAGS = [
  "io.frihet/authenticationRequired", "io.frihet/operationOutcomeUnknown",
  "io.frihet/transportOutcomeUnknown", "io.frihet/retryable", "io.frihet/operationMayHaveCompleted",
  "io.frihet/resourceNotFound", "io.frihet/accessDenied",
  "io.frihet/confirmationRequired", "io.frihet/localValidationRejected", "io.frihet/requestRejected",
] as const;

/** Claude does not expose opaque tool metadata as an actionable error message.
 * Render fixed text from the typed flags, never provider text, codes or IDs.
 */
function claudeErrorText(meta: Record<string, unknown>): string {
  const unknown = "Frihet could not complete or confirm this request. Check access and read the current record before deciding whether to retry.";
  if (["io.frihet/operationOutcomeUnknown", "io.frihet/transportOutcomeUnknown", "io.frihet/operationMayHaveCompleted"]
    .some((flag) => meta[flag] === true)) return unknown;
  if (meta["io.frihet/confirmationRequired"] === true) {
    return "CONFIRMATION_REQUIRED: This action requires explicit confirmation (confirm=true). No action was performed. Review the action and its side effects before confirming.";
  }
  if (meta["io.frihet/authenticationRequired"] === true) {
    return "AUTHENTICATION_REQUIRED: Reconnect Frihet using the authorized account and existing permissions before retrying.";
  }
  if (meta["io.frihet/accessDenied"] === true) {
    return "ACCESS_DENIED: Frihet did not authorize this request. Check the current account and existing permissions; do not retry automatically.";
  }
  if (meta["io.frihet/resourceNotFound"] === true) {
    return "NOT_FOUND: No record is available with this ID in the authorized workspace. Check the ID; after deletion, verify absence with a list. Do not automatically repeat a write.";
  }
  if (meta["io.frihet/localValidationRejected"] === true) {
    return "VALIDATION_FAILED: The ID or input parameters were rejected before sending the request. No action was performed. Correct the ID and parameters before retrying.";
  }
  if (meta["io.frihet/requestRejected"] === true) {
    return "REQUEST_REJECTED: Frihet rejected this request. Check the ID and input parameters, then read the current record before deciding whether to retry. Do not automatically repeat a write.";
  }
  return unknown;
}

/** Never forward opaque content blocks or arbitrary response metadata. */
export function claudeToolResult(result: Record<string, unknown>, toolName?: string): Record<string, unknown> {
  const meta = result._meta as Record<string, unknown> | undefined;
  const safeMeta = Object.fromEntries(SAFE_META_FLAGS.flatMap((key) =>
    typeof meta?.[key] === "boolean" ? [[key, meta[key]]] : [],
  ));
  const error = result.isError === true;
  // Confirmation, validation and uncertain outcomes use fixed remediation,
  // never provider text or IDs. Preserve the existing denial/output contract.
  const fixedRemediation = error && (
    safeMeta["io.frihet/confirmationRequired"] === true
    || safeMeta["io.frihet/localValidationRejected"] === true
    || safeMeta["io.frihet/requestRejected"] === true
    || safeMeta["io.frihet/operationOutcomeUnknown"] === true
    || safeMeta["io.frihet/transportOutcomeUnknown"] === true
    || safeMeta["io.frihet/operationMayHaveCompleted"] === true
  );
  const structured = fixedRemediation || result.structuredContent === undefined ? undefined
    : sanitizeClaudeOutput(result.structuredContent, error ? undefined : toolName);
  const text = structured !== undefined ? JSON.stringify(structured, null, 2)
    : error ? claudeErrorText(safeMeta)
      : "Frihet returned an unstructured response. Its content was withheld by the Claude privacy boundary.";
  return {
    content: [{ type: "text", text }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
    ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
    ...(Object.keys(safeMeta).length ? { _meta: safeMeta } : {}),
  };
}

/** Candidate resources are JSON. Refuse opaque or unexpected formats. */
export function claudeResourceResult(result: { contents?: unknown[] }, uri: string): { contents: unknown[] } {
  return {
    contents: (result.contents ?? []).map((item) => {
      const content = item as { text?: unknown; mimeType?: unknown };
      if (content.mimeType !== "application/json" || typeof content.text !== "string") {
        throw new Error("Claude resource response withheld: expected JSON data");
      }
      let parsed: unknown;
      try { parsed = JSON.parse(content.text); }
      catch { throw new Error("Claude resource response withheld: invalid JSON data"); }
      return { uri, mimeType: "application/json", text: JSON.stringify(sanitizeClaudeOutput(parsed), null, 2) };
    }),
  };
}
