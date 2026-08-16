/**
 * Langfuse observability for Frihet MCP server.
 *
 * Uses direct HTTP POST to the Langfuse ingestion API (no SDK dependency)
 * so it works identically in Node.js (stdio) and Cloudflare Workers (edge).
 *
 * Design:
 *   - Fail-open: any Langfuse error logs a warning and lets the tool proceed.
 *   - Data minimization: only bounded operational facts cross the telemetry
 *     boundary. Tool input/output, arbitrary error text, and user/workspace
 *     identity are never serialized.
 *   - Fire-and-forget: traces are sent via waitUntil (Workers) or unref'd promise
 *     (Node.js) so they never block tool responses.
 *
 * Environment variables (both Node.js stdio and Cloudflare Worker):
 *   LANGFUSE_PUBLIC_KEY   — pk-lf-...
 *   LANGFUSE_SECRET_KEY   — sk-lf-...
 *   LANGFUSE_BASE_URL     — https://langfuse.frihet.io (no trailing slash)
 *
 * Docs: https://langfuse.com/docs/api/reference/overview
 */

import { log } from "./logger.js";

// Declared to avoid TS errors in Workers environment where `process` is not typed
declare const process: { env?: Record<string, string | undefined> } | undefined;

// ── Config resolution ────────────────────────────────────────────────────────

interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

const CANONICAL_LANGFUSE_ORIGIN = "https://langfuse.frihet.io";

/**
 * Langfuse receives a Basic Authorization header, so its authority is exact.
 * The current product contract documents one hosted origin; arbitrary Frihet
 * subdomains and self-hosted overrides are intentionally not trusted here.
 */
export function normalizeLangfuseBaseUrl(value: string): string {
  if (value !== value.trim()) {
    throw new Error("LANGFUSE_BASE_URL must not contain surrounding whitespace");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("LANGFUSE_BASE_URL must be a valid URL");
  }

  if (parsed.protocol !== "https:") throw new Error("LANGFUSE_BASE_URL must use HTTPS");
  if (parsed.username || parsed.password) {
    throw new Error("LANGFUSE_BASE_URL must not contain URL credentials");
  }
  if (parsed.port) throw new Error("LANGFUSE_BASE_URL must use the default HTTPS port");
  if (parsed.search || parsed.hash) {
    throw new Error("LANGFUSE_BASE_URL must not contain a query or fragment");
  }
  if (parsed.pathname !== "/") throw new Error("LANGFUSE_BASE_URL must use the origin root");
  if (parsed.hostname.toLowerCase() !== "langfuse.frihet.io") {
    throw new Error("LANGFUSE_BASE_URL hostname is not trusted");
  }

  return CANONICAL_LANGFUSE_ORIGIN;
}

function buildConfig(
  publicKey: string | undefined,
  secretKey: string | undefined,
  baseUrl: string | undefined,
): LangfuseConfig | null {
  if (!publicKey || !secretKey || !baseUrl) return null;
  try {
    return { publicKey, secretKey, baseUrl: normalizeLangfuseBaseUrl(baseUrl) };
  } catch {
    // Telemetry is optional and fail-open for tools. An invalid authority
    // disables telemetry rather than risking credentials or blocking MCP calls.
    return null;
  }
}

function getConfig(): LangfuseConfig | null {
  let publicKey: string | undefined;
  let secretKey: string | undefined;
  let baseUrl: string | undefined;

  // Node.js
  if (typeof process !== "undefined" && process?.env) {
    publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    secretKey = process.env.LANGFUSE_SECRET_KEY;
    baseUrl = process.env.LANGFUSE_BASE_URL;
  }

  return buildConfig(publicKey, secretKey, baseUrl);
}

// ── Worker env injection (for Cloudflare Workers) ───────────────────────────

let workerEnv: LangfuseConfig | null = null;

/**
 * Called once from FrihetMCP.init() in the Worker to inject env vars.
 * Not needed in Node.js stdio mode (reads from process.env directly).
 */
export function initLangfuse(config: {
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
}): void {
  workerEnv = buildConfig(config.publicKey, config.secretKey, config.baseUrl);
}

function resolveConfig(): LangfuseConfig | null {
  return workerEnv ?? getConfig();
}

// ── Langfuse ingestion types ─────────────────────────────────────────────────

// Minimal Langfuse batch ingestion payload
interface LangfuseSpanBody {
  id: string;
  traceId: string;
  name: string;
  startTime: string;
  endTime: string;
  metadata?: Record<string, unknown>;
  level?: "DEFAULT" | "DEBUG" | "WARNING" | "ERROR";
  statusMessage?: string;
}

interface LangfuseTraceBody {
  id: string;
  name: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

interface IngestionBatch {
  batch: Array<{ type: string; id: string; timestamp: string; body: LangfuseTraceBody | LangfuseSpanBody }>;
}

// ── ID generation ────────────────────────────────────────────────────────────

function newId(): string {
  // crypto.randomUUID() available in Node.js ≥18 and all Workers
  return crypto.randomUUID();
}

// ── Fabricated-success / stub detection ──────────────────────────────────────

interface StubMarker { stub: true }

/**
 * Inspect a resolved tool output for stub / not-implemented / unavailable
 * markers and return them if present, else null.
 *
 * A tool that catches its own 404 (or is a forward-compat stub) RETURNS a
 * fabricated body instead of throwing — so the try/catch in traceMCPTool never
 * runs and the call looks successful. These markers are the structural signal
 * that the "success" is fabricated:
 *   - `_stub: true`            → 404 → fallback stub body
 *   - `_notImplemented: true`  → forward-compat stub (endpoint not yet shipped)
 *   - `_unavailable: true`     → honest "backend endpoint not yet available"
 *   - `_plannedEndpoint`       → present on any of the above
 *
 * Checks both the top-level MCP tool result and its `structuredContent`, since
 * tools place the markers inside `structuredContent`.
 */
export function inspectStubMarker(output: unknown): StubMarker | null {
  if (!output || typeof output !== "object") return null;

  const candidates: Record<string, unknown>[] = [];
  const top = output as Record<string, unknown>;
  candidates.push(top);
  const sc = top["structuredContent"];
  if (sc && typeof sc === "object") candidates.push(sc as Record<string, unknown>);

  for (const obj of candidates) {
    if (obj["_stub"] === true || obj["_notImplemented"] === true || obj["_unavailable"] === true) {
      return { stub: true };
    }
    // A bare _plannedEndpoint (without an explicit flag) is also a stub signal.
    if (typeof obj["_plannedEndpoint"] === "string") {
      return { stub: true };
    }
  }

  return null;
}

// ── HTTP send ────────────────────────────────────────────────────────────────

async function sendBatch(config: LangfuseConfig, batch: IngestionBatch): Promise<void> {
  const credentials = btoa(`${config.publicKey}:${config.secretKey}`);

  const resp = await fetch(`${config.baseUrl}/api/public/ingestion`, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${credentials}`,
    },
    body: JSON.stringify(batch),
    signal: AbortSignal.timeout(5000),
  });

  if (!resp.ok) {
    // Never read/log the provider response body. Status is sufficient to
    // correlate an operational delivery failure without importing arbitrary
    // third-party text into telemetry.
    log({
      level: "warn",
      message: "Langfuse ingestion request failed",
      operation: "langfuse_send",
      error: {
        message: "MCP operation failed",
        code: "telemetry_http_error",
        statusCode: resp.status,
      },
    });
  }
}

// ── Main trace function ──────────────────────────────────────────────────────

interface TraceContext {
  /** MCP protocol version */
  mcpVersion?: string;
}

// Module-level context set once per session (Workers: per DO init, Node.js: startup)
let _sessionContext: TraceContext = {};

/**
 * Set session-level protocol context. Client identity is intentionally absent.
 * Call once from server init; applies to all subsequent traces.
 */
export function setTraceContext(ctx: TraceContext): void {
  _sessionContext = { ..._sessionContext, ...ctx };
}

// ── Trace payload builder (pure, redacted) ───────────────────────────────────

interface TracePayloadParams {
  toolName: string;
  isError: boolean;
  errorClass?: string;
  errorCode?: string;
  statusCode?: number;
  startTime: Date;
  endTime: Date;
  traceId: string;
  spanId: string;
  mcpVersion?: string;
  /** Fabricated-stub marker, or null on a genuine result. */
  stub: StubMarker | null;
}

/**
 * Builds the Langfuse trace+span ingestion batch for a single tool call.
 *
 * CRITICAL (Trust): this builder is an allowlist. It has no input/output or
 * identity fields and ignores any extra runtime properties a caller supplies.
 * Exported so tests can assert the exact operational shape.
 */
export function buildTracePayload(p: TracePayloadParams): IngestionBatch {
  const {
    toolName, isError, errorClass, errorCode, statusCode,
    startTime, endTime, traceId, spanId, mcpVersion, stub,
  } = p;

  const stubbed = stub !== null;
  // success: false whenever the call threw OR returned a fabricated stub body.
  const success = !isError && !stubbed;
  const safeToolName = toolNameToken(toolName) ?? "unknown_tool";
  const safeMcpVersion = mcpVersion === "mcp/1.0" ? mcpVersion : undefined;
  const safeErrorClass = TELEMETRY_ERROR_CLASSES.has(errorClass ?? "")
    ? errorClass
    : undefined;
  const safeErrorCode = TELEMETRY_ERROR_CODES.has(errorCode ?? "")
    ? errorCode
    : undefined;
  const safeStatusCode = typeof statusCode === "number"
    && Number.isInteger(statusCode)
    && statusCode >= 0
    && statusCode <= 599
    ? statusCode
    : undefined;
  const errorFacts = {
    ...(safeErrorClass ? { errorClass: safeErrorClass } : {}),
    ...(safeErrorCode ? { errorCode: safeErrorCode } : {}),
    ...(safeStatusCode !== undefined ? { statusCode: safeStatusCode } : {}),
  };

  const traceBody: LangfuseTraceBody = {
    id: traceId,
    name: "mcp_request",
    timestamp: startTime.toISOString(),
    metadata: {
      tool: safeToolName,
      ...(safeMcpVersion ? { mcpVersion: safeMcpVersion } : {}),
      // FALSE on a thrown error AND on a fabricated-stub fallback.
      success,
      ...(stubbed ? { stub: true } : {}),
      ...errorFacts,
    },
    tags: [`mcp.tool.${safeToolName}`, ...(stubbed ? ["mcp.stub"] : [])],
  };

  const spanBody: LangfuseSpanBody = {
    id: spanId,
    traceId,
    name: `tool.${safeToolName}`,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    metadata: {
      durationMs: endTime.getTime() - startTime.getTime(),
      ...(safeMcpVersion ? { mcpVersion: safeMcpVersion } : {}),
      success,
      ...(stubbed ? { stub: true } : {}),
      ...errorFacts,
    },
    // ERROR on a thrown error; WARNING on a fabricated-stub fallback (the call
    // "succeeded" mechanically but returned no real backend data); DEFAULT only
    // on a genuine success.
    level: isError ? "ERROR" : stubbed ? "WARNING" : "DEFAULT",
    ...(isError
      ? { statusMessage: safeErrorCode ?? safeErrorClass ?? "operation_failed" }
      : stubbed
        ? { statusMessage: "stub_response" }
        : {}),
  };

  return {
    batch: [
      { type: "trace-create", id: newId(), timestamp: startTime.toISOString(), body: traceBody },
      { type: "span-create", id: newId(), timestamp: startTime.toISOString(), body: spanBody },
    ],
  };
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const TELEMETRY_ERROR_CLASSES = new Set([
  "handled_mcp_error",
  "request_timeout",
  "abort_error",
  "api_error",
  "telemetry_error",
  "unknown_error",
]);
const TELEMETRY_ERROR_CODES = new Set([
  "tool_error",
  "request_timeout",
  "unauthorized",
  "forbidden",
  "not_found",
  "rate_limited",
  "client_error",
  "backend_error",
  "telemetry_http_error",
  "telemetry_error",
  "unknown_error",
]);

function toolNameToken(value: unknown): string | undefined {
  return typeof value === "string" && TOOL_NAME.test(value) ? value : undefined;
}

function statusErrorCode(statusCode: unknown): string | undefined {
  if (typeof statusCode !== "number" || !Number.isInteger(statusCode)) return undefined;
  if (statusCode === 401) return "unauthorized";
  if (statusCode === 403) return "forbidden";
  if (statusCode === 404) return "not_found";
  if (statusCode === 408) return "request_timeout";
  if (statusCode === 429) return "rate_limited";
  if (statusCode >= 400 && statusCode < 500) return "client_error";
  if (statusCode >= 500 && statusCode <= 599) return "backend_error";
  return undefined;
}

function operationalErrorFacts(error: unknown): Pick<TracePayloadParams, "errorClass" | "errorCode" | "statusCode"> {
  if (!error || typeof error !== "object") return { errorClass: "unknown_error" };
  const record = error as Record<string, unknown>;
  const statusCode = typeof record.statusCode === "number" ? record.statusCode : undefined;
  const name = record.name;
  const errorClass = name === "TimeoutError"
    ? "request_timeout"
    : name === "AbortError"
      ? "abort_error"
      : statusErrorCode(statusCode)
        ? "api_error"
        : "unknown_error";
  return {
    errorClass,
    errorCode: statusErrorCode(statusCode) ?? (errorClass === "request_timeout" ? "request_timeout" : "unknown_error"),
    statusCode,
  };
}

function isHandledMcpError(output: unknown): boolean {
  return !!output && typeof output === "object" && (output as Record<string, unknown>).isError === true;
}

/**
 * Wraps a tool handler fn and sends a Langfuse trace+span for the call.
 *
 * Fail-open: if Langfuse is not configured or errors, fn runs unchanged.
 * Fire-and-forget: Langfuse POST never blocks the tool response.
 *
 * @param toolName  Tool name (e.g. "create_invoice")
 * @param input     Raw tool input args
 * @param fn        Async tool handler to wrap
 * @returns         Result of fn
 */
export async function traceMCPTool<T>(
  toolName: string,
  _input: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const config = resolveConfig();

  // No config — pass through silently
  if (!config) {
    return fn();
  }

  const traceId = newId();
  const spanId = newId();
  const startTime = new Date();

  let result: T;
  let isError = false;
  let errorFacts: Pick<TracePayloadParams, "errorClass" | "errorCode" | "statusCode"> = {};
  let output: unknown;

  try {
    result = await fn();
    output = result;
    if (isHandledMcpError(result)) {
      isError = true;
      errorFacts = { errorClass: "handled_mcp_error", errorCode: "tool_error" };
    }
    return result;
  } catch (err) {
    isError = true;
    errorFacts = operationalErrorFacts(err);
    throw err;
  } finally {
    const endTime = new Date();

    // ── Fabricated-success detection ──────────────────────────────────────────
    // A tool that catches its own 404 and RETURNS a stub / unavailable body never
    // throws, so `isError` stays false and the trace would otherwise be logged as
    // a SUCCESSFUL call whose output is a fabricated payload. Inspect the resolved
    // output for the markers the e-invoice tools (and any future stub branch) set
    // — `_stub`, `_notImplemented`, `_unavailable`, `_plannedEndpoint` — and
    // downgrade the trace so observability is NOT structurally blind to fabricated
    // success. This is the central fix: it covers every stub branch regardless of
    // which tool produced it, because the stub path never reaches the catch above.
    const stub = isError ? null : inspectStubMarker(output);

    // Fire-and-forget — build and send async, never awaited
    void (async () => {
      try {
        const batch = buildTracePayload({
          toolName,
          isError,
          ...errorFacts,
          startTime,
          endTime,
          traceId,
          spanId,
          mcpVersion: _sessionContext.mcpVersion,
          stub,
        });

        await sendBatch(config, batch);
      } catch (langfuseErr) {
        // Fail-open, but never serialize the provider/runtime exception text.
        const facts = operationalErrorFacts(langfuseErr);
        log({
          level: "warn",
          message: "Langfuse trace failed (non-blocking)",
          operation: "langfuse_trace",
          error: {
            message: "MCP operation failed",
            code: "telemetry_error",
            statusCode: facts.statusCode,
          },
        });
      }
    })();
  }
}
