/**
 * Structured logging utility for the Frihet MCP server.
 *
 * Outputs JSON to stderr (MCP protocol uses stdout for messages).
 * Works in both Node.js (stdio) and Cloudflare Workers (fetch handler) environments.
 *
 * Set FRIHET_MCP_DEBUG=1 to enable debug-level logs.
 */

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  service: "frihet-mcp";
  timestamp: string;
  tool?: string;
  operation?: string;
  durationMs?: number;
  error?: { message: string; code?: string; statusCode?: number };
  metadata?: Record<string, unknown>;
}

type LogInput = Omit<LogEntry, "service" | "timestamp">;

const OPERATION_MESSAGES: Readonly<Record<string, string>> = {
  startup: "MCP startup event",
  session_init: "MCP session event",
  tool_call: "MCP tool call completed",
  tool_error: "MCP tool error",
  api_call: "MCP API call completed",
  api_retry: "MCP API retry scheduled",
  http_request: "MCP HTTP request completed",
  oauth_authorize: "MCP OAuth authorization event",
  oauth_callback: "MCP OAuth callback event",
  shutdown_metrics: "MCP shutdown event",
  langfuse_send: "MCP telemetry delivery event",
  langfuse_trace: "MCP telemetry trace event",
};

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const PACKAGE_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/u;
const SAFE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const SAFE_TRANSPORTS = new Set(["stdio", "remote"]);
const SAFE_MCP_VERSIONS = new Set(["mcp/1.0"]);
const LOCAL_ERROR_CODES = new Set([
  "tool_error",
  "telemetry_http_error",
  "telemetry_error",
  "startup_error",
  "unknown_error",
]);

function toolNameToken(value: unknown): string | undefined {
  return typeof value === "string" && TOOL_NAME.test(value) ? value : undefined;
}

function operationalErrorCode(value: unknown, statusCode: number | undefined): string {
  if (statusCode === 401) return "unauthorized";
  if (statusCode === 403) return "forbidden";
  if (statusCode === 404) return "not_found";
  if (statusCode === 408) return "request_timeout";
  if (statusCode === 429) return "rate_limited";
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) return "client_error";
  if (statusCode !== undefined && statusCode >= 500) return "backend_error";
  return typeof value === "string" && LOCAL_ERROR_CODES.has(value) ? value : "unknown_error";
}

function safeInteger(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

/**
 * Central operational metadata allowlist.
 *
 * Callers may pass arbitrary objects for backwards compatibility, but only
 * bounded protocol/runtime facts can cross the logging boundary. Dynamic
 * paths, identifiers, user agents, emails, provider bodies, and nested objects
 * are intentionally discarded.
 */
function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  const safe: Record<string, unknown> = {};
  const version = typeof metadata.version === "string" && PACKAGE_VERSION.test(metadata.version)
    ? metadata.version
    : undefined;
  const transport = typeof metadata.transport === "string" && SAFE_TRANSPORTS.has(metadata.transport)
    ? metadata.transport
    : undefined;
  const mcpVersion = typeof metadata.mcpVersion === "string" && SAFE_MCP_VERSIONS.has(metadata.mcpVersion)
    ? metadata.mcpVersion
    : undefined;
  const method = typeof metadata.method === "string" && SAFE_METHODS.has(metadata.method)
    ? metadata.method
    : undefined;
  const statusCode = safeInteger(metadata.statusCode, 0, 599);
  const retryCount = safeInteger(metadata.retryCount, 0, 100);
  const delayMs = safeInteger(metadata.delayMs, 0, 86_400_000);
  const uptime = safeInteger(metadata.uptime, 0, Number.MAX_SAFE_INTEGER);

  if (version) safe.version = version;
  if (transport) safe.transport = transport;
  if (mcpVersion) safe.mcpVersion = mcpVersion;
  if (method) safe.method = method;
  if (statusCode !== undefined) safe.statusCode = statusCode;
  if (retryCount !== undefined) safe.retryCount = retryCount;
  if (delayMs !== undefined) safe.delayMs = delayMs;
  if (uptime !== undefined) safe.uptime = uptime;
  if (typeof metadata.success === "boolean") safe.success = metadata.success;
  if (typeof metadata.stub === "boolean") safe.stub = metadata.stub;

  return Object.keys(safe).length > 0 ? safe : undefined;
}

// Declared to avoid TS errors in Workers environment where `process` is not typed
declare const process: { env?: Record<string, string | undefined>; on?: unknown } | undefined;

/**
 * Returns true if debug logging is enabled.
 * Checks env var in Node.js; always false in Workers unless overridden.
 */
function isDebugEnabled(): boolean {
  // Node.js environment
  if (typeof process !== "undefined" && process?.env) {
    return process.env.FRIHET_MCP_DEBUG === "1" || process.env.FRIHET_MCP_DEBUG === "true";
  }
  return false;
}

/**
 * Emit a structured log entry as JSON to stderr.
 * In Cloudflare Workers, console.error automatically routes to Workers Logs.
 */
export function log(entry: LogInput): void {
  if (entry.level === "debug" && !isDebugEnabled()) {
    return;
  }

  const operation = typeof entry.operation === "string" && Object.hasOwn(OPERATION_MESSAGES, entry.operation)
    ? entry.operation
    : undefined;
  const tool = toolNameToken(entry.tool);
  const durationMs = typeof entry.durationMs === "number"
    && Number.isFinite(entry.durationMs)
    && entry.durationMs >= 0
    && entry.durationMs <= 86_400_000
    ? Math.round(entry.durationMs)
    : undefined;
  const errorStatus = safeInteger(entry.error?.statusCode, 0, 599);
  const errorCode = operationalErrorCode(entry.error?.code, errorStatus);
  const metadata = sanitizeMetadata(entry.metadata);

  const full: LogEntry = {
    level: entry.level,
    message: operation === "tool_call" && entry.level === "error"
      ? "MCP tool call failed"
      : operation
        ? (OPERATION_MESSAGES[operation] ?? "MCP operational event")
        : "MCP operational event",
    service: "frihet-mcp",
    timestamp: new Date().toISOString(),
    ...(tool ? { tool } : {}),
    ...(operation ? { operation } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(entry.error
      ? {
          error: {
            message: "MCP operation failed",
            code: errorCode,
            ...(errorStatus !== undefined ? { statusCode: errorStatus } : {}),
          },
        }
      : {}),
    ...(metadata ? { metadata } : {}),
  };

  // Remove undefined fields for cleaner output
  const cleaned = JSON.stringify(full, (_key, value) =>
    value === undefined ? undefined : value,
  );

  console.error(cleaned);
}

/**
 * Log the result of a tool call with timing.
 */
export function logToolCall(
  tool: string,
  startTime: number,
  success: boolean,
  error?: Error & { statusCode?: number; errorCode?: string },
): void {
  const durationMs = Math.round(Date.now() - startTime);

  if (!success && error) {
    log({
      level: "error",
      message: `Tool ${tool} failed`,
      tool,
      operation: "tool_call",
      durationMs,
      error: {
        message: "MCP operation failed",
        code: error.errorCode ?? error.name,
        statusCode: error.statusCode,
      },
    });
  } else {
    log({
      level: "info",
      message: `Tool ${tool} completed`,
      tool,
      operation: "tool_call",
      durationMs,
    });
  }
}

/**
 * Log an outbound API call with timing.
 */
export function logApiCall(
  method: string,
  _path: string,
  statusCode: number,
  durationMs: number,
): void {
  const level = statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info";

  log({
    level,
    message: "MCP API call completed",
    operation: "api_call",
    durationMs,
    metadata: { method, statusCode },
  });
}

/**
 * Log a rate-limit retry.
 */
export function logRetry(
  method: string,
  _path: string,
  retryCount: number,
  delayMs: number,
): void {
  log({
    level: "warn",
    message: "MCP API retry scheduled",
    operation: "api_retry",
    metadata: { method, retryCount: retryCount + 1, delayMs },
  });
}
