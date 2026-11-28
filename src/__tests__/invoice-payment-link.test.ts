import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  enforceGenericInvoiceRedaction, InvoicePaymentLinkOutputSchema,
  projectInvoicePaymentLinkOutput, redactPaymentLinkForTrace, validatePortalPayUrl,
  type UpstreamInvoicePaymentLinkResponse,
} from "../invoice-payment-link.js";
import { buildTracePayload } from "../observability.js";
import { fixture, erpServer, mcpSurface } from "./helpers/erp-parity.js";

const response = () => fixture<UpstreamInvoicePaymentLinkResponse>("invoice-payment-link");
const ID = "inv_2026_104";

describe("Canonical invoice payment link (#3161 / #4033)", () => {
  test("preserves canonical balance, provenance and token policy without deriving minor units", () => {
    const upstream = response();
    const out = projectInvoicePaymentLinkOutput(upstream, ID);
    const { paymentUrl, ...expected } = upstream;
    assert.deepEqual(out, { ...expected, authorizedPortalUrl: paymentUrl });
    assert.equal(InvoicePaymentLinkOutputSchema.safeParse(out).success, true);
    for (const currency of ["USD", "GBP", "JPY"]) {
      assert.equal(projectInvoicePaymentLinkOutput({ ...upstream, currency, amountDue: 450.5 }, ID).amountDue, 450.5);
    }
  });

  test("unknown authority preserves null balances and withholds the link even on contradictory upstream data", () => {
    const out = projectInvoicePaymentLinkOutput({ ...response(), authorityState: "unknown" }, ID);
    assert.equal(out.payable, false);
    assert.equal(out.authorizedPortalUrl, null);
    assert.equal(out.totalAmount, null);
    assert.equal(out.amountPaid, null);
    assert.equal(out.amountDue, null);
    assert.equal(out.unavailableReason, "authority_state_unknown");
  });

  for (const status of ["draft", "paid", "cancelled"]) {
    test(`${status} invoices never expose a payment URL`, () => {
      const out = projectInvoicePaymentLinkOutput({ ...response(), status }, ID);
      assert.equal(out.payable, false);
      assert.equal(out.authorizedPortalUrl, null);
    });
  }

  test("missing/zero balances, processing and explicit server refusals withhold URLs", () => {
    for (const override of [
      { amountDue: null }, { amountDue: 0 }, { amountDue: -1 },
      { paymentState: "processing" as const }, { paymentState: "unknown" as const },
      { paymentState: "paid" as const }, { paymentState: "cancelled" as const },
      { unavailableReason: "historical_import" as const },
      { unavailableReason: "credit_note_not_payable" as const },
      { payable: false, unavailableReason: "client_portal_plan_required" as const },
    ]) {
      const out = projectInvoicePaymentLinkOutput({ ...response(), ...override }, ID);
      assert.equal(out.payable, false);
      assert.equal(out.authorizedPortalUrl, null);
    }
  });

  test("rejects mismatched invoices and malformed responses without fabricating authority", () => {
    assert.throws(() => projectInvoicePaymentLinkOutput(response(), "inv_other"), /requested invoice/);
    assert.throws(() => projectInvoicePaymentLinkOutput({ ...response(), amountDue: NaN }, ID));
    assert.throws(() => projectInvoicePaymentLinkOutput({ ...response(), observedAt: "bad" }, ID));
  });

  test("rejects alternate origins, wrong invoice/workspace, traversal, fragments, queries and normalization tricks", () => {
    const url = response().paymentUrl!;
    for (const invalid of [
      url.replace("https:", "http:"), url.replace("app.frihet.io", "evil.example"),
      url.replace("https://", "https://user:pass@"), `${url}?redirect=x`, `${url}#token`,
      url.replace(ID, "inv_other"), url.replace("/pay/", "/pay/unused/../"),
      url.replace("/pay/", "/pay//"), url + "/", " " + url,
      "https://app.frihet.io/pay/ws_prod_01/inv_2026_104/short",
    ]) {
      assert.equal(validatePortalPayUrl(invalid, "ws_prod_01", ID).valid, false, invalid);
      assert.equal(projectInvoicePaymentLinkOutput({ ...response(), paymentUrl: invalid }, ID).authorizedPortalUrl, null);
    }
    assert.equal(validatePortalPayUrl(url, "ws_other", ID).valid, false);
    assert.equal(validatePortalPayUrl(url, "ws_prod_01", ID).valid, true);
  });

  test("generic invoice redaction and operational telemetry never expose signed capabilities", () => {
    const url = response().paymentUrl!;
    const record = { id: ID, paymentUrl: url, payment_url: url, paymentLink: url, payment_link: url, clientTaxId: "B12345678" };
    assert.deepEqual(enforceGenericInvoiceRedaction(record), { id: ID });
    const projected = projectInvoicePaymentLinkOutput(response(), ID);
    assert.match(String(redactPaymentLinkForTrace(projected).authorizedPortalUrl), /\[redacted-token\]$/);
    const time = new Date("2026-11-28T12:00:00Z");
    const trace = buildTracePayload({
      toolName: "get_invoice_payment_link", output: { structuredContent: projected },
      isError: false, startTime: time, endTime: time, traceId: "trace_1", spanId: "span_1", stub: null,
    } as unknown as Parameters<typeof buildTracePayload>[0]);
    assert.equal(JSON.stringify(trace).includes(url), false);
  });

  test("production composition registers exactly once and GET reads use no body or idempotency cache", async (t) => {
    let upstream = response();
    const { backend, requests } = await erpServer(t, (_req, res) => res.end(JSON.stringify({ data: upstream })));
    const client = await mcpSurface(t, backend);
    const tools = (await client.listTools()).tools.filter((tool) => tool.name === "get_invoice_payment_link");
    assert.equal(tools.length, 1);
    assert.deepEqual(tools[0].annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const first = await client.callTool({ name: "get_invoice_payment_link", arguments: { id: ID } });
    assert.equal(first.isError, undefined);
    assert.equal((first.structuredContent as Record<string, unknown>)?.authorizedPortalUrl, upstream.paymentUrl);
    upstream = { ...upstream, payable: false, paymentUrl: null, status: "paid", amountDue: 0, unavailableReason: "already_paid" };
    const second = await client.callTool({ name: "get_invoice_payment_link", arguments: { id: ID } });
    assert.equal(second.isError, undefined);
    assert.equal((second.structuredContent as Record<string, unknown>)?.authorizedPortalUrl, null);
    assert.equal((second.structuredContent as Record<string, unknown>)?.amountDue, 0);
    assert.equal(requests.length, 2);
    for (const req of requests) {
      assert.equal(req.method, "GET");
      assert.equal(req.url.pathname, `/v1/invoices/${ID}/payment-link`);
      assert.equal(req.headers["idempotency-key"], undefined);
      assert.equal(req.body, "");
    }
  });

  test("strict input rejection makes no upstream request", async (t) => {
    const { backend, requests } = await erpServer(t, (_req, res) => res.end("{}"));
    const client = await mcpSurface(t, backend);
    for (const args of [{}, { id: "../inv_1" }, { id: ID, idempotencyKey: "obsolete-cache-key" }, { id: "" }]) {
      const result = await client.callTool({ name: "get_invoice_payment_link", arguments: args });
      assert.equal(result.isError, true);
    }
    assert.equal(requests.length, 0);
  });

  for (const status of [401, 403, 404, 429, 500]) {
    test(`HTTP ${status} remains a sanitized MCP error`, async (t) => {
      const { backend } = await erpServer(t, (_req, res) => {
        res.statusCode = status;
        if (status === 429) res.setHeader("Retry-After", "1");
        res.end(JSON.stringify({ error: "fri_live_SECRET-provider-body" }));
      });
      const client = await mcpSurface(t, backend);
      const result = await client.callTool({ name: "get_invoice_payment_link", arguments: { id: ID } });
      assert.equal(result.isError, true);
      assert.equal(JSON.stringify(result).includes("fri_live_SECRET"), false);
      assert.equal(result.structuredContent, undefined);
    });
  }
});
