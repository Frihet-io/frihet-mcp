/**
 * Deterministic evidence bundle for the Phase 0 baseline (#1578).
 *
 * The harness's own output tree cannot be committed as-is: it names every result
 * directory with a run timestamp, and `server-sse-multiple-streams` alone dumps
 * ~1.1 MB of SSE events. Both would make the artifact churn on every rerun, which
 * is the opposite of a baseline.
 *
 * This normalises the same information into something byte-stable: check
 * verdicts with their run timestamps stripped, oversized `details` truncated with
 * an explicit marker (never silently), and the scenario-tagged relay transcript
 * that is the actual proof an external harness talked to the real server.
 */

export const MAX_DETAIL_CHARS = 2000;

/**
 * Values that change every run and carry no information about the server.
 *
 * Redacted rather than kept, because a baseline that differs from itself on
 * every rerun cannot be diffed, and a diff nobody can read is a diff nobody
 * checks. Each pattern is listed so the redaction is auditable: if one of these
 * ever hides something meaningful, it is visible here rather than buried in a
 * regex. Nothing about a request or a verdict is touched.
 */
const VOLATILE = [
  // The relay binds an ephemeral port (--port 0), so the URL differs per run.
  [/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>"],
  // Streamable HTTP session ids are random UUIDs minted per session.
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>"],
  // HTTP Date response header.
  [/[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT/g, "<http-date>"],
];

export function redactVolatile(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const [pattern, replacement] of VOLATILE) out = out.replace(pattern, replacement);
  return out;
}

export function normaliseDetails(details) {
  if (details === null || details === undefined) return null;
  const serialised = redactVolatile(JSON.stringify(details));
  if (serialised.length <= MAX_DETAIL_CHARS) return { json: serialised, truncated: false };
  return {
    json: serialised.slice(0, MAX_DETAIL_CHARS),
    truncated: true,
    originalLength: serialised.length,
  };
}

export function normaliseChecks(checks) {
  return checks.map((check) => ({
    id: check.id,
    status: check.status,
    errorMessage: redactVolatile(check.errorMessage ?? ""),
    details: normaliseDetails(check.details),
  }));
}

/**
 * `results` is what the runner collected; `segments` is the transcript grouped by
 * scenario tag. Scenarios are emitted in the order the harness declared them so
 * the file does not reorder between runs.
 */
export function buildEvidence({ declaredScenarios, results, segments, versions }) {
  const byScenario = new Map(results.map((r) => [r.scenario, r]));
  return {
    $comment:
      "Normalised, byte-stable evidence for docs/conformance/PHASE0-BASELINE.md. Regenerate with `npm run conformance:phase0`. The unnormalised harness output lives in raw/ and is gitignored.",
    versions,
    scenarios: declaredScenarios.map((scenario) => {
      const result = byScenario.get(scenario);
      return {
        scenario,
        parseError: result?.parseError ?? null,
        checks: result?.checks ? normaliseChecks(result.checks) : [],
        transcript: (segments[scenario] ?? []).map((m) => ({
          direction: m.direction,
          method: m.method ?? null,
          toolName: m.toolName ?? null,
          resourceUri: m.resourceUri ?? null,
          promptName: m.promptName ?? null,
          isError: m.isError ?? null,
          errorCode: m.errorCode ?? null,
        })),
      };
    }),
  };
}
