/**
 * Backend-availability guard for MCP tool handlers.
 *
 * HTTP 404 can mean an unavailable record, an unknown route, or an endpoint
 * that is not enabled. The status alone cannot establish deployment state.
 *
 * If that raw 404 reaches `handleToolError` it is mapped to the generic message
 * "Resource not found. / Recurso no encontrado." — which an LLM reads as "the
 * thing you asked about does not exist" and then HALLUCINATES a confident answer
 * ("you have no Modelo 303 to file", "this workspace has no permissions matrix").
 * That is a Trust-Area failure: the model invents fiscal/compliance facts.
 *
 * Preserve typed application NOT_FOUND errors for the normal denial handler.
 * Ambiguous 404s remain explicit errors with no inferred data or deployment
 * state. Only notDeployedError states that a route is not deployed.
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

/** Builds the explicit error for a route known not to be deployed. */
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

/** An ambiguous 404 establishes neither missing business data nor deployment. */
function lookupUnavailableError(toolName: string, endpoint?: string): BackendGuardErrorResult {
  const message =
    `Frihet could not resolve the requested resource or endpoint for "${toolName}" (HTTP 404). ` +
    `No data could be retrieved. Do not infer an empty or zero result, missing business records, or deployment status. ` +
    `Check the record ID and feature availability before deciding whether to retry. ` +
    `/ Frihet no pudo resolver el recurso o endpoint solicitado (HTTP 404). ` +
    `No se recuperaron datos. No deduzcas un resultado vacío o cero, la ausencia de registros ni el estado del despliegue.`;
  return {
    content: [{ type: "text", text: `Error: ${message}`, annotations: ERROR_CONTENT_ANNOTATIONS }],
    structuredContent: {
      error: "lookup_unavailable", code: "LOOKUP_UNAVAILABLE", tool: toolName, message,
      ...(endpoint ? { endpoint } : {}),
    },
    isError: true,
  };
}

export function notDeployedError(
  toolName: string,
  endpoint: string,
): BackendGuardErrorResult {
  const result = backendUnavailableError(toolName, endpoint);
  result.structuredContent = { ...result.structuredContent, code: "NOT_DEPLOYED" };
  return result;
}

/** Keep application denials intact; ambiguous HTTP 404s are never empty data. */
export async function withBackendGuard<T extends { content: unknown[] }>(
  toolName: string,
  endpoint: string | undefined,
  fn: () => Promise<T>,
): Promise<T | BackendGuardErrorResult> {
  try {
    return await fn();
  } catch (err) {
    if (isBackendNotFound(err)) {
      if ((err as { errorCode?: unknown }).errorCode === "NOT_FOUND") throw err;
      return lookupUnavailableError(toolName, endpoint);
    }
    throw err;
  }
}
