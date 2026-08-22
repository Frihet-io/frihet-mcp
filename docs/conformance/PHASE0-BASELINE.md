# Official MCP conformance — Phase 0 baseline

Tracker: [berthelius/Frihet-ERP#1578](https://github.com/berthelius/Frihet-ERP/issues/1578) · Phase 0 only.
Machine-readable artifacts: [`phase0/baseline.json`](./phase0/baseline.json) (the matrix)
and [`phase0/evidence.json`](./phase0/evidence.json) (every check verdict and every
relayed message, per scenario). The harness's own output tree lands in
`phase0/raw/` and is gitignored — it is regenerable, and it is not stable across
runs because the harness timestamps its result directories.

This is **not** the same thing as PR #148, and it should not be described as if
it were. #148 is an in-repo canary (`scripts/canary-mcp.mjs` →
`src/canary/mcp-harness.ts`) whose own snapshot records
`"harnessMode": "in-process-sdk-client"` and `"protocolVersion": null`: it links
a `Client` to the server over `InMemoryTransport`, so there is no process
boundary, no wire, and no protocol negotiation to observe. It also records
`"inspectorPinnedVersion": "2.3.0"` as a reference string without running the
Inspector.

Phase 0 is the first time an external process has spoken the MCP wire protocol
to this server and scored it against the specification.

## Headline

The official conformance suite reaches a verdict about the Frihet server on
**5 of its 32 server scenarios**. The other 27 do not test us: 19 need fixtures
from the reference "everything" server that we have no reason to expose, 5 probe
capabilities we deliberately do not advertise, and 3 measure the HTTP transport,
which we do not ship.

Zero scenarios are attributed to a Frihet defect. That is a much weaker statement
than it sounds, and the coverage table below is the more useful artifact: it says
what remains unmeasured, which is most of the surface.

## Pinned versions

| What | Value |
|---|---|
| Server SHA | `37b0e59947eff3f2ddf0c380d739ee9fc8fcbdb8` |
| Server package | `@frihet/mcp-server@1.16.6` |
| `@modelcontextprotocol/sdk` | declared `^1.27.0`, **resolved `1.30.0`** (per `package-lock.json`) |
| Negotiated protocol | **`2025-11-25`** |
| `@modelcontextprotocol/conformance` | **`0.1.16`** (latest stable; `0.2.0-alpha.11` exists and was not used) |
| `@modelcontextprotocol/inspector` | **`2.3.0`** |
| Node | `v22.22.2` |
| Target | stdio, `FRIHET_DEMO=1`, no `FRIHET_API_KEY` in the child env |

## The obstacle, and what was built to get around it

`@modelcontextprotocol/conformance@0.1.16 server` accepts **only** `--url`. It
ships no stdio client transport. The Frihet server is stdio-only
(`StdioServerTransport`, `src/index.ts`). Without something in between, all 32
scenarios would have had to be recorded as NOT_EXERCISED.

`scripts/conformance/http-bridge.mjs` is a verbatim JSON-RPC relay: Streamable
HTTP on the harness side, stdio on the server side, forwarding every message
unmodified in both directions. It never answers on the server's behalf, including
`initialize` — protocol negotiation in this baseline is genuinely ours.

**The relay is harness, not server.** Anything it implements itself — the HTTP
layer, session ids, SSE stream management, Origin/DNS-rebinding checks,
resumability — is not evidence about Frihet. Scenarios that test those surfaces
are classified `NOT_APPLICABLE / bridge-under-test` and **can never be a PASS**;
`validate-baseline.mjs` fails RED if one ever is.

The MCP Inspector is run separately and needs no relay: its CLI speaks stdio
natively, so it reaches the real server directly and covers what the conformance
fixtures structurally cannot — our real resource URIs, our real prompts, and a
real read-only tool call.

## Result matrix — official conformance (32 scenarios)

| Outcome | Count | Scenarios |
|---|---:|---|
| **PASS** | 5 | `server-initialize`, `ping`, `tools-list`, `resources-list`, `prompts-list` |
| **FAIL_SERVER** | 0 | — |
| **FAIL_HARNESS** | 0 | — |
| **NOT_APPLICABLE** | 27 | see breakdown |
| **NOT_EXERCISED** | 0 | — |

### NOT_APPLICABLE breakdown

**`harness-false-green-on-missing-fixture` (2)** — `tools-call-simple-text`,
`tools-call-error`.

These are the important ones. The official harness scored both **SUCCESS**, and
both would have entered this baseline as passes. They are not. The recorded
transcript shows the harness called `test_simple_text` and `test_error_handling`
— tools Frihet has never exposed — and the server answered `isError: true`
("tool not found"). That error response satisfied each scenario's assertion.
Nothing was exercised.

From `phase0/evidence.json`, the harness's own record for
`tools-call-simple-text` — status `SUCCESS`, over this response:

```json
{
  "id": "tools-call-simple-text",
  "status": "SUCCESS",
  "details": { "json": "{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"MCP error -32602: Tool test_simple_text not found\"}],\"isError\":true}}" }
}
```

The same file's `transcript` array for that scenario shows the request that
produced it (`"method": "tools/call", "toolName": "test_simple_text"`) followed
by a response with `"isError": true`.

The consequence: **the official conformance run never once performed a
successful `tools/call` against a real Frihet tool.** That gap is covered by the
Inspector smoke instead, not by this suite.

**`harness-fixture` (17)** — `tools-call-image`, `tools-call-audio`,
`tools-call-embedded-resource`, `tools-call-mixed-content`,
`tools-call-with-progress`, `tools-call-sampling`, `tools-call-elicitation`,
`elicitation-sep1034-defaults`, `elicitation-sep1330-enums`,
`resources-read-text`, `resources-read-binary`, `resources-templates-read`,
`prompts-get-simple`, `prompts-get-with-args`, `prompts-get-embedded-resource`,
`prompts-get-with-image`, `json-schema-2020-12`.

Each asks for a named fixture of the reference server (`test://static-text`,
`test_simple_prompt`, `json_schema_2020_12_tool`, a tool that returns an image,
a tool that elicits from the client…). The spec requires no server to expose
these, so their absence is not a defect — but it does mean these behaviours are
**unmeasured**, not proven. `json-schema-2020-12` is the one worth remembering:
our tool input schemas are consequently not validated against JSON Schema
2020-12 by anything in this baseline.

**`capability-absent` (5)** — `logging-set-level`, `tools-call-with-logging`,
`completion-complete`, `resources-subscribe`, `resources-unsubscribe`.

We advertise `tools`, `resources` and `prompts` only, so `-32601 Method not
found` is the spec-correct answer. This classification is guarded, not asserted:
each rule declares `requiresCapabilityAbsent`, and the classifier re-reads the
live `initialize` result. If a future build starts advertising `logging` while
still answering `-32601`, the rule stops applying and the scenario becomes
`FAIL_SERVER`.

**`bridge-under-test` (3)** — `dns-rebinding-protection`,
`server-sse-multiple-streams`, `server-sse-polling`.

`server-sse-multiple-streams` was scored SUCCESS by the harness. It is recorded
as NOT_APPLICABLE anyway: it passed against the relay's SSE implementation, not
against anything Frihet ships.

## Result matrix — official Inspector 2.3.0 CLI smoke (11 cases, native stdio)

| Case | Status | Exit |
|---|---|---:|
| `tools-list` | PASS | 0 |
| `resources-list` | PASS | 0 |
| `prompts-list` | PASS | 0 |
| `resources-read-real-uri` (`frihet://tax/rates`) | PASS | 0 |
| `prompts-get-no-args` (`overdue-followup`) | PASS | 0 |
| `prompts-get-with-args` (`monthly-close month=2026-07`) | PASS | 0 |
| `tools-call-safe-read` (`get_business_context`) | PASS | 0 |
| `negative-unknown-resource` | PASS | 1 |
| `negative-unknown-prompt` | PASS | 1 |
| `negative-missing-required-prompt-arg` (`year-end-close`, `year` required) | PASS | 1 |
| `negative-unknown-tool` | **NOT_EXERCISED** | 5 |

`negative-unknown-tool` is not a pass and is not recorded as one. The Inspector
checks `tools/list` first and refuses client-side with exit 5, so the request
never reaches the server; server-side unknown-tool handling is unproven by this
case. (It is separately visible in the conformance transcript, where the server
answered `isError: true` / `-32602 … not found` — but that came from a fixture
scenario, so it is reported here as context, not as a graded result.)

One correction worth recording, because it was nearly filed as a server defect:
`prompts/get monthly-close` with no arguments returns a prompt, and that is
**correct** — `month` is declared `required: false` and defaults to the previous
month. The genuine required-argument case is `year-end-close.year`, which the
server does reject with `-32602 Invalid arguments`.

## Auth

**NOT_EXERCISED.** `@modelcontextprotocol/conformance@0.1.16` exposes auth
scenarios in its **client** suite; `list --server` declares none. The Frihet
server is stdio-only and carries no auth transport for the harness to traverse,
and the relay deliberately implements none. Per the Phase 0 rule that
UNKNOWN ≠ PASS, no auth claim is made here in either direction.

## Anti-false-green gates

`scripts/conformance/validate-baseline.mjs` fails RED on:

| Rule | Fails when |
|---|---|
| `R1-zero-scenarios` | the matrix, the declared list, or the Inspector case list is empty |
| `R2-parser-failure` | `checks.json` is unreadable/not an array/zero-length, a row has no scenario name, a row is duplicated, or a recorded parse error is not reflected as a `FAIL_HARNESS` row |
| `R3-relabelled-result` | a raw `FAILURE` comes out as `PASS`; a `PASS` has no raw status behind it, or none of its raw statuses is a `SUCCESS`; any outcome outside the five allowed values (there is no `SKIP`); an Inspector `PASS` with no exit code or one that does not reach the server |
| `R4-version-metadata-missing` | any of `serverSha`, `serverPackageVersion`, `sdkVersion`, `protocolVersion`, `conformanceVersion`, `inspectorVersion`, `nodeVersion` is absent, blank, or `"unknown"` |
| `R5-coverage-gap` | the matrix has fewer rows than the harness declared scenarios, or results exist for a scenario never declared |
| `R6-bridge-cannot-pass` | a `bridge-under-test` scenario is recorded as a server `PASS` |
| `R7-unexplained-na` | `NOT_APPLICABLE` / `NOT_EXERCISED` without a reason, or `NOT_APPLICABLE` without harness evidence |
| `R8-evidence-unverifiable` | a `NOT_APPLICABLE` row whose required evidence does not actually appear in a failing check in `evidence.json`, or the evidence bundle being absent altogether |
| `R9-pass-on-missing-fixture` | a `PASS` whose transcript shows the harness asked for a tool/resource/prompt the server does not expose — or a `PASS` with **zero** relayed messages attributed to it, which means the detector saw nothing rather than found nothing |
| `R11-relay-errors` | the relay reported a dropped message, or the baseline does not record its error list at all |

Each rule is here because something got through. `R5` exists because the first
run silently produced 30 rows for 32 declared scenarios — the `active` suite
excludes two as pending, and nothing said so; it now compares sets, not lengths,
because a *renamed* row kept the count at 32. `R9` exists because of the two
false greens above, and grew its zero-messages clause when an adversarial pass
showed the detector failing **open**: lose the transcript and every row comes
back with an empty `unknownFixtures`, which reads exactly like "checked, found
nothing", and both false greens return as PASS with the gate still green.
`R8` exists because a row's `evidence` used to be the rule's own
`requiresEvidence` string echoed back — proof that a rule asked for `-32601`,
never that the harness produced it; it is now the harness's real surrounding
text, cross-checked against `evidence.json`. `R11` exists because the relay
recorded its own dropped messages and nothing ever read them.

Two more, from the same pass: a rule's evidence is now matched only against
checks that actually **failed** (a passing check in a two-phase scenario could
otherwise explain an unrelated failure), and it must explain **every** failing
check, not just one of them. The "none of its raw
statuses is a `SUCCESS`" clause exists because absence of `FAILURE` was reading
as presence of `SUCCESS`: a scenario returning only `INFO`/`WARNING` notes had
nothing to catch it, so the classifier now returns `NOT_EXERCISED /
no-decisive-checks` for that case and refuses any applicability rule that tries
to declare `outcome: "PASS"` (`FAIL_HARNESS / invalid-rule-outcome` — only the
harness may award a pass).

The unit tests live in `scripts/__tests__/conformance-phase0.test.mjs` and drive
each rule with synthetic input, so the gates are shown to go RED rather than
assumed to.

## Reproducing

```bash
npm run build
npm run conformance:phase0          # rerun and rewrite the baseline
npm run conformance:phase0:check    # rerun and fail if the baseline moved
npm run gate:conformance-baseline   # offline validation of the committed artifact (this one runs in CI)
```

The first two need network — `npx` fetches the pinned harnesses — and spawn the
server, so they are local gates. CI runs only the offline validation plus the
unit tests.

`conformance:phase0:check` is the determinism gate, and it is a claim that was
checked rather than asserted: a full independent rerun reproduces both artifacts
byte-for-byte and exits 0. Getting there required naming three values that change
every run and carry nothing about the server — the relay's ephemeral port, the
Streamable HTTP session UUID, and the HTTP `Date` header. They are redacted in
`scripts/conformance/evidence.mjs`, in one auditable list, rather than left to
churn the artifact on every run.

The harnesses are pinned by tarball `dist.integrity`, not only by version string,
so a republished `0.1.16` would be visible. The run also asserts the conformance
CLI self-reports the pinned version before trusting its output. The Inspector has
no version flag — `--version` is parsed as a connection target and hangs — so its
identity rests on the exact `npx` spec plus that hash.

## Premise corrections for Phase 1

Three claims in #1578 do not survive contact with the current packages. None of
them block Phase 0, but Phase 1 is planned on top of them.

1. **"the official TypeScript SDK v2 is now the stable line."** There is no
   `@modelcontextprotocol/sdk@2`; that package's `latest` is `1.30.0`. The v2
   line ships under **new package names** — `@modelcontextprotocol/core@2.0.0`,
   `@modelcontextprotocol/client@2.0.0`, `@modelcontextprotocol/server@2.0.0`.
   A v2 canary is a package **rename**, not a version bump.
2. **"MCP 2026-07-28."** No such protocol version exists in any of the packages
   inspected. `sdk@1.27.1`, `sdk@1.30.0` and `core@2.0.0` all know exactly
   `2025-03-26`, `2025-06-18`, `2025-11-25`, and conformance `0.1.16` tags its
   scenarios `2025-06-18` / `2025-11-25`. The current era is **`2025-11-25`**,
   which this server already negotiates.
3. **"conformance server/core/auth scenarios."** `list --server` declares no
   auth scenarios at all; auth lives in the client suite. There is no
   server-side auth conformance to run against us at `0.1.16`.

A fourth item, not a correction but a constraint: the promotion gate in Phase 1
("v2 ≥ v1 baseline") is worth only what the baseline covers. On 5 graded
scenarios out of 32, parity is a weak signal. If the gate is meant to carry real
weight, the cheapest way to raise it is to widen the Inspector smoke matrix,
which reaches the real surface, rather than to lean on the conformance count.

## Uncovered — carried forward, not closed

- A successful `tools/call` on a real tool is proven only by the Inspector smoke
  (one tool, `get_business_context`), not by conformance.
- Tool input schemas are not checked against JSON Schema 2020-12 by anything here.
- Frihet's own `resources/read` and `prompts/get` are covered by the Inspector
  smoke on one URI and two prompts, not across the 11 resources and 10 prompts.
- 162 tools are exposed; conformance graded none of them and the smoke calls one.

### Known blind spot in the classifier

If the harness touches a missing fixture anywhere in a scenario, the whole
scenario becomes `NOT_APPLICABLE` — there is no correlation between the check
that failed and the fixture that was requested. A genuine defect raised by a
scenario that also happens to ask for a fixture would be buried. It does not
happen in this run (`json-schema-2020-12`, the scenario where it would matter,
only issued `tools/list`), but that is a property of conformance `0.1.16`, not a
mechanism. Recorded deliberately rather than fixed, because the alternative —
attributing a failure to the server when the harness was asking for something
that does not exist — is the worse error.

## One real server finding: three advertised capabilities that are never emitted

Not a conformance result. No scenario tests it, which is why it is written down
here rather than left in the matrix.

The server advertises `tools.listChanged: true`, `resources.listChanged: true`
and `prompts.listChanged: true`. It never sends any of those notifications.

- The SDK sets all three unconditionally when handlers are registered
  (`@modelcontextprotocol/sdk` `server/mcp.js`, in `setToolRequestHandlers`,
  `setResourceRequestHandlers`, `setPromptRequestHandlers`) — Frihet does not
  opt into them, it inherits them.
- They would be emitted by `sendToolListChanged` / `sendResourceListChanged` /
  `sendPromptListChanged`, whose only callers inside the SDK are `.enable()`,
  `.disable()`, `.update()`, `.remove()`, and registration performed *after*
  `connect`.
- `src/` calls none of those, and `registerMcpSurface` (`src/index.ts`) runs
  before `server.connect(transport)`, so even the post-connect path never fires.
- The same three claims are repeated on a second public surface, the Worker's
  server card (`workers/remote-mcp/src/server-card.ts`).

A client that trusts the advertisement will wait for a notification that never
arrives. Carried into Phase 1: either emit them or stop advertising them. No
test would fail today if this were fixed, which is itself the point.
