/**
 * Regression proof for actionable, safe 403 remediation.
 *
 * The ERP may return a precise scope remedy in `detail`. Both JSON and
 * document transports must retain it, while the MCP surface must fail closed
 * when server-provided guidance looks like a credential or stack trace.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { FrihetApiError, FrihetClient } from "../client.js";
import { handleToolError, withToolLogging } from "../tools/shared.js";

const GENERIC_403 =
  "Access denied. Your API key does not have permission for this action. / Acceso denegado.";
const SCOPE_REMEDY =
  "This API key requires the einvoice:read or einvoice:write scope to access e-invoicing endpoints. Add the scope when creating or updating the key.";
const REAL_FORMAT_FRIHET_KEY = `fri_${"A".repeat(43)}`;

function rendered(error: unknown): string {
  return handleToolError(error, "permissions_test").content[0]!.text;
}

describe("403 remediation rendering", () => {
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
      assert.match(serializedLogs, /403 forbidden: Forbidden/);
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
      rendered(new FrihetApiError(404, "not_found", "backend detail")),
      "Error: Resource not found. / Recurso no encontrado.",
    );
    assert.equal(
      rendered(new FrihetApiError(413, "payload_too_large", "Document response exceeds 5242880 bytes")),
      "Error: Document response too large: Document response exceeds 5242880 bytes / Respuesta de documento demasiado grande.",
    );
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
