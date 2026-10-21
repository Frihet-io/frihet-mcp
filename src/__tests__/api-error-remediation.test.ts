/**
 * Regression proof for actionable, safe 403 remediation.
 *
 * The ERP may return a precise scope remedy in `detail`. Both JSON and
 * document transports must retain it, while the MCP surface must fail closed
 * when server-provided guidance looks like a credential or stack trace.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { FrihetApiError, FrihetClient, isLocalInputValidationError, toApiEInvoiceExportFormat } from "../client.js";
import { handleToolError, withToolLogging } from "../tools/shared.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMcpSurface, localMcpSurfaceComposition, remoteMcpSurfaceComposition } from "../server-composition.js";
import { isBackendNotFound, notDeployedError, withBackendGuard } from "../tools/backend-availability.js";
import { initLangfuse } from "../observability.js";

const GENERIC_403 =
  "Access denied. Reconnect Frihet or use configured credentials with permission for this action. / Acceso denegado. Vuelve a conectar Frihet o usa credenciales con permiso para esta accion.";
const SCOPE_REMEDY =
  "This API key requires the einvoice:read or einvoice:write scope to access e-invoicing endpoints. Add the scope when creating or updating the key.";
const REAL_FORMAT_FRIHET_KEY = `fri_${"A".repeat(43)}`;

for (const local of [true, false]) for (const claude of [true, false]) {
  test(`${claude ? "Claude" : "general"} ${local ? "local" : "remote"} preserves GL application404 and treats ambiguous404 as an error`, async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    let mode: "application" | "generic" | "non-json" = "application";
    globalThis.fetch = async input => {
      requests++;
      assert.equal(new URL(String(input)).pathname, "/v1/gl/entries/PRIVATE_entry_fixture/audit-log");
      return new Response(mode === "application"
        ? JSON.stringify({ error: "NOT_FOUND", message: "GL entry 'PRIVATE_entry_fixture' not found", meta: { requestId: "PRIVATE_request" } })
        : mode === "generic" ? JSON.stringify({ error: "Resource not found" }) : "PRIVATE_upstream404", {
        status: 404, headers: { "content-type": mode === "non-json" ? "text/html" : "application/json" },
      });
    };
    initLangfuse({});
    const server = new McpServer({ name: "lookup-denial", version: "1.0.0" });
    const api = new FrihetClient("fri_synthetic_not_a_credential", "https://api.example.test/v1");
    registerMcpSurface(server, api, (local ? localMcpSurfaceComposition : remoteMcpSurfaceComposition)(false, true, claude));
    const client = new Client({ name: "lookup-test", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      await assert.rejects(api.getGLEntryAuditLog("PRIVATE_entry_fixture"), (error: FrihetApiError) => {
        assert.equal(error.statusCode, 404);
        assert.equal(error.errorCode, "NOT_FOUND");
        assert.equal(error.message, "GL entry 'PRIVATE_entry_fixture' not found");
        return true;
      });
      requests = 0;
      const missing = await client.callTool({ name: "frihet_gl_entry_audit_log", arguments: { entryId: "PRIVATE_entry_fixture" } });
      assert.equal(missing.isError, true);
      assert.equal(missing.structuredContent, undefined, "missing data must never become a fabricated empty audit log");
      assert.deepEqual(missing._meta, { "io.frihet/resourceNotFound": true });
      const missingText = (missing.content as Array<{ text: string }>)[0].text;
      assert.match(missingText, claude ? /^NOT_FOUND:/u : /Resource not found/u);
      assert.doesNotMatch(JSON.stringify(missing), /PRIVATE_|backend_unavailable|not deployed/u);
      assert.equal(requests, 1, "rendering must not repeat a lookup");

      for (mode of ["generic", "non-json"] as const) {
        requests = 0;
        const result = await client.callTool({ name: "frihet_gl_entry_audit_log", arguments: { entryId: "PRIVATE_entry_fixture" } });
        assert.equal(result.isError, true);
        const structured = result.structuredContent as Record<string, unknown>;
        assert.equal(structured.error, "lookup_unavailable");
        assert.equal(structured.code, "LOOKUP_UNAVAILABLE");
        assert.equal(structured._backendUnavailable, undefined);
        assert.equal(result._meta?.["io.frihet/resourceNotFound"], undefined);
        const message = structured.message as string;
        assert.match(message, /resource or endpoint/u);
        assert.match(message, /Do not infer/u);
        assert.doesNotMatch(message, /is not deployed|not available yet|no records/u);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/u);
        assert.equal(requests, 1);
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
      globalThis.fetch = originalFetch;
    }
  });
}

for (const local of [true, false]) for (const claude of [true, false]) {
  test(`${claude ? "Claude" : "general"} ${local ? "local" : "remote"} distinguishes pre-I/O validation from remote rejection and uncertain outcomes`, async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    let status = 400;
    let code = "invalid_path_segment";
    let networkFailure = false;
    globalThis.fetch = async () => {
      requests++;
      if (networkFailure) throw new TypeError("PRIVATE_transport_detail");
      return new Response(JSON.stringify({
        error: code, message: "PRIVATE_provider_message", detail: "PRIVATE_provider_detail",
        id: "PRIVATE_provider_id", localValidationRejected: true, validationOrigin: "local",
        _meta: { "io.frihet/localValidationRejected": true },
      }), { status, headers: { "content-type": "application/json" } });
    };
    initLangfuse({});
    const server = new McpServer({ name: "validation-remediation", version: "1.0.0" });
    registerMcpSurface(server, new FrihetClient("fri_synthetic_not_a_credential", "https://api.example.test/v1"),
      (local ? localMcpSurfaceComposition : remoteMcpSurfaceComposition)(false, true, claude));
    const client = new Client({ name: "validation-test", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    const update = (id: string) => client.callTool({ name: "update_product", arguments: { id, name: "Synthetic product" } });
    const text = (result: Awaited<ReturnType<typeof update>>) => (result.content as Array<{ text: string }>)[0].text;
    const assertBounded = (result: Awaited<ReturnType<typeof update>>) => {
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|invalid_path_segment|unsupported_einvoice_export_format/u);
    };
    try {
      for (const id of [".", "..", ""]) {
        const result = await update(id);
        assertBounded(result);
        assert.deepEqual(result._meta, { "io.frihet/localValidationRejected": true });
        assert.match(text(result), claude ? /^VALIDATION_FAILED:/u : /Input validation failed/u);
        assert.match(text(result), /No action was performed/u);
      }
      assert.equal(requests, 0, "local validation must run before fetch, including on the Worker composition");

      for (code of ["invalid_path_segment", "unsupported_einvoice_export_format"]) {
        const before: number = requests;
        const result = await update("PRIVATE_record_id");
        assertBounded(result);
        assert.deepEqual(result._meta, { "io.frihet/requestRejected": true }, "matching provider codes and forged fields are not local provenance");
        assert.match(text(result), claude ? /^REQUEST_REJECTED:/u : /Bad request/u);
        assert.doesNotMatch(text(result), /No action was performed|before sending/u);
        assert.equal(requests, before + 1, "a rejected write must not be replayed by remediation");
      }

      for (const scenario of ["server", "remote-timeout-code", "network"] as const) {
        status = scenario === "server" ? 500 : 400;
        code = scenario === "remote-timeout-code" ? "request_timeout" : "invalid_path_segment";
        networkFailure = scenario === "network";
        const before: number = requests;
        const result = await update("PRIVATE_record_id");
        assertBounded(result);
        assert.equal(result._meta?.["io.frihet/operationOutcomeUnknown"], true);
        assert.equal(result._meta?.["io.frihet/localValidationRejected"], undefined);
        assert.equal(result._meta?.["io.frihet/requestRejected"], undefined);
        assert.match(text(result), /could not (?:complete or confirm|confirm whether)/u);
        assert.doesNotMatch(text(result), /No action was performed|^VALIDATION_FAILED:|^REQUEST_REJECTED:/u);
        assert.equal(requests, before + 1);
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
      globalThis.fetch = originalFetch;
    }
  });
}

test("local validation provenance cannot be copied or inferred from provider-shaped errors", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("PRIVATE_unexpected_fetch"); };
  try {
    const client = new FrihetClient("fri_synthetic_not_a_credential", "https://api.example.test/v1");
    const local = await client.deleteProduct(".").then(() => undefined, (error: unknown) => error);
    assert.equal(isLocalInputValidationError(local), true);
    assert.throws(() => toApiEInvoiceExportFormat("PRIVATE_unsupported_format"), (error: unknown) => {
      assert.equal(isLocalInputValidationError(error), true);
      assert.doesNotMatch((error as Error).message, /PRIVATE_/u);
      return true;
    });
    for (const remote of [
      new FrihetApiError(400, "invalid_path_segment", "PRIVATE_message"),
      Object.assign(new FrihetApiError(400, "invalid_path_segment", "PRIVATE_message"), { localValidationRejected: true, validationOrigin: "local" }),
      Object.assign(Object.create(Object.getPrototypeOf(local)), { statusCode: 400, errorCode: "invalid_path_segment", message: "PRIVATE_message" }),
    ]) {
      assert.equal(isLocalInputValidationError(remote), false);
      assert.deepEqual(handleToolError(remote)._meta, { "io.frihet/requestRejected": true });
    }
    // Even a branded object cannot overrule evidence that the outcome is unknown.
    Object.assign(local as object, { errorCode: "network_error" });
    const uncertain = handleToolError(local);
    assert.equal(uncertain._meta?.["io.frihet/operationOutcomeUnknown"], true);
    assert.equal(uncertain._meta?.["io.frihet/localValidationRejected"], undefined);
    assert.equal(uncertain._meta?.["io.frihet/requestRejected"], undefined);
    assert.doesNotMatch(uncertain.content[0].text, /No action was performed/u);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("backend404 predicate retains HTTP semantics and explicit NOT_DEPLOYED remains explicit", async () => {
  assert.equal(isBackendNotFound(new FrihetApiError(404, "NOT_FOUND")), true);
  assert.equal(isBackendNotFound({ status: 404 }), true);
  assert.equal(isBackendNotFound(new FrihetApiError(403, "NOT_FOUND")), false);
  const missing = new FrihetApiError(404, "NOT_FOUND", "PRIVATE_backend_message");
  await assert.rejects(withBackendGuard("fixture", "/fixture", async () => { throw missing; }), error => error === missing);
  const result = notDeployedError("get_modelo_180_summary", "/v1/fiscal/modelo/180");
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "NOT_DEPLOYED");
  assert.equal(result.structuredContent._backendUnavailable, true);
  assert.match(result.structuredContent.message as string, /is not deployed/u);
});

function rendered(error: unknown): string {
  return handleToolError(error, "permissions_test").content[0]!.text;
}

describe("403 remediation rendering", () => {
  test("only definitive API 404/403 responses carry non-PII denial flags", () => {
    for (const [status, flag] of [[404, "resourceNotFound"], [403, "accessDenied"]] as const) {
      const result = handleToolError(new FrihetApiError(status, "PRIVATE_code", "PRIVATE_message", "PRIVATE_detail"));
      assert.deepEqual(result._meta, { [`io.frihet/${flag}`]: true });
      assert.equal(result.structuredContent, undefined);
    }
    for (const error of [
      ...[400, 401, 429, 500, 503].map(status => new FrihetApiError(status, "error", "PRIVATE_message")),
      ...[403, 404].flatMap(status => ["request_timeout", "network_error", "response_timeout", "invalid_response_after_success"]
        .map(code => new FrihetApiError(status, code, "PRIVATE_message"))),
      new Error("PRIVATE_unexpected"),
      { statusCode: 404, message: "not_found" },
    ]) {
      const result = handleToolError(error);
      assert.equal(result._meta?.["io.frihet/resourceNotFound"], undefined);
      assert.equal(result._meta?.["io.frihet/accessDenied"], undefined);
    }
  });

  test("prefers actionable detail and includes it exactly once", () => {
    const text = rendered(new FrihetApiError(403, "Forbidden", "Access forbidden", SCOPE_REMEDY));
    assert.match(text, new RegExp(GENERIC_403.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(text.split(SCOPE_REMEDY).length - 1, 1);
    assert.doesNotMatch(text, /Access forbidden/);
  });

  test("uses a non-generic server message when detail is absent", () => {
    const message = "Ask a workspace owner to grant access to this resource.";
    const text = rendered(new FrihetApiError(403, "Forbidden", message));
    assert.match(text, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(text.split(message).length - 1, 1);
  });

  test("falls back to the existing generic 403 copy for error-only or whitespace guidance", () => {
    for (const error of [
      new FrihetApiError(403, "Forbidden"),
      new FrihetApiError(403, "Forbidden", "  ", "\t"),
    ]) {
      assert.equal(rendered(error), `Error: ${GENERIC_403}`);
      assert.doesNotMatch(rendered(error), /undefined/);
    }
  });

  test("never displays credential, token, stack, internal-path, control, or oversized input", () => {
    const unsafe = [
      "Use Authorization: Bearer super-secret-token to retry.",
      "Use Bearer super-secret-token to retry.",
      "Use Basic QWxhZGRpbjpvcGVuU2VzYW1l to retry.",
      "Set api_key=fri_live_TOPSECRET before retrying.",
      `Use ${REAL_FORMAT_FRIHET_KEY} to retry.`,
      "The token is a-super-secret-token-value.",
      "Retry with secret TOPSECRET.",
      "Retry with opaque VGhpcyBpcyBhIHNlY3JldCB2YWx1ZQ.",
      "This API key requires the secret:TOPSECRET scope to access e-invoicing endpoints. Add the scope when creating or updating the key.",
      "This API key requires the secret:topsecret scope to access e-invoicing endpoints. Add the scope when creating or updating the key.",
      "This API key requires the einvoice:read or secret:aBcDeFgHiJkLmNoP scope to access e-invoicing endpoints. Add the scope when creating or updating the key.",
      "This API key requires the einvoice:read or einvoice:write scope to access e-Invoicing endpoints. Add the scope when creating or updating the key.",
      "This API key requires the einvoice:read or einvoice:write scope to access payrollsecrettoken endpoints. Add the scope when creating or updating the key.",
      "Error: denied\n    at authorize (/srv/app/src/auth.ts:42:7)",
      "Inspect /Users/backend/service/auth.ts for the denied scope.",
      "Inspect /etc/passwd for the denied scope.",
      "Inspect src/auth.ts for the denied scope.",
      "scope ".repeat(200),
      "scope\u0000remedy",
    ];

    for (const detail of unsafe) {
      const text = rendered(new FrihetApiError(403, "Forbidden", "Forbidden", detail));
      assert.equal(text, `Error: ${GENERIC_403}`, detail);
      assert.ok(!text.includes(detail), detail);
    }
  });

  test("unsafe 403 message and detail stay out of tool output and both log sites", async () => {
    const bearerSecret = "Bearer a-very-secret-bearer-value";
    const rawLogs: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => rawLogs.push(args.map(String).join(" "));

    try {
      const error = new FrihetApiError(
        403,
        "Forbidden",
        `Retry with ${bearerSecret}.`,
        `Use ${REAL_FORMAT_FRIHET_KEY} to retry.`,
      );
      assert.equal(error.message, "Forbidden", "unsafe 403 message must be normalized before logging");

      const result = await withToolLogging("unsafe_403_test", async () => {
        throw error;
      });
      const output = result.content[0]!.text;
      const serializedLogs = rawLogs.join("\n");
      assert.equal(output, `Error: ${GENERIC_403}`);
      for (const unsafeValue of [bearerSecret, REAL_FORMAT_FRIHET_KEY]) {
        assert.doesNotMatch(output, new RegExp(unsafeValue));
        assert.doesNotMatch(serializedLogs, new RegExp(unsafeValue));
      }
      assert.equal(rawLogs.length, 2);
      for (const rawLog of rawLogs) {
        const parsed = JSON.parse(rawLog) as {
          message: string;
          error?: { message?: string; code?: string; statusCode?: number };
        };
        assert.ok(["MCP tool call failed", "MCP tool error"].includes(parsed.message));
        assert.deepEqual(parsed.error, {
          message: "MCP operation failed",
          code: "forbidden",
          statusCode: 403,
        });
      }
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("representative non-403 mappings and document 413 special case are unchanged", () => {
    assert.equal(
      rendered(new FrihetApiError(400, "invalid_request", "backend detail")),
      "Error: Bad request. Check your input parameters. / Solicitud incorrecta. Revisa los parametros.",
    );
    assert.equal(
      rendered(new FrihetApiError(401, "unauthorized", "backend detail")),
      "Error: Authentication failed. Reconnect Frihet or check the configured credentials. / Autenticacion fallida. Vuelve a conectar Frihet o revisa las credenciales configuradas.",
    );
    assert.equal(
      rendered(new FrihetApiError(404, "not_found", "backend detail")),
      "Error: Resource not found. / Recurso no encontrado.",
    );
    assert.equal(
      rendered(new FrihetApiError(413, "payload_too_large", "Document response exceeds 5242880 bytes")),
      "Error: Document response too large: Document response exceeds 5242880 bytes / Respuesta de documento demasiado grande.",
    );
    const unauthorized = handleToolError(
      new FrihetApiError(401, "unauthorized", "provider body"),
    );
    assert.deepEqual(unauthorized._meta, {
      "io.frihet/authenticationRequired": true,
    });
  });
});

describe("FrihetClient preserves backend 403 detail", () => {
  test("generic JSON and bounded document paths carry detail separately", async () => {
    const originalFetch = globalThis.fetch;
    const seenPaths: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      seenPaths.push(url.pathname);
      if (url.pathname === "/invoices/missing_error") {
        return new Response(JSON.stringify({ detail: SCOPE_REMEDY }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/invoices/non_string_error") {
        return new Response(JSON.stringify({
          error: { nested: true },
          message: `Retry with Bearer a-very-secret-bearer-value.`,
          detail: "Inspect /etc/passwd for the denied scope.",
        }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        error: "Forbidden",
        detail: SCOPE_REMEDY,
        meta: { requestId: "req_test_only" },
      }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const client = new FrihetClient("fri_test_key", "https://api.example.test");
      for (const call of [
        () => client.getInvoice("inv_json"),
        () => client.getInvoicePdf("inv_pdf"),
      ]) {
        await assert.rejects(call, (error: Error & {
          statusCode?: number;
          errorCode?: string;
          detail?: string;
        }) => {
          assert.equal(error.statusCode, 403);
          assert.equal(error.errorCode, "Forbidden");
          assert.equal(error.message, "Forbidden");
          assert.equal(error.detail, SCOPE_REMEDY);
          assert.equal(rendered(error).split(SCOPE_REMEDY).length - 1, 1);
          return true;
        });
      }

      await assert.rejects(
        () => client.getInvoice("missing_error"),
        (error: Error & { errorCode?: string; detail?: string }) => {
          assert.equal(error.errorCode, "http_403");
          assert.equal(error.message, "http_403");
          assert.equal(error.detail, SCOPE_REMEDY);
          assert.equal(rendered(error).split(SCOPE_REMEDY).length - 1, 1);
          return true;
        },
      );

      await assert.rejects(
        () => client.getInvoice("non_string_error"),
        (error: Error & { errorCode?: string; detail?: string }) => {
          assert.equal(error.errorCode, "http_403");
          assert.equal(error.message, "http_403");
          assert.equal(error.detail, "Inspect /etc/passwd for the denied scope.");
          assert.equal(rendered(error), `Error: ${GENERIC_403}`);
          return true;
        },
      );

      assert.deepEqual(seenPaths, [
        "/invoices/inv_json",
        "/invoices/inv_pdf/pdf",
        "/invoices/missing_error",
        "/invoices/non_string_error",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("ambiguous transport failures", () => {
  test("normalizes raw fetch failures without exposing transport internals", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError("socket failure containing internal transport detail");
    };

    try {
      const client = new FrihetClient("fri_test_key", "https://api.example.test");
      await assert.rejects(
        () => client.createVendor({ name: "Network Supplier" }),
        (error: Error & { statusCode?: number; errorCode?: string }) => {
          assert.equal(error.statusCode, 503);
          assert.equal(error.errorCode, "network_error");
          assert.doesNotMatch(error.message, /socket|internal transport/i);
          const result = handleToolError(error, "create_vendor");
          assert.equal(result._meta?.["io.frihet/transportOutcomeUnknown"], true);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("marks server and idempotency responses that may follow a committed write", () => {
    for (const error of [
      new FrihetApiError(500, "internal_error", "Internal error"),
      new FrihetApiError(502, "bad_gateway", "Bad gateway"),
      new FrihetApiError(
        409,
        "IDEMPOTENCY_REQUEST_IN_PROGRESS",
        "The original outcome is still being reconciled",
      ),
    ]) {
      const result = handleToolError(error, "create_vendor");
      assert.equal(result._meta?.["io.frihet/operationOutcomeUnknown"], true);
    }

    const refused = handleToolError(
      new FrihetApiError(400, "validation_error", "Bad request"),
      "create_vendor",
    );
    assert.equal(refused._meta?.["io.frihet/operationOutcomeUnknown"], undefined);
  });

  test("classifies malformed or empty 2xx bodies as post-success ambiguity", async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const body of ["{", "null"]) {
        globalThis.fetch = async () => new Response(body, {
          status: 201,
          headers: { "content-type": "application/json" },
        });
        const client = new FrihetClient("fri_test_key", "https://api.example.test");
        await assert.rejects(
          () => client.createVendor({ name: "Response Supplier" }),
          (error: Error & { statusCode?: number; errorCode?: string }) => {
            assert.equal(error.statusCode, 201);
            assert.equal(error.errorCode, "invalid_response_after_success");
            assert.doesNotMatch(error.message, /SyntaxError|JSON|Unexpected token/i);
            const result = handleToolError(error, "create_vendor");
            assert.equal(result._meta?.["io.frihet/operationOutcomeUnknown"], true);
            return true;
          },
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps the timeout active while consuming a 2xx response body", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      const response = new Response("{}", {
        status: 201,
        headers: { "content-type": "application/json" },
      });
      response.json = () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("body read aborted"), { name: "AbortError" }));
        }, { once: true });
      });
      return response;
    };

    try {
      const client = new FrihetClient(
        "fri_test_key",
        "https://api.example.test",
        { timeoutMs: 10 },
      );
      await assert.rejects(
        () => client.createVendor({ name: "Slow Supplier" }),
        (error: Error & { statusCode?: number; errorCode?: string }) => {
          assert.equal(error.statusCode, 408);
          assert.equal(error.errorCode, "response_timeout");
          const result = handleToolError(error, "create_vendor");
          assert.equal(result._meta?.["io.frihet/operationOutcomeUnknown"], true);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
