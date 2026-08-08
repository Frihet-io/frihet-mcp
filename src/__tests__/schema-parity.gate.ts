/**
 * SCHEMA PARITY GATE — real backend response shapes vs declared MCP outputSchemas.
 *
 * WHY THIS EXISTS
 * ---------------
 * Seven tools shipped with `outputSchema`s the deployed backend could not
 * satisfy (list_webhooks, payroll_checklist, overtime_report, payroll_export,
 * period_close_status, list_vendors, get_vendor), plus two that shipped the raw
 * `{data, meta}` envelope as `structuredContent`. Every one of them was GREEN in
 * the unit suite, because every unit fixture was hand-typed from the SCHEMA's
 * assumption instead of from the backend's behaviour (e.g.
 * `listWebhooks: async () => ({ data: [], total: 0, limit: 20, offset: 0 })` —
 * inventing the two keys the backend omits).
 *
 * This gate closes that loop. For every covered tool it:
 *   1. serves the EXACT wire body the Cloud Function emits (checked-in fixture,
 *      each one carrying a `provenance` string with the erp-main file:line it
 *      was copied from) from a local `node:http` mock,
 *   2. drives a REAL `FrihetClient` and the REAL registered tool handler, so the
 *      `request()` vs `requestUnwrapped()` wiring is exercised, not stubbed,
 *   3. validates the resulting `structuredContent` against the tool's OWN
 *      declared `outputSchema`,
 *   4. rejects a leaked `{data, meta}` envelope even when the schema would accept
 *      it vacuously (all-optional + passthrough schemas validate the WRONG
 *      object — that is exactly how permissions_me/permissions_matrix shipped),
 *   5. flags every top-level key the schema DECLARES but no real response ever
 *      carries (phantom fields such as `estimatedCostEur`), unless the fixture
 *      explicitly documents why in `declaredKeysNotInFixtures`.
 *
 * It is offline by construction: JSON fixtures + 127.0.0.1, no credentials, no
 * network, so it runs in CI on every PR.
 *
 * COVERAGE IS REPORTED, NEVER ASSUMED. The report names how many of the
 * registered tools it actually scanned and lists the UNCOVERED ones by name — a
 * gate that asserts an invariant while silently scanning a subset is a green
 * that lies. A committed floor (`_coverage.json`) makes deleting a fixture red.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { FrihetClient } from "../client.js";
import type { IFrihetClient } from "../client-interface.js";
import { registerAllTools } from "../tools/register-all.js";

/* ------------------------------------------------------------------ */
/*  Fixture corpus types                                               */
/* ------------------------------------------------------------------ */

export interface ParityCase {
  /** Human label, printed on failure. */
  name: string;
  /** True when the body reproduces a LEGACY-shaped record still live in prod. */
  legacy?: boolean;
  /** Arguments passed to the tool handler. */
  args?: Record<string, unknown>;
  /** `"<METHOD> <pathname>"` → exact wire body the Cloud Function emits. */
  routes: Record<string, unknown>;
}

export interface ParityFixture {
  /** Registered MCP tool name. */
  tool: string;
  /** erp-main file:line the wire bodies were copied from. */
  provenance: string;
  /**
   * Top-level keys the outputSchema declares that no fixture exercises, each
   * mapped to the REASON. Anything not listed here that stays unobserved is a
   * failure — that is the phantom-field detector. Adding a key here must be a
   * deliberate, reviewable act.
   */
  declaredKeysNotInFixtures?: Record<string, string>;
  cases: ParityCase[];
}

export type ParityFailureKind =
  | "unknown-tool"
  | "no-output-schema"
  | "tool-error"
  | "no-structured-content"
  | "envelope-leak"
  | "schema-rejected-real-response"
  | "unrouted-request"
  | "undocumented-phantom-key"
  | "coverage-floor";

export interface ParityFailure {
  kind: ParityFailureKind;
  tool: string;
  case?: string;
  detail: string;
}

export interface ParityReport {
  toolsRegistered: number;
  toolsWithOutputSchema: number;
  toolsCovered: number;
  casesChecked: number;
  legacyCasesChecked: number;
  /** Registered tools that declare an outputSchema but have NO fixture. */
  uncovered: string[];
  /** Keys real responses carry that the schema does not declare (info only). */
  undeclaredObservedKeys: Record<string, string[]>;
  failures: ParityFailure[];
  coverageFloor: number;
}

/* ------------------------------------------------------------------ */
/*  Tool capture                                                       */
/* ------------------------------------------------------------------ */

interface ZodLike {
  safeParse: (value: unknown) => { success: boolean; error?: unknown };
  shape?: Record<string, unknown>;
}

interface ToolConfig {
  description?: string;
  outputSchema?: unknown;
  [key: string]: unknown;
}

type ToolHandler = (args?: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

class CapturingMcpServer {
  tools = new Map<string, { config: ToolConfig; handler: ToolHandler }>();
  registerTool(name: string, config: ToolConfig, handler: ToolHandler): void {
    this.tools.set(name, { config, handler });
  }
  registerPrompt(): void {
    /* unused */
  }
  registerResource(): void {
    /* unused */
  }
}

/**
 * Registers every tool against a throwaway client and returns the captured
 * `{ config, handler }` map. Exported so contract tests can inspect the REAL
 * registered input/output schemas instead of re-typing them.
 */
export function captureRegisteredTools(
  client: IFrihetClient,
): Map<string, { config: ToolConfig; handler: ToolHandler }> {
  const capture = new CapturingMcpServer();
  registerAllTools(
    capture as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    client,
  );
  return capture.tools;
}

function isZodLike(value: unknown): value is ZodLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}

/** Top-level keys a zod object schema declares (empty for non-object schemas). */
function declaredKeys(schema: ZodLike): string[] {
  const shape = (schema as { shape?: unknown }).shape;
  if (shape && typeof shape === "object") return Object.keys(shape as object);
  return [];
}

/**
 * True for an anti-envelope tripwire field — `z.never().optional()`, which
 * accepts `undefined` and rejects every real JSON value. Those keys exist
 * PRECISELY so no response ever carries them (they reject a leaked `{data,meta}`
 * envelope), so the phantom-key check must not demand a fixture for them.
 */
function isNeverTripwire(field: unknown): boolean {
  if (!isZodLike(field)) return false;
  if (!field.safeParse(undefined).success) return false;
  const probes: unknown[] = [null, 0, "", false, {}, [], "x"];
  return probes.every((p) => !field.safeParse(p).success);
}

/** Declared keys that a real response could actually carry. */
function checkableKeys(schema: ZodLike): string[] {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (!shape || typeof shape !== "object") return [];
  return Object.keys(shape).filter((key) => !isNeverTripwire(shape[key]));
}

/* ------------------------------------------------------------------ */
/*  Fixture loading                                                    */
/* ------------------------------------------------------------------ */

/** Walk up from this module until the directory holding package.json. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("schema-parity gate: cannot locate repo root (no package.json above this module)");
}

export function fixturesDir(): string {
  return join(repoRoot(), "src", "__tests__", "fixtures", "backend-parity");
}

export function loadFixtures(dir = fixturesDir()): ParityFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as ParityFixture);
}

export function loadCoverageFloor(dir = fixturesDir()): number {
  const path = join(dir, "_coverage.json");
  if (!existsSync(path)) return 0;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { minimumCoveredTools?: number };
  return typeof parsed.minimumCoveredTools === "number" ? parsed.minimumCoveredTools : 0;
}

/* ------------------------------------------------------------------ */
/*  The gate                                                           */
/* ------------------------------------------------------------------ */

export interface RunOptions {
  /** In-memory corpus override — used by the gate's own selftest. */
  fixtures?: ParityFixture[];
  /** Coverage floor override — used by the gate's own selftest. */
  coverageFloor?: number;
}

export async function runSchemaParityGate(opts: RunOptions = {}): Promise<ParityReport> {
  const fixtures = opts.fixtures ?? loadFixtures();
  const coverageFloor = opts.coverageFloor ?? loadCoverageFloor();

  let routes: Record<string, unknown> = {};
  const unrouted: string[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const key = `${req.method} ${url.pathname}`;
    res.setHeader("Content-Type", "application/json");
    // Drain the request body so POST/PATCH sockets close cleanly.
    req.resume();
    req.on("end", () => {
      if (key in routes) {
        res.statusCode = 200;
        res.end(JSON.stringify(routes[key]));
        return;
      }
      unrouted.push(key);
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found", meta: {} }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const capture = new CapturingMcpServer();
  const client = new FrihetClient("fri_parity_gate_key", baseUrl) as unknown as IFrihetClient;
  registerAllTools(
    capture as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    client,
  );

  const withSchema = [...capture.tools.entries()].filter(([, t]) => isZodLike(t.config.outputSchema));
  const covered = new Set<string>();
  const failures: ParityFailure[] = [];
  const undeclaredObservedKeys: Record<string, string[]> = {};
  let casesChecked = 0;
  let legacyCasesChecked = 0;

  try {
    for (const fixture of fixtures) {
      const entry = capture.tools.get(fixture.tool);
      if (!entry) {
        failures.push({
          kind: "unknown-tool",
          tool: fixture.tool,
          detail: `fixture names a tool that is not registered by registerAllTools()`,
        });
        continue;
      }
      const schema = entry.config.outputSchema;
      if (!isZodLike(schema)) {
        failures.push({
          kind: "no-output-schema",
          tool: fixture.tool,
          detail: `tool declares no outputSchema, so nothing can be validated`,
        });
        continue;
      }
      covered.add(fixture.tool);

      const observed = new Set<string>();

      for (const testCase of fixture.cases) {
        routes = testCase.routes;
        unrouted.length = 0;
        casesChecked += 1;
        if (testCase.legacy) legacyCasesChecked += 1;

        let result: Awaited<ReturnType<ToolHandler>>;
        try {
          result = await entry.handler(testCase.args ?? {});
        } catch (error) {
          failures.push({
            kind: "tool-error",
            tool: fixture.tool,
            case: testCase.name,
            detail: `handler threw: ${(error as Error).message}`,
          });
          continue;
        }

        if (unrouted.length > 0) {
          failures.push({
            kind: "unrouted-request",
            tool: fixture.tool,
            case: testCase.name,
            detail: `fixture has no route for ${[...new Set(unrouted)].join(", ")} — the mock answered 404, so this case proved nothing`,
          });
          continue;
        }

        if (result.isError) {
          failures.push({
            kind: "tool-error",
            tool: fixture.tool,
            case: testCase.name,
            detail: `handler returned isError with content: ${result.content?.[0]?.text?.slice(0, 200) ?? "(none)"}`,
          });
          continue;
        }

        const structured = result.structuredContent;
        if (!structured || typeof structured !== "object") {
          failures.push({
            kind: "no-structured-content",
            tool: fixture.tool,
            case: testCase.name,
            detail: `handler returned no structuredContent — schema-following agents get nothing`,
          });
          continue;
        }

        // Envelope leak: a SINGLE-OBJECT `{data: {...}, meta}` reaching
        // structuredContent means a client method forgot requestUnwrapped().
        // A list envelope has an ARRAY `data` and is legitimate, so it is
        // deliberately excluded from this check.
        const dataValue = (structured as Record<string, unknown>)["data"];
        if (
          "meta" in structured &&
          dataValue !== null &&
          typeof dataValue === "object" &&
          !Array.isArray(dataValue)
        ) {
          failures.push({
            kind: "envelope-leak",
            tool: fixture.tool,
            case: testCase.name,
            detail:
              `structuredContent is the raw { data, meta } API envelope, not the payload ` +
              `(client method must use requestUnwrapped). Keys: ${Object.keys(structured).join(", ")}`,
          });
          continue;
        }

        for (const key of Object.keys(structured)) observed.add(key);

        const parsed = schema.safeParse(structured);
        if (!parsed.success) {
          failures.push({
            kind: "schema-rejected-real-response",
            tool: fixture.tool,
            case: testCase.name,
            detail:
              `outputSchema REJECTS the real backend response (${fixture.provenance}): ` +
              JSON.stringify(parsed.error, null, 2),
          });
        }
      }

      // Reverse drift: keys the schema promises that no real response carries.
      const documented = fixture.declaredKeysNotInFixtures ?? {};
      const phantom = checkableKeys(schema).filter((k) => !observed.has(k) && !(k in documented));
      if (phantom.length > 0) {
        failures.push({
          kind: "undocumented-phantom-key",
          tool: fixture.tool,
          detail:
            `outputSchema declares ${phantom.map((k) => `\`${k}\``).join(", ")} but no fixture response carries ` +
            `${phantom.length === 1 ? "it" : "them"}. Either the backend really sends the key (add a fixture) ` +
            `or it is a phantom field (delete it), or justify it in declaredKeysNotInFixtures.`,
        });
      }

      const undeclared = [...observed].filter((k) => !declaredKeys(schema).includes(k));
      if (undeclared.length > 0) undeclaredObservedKeys[fixture.tool] = undeclared.sort();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const uncovered = withSchema.map(([name]) => name).filter((name) => !covered.has(name)).sort();

  if (covered.size < coverageFloor) {
    failures.push({
      kind: "coverage-floor",
      tool: "(corpus)",
      detail:
        `only ${covered.size} tools carry a parity fixture, below the committed floor of ${coverageFloor}. ` +
        `A fixture was deleted or renamed — restore it, or lower the floor in _coverage.json in the same diff.`,
    });
  }

  return {
    toolsRegistered: capture.tools.size,
    toolsWithOutputSchema: withSchema.length,
    toolsCovered: covered.size,
    casesChecked,
    legacyCasesChecked,
    uncovered,
    undeclaredObservedKeys,
    failures,
    coverageFloor,
  };
}

/** Human-readable report. The success line NAMES what was scanned. */
export function formatReport(report: ParityReport): string {
  const lines: string[] = [];
  lines.push("── MCP ⇄ backend schema parity ─────────────────────────────");
  lines.push(
    `checked ${report.toolsCovered} of ${report.toolsWithOutputSchema} tools that declare an outputSchema ` +
      `(${report.toolsRegistered} registered in total); ` +
      `${report.uncovered.length} have no fixture → UNCOVERED`,
  );
  lines.push(
    `${report.casesChecked} response fixtures replayed through a real FrihetClient ` +
      `(${report.legacyCasesChecked} of them legacy-shaped); coverage floor = ${report.coverageFloor}`,
  );

  if (Object.keys(report.undeclaredObservedKeys).length > 0) {
    lines.push("");
    lines.push("INFO — keys the backend sends that the schema does not declare (passthrough absorbs them):");
    for (const [tool, keys] of Object.entries(report.undeclaredObservedKeys)) {
      lines.push(`  ${tool}: ${keys.join(", ")}`);
    }
  }

  if (report.uncovered.length > 0) {
    lines.push("");
    lines.push(`UNCOVERED (${report.uncovered.length}) — no backend fixture, parity NOT proven for these:`);
    for (const name of report.uncovered) lines.push(`  · ${name}`);
  }

  lines.push("");
  if (report.failures.length === 0) {
    lines.push(
      `PASS — ${report.toolsCovered} tools / ${report.casesChecked} real backend response fixtures ` +
        `validated against their declared outputSchemas. ` +
        `This proves NOTHING about the ${report.uncovered.length} uncovered tools listed above.`,
    );
  } else {
    lines.push(`FAIL — ${report.failures.length} parity defect(s):`);
    for (const f of report.failures) {
      lines.push("");
      lines.push(`  [${f.kind}] ${f.tool}${f.case ? ` — case "${f.case}"` : ""}`);
      lines.push(`    ${f.detail.split("\n").join("\n    ")}`);
    }
  }
  return lines.join("\n");
}
