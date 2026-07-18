/**
 * Demo profile — the server-side guardrail that stamps EVERY tool response with
 * the demo banner when FRIHET_DEMO=1 (and no API key) is active.
 *
 * WHY a registerTool interceptor (not per-tool edits): the guardrail requires
 * the banner on EVERY response of EVERY tool, not just the first, and not only
 * the ~30 rich fixtures — the whole 157-tool surface. Patching registerTool once
 * (the same technique register-all.ts uses for Langfuse tracing) guarantees the
 * banner is injected on 100% of tool results with zero per-tool cost and no way
 * for a new tool to forget it.
 *
 * Injection is SAFE against output-schema validation:
 *   - The MCP SDK validates result.structuredContent with safeParseAsync but
 *     NEVER replaces it (server/mcp.js validateToolOutput reads only
 *     parseResult.success), so extra keys survive on the wire.
 *   - Zod object schemas strip unknown keys instead of erroring, so adding
 *     `_demo` to a strict paginated wrapper still validates.
 *   - Item schemas are `.passthrough()`, so nested `_demo` markers survive too.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { log } from "../logger.js";

/**
 * Exact banner text mandated by the spec (guardrail #1). Kept as a single
 * exported constant so the DemoClient, tests, and interceptor all agree.
 */
export const DEMO_BANNER =
  "DEMO MODE — datos de ejemplo; para datos reales: app.frihet.io → Settings → API keys";

/**
 * Determine whether demo mode is active. Demo mode requires FRIHET_DEMO=1 AND
 * the ABSENCE of an API key — if a real key is present we NEVER serve fixtures
 * (guardrail #4). Reads process.env lazily so it is safe in any environment.
 */
export function isDemoMode(): boolean {
  const env =
    typeof process !== "undefined" && process.env ? process.env : undefined;
  if (!env) return false;
  return env.FRIHET_DEMO === "1" && !env.FRIHET_API_KEY;
}

/**
 * Inject the demo banner into a single tool result. Never throws — a
 * banner-injection bug must not crash the tool call. Returns the mutated result.
 */
export function stampResult(result: unknown): unknown {
  try {
    if (result === null || typeof result !== "object") {
      // A tool that returned a non-object still gets a banner-bearing envelope.
      return {
        content: [{ type: "text", text: DEMO_BANNER }],
        structuredContent: { _demo: true, _demoNotice: DEMO_BANNER, value: result },
      };
    }

    const r = result as Record<string, unknown>;

    // 1. structuredContent — add `_demo: true` (the mandated field) + notice.
    //    Create it if the tool returned none (harmless when no outputSchema).
    const sc =
      r.structuredContent && typeof r.structuredContent === "object"
        ? (r.structuredContent as Record<string, unknown>)
        : {};
    sc._demo = true;
    sc._demoNotice = DEMO_BANNER;
    r.structuredContent = sc;

    // 2. content — prepend a visible text banner block so the human/agent sees
    //    it even in clients that ignore structuredContent.
    const banner = { type: "text" as const, text: `⚠ ${DEMO_BANNER}` };
    if (Array.isArray(r.content)) {
      r.content = [banner, ...(r.content as unknown[])];
    } else {
      r.content = [banner];
    }

    return r;
  } catch {
    // Fail-closed on the banner is impossible without a result; return a minimal
    // banner envelope so the guarantee ("banner on every response") still holds.
    return {
      content: [{ type: "text", text: DEMO_BANNER }],
      structuredContent: { _demo: true, _demoNotice: DEMO_BANNER },
    };
  }
}

/**
 * Build a demo-stamped ERROR result. Used when a tool handler rejects/throws so
 * the banner survives on the FAILURE path too (guardrail #1 requires the banner
 * on EVERY response, success or error — not just the happy path). Mirrors the
 * MCP SDK's own error-result shape ({ content, isError: true }) plus the demo
 * markers.
 */
export function stampError(err: unknown): Record<string, unknown> {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [
      { type: "text" as const, text: `⚠ ${DEMO_BANNER}` },
      { type: "text" as const, text: message },
    ],
    structuredContent: { _demo: true, _demoNotice: DEMO_BANNER, error: message },
    isError: true,
  };
}

/**
 * Patch server.registerTool so every tool callback's result is stamped with the
 * demo banner. Composes cleanly with the tracing / OpenAI / grouped patches
 * because it uses the identical (name, config, cb) 3-arg convention and simply
 * post-processes the awaited result.
 *
 * ORDERING — apply this:
 *   • BEFORE applyToolExposureProfile() (grouped mode): tool-exposure captures
 *     the current server.registerTool as its `originalRegisterTool` and registers
 *     the 3 discovery meta-tools EAGERLY through it. Applying demo first means
 *     that captured fn is THIS demo wrapper, so the meta-tools' textResult()
 *     responses get the _demo banner too (otherwise they'd bypass it — the
 *     grouped-mode guardrail hole this fixes).
 *   • BEFORE registerAllTools() (which itself patches registerTool for tracing):
 *     each later patch wraps the demo wrapper's `originalRegisterTool`, so the
 *     tracing/grouped/openai handlers end up INSIDE the demo wrapper and
 *     stampResult remains the OUTERMOST transformation, always running last on
 *     the result.
 *
 * Also overrides server.createToolError so SDK-generated error results (input-
 * schema validation failures + thrown-handler errors the SDK catches) carry the
 * banner — see the inline note below.
 */
export function applyDemoProfile(server: McpServer): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalRegisterTool = server.registerTool.bind(server);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = function demoPatchedRegisterTool(
    name: string,
    config: Record<string, unknown>,
    cb: (args: unknown, extra: unknown) => unknown,
  ): unknown {
    const wrapped = async (args: unknown, extra: unknown): Promise<unknown> => {
      try {
        const result = await Promise.resolve(cb(args, extra));
        return stampResult(result);
      } catch (err) {
        // The tool handler rejected/threw. Without this catch the raw error
        // would propagate to the SDK's CallTool handler and become an error
        // result (via createToolError) — banner-less if that patch ever
        // regressed. Catching here guarantees the _demo banner on handler-
        // thrown errors in OUR code, independent of any SDK internal.
        return stampError(err);
      }
    };
    return originalRegisterTool(
      name,
      config as Parameters<typeof originalRegisterTool>[1],
      wrapped as Parameters<typeof originalRegisterTool>[2],
    );
  };

  // Stamp SDK-generated error results too (guardrail #1 on the error path).
  // The MCP SDK funnels BOTH input-schema validation failures (which run BEFORE
  // the tool handler, so the stampResult in `wrapped` above can NEVER see them)
  // AND any thrown-handler error it catches into `this.createToolError(message)`
  // inside its CallTool request handler (@modelcontextprotocol/sdk
  // server/mcp.js). Overriding that instance method is the lowest-risk
  // interception point for validation errors: it is FAIL-OPEN (if a future SDK
  // renames/removes the method our override is simply never invoked and
  // validation errors fall back to today's un-bannered behaviour — nothing
  // crashes), and it is pinned by demo-smoke's grouped-mode validation-error
  // assertion + the demo-profile unit test.
  //
  // KNOWN LIMITATION: this relies on the SDK routing validation errors through
  // createToolError. It does — verified against the installed SDK — but it is an
  // internal, undocumented method; a major SDK bump could change the funnel. The
  // guardrail then silently degrades to "no banner on VALIDATION errors" (handler
  // errors are still covered by the try/catch above, which is SDK-independent).
  const serverWithError = server as unknown as {
    createToolError?: (message: string) => unknown;
  };
  const original = serverWithError.createToolError;
  if (typeof original === "function") {
    const originalCreateToolError = original.bind(server);
    serverWithError.createToolError = (message: string): unknown =>
      stampResult(originalCreateToolError(message));
  }

  log({
    level: "info",
    message:
      "Demo profile active — every tool response stamped with _demo:true + banner; all data served from embedded fixtures, no network to the real API",
    operation: "startup",
  });
}

/**
 * Emit a `demo_session_started` event via the existing structured logger.
 * Trivial instrumentation (guardrail: "si es trivial") — the JSON log line is
 * picked up by the same stderr pipeline the rest of the server uses; no extra
 * observability wiring required.
 */
export function emitDemoSessionStarted(metadata?: Record<string, unknown>): void {
  log({
    level: "info",
    message: "demo_session_started",
    operation: "demo_session_started",
    metadata: { mode: "FRIHET_DEMO", ...metadata },
  });
}
