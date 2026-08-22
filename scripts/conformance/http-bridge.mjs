#!/usr/bin/env node
/**
 * Streamable HTTP <-> stdio relay for the official MCP conformance harness.
 *
 * WHY THIS EXISTS
 * ---------------
 * `@modelcontextprotocol/conformance server` only speaks Streamable HTTP
 * (`--url <url>`); it ships no stdio client transport. The Frihet MCP server is
 * stdio-only (`StdioServerTransport` in src/index.ts). Without a relay the
 * official server suite cannot reach the real server at all, and every scenario
 * would have to be recorded as NOT_EXERCISED.
 *
 * WHAT IT DOES
 * ------------
 * Verbatim JSON-RPC relay. Every message the harness sends is forwarded to the
 * real server process byte-for-byte-equivalent (same JSON value, no rewriting of
 * `id`, `method`, `params`, `protocolVersion` or capabilities), and every message
 * the server emits is forwarded back. The relay never answers on the server's
 * behalf — including `initialize`, so protocol negotiation is genuinely the real
 * server's.
 *
 * ATTRIBUTION RULE (read before trusting any result)
 * --------------------------------------------------
 * This relay is HARNESS, not server. Anything it implements itself — the HTTP
 * layer, session ids, SSE stream management, Origin/DNS-rebinding checks,
 * resumability, AND JSON-RPC envelope validation — is NOT evidence about the
 * Frihet server. Scenarios that test those surfaces are classified
 * NOT_APPLICABLE in applicability.json, never PASS.
 *
 * That last one is the least obvious and the easiest to misread as a Frihet
 * verdict: `StreamableHTTPServerTransport` runs `JSONRPCMessageSchema.parse()`
 * before `onmessage` fires, and the schema is `.strict()` at the top level. A
 * malformed envelope (extra top-level key, `id: null`, non-integer `id`,
 * `jsonrpc: "1.0"`, non-object `params`) is rejected by the SDK inside this
 * bridge and never reaches Frihet. `params` is loose, so its contents do pass
 * through untouched. The transport also validates the `MCP-Protocol-Version`
 * HEADER against its own supported list — the negotiation in the `initialize`
 * BODY is genuinely Frihet's, the header check is not. Any future malformed-
 * message scenario therefore needs an explicit `bridge-under-test` rule.
 *
 * Harness only. Not shipped in the published package, not on any runtime path.
 */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);

function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

const PORT = Number(flag("port", "0"));
const HOST = "127.0.0.1";
const SERVER_ENTRY = flag("server-entry", null);
const READY_FILE = flag("ready-file", null);
const TRANSCRIPT_FILE = flag("transcript", null);

if (!SERVER_ENTRY) {
  console.error("[bridge] --server-entry <path to dist/index.js> is required");
  process.exit(2);
}

// The child inherits ONLY this env. FRIHET_DEMO=1 keeps it on fixtures with no
// network calls and no API key; omitting FRIHET_API_KEY makes a live call
// impossible rather than merely unlikely.
const CHILD_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  FRIHET_DEMO: "1",
};

/** @type {Map<string, {http: StreamableHTTPServerTransport, stdio: StdioClientTransport}>} */
const sessions = new Map();

/** Messages the relay itself could not deliver, for post-run auditing. */
const relayErrors = [];

/**
 * Every JSON-RPC message that crossed the relay, in order. This is the primary
 * evidence that an external harness really talked to the real server, and the
 * proof that no mutating tool was invoked against anything but demo fixtures.
 */
const transcript = [];
let seq = 0;
let currentTag = "unattributed";

function record(direction, message) {
  transcript.push({
    seq: seq++,
    tag: currentTag,
    direction,
    method: typeof message === "object" && message && "method" in message ? message.method : undefined,
    id: typeof message === "object" && message && "id" in message ? message.id : undefined,
    toolName:
      typeof message === "object" &&
      message &&
      message.method === "tools/call" &&
      typeof message.params === "object" &&
      message.params
        ? message.params.name
        : undefined,
    resourceUri:
      typeof message === "object" &&
      message &&
      message.method === "resources/read" &&
      typeof message.params === "object" &&
      message.params
        ? message.params.uri
        : undefined,
    promptName:
      typeof message === "object" &&
      message &&
      message.method === "prompts/get" &&
      typeof message.params === "object" &&
      message.params
        ? message.params.name
        : undefined,
    isError:
      typeof message === "object" && message && typeof message.result === "object" && message.result
        ? message.result.isError === true
        : undefined,
    errorCode:
      typeof message === "object" && message && typeof message.error === "object" && message.error
        ? message.error.code
        : undefined,
  });
}

async function createSession() {
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: CHILD_ENV,
    stderr: "pipe",
  });

  const http = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      sessions.set(sid, { http, stdio });
    },
    onsessionclosed: (sid) => {
      sessions.delete(sid);
      stdio.close().catch(() => {});
    },
  });

  // The Streamable HTTP transport needs a hint to route a server-initiated
  // notification (progress, logging) onto the SSE stream still open for the
  // request that triggered it. Responses carry their own `id` and need none.
  //
  // LIMIT, and it is a real one: this tracks the LAST request only, not a
  // per-id map. The harness does pipeline — `server-sse-multiple-streams` sends
  // three `tools/list` back to back before any response — so if the server
  // emitted a notification for the first while the third was in flight, it
  // would be attributed to the third. It cannot mis-score anything today
  // because Frihet never emits notifications at all (see PHASE0-BASELINE.md,
  // "Uncovered"). The day progress lands, `tools-call-with-progress` becomes
  // bridge-limited too and this needs an id→stream map.
  let lastRequestId;

  // harness -> real server, verbatim
  http.onmessage = (message) => {
    if ("id" in message && "method" in message) lastRequestId = message.id;
    record("harness->server", message);
    stdio.send(message).catch((error) => {
      relayErrors.push({ direction: "to-server", error: String(error) });
    });
  };

  // real server -> harness, verbatim
  stdio.onmessage = (message) => {
    record("server->harness", message);
    const isResponse = "id" in message && ("result" in message || "error" in message);
    const options =
      !isResponse && lastRequestId !== undefined ? { relatedRequestId: lastRequestId } : undefined;
    http.send(message, options).catch((error) => {
      relayErrors.push({ direction: "to-harness", error: String(error) });
    });
  };

  // Without these, a transport-level error is swallowed whole: it is not a
  // message, so it never reaches `record()`, and the scenario dies by timeout
  // with nothing in the evidence to say why. A Frihet response that failed
  // JSON-RPC envelope validation would be invisible — exactly the kind of spec
  // violation this baseline exists to surface.
  stdio.onerror = (error) => relayErrors.push({ direction: "server-transport", error: String(error) });
  http.onerror = (error) => relayErrors.push({ direction: "harness-transport", error: String(error) });

  http.onclose = () => {
    stdio.close().catch(() => {});
  };

  await stdio.start();
  // Drain child stderr so a chatty server can never fill the pipe and stall.
  stdio.stderr?.resume();
  await http.start();

  return { http, stdio };
}

/**
 * A transport with no child behind it, for requests that cannot legally start a
 * session. Spawning a full Frihet server (162 tools) just to let the SDK emit a
 * 400 leaked one orphaned child per stray GET/DELETE: `_onsessioninitialized`
 * only fires on POST-initialize, so those children never entered `sessions` and
 * `shutdown()` never reaped them. The real run relayed 34 initializes for 32
 * scenarios.
 */
async function createBareTransport() {
  const http = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  http.onerror = (error) => relayErrors.push({ direction: "harness-transport", error: String(error) });
  await http.start();
  return http;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON. Hand it back as undefined and let the SDK produce the parse
    // error itself rather than inventing one here.
    return undefined;
  }
}

function isInitialize(body) {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((m) => m && typeof m === "object" && m.method === "initialize");
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);

  // Attribution endpoint. The runner marks the transcript before each scenario so
  // every relayed message can be traced back to the scenario that produced it —
  // that is what makes it possible to see that a "passing" scenario only ever
  // called a fixture tool this server does not have.
  if (url.pathname === "/_mark") {
    currentTag = url.searchParams.get("tag") ?? "unattributed";
    res.writeHead(204).end();
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404).end();
    return;
  }

  const sid = req.headers["mcp-session-id"];
  const existing = typeof sid === "string" ? sessions.get(sid) : undefined;

  try {
    if (existing) {
      await existing.http.handleRequest(req, res);
      return;
    }

    // A child process is spawned only for a POST that actually carries an
    // `initialize`. Everything else gets a childless transport, which produces
    // the spec-mandated error and is then closed.
    const body = req.method === "POST" ? await readBody(req) : undefined;
    if (req.method === "POST" && isInitialize(body)) {
      const fresh = await createSession();
      await fresh.http.handleRequest(req, res, body);
      return;
    }

    const bare = await createBareTransport();
    try {
      await bare.handleRequest(req, res, body);
    } finally {
      await bare.close().catch(() => {});
    }
  } catch (error) {
    relayErrors.push({ direction: "http", error: String(error) });
    if (!res.headersSent) res.writeHead(500).end();
  }
});

httpServer.listen(PORT, HOST, () => {
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : PORT;
  const info = { url: `http://${HOST}:${port}/mcp`, port, pid: process.pid };
  // Written last: the runner waits on this file, so its existence means listening.
  if (READY_FILE) writeFileSync(READY_FILE, JSON.stringify(info));
  console.error(`[bridge] listening ${info.url}`);
});

function shutdown() {
  for (const { stdio } of sessions.values()) stdio.close().catch(() => {});
  if (TRANSCRIPT_FILE) {
    try {
      writeFileSync(TRANSCRIPT_FILE, JSON.stringify({ relayErrors, transcript }, null, 2));
    } catch (error) {
      console.error(`[bridge] could not write transcript: ${String(error)}`);
    }
  }
  if (relayErrors.length > 0) {
    console.error(`[bridge] relay errors: ${JSON.stringify(relayErrors)}`);
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
