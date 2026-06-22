/**
 * Langfuse observability for Frihet MCP server.
 *
 * Uses direct HTTP POST to the Langfuse ingestion API (no SDK dependency)
 * so it works identically in Node.js (stdio) and Cloudflare Workers (edge).
 *
 * Design:
 *   - Fail-open: any Langfuse error logs a warning and lets the tool proceed.
 *   - PII: tool input content is passed as-is (business data is fine to trace).
 *     userId / apiKey metadata are hashed with a simple SHA-256 fingerprint.
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

import { redactClone, redactText } from "./redaction.js";

// Declared to avoid TS errors in Workers environment where `process` is not typed
declare const process: { env?: Record<string, string | undefined> } | undefined;

// ── Config resolution ────────────────────────────────────────────────────────

interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
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

  if (!publicKey || !secretKey || !baseUrl) return null;

  return { publicKey, secretKey, baseUrl: baseUrl.replace(/\/$/, "") };
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
  if (config.publicKey && config.secretKey && config.baseUrl) {
    workerEnv = {
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl.replace(/\/$/, ""),
    };
  }
}

function resolveConfig(): LangfuseConfig | null {
  return workerEnv ?? getConfig();
}

// ── PII helpers ──────────────────────────────────────────────────────────────

/**
 * One-way fingerprint for PII values (apiKey, userId, email).
 * Uses Web Crypto API (available in both Node.js ≥18 and Workers).
 */
async function hashPii(value: string): Promise<string> {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(value);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  } catch {
    return "[hash-error]";
  }
}

// ── Langfuse ingestion types ─────────────────────────────────────────────────

// Minimal Langfuse batch ingestion payload
interface LangfuseSpanBody {
  id: string;
  traceId: string;
  name: string;
  startTime: string;
  endTime: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: "DEFAULT" | "DEBUG" | "WARNING" | "ERROR";
  statusMessage?: string;
}

interface LangfuseTraceBody {
  id: string;
  name: string;
  timestamp: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
  userId?: string;
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

interface StubMarker {
  plannedEndpoint?: string;
  note?: string;
}

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
      return {
        plannedEndpoint: typeof obj["_plannedEndpoint"] === "string" ? (obj["_plannedEndpoint"] as string) : undefined,
        note: typeof obj["_note"] === "string" ? (obj["_note"] as string) : undefined,
      };
    }
    // A bare _plannedEndpoint (without an explicit flag) is also a stub signal.
    if (typeof obj["_plannedEndpoint"] === "string") {
      return {
        plannedEndpoint: obj["_plannedEndpoint"] as string,
        note: typeof obj["_note"] === "string" ? (obj["_note"] as string) : undefined,
      };
    }
  }

  return null;
}

// ── HTTP send ────────────────────────────────────────────────────────────────

async function sendBatch(config: LangfuseConfig, batch: IngestionBatch): Promise<void> {
  const credentials = btoa(`${config.publicKey}:${config.secretKey}`);

  const resp = await fetch(`${config.baseUrl}/api/public/ingestion`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${credentials}`,
    },
    body: JSON.stringify(batch),
    signal: AbortSignal.timeout(5000),
  });

  if (!resp.ok) {
    // Log but don't throw — fail-open
    const body = await resp.text().catch(() => "");
    console.error(
      JSON.stringify({
        service: "frihet-mcp",
        level: "warn",
        message: `Langfuse ingestion failed: ${resp.status} ${body.slice(0, 200)}`,
        operation: "langfuse_send",
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

// ── Main trace function ──────────────────────────────────────────────────────

interface TraceContext {
  /** User-Agent from MCP client or other client identifier */
  clientName?: string;
  /** MCP protocol version */
  mcpVersion?: string;
  /** Frihet workspace/user ID — will be hashed */
  userId?: string;
}

// Module-level context set once per session (Workers: per DO init, Node.js: startup)
let _sessionContext: TraceContext = {};

/**
 * Set session-level context (client identity, MCP version).
 * Call once from server init; applies to all subsequent traces.
 */
export function setTraceContext(ctx: TraceContext): void {
  _sessionContext = { ..._sessionContext, ...ctx };
}

// ── Trace payload builder (pure, redacted) ───────────────────────────────────

interface TracePayloadParams {
  toolName: string;
  /** Raw tool input args (redacted before serialization). */
  input: unknown;
  /** Raw tool output (redacted before serialization); ignored when isError. */
  output: unknown;
  isError: boolean;
  errorMessage?: string;
  startTime: Date;
  endTime: Date;
  traceId: string;
  spanId: string;
  /** Already-hashed user id, or undefined. */
  userIdHashed?: string;
  clientName?: string;
  mcpVersion?: string;
  /** Fabricated-stub marker, or null on a genuine result. */
  stub: StubMarker | null;
}

/**
 * Builds the Langfuse trace+span ingestion batch for a single tool call.
 *
 * CRITICAL (Trust): `input` and `output` are passed through {@link redactClone}
 * before they enter the payload, so government IDs (taxId/NIF/CIF), banking
 * identifiers (IBAN), webhook signing secrets, and auth tokens NEVER reach the
 * external Langfuse service — in ANY profile mode. The tool-call output handed
 * to the user is redacted later (OpenAI mode only); this redacts the trace copy
 * unconditionally. Exported so a test can assert no sensitive value survives.
 */
export function buildTracePayload(p: TracePayloadParams): IngestionBatch {
  const {
    toolName, input, output, isError, errorMessage,
    startTime, endTime, traceId, spanId, userIdHashed, clientName, mcpVersion, stub,
  } = p;

  const stubbed = stub !== null;
  // success: false whenever the call threw OR returned a fabricated stub body.
  const success = !isError && !stubbed;
  const stubNote =
    stub?.note ??
    (stub?.plannedEndpoint
      ? `Backend endpoint not yet available: ${stub.plannedEndpoint}`
      : undefined);

  // ── Redact BEFORE the payload is built (never mutates the live response) ──
  const safeArgs = redactClone(input);
  const safeError = errorMessage ? redactText(errorMessage) : errorMessage;
  const safeOutput = isError ? { error: safeError } : redactClone(output);

  const traceBody: LangfuseTraceBody = {
    id: traceId,
    name: "mcp_request",
    timestamp: startTime.toISOString(),
    input: { tool: toolName, args: safeArgs },
    output: safeOutput,
    metadata: {
      tool: toolName,
      clientName,
      mcpVersion,
      // FALSE on a thrown error AND on a fabricated-stub fallback.
      success,
      ...(stubbed
        ? {
            stub: true,
            ...(stub?.plannedEndpoint ? { plannedEndpoint: stub.plannedEndpoint } : {}),
            ...(stubNote ? { note: stubNote } : {}),
          }
        : {}),
    },
    tags: [`mcp.tool.${toolName}`, ...(stubbed ? ["mcp.stub"] : [])],
    ...(userIdHashed ? { userId: userIdHashed } : {}),
  };

  const spanBody: LangfuseSpanBody = {
    id: spanId,
    traceId,
    name: `tool.${toolName}`,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    input: safeArgs,
    output: safeOutput,
    metadata: {
      durationMs: endTime.getTime() - startTime.getTime(),
      clientName,
      mcpVersion,
      ...(stubbed ? { stub: true } : {}),
    },
    // ERROR on a thrown error; WARNING on a fabricated-stub fallback (the call
    // "succeeded" mechanically but returned no real backend data); DEFAULT only
    // on a genuine success.
    level: isError ? "ERROR" : stubbed ? "WARNING" : "DEFAULT",
    ...(isError && safeError
      ? { statusMessage: safeError }
      : stubbed && stubNote
        ? { statusMessage: stubNote }
        : {}),
  };

  return {
    batch: [
      { type: "trace-create", id: newId(), timestamp: startTime.toISOString(), body: traceBody },
      { type: "span-create", id: newId(), timestamp: startTime.toISOString(), body: spanBody },
    ],
  };
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
  input: unknown,
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
  let errorMessage: string | undefined;
  let output: unknown;

  try {
    result = await fn();
    output = result;
    return result;
  } catch (err) {
    isError = true;
    errorMessage = err instanceof Error ? err.message : String(err);
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
        // Hash PII fields
        const userIdRaw = _sessionContext.userId;
        const userIdHashed = userIdRaw ? await hashPii(userIdRaw) : undefined;

        // buildTracePayload redacts input/output (taxId/secret/IBAN/tokens) so
        // the external Langfuse service never stores cleartext PII or credentials.
        const batch = buildTracePayload({
          toolName,
          input,
          output,
          isError,
          errorMessage,
          startTime,
          endTime,
          traceId,
          spanId,
          userIdHashed,
          clientName: _sessionContext.clientName,
          mcpVersion: _sessionContext.mcpVersion,
          stub,
        });

        await sendBatch(config, batch);
      } catch (langfuseErr) {
        // Fail-open: log warn only
        console.error(
          JSON.stringify({
            service: "frihet-mcp",
            level: "warn",
            message: `Langfuse trace failed (non-blocking): ${langfuseErr instanceof Error ? langfuseErr.message : String(langfuseErr)}`,
            operation: "langfuse_trace",
            timestamp: new Date().toISOString(),
          }),
        );
      }
    })();
  }
}
