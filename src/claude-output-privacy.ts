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

/** Collect copies before deleting fields, including copies embedded in prose. */
function sensitiveValues(value: unknown, values = new Set<string>(), depth = 0): Set<string> {
  if (depth > 16 || value === null || typeof value !== "object") return values;
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveField(key)) {
      const collect = (part: unknown, level: number): void => {
        if (level > 16) return;
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
    sensitiveValues(item, values, depth + 1);
  }
  return values;
}

function sanitizeValue(value: unknown, copies: readonly string[], depth = 0): unknown {
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
    for (const secret of copies) text = text.split(secret).join(REDACTED);
    return text;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, copies, depth + 1));
  if (typeof value !== "object") return REDACTED;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) =>
    isSensitiveField(key) ? [] : [[key, sanitizeValue(item, copies, depth + 1)]],
  ));
}

export function sanitizeClaudeOutput(value: unknown): unknown {
  return sanitizeValue(value, [...sensitiveValues(value)].sort((a, b) => b.length - a.length));
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
] as const;

/** Claude does not expose opaque tool metadata as an actionable error message.
 * Render fixed text from the typed flags, never provider text, codes or IDs.
 */
function claudeErrorText(meta: Record<string, unknown>): string {
  const unknown = "Frihet could not complete or confirm this request. Check access and read the current record before deciding whether to retry.";
  if (["io.frihet/operationOutcomeUnknown", "io.frihet/transportOutcomeUnknown", "io.frihet/operationMayHaveCompleted"]
    .some((flag) => meta[flag] === true)) return unknown;
  if (meta["io.frihet/authenticationRequired"] === true) {
    return "AUTHENTICATION_REQUIRED: Reconnect Frihet using the authorized account and existing permissions before retrying.";
  }
  if (meta["io.frihet/accessDenied"] === true) {
    return "ACCESS_DENIED: Frihet did not authorize this request. Check the current account and existing permissions; do not retry automatically.";
  }
  if (meta["io.frihet/resourceNotFound"] === true) {
    return "NOT_FOUND: No record is available with this ID in the authorized workspace. Check the ID; after deletion, verify absence with a list. Do not automatically repeat a write.";
  }
  return unknown;
}

/** Never forward opaque content blocks or arbitrary response metadata. */
export function claudeToolResult(result: Record<string, unknown>): Record<string, unknown> {
  const structured = result.structuredContent === undefined ? undefined : sanitizeClaudeOutput(result.structuredContent);
  const meta = result._meta as Record<string, unknown> | undefined;
  const safeMeta = Object.fromEntries(SAFE_META_FLAGS.flatMap((key) =>
    typeof meta?.[key] === "boolean" ? [[key, meta[key]]] : [],
  ));
  const error = result.isError === true;
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
