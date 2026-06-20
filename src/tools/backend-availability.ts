/**
 * Backend-availability guard for MCP tool handlers.
 *
 * PROBLEM (the bug this prevents): several tool families are wired here AHEAD of
 * their Frihet-ERP backend Cloud Functions shipping (fiscal `/v1/fiscal/*`, bank
 * rules `/v1/banking/rules`, gestoria `/v1/gestoria/*`, GL audit `/v1/gl/*`,
 * portal domain/onboard, IGIC, IS, VIES onboarding, payroll prep, permissions,
 * HR leaves/anomalies, accounting periods, webhook test). Until the CF deploys,
 * the API returns a genuine HTTP 404.
 *
 * If that raw 404 reaches `handleToolError` it is mapped to the generic message
 * "Resource not found. / Recurso no encontrado." — which an LLM reads as "the
 * thing you asked about does not exist" and then HALLUCINATES a confident answer
 * ("you have no Modelo 303 to file", "this workspace has no permissions matrix").
 * That is a Trust-Area failure: the model invents fiscal/compliance facts.
 *
 * FIX: wrap the client call in `withBackendGuard`. A genuine 404 is converted into
 * an explicit STRUCTURED tool error that names the tool and states the backend is
 * not available yet — never a value the LLM can mistake for real business data.
 * Any other error (401/403/429/5xx/network) is RE-THROWN unchanged so the normal
 * `withToolLogging` → `handleToolError` path still surfaces it.
 *
 * NOTE: this is intentionally a SEPARATE module from `shared.ts` (owned elsewhere)
 * and `client.ts`. It only depends on the public content-block shape.
 */

import { ERROR_CONTENT_ANNOTATIONS, type AnnotatedTextContent } from "./shared.js";

/** Structured-content payload returned alongside a backend-unavailable error. */
export interface BackendUnavailableStructured {
  error: "backend_unavailable";
  tool: string;
  message: string;
  /** The planned REST endpoint, if known — aids ops/debugging, not the LLM. */
  endpoint?: string;
  /** Machine flag so downstream agents can branch without parsing prose. */
  _backendUnavailable: true;
}

export interface BackendGuardErrorResult {
  /** Index signature mirrors the MCP `ToolResult` shape so this is assignable to it. */
  [x: string]: unknown;
  content: AnnotatedTextContent[];
  structuredContent: Record<string, unknown>;
  isError: true;
}

/**
 * True when an error is a genuine HTTP 404 (FrihetApiError-like or fetch-shaped).
 * Duck-typed so it works regardless of which client implementation threw.
 */
export function isBackendNotFound(error: unknown): boolean {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (e["statusCode"] === 404) return true;
    if (e["status"] === 404) return true;
  }
  return false;
}

/**
 * Builds the explicit, LLM-safe "backend not available" tool error.
 */
export function backendUnavailableError(
  toolName: string,
  endpoint?: string,
): BackendGuardErrorResult {
  const message =
    `The backend for "${toolName}" is not available yet, so no data could be retrieved. ` +
    `This is NOT an empty or zero result — the underlying Frihet ERP endpoint ` +
    (endpoint ? `(${endpoint}) ` : "") +
    `is not deployed in your workspace. ` +
    `Do NOT infer or invent a value (e.g. "no records", "0 due", "no permissions"). ` +
    `Tell the user this feature is not enabled yet and to contact Frihet support / check feature availability. ` +
    `/ El backend de "${toolName}" aun no esta disponible: el endpoint de Frihet ERP no esta desplegado en este workspace. ` +
    `NO es un resultado vacio ni cero — no inventes un valor. Indica al usuario que la funcion aun no esta activa.`;

  const structured: BackendUnavailableStructured = {
    error: "backend_unavailable",
    tool: toolName,
    message,
    ...(endpoint ? { endpoint } : {}),
    _backendUnavailable: true,
  };

  return {
    content: [{ type: "text", text: `Error: ${message}`, annotations: ERROR_CONTENT_ANNOTATIONS }],
    structuredContent: structured as unknown as Record<string, unknown>,
    isError: true,
  };
}

/**
 * Wraps a tool's client call. On a genuine 404 (backend not deployed) returns a
 * structured backend-unavailable error instead of letting the raw 404 surface as
 * a generic "resource not found" that the LLM would treat as real data. Any other
 * error is re-thrown so `withToolLogging`/`handleToolError` handle it normally.
 *
 * Usage:
 * ```ts
 * async ({ period }) => withToolLogging("get_modelo_303_summary", () =>
 *   withBackendGuard("get_modelo_303_summary", "/v1/fiscal/303", async () => {
 *     const result = await client.getFiscalModeloSummary("303", period);
 *     return { content: [getContent(formatRecord("Modelo 303 Summary", result))],
 *              structuredContent: result as unknown as Record<string, unknown> };
 *   }),
 * )
 * ```
 */
export async function withBackendGuard<T extends { content: unknown[] }>(
  toolName: string,
  endpoint: string | undefined,
  fn: () => Promise<T>,
): Promise<T | BackendGuardErrorResult> {
  try {
    return await fn();
  } catch (err) {
    if (isBackendNotFound(err)) {
      return backendUnavailableError(toolName, endpoint);
    }
    throw err;
  }
}
