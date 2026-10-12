import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";

import { normalizePublicApiBaseUrl } from "../api-origin.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { FrihetClient } from "../client.js";
import { log } from "../logger.js";
import {
  buildTracePayload,
  initLangfuse,
  normalizeLangfuseBaseUrl,
  traceMCPTool,
} from "../observability.js";
import { registerCrmTools } from "../tools/crm.js";

const BUSINESS_DATA = {
  customerName: "Ada Lovelace",
  email: "ada.private@example.test",
  address: "42 Private Street",
  salary: 98765,
  invoiceLine: "Confidential restructuring engagement",
  freeText: "Owner-only commercial negotiation notes",
  apiKey: "fri_PRIVATE_KEY_MATERIAL",
  workspaceId: "workspace-low-entropy-42",
};

const BUSINESS_VALUES = Object.values(BUSINESS_DATA).map(String);

function assertNoBusinessPayload(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const secret of BUSINESS_VALUES) {
    assert.ok(!serialized.includes(secret), `telemetry leaked business value: ${secret}`);
  }
}

describe("telemetry data minimization", () => {
  test("Langfuse authority is the exact canonical HTTPS origin", () => {
    assert.equal(
      normalizeLangfuseBaseUrl("https://LANGFUSE.FRIHET.IO:443/"),
      "https://langfuse.frihet.io",
    );
    for (const candidate of [
      "http://langfuse.frihet.io",
      "https://user:password@langfuse.frihet.io",
      "https://langfuse.frihet.io:444",
      "https://langfuse.frihet.io/path",
      "https://langfuse.frihet.io?query=value",
      "https://langfuse.frihet.io#fragment",
      "https://other.frihet.io",
      "https://.frihet.io",
      "https://langfuse.frihet.io.",
    ]) {
      assert.throws(() => normalizeLangfuseBaseUrl(candidate), candidate);
    }
  });

  test("Langfuse redirects cannot forward Basic authorization to a second origin", async () => {
    const sinkRequests: Array<{ authorization: string | undefined }> = [];
    const redirectRequests: Array<{ authorization: string | undefined }> = [];
    const sink = createServer((req, res) => {
      sinkRequests.push({ authorization: req.headers.authorization });
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const sinkPort = (sink.address() as AddressInfo).port;

    const redirector = createServer((req, res) => {
      redirectRequests.push({ authorization: req.headers.authorization });
      res.writeHead(307, { location: `http://127.0.0.1:${sinkPort}/ingestion-sink` });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    const redirectPort = (redirector.address() as AddressInfo).port;

    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    const logs: string[] = [];
    let requestSettledResolve: (() => void) | undefined;
    const requestSettled = new Promise<void>((resolve) => { requestSettledResolve = resolve; });
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), "https://langfuse.frihet.io/api/public/ingestion");
      try {
        return await originalFetch(`http://127.0.0.1:${redirectPort}/api/public/ingestion`, init);
      } finally {
        requestSettledResolve?.();
      }
    };
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    initLangfuse({
      publicKey: "pk_test_redirect",
      secretKey: "sk_test_redirect",
      baseUrl: "https://langfuse.frihet.io",
    });

    try {
      await traceMCPTool("get_client", {}, async () => ({ ok: true }));
      let settleTimeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        requestSettled,
        new Promise<never>((_resolve, reject) => {
          settleTimeout = setTimeout(
            () => reject(new Error("Langfuse redirect request did not settle")),
            2_000,
          );
        }),
      ]);
      if (settleTimeout) clearTimeout(settleTimeout);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalConsoleError;
      await Promise.all([
        new Promise<void>((resolve, reject) => sink.close((error) => error ? reject(error) : resolve())),
        new Promise<void>((resolve, reject) => redirector.close((error) => error ? reject(error) : resolve())),
      ]);
    }

    assert.equal(redirectRequests.length, 1);
    assert.match(redirectRequests[0]?.authorization ?? "", /^Basic /u);
    assert.deepEqual(sinkRequests, []);
    const parsedLogs = logs.map((entry) => JSON.parse(entry) as Record<string, unknown>);
    for (const entry of parsedLogs) delete entry.timestamp;
    assert.deepEqual(parsedLogs, [{
      level: "warn",
      message: "MCP telemetry trace event",
      service: "frihet-mcp",
      operation: "langfuse_trace",
      error: { message: "MCP operation failed", code: "telemetry_error" },
    }]);
  });

  test("invalid worker telemetry authority clears stale configuration and disables sending", async () => {
    initLangfuse({
      publicKey: "pk_stale",
      secretKey: "sk_stale",
      baseUrl: "https://langfuse.frihet.io",
    });
    initLangfuse({
      publicKey: "pk_invalid",
      secretKey: "sk_invalid",
      baseUrl: "https://other.frihet.io",
    });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    };
    try {
      const result = await traceMCPTool("get_client", {}, async () => ({ ok: true }));
      assert.deepEqual(result, { ok: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls, 0);
  });

  test("explicit Worker opt-out cannot fall back to populated process telemetry env", async () => {
    const envKeys = [
      "LANGFUSE_PUBLIC_KEY",
      "LANGFUSE_SECRET_KEY",
      "LANGFUSE_BASE_URL",
    ] as const;
    const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    let calls = 0;

    process.env.LANGFUSE_PUBLIC_KEY = "pk_process_fallback";
    process.env.LANGFUSE_SECRET_KEY = "sk_process_fallback";
    process.env.LANGFUSE_BASE_URL = "https://langfuse.frihet.io";
    initLangfuse({});
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    };

    try {
      const result = await traceMCPTool("get_client", {}, async () => ({ ok: true }));
      assert.deepEqual(result, { ok: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    assert.equal(calls, 0);
  });

  test("Langfuse payload is an operational allowlist, never a redacted business payload", () => {
    const now = new Date("2026-08-16T00:00:00.000Z");
    const untrustedParams = {
      toolName: "create_invoice",
      input: { nested: BUSINESS_DATA },
      output: {
        structuredContent: { invoice: BUSINESS_DATA },
        content: [{ type: "text", text: JSON.stringify(BUSINESS_DATA) }],
      },
      isError: false,
      errorMessage: `Provider echoed ${JSON.stringify(BUSINESS_DATA)}`,
      startTime: now,
      endTime: new Date(now.getTime() + 25),
      traceId: "trace-operational-1",
      spanId: "span-operational-1",
      userIdHashed: "unkeyed-truncated-workspace-hash",
      clientName: BUSINESS_DATA.email,
      mcpVersion: BUSINESS_DATA.apiKey,
      errorClass: BUSINESS_DATA.apiKey,
      errorCode: BUSINESS_DATA.workspaceId,
      stub: null,
    } as unknown as Parameters<typeof buildTracePayload>[0];

    const payload = buildTracePayload(untrustedParams);
    assertNoBusinessPayload(payload);

    assert.deepEqual(payload.batch.map((event) => event.body), [
      {
        id: "trace-operational-1",
        name: "mcp_request",
        timestamp: now.toISOString(),
        metadata: { tool: "create_invoice", success: true },
        tags: ["mcp.tool.create_invoice"],
      },
      {
        id: "span-operational-1",
        traceId: "trace-operational-1",
        name: "tool.create_invoice",
        startTime: now.toISOString(),
        endTime: new Date(now.getTime() + 25).toISOString(),
        metadata: { durationMs: 25, success: true },
        level: "DEFAULT",
      },
    ]);
  });

  test("generic structured logging drops arbitrary message, error, and metadata payloads", () => {
    const captured: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      log({
        level: "error",
        message: `Provider failure: ${JSON.stringify(BUSINESS_DATA)}`,
        operation: "tool_error",
        tool: "create_invoice",
        error: {
          message: `Raw provider body: ${JSON.stringify(BUSINESS_DATA)}`,
          code: "provider_error",
          statusCode: 502,
        },
        metadata: {
          ...BUSINESS_DATA,
          path: "/v1/clients/client-low-entropy-7",
          version: BUSINESS_DATA.apiKey,
          transport: BUSINESS_DATA.email,
          clientName: BUSINESS_DATA.email,
          mcpVersion: BUSINESS_DATA.workspaceId,
          method: BUSINESS_DATA.customerName,
        },
      });
      log({
        level: "warn",
        message: BUSINESS_DATA.freeText,
        operation: "constructor",
        tool: BUSINESS_DATA.apiKey,
        error: { message: BUSINESS_DATA.invoiceLine, code: BUSINESS_DATA.apiKey },
      });
    } finally {
      console.error = original;
    }

    assert.equal(captured.length, 2);
    assertNoBusinessPayload(captured);
    assert.ok(!captured.join("\n").includes("client-low-entropy-7"));
    const parsed = captured.map((entry) => JSON.parse(entry) as Record<string, unknown>);
    for (const entry of parsed) delete entry.timestamp;
    assert.deepEqual(parsed, [
      {
        level: "error",
        message: "MCP tool error",
        service: "frihet-mcp",
        tool: "create_invoice",
        operation: "tool_error",
        error: {
          message: "MCP operation failed",
          code: "backend_error",
          statusCode: 502,
        },
      },
      {
        level: "warn",
        message: "MCP operational event",
        service: "frihet-mcp",
        error: { message: "MCP operation failed", code: "unknown_error" },
      },
    ]);
  });

  test("handled MCP failures stay payload-free, truthful, and never consume provider error bodies", async () => {
    const capturedRequests: string[] = [];
    const capturedLogs: string[] = [];
    const providerResponse = new Response(JSON.stringify(BUSINESS_DATA), { status: 503 });
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      capturedRequests.push(String(init?.body ?? ""));
      return providerResponse;
    };
    console.error = (...args: unknown[]) => capturedLogs.push(args.map(String).join(" "));
    initLangfuse({ publicKey: "pk_test", secretKey: "sk_test", baseUrl: "https://langfuse.frihet.io" });

    try {
      const liveResult = { isError: true, content: [{ type: "text", text: JSON.stringify(BUSINESS_DATA) }] };
      const returned = await traceMCPTool("create_invoice", BUSINESS_DATA, async () => liveResult);
      assert.equal(returned, liveResult, "telemetry must not mutate the live MCP result");
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalConsoleError;
    }

    assert.equal(capturedRequests.length, 1);
    assertNoBusinessPayload(capturedRequests[0]);
    const batch = JSON.parse(capturedRequests[0]!) as {
      batch: Array<{ body: { metadata?: Record<string, unknown> } }>;
    };
    for (const event of batch.batch) {
      assert.equal(event.body.metadata?.success, false);
    }
    assert.equal(providerResponse.bodyUsed, false, "telemetry must not read a provider error body");
    assertNoBusinessPayload(capturedLogs);
  });
});

describe("public API origin boundary", () => {
  test("canonical Frihet origins normalize to a fixed /v1 base", () => {
    assert.equal(normalizePublicApiBaseUrl("https://frihet.io"), "https://frihet.io/v1");
    assert.equal(normalizePublicApiBaseUrl("https://api.frihet.io/"), "https://api.frihet.io/v1");
    assert.equal(normalizePublicApiBaseUrl("https://API.FRIHET.IO:443/v1/"), "https://api.frihet.io/v1");
  });

  test("host confusion, credentials, unsafe ports, and ambiguous URL components fail closed", () => {
    const rejected = [
      "https://evilfrihet.io/v1",
      "https://api.frihet.io.evil.example/v1",
      "https://api.frihet.io@evil.example/v1",
      "https://user:password@api.frihet.io/v1",
      "http://api.frihet.io/v1",
      "https://api.frihet.io:444/v1",
      "https://.frihet.io/v1",
      "https://.api.frihet.io/v1",
      "https://api..frihet.io/v1",
      "https://api.frihet.io./v1",
      "https://api.frihet.io/v1?forward=evil",
      "https://api.frihet.io/v1#fragment",
      "https://api.frihet.io/not-v1",
    ];
    for (const candidate of rejected) {
      assert.throws(() => normalizePublicApiBaseUrl(candidate), candidate);
    }
  });

  test("generic and document redirects cannot deliver an API key to another origin", async () => {
    const sinkRequests: Array<{ path: string; apiKey: string | undefined }> = [];
    const sink = createServer((req, res) => {
      sinkRequests.push({ path: req.url ?? "", apiKey: req.headers["x-api-key"] as string | undefined });
      if (req.url?.endsWith("/pdf")) {
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end("%PDF-1.4\nredirect sink");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [], total: 0 }));
      }
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const sinkPort = (sink.address() as AddressInfo).port;

    const redirector = createServer((req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${sinkPort}${req.url ?? "/"}` });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    const redirectPort = (redirector.address() as AddressInfo).port;

    try {
      const client = new FrihetClient("fri_test_key", `http://127.0.0.1:${redirectPort}/v1`);
      await assert.rejects(() => client.listClients());
      await assert.rejects(() => client.getInvoicePdf("inv_redirect"));
    } finally {
      await Promise.all([
        new Promise<void>((resolve, reject) => sink.close((error) => error ? reject(error) : resolve())),
        new Promise<void>((resolve, reject) => redirector.close((error) => error ? reject(error) : resolve())),
      ]);
    }

    assert.deepEqual(sinkRequests, [], "redirect target must receive zero requests and zero credentials");
  });
});

describe("public API path segments", () => {
  const INVALID_SEGMENTS = ["..", ".", ""];

  async function withRecordingApi(run: (client: FrihetClient, sent: string[]) => Promise<void>): Promise<void> {
    const sent: string[] = [];
    const api = createServer((req, res) => {
      sent.push(`${req.method} ${req.url}`);
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: {} }));
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    try {
      const port = (api.address() as AddressInfo).port;
      await run(new FrihetClient("fri_test_key", `http://127.0.0.1:${port}/v1`, { retryBudgetMs: 0 }), sent);
    } finally {
      await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
    }
  }

  test("rejects dot segments in path ids", async () => {
    await withRecordingApi(async (frihet, sent) => {
      const server = new McpServer({ name: "path-segment-test", version: "0.0.0" });
      registerCrmTools(server, frihet);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "path-segment-test-client", version: "0.0.0" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        for (const value of [".", ".."]) {
          for (const call of [
            { name: "delete_client_contact", arguments: { clientId: "client-1", contactId: value } },
            { name: "delete_client_note", arguments: { clientId: "client-1", noteId: value } },
          ]) {
            const result = await client.callTool(call);
            assert.equal(result.isError, true, `${call.name} with ${JSON.stringify(value)}`);
          }
        }
        assert.deepEqual(sent, []);

        await client.callTool({ name: "delete_client_contact", arguments: { clientId: "client-1", contactId: "contact-1" } });
        await client.callTool({ name: "delete_client_note", arguments: { clientId: "client-1", noteId: "note-1" } });
        assert.deepEqual(sent, [
          "DELETE /v1/clients/client-1/contacts/contact-1",
          "DELETE /v1/clients/client-1/notes/note-1",
        ]);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  test("every client method that builds a path from an id never sends a dot or empty segment", async () => {
    const methods = Object.getOwnPropertyNames(FrihetClient.prototype)
      .filter((name) => name !== "constructor")
      .map((name) => [name, (FrihetClient.prototype as unknown as Record<string, unknown>)[name]] as const)
      .filter((entry): entry is readonly [string, (...args: unknown[]) => Promise<unknown>] => typeof entry[1] === "function");
    const builders = methods.filter(([, method]) => method.toString().includes("pathSegment("));

    assert.deepEqual(
      methods.filter(([, method]) => method.toString().includes("encodeURIComponent(")).map(([name]) => name),
      [],
      "path ids are encoded only through the shared segment check",
    );
    assert.deepEqual(
      methods.filter(([, method]) => /`\/[^`]*\$\{(?!pathSegment\()/u.test(method.toString())).map(([name]) => name),
      [],
      "every value interpolated into a path goes through the shared segment check",
    );
    assert.ok(builders.length > 0);

    // Fields that must be valid for the call to reach its path.
    const validFields: Record<string, Record<string, string>> = {
      exportEInvoice: { format: "ubl" },
    };

    await withRecordingApi(async (frihet, sent) => {
      for (const [name, method] of builders) {
        for (const value of INVALID_SEGMENTS) {
          // Reads as `value` both as a positional id and as any field of a params object.
          const fields = validFields[name] ?? {};
          const id = new Proxy({}, {
            get: (_target, key) => key === Symbol.toPrimitive
              ? () => value
              : typeof key === "string" && key !== "then" ? (Object.hasOwn(fields, key) ? fields[key] : value) : undefined,
          });
          const before = sent.length;
          const error = await method.apply(frihet, [id, id, id, id]).then(() => undefined, (caught: unknown) => caught);
          const requests = sent.slice(before);
          const label = `${name} with ${JSON.stringify(value)}`;
          if (value === "") {
            // An empty optional id may select another route; it must never leave an empty segment.
            for (const request of requests) assert.doesNotMatch(request, /\/\/|\/(\?|$)/u, label);
          } else {
            assert.equal((error as { errorCode?: unknown } | undefined)?.errorCode, "invalid_path_segment", label);
            assert.deepEqual(requests, [], label);
          }
        }
      }
    });
  });
});
