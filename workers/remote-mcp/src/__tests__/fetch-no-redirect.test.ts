import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rejectRedirectResponse } from "../../../../src/fetch-no-redirect.js";
import { FrihetClient } from "../../../../src/client.js";
import { initLangfuse, traceMCPTool } from "../../../../src/observability.js";
import {
  provisionOAuthApiKey,
  revokeOAuthApiKey,
} from "../oauth-provisioning.js";

const statuses = [301, 302, 303, 307, 308];
const lifecycle =
  "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/oauthApiKeyProvisioning";
const secret = "synthetic-service-secret-at-least-32bytes";
const binding = {
  uid: "synthetic-owner",
  accessProfile: "openai",
  oauthResource: "https://openai-mcp.frihet.io",
} as const;

test("five credential sinks reject every redirect with zero requests or credentials at destination", async (t) => {
  let status = 301;
  let destinationCalls = 0;
  const origins: Array<Record<string, unknown>> = [];
  const destination = createServer((_req, res) => {
    destinationCalls += 1;
    res.end("unexpected destination");
  });
  await new Promise<void>((resolve) =>
    destination.listen(0, "127.0.0.1", resolve),
  );
  const destinationPort = (destination.address() as AddressInfo).port;
  const origin = createServer((req, res) => {
    origins.push({
      method: req.method,
      apiKey: req.headers["x-api-key"],
      authorization: req.headers.authorization,
      service: req.headers["x-frihet-oauth-key"],
    });
    res.writeHead(status, {
      location: `http://127.0.0.1:${destinationPort}/credential-sink`,
    });
    res.end("do not follow or consume this body");
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
  const nativeFetch = globalThis.fetch;
  const telemetry: Array<Promise<Response>> = [];
  t.mock.method(
    globalThis,
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("https://langfuse.frihet.io/")) {
        const pending = nativeFetch(`${base}/telemetry`, init);
        telemetry.push(pending);
        return pending;
      }
      return nativeFetch(input, init);
    },
  );
  const fetchLifecycle = (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    assert.equal(
      init?.redirect,
      "manual",
      "injectable lifecycle fetch must receive no-follow mode",
    );
    return nativeFetch(`${base}/lifecycle`, init);
  };
  try {
    for (const candidate of statuses)
      await t.test(String(candidate), async () => {
        status = candidate;
        const before = origins.length;
        const client = new FrihetClient("fri_synthetic-key", base);
        await assert.rejects(() => client.getProduct("synthetic"));
        await assert.rejects(() => client.getInvoicePdf("synthetic"));
        await assert.rejects(
          () =>
            provisionOAuthApiKey(
              lifecycle,
              "synthetic-id-token",
              secret,
              binding,
              "12345678-1234-4123-8123-123456789abc",
              fetchLifecycle,
            ),
          /Redirect responses are not allowed/,
        );
        await assert.rejects(
          () =>
            revokeOAuthApiKey(
              lifecycle,
              secret,
              { ...binding, keyId: "a".repeat(20) },
              fetchLifecycle,
            ),
          /Redirect responses are not allowed/,
        );
        initLangfuse({
          publicKey: "pk_synthetic",
          secretKey: "sk_synthetic",
          baseUrl: "https://langfuse.frihet.io",
        });
        assert.deepEqual(
          await traceMCPTool("get_product", {}, async () => ({ ok: true })),
          { ok: true },
          "telemetry remains fail-open",
        );
        await Promise.all(telemetry);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const rows = origins.slice(before);
        assert.equal(rows.length, 5);
        assert.equal(rows[0].apiKey, "fri_synthetic-key");
        assert.equal(rows[1].apiKey, "fri_synthetic-key");
        assert.equal(rows[2].authorization, "Bearer synthetic-id-token");
        assert.equal(rows[2].service, secret);
        assert.equal(rows[3].authorization, undefined);
        assert.equal(rows[3].service, secret);
        assert.equal(
          rows[4].authorization,
          `Basic ${btoa("pk_synthetic:sk_synthetic")}`,
        );
        assert.equal(
          destinationCalls,
          0,
          "redirect target receives zero requests and therefore zero credentials",
        );
      });
  } finally {
    initLangfuse({});
    await Promise.all([
      new Promise<void>((resolve, reject) =>
        destination.close((error) => (error ? reject(error) : resolve())),
      ),
      new Promise<void>((resolve, reject) =>
        origin.close((error) => (error ? reject(error) : resolve())),
      ),
    ]);
  }
});

test("no-redirect helper cancels rejected bodies and preserves successful responses", async () => {
  for (const status of statuses) {
    let cancelled = 0;
    const stream = new ReadableStream({
      cancel() {
        cancelled += 1;
      },
    });
    await assert.rejects(
      () =>
        rejectRedirectResponse(
          new Response(stream, {
            status,
            headers: { location: "https://other.invalid" },
          }),
        ),
      /Redirect responses are not allowed/,
    );
    assert.equal(cancelled, 1);
  }
  const response = Response.json({ ok: true });
  const result = await rejectRedirectResponse(response);
  assert.equal(result, response);
  assert.equal(result.bodyUsed, false);
  assert.deepEqual(await result.json(), { ok: true });
  const unchanged = new Response(null, { status: 304 });
  assert.equal(await rejectRedirectResponse(unchanged), unchanged);
});
