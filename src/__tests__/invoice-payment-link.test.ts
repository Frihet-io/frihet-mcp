import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  enforceGenericInvoiceRedaction,
  projectInvoicePaymentLinkOutput,
  redactPaymentLinkForTrace,
  registerInvoicePaymentLinkTool,
  validatePortalPayUrl,
  type InvoicePaymentLinkTransport,
  type UpstreamInvoicePaymentLinkResponse,
} from "../invoice-payment-link.js";

const VALID_TOKEN = "hmac_v1_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c";
const VALID_PORTAL_URL = `https://app.frihet.io/pay/ws_prod_01/inv_2026_104/${VALID_TOKEN}`;

describe("Collections PayLink MCP Contract (#3161)", () => {
  test("1. Issued collectible invoice returns signed portal URL, server balance, and zero side effects", () => {
    const upstream: UpstreamInvoicePaymentLinkResponse = {
      invoiceId: "inv_2026_104",
      workspaceId: "ws_prod_01",
      status: "issued",
      collectible: true,
      unavailableReason: null,
      currency: "EUR",
      amountRemainingMinor: 121000,
      balanceProvenance: "payment_authority_v1",
      asOf: "2026-11-08T20:00:00.000Z",
      portalUrl: VALID_PORTAL_URL,
    };

    const out = projectInvoicePaymentLinkOutput(upstream, "ws_prod_01");
    assert.equal(out.invoiceId, "inv_2026_104");
    assert.equal(out.workspaceId, "ws_prod_01");
    assert.equal(out.status, "issued");
    assert.equal(out.collectible, true);
    assert.equal(out.unavailableReason, null);
    assert.equal(out.currency, "EUR");
    assert.equal(out.amountRemainingMinor, 121000);
    assert.equal(out.amountRemainingFormatted, "1210.00 EUR");
    assert.equal(out.balanceProvenance, "payment_authority_v1");
    assert.equal(out.authorizedPortalUrl, VALID_PORTAL_URL);
    assert.equal(out.tokenLifetimePolicy, "hmac_v1_stateless_revalidated_on_open");
    assert.deepEqual(out.sideEffects, {
      emailSent: false,
      paymentInitiated: false,
      ledgerMutated: false,
      checkoutSessionCreated: false,
    });
  });

  test("2. Partial payment and non-EUR currency (USD/GBP) preserve server-computed remaining balance", () => {
    const tokenUsd = "hmac_v1_usd_partial_token_1234567890abcdef";
    const out = projectInvoicePaymentLinkOutput({
      invoiceId: "inv_usd_77",
      workspaceId: "ws_intl_02",
      status: "partially_paid",
      collectible: true,
      currency: "usd",
      amountRemainingMinor: 45050,
      totalAmountMinor: 100000,
      paidAmountMinor: 54950,
      balanceProvenance: "payment_authority_v1",
      asOf: "2026-11-08T20:05:00.000Z",
      portalUrl: `https://app.frihet.io/pay/ws_intl_02/inv_usd_77/${tokenUsd}`,
    });

    assert.equal(out.currency, "USD");
    assert.equal(out.status, "partially_paid");
    assert.equal(out.collectible, true);
    assert.equal(out.amountRemainingMinor, 45050);
    assert.equal(out.amountRemainingFormatted, "450.50 USD");
    assert.equal(
      out.authorizedPortalUrl,
      `https://app.frihet.io/pay/ws_intl_02/inv_usd_77/${tokenUsd}`,
    );
  });

  test("3. Draft, paid, cancelled, and unknown-balance invoices fail closed and never emit a portal URL or coerce unknown balance to 0", () => {
    const draft = projectInvoicePaymentLinkOutput({
      invoiceId: "inv_draft_1",
      workspaceId: "ws_prod_01",
      status: "draft",
      collectible: true, // even if upstream mistakenly says true, draft is never collectible
      currency: "EUR",
      amountRemainingMinor: 50000,
      balanceProvenance: "server_computed",
      portalUrl: `https://app.frihet.io/pay/ws_prod_01/inv_draft_1/${VALID_TOKEN}`,
    });
    assert.equal(draft.collectible, false);
    assert.equal(draft.unavailableReason, "draft_invoice");
    assert.equal(draft.authorizedPortalUrl, null);

    const paid = projectInvoicePaymentLinkOutput({
      invoiceId: "inv_paid_1",
      workspaceId: "ws_prod_01",
      status: "paid",
      collectible: false,
      currency: "EUR",
      amountRemainingMinor: 0,
      balanceProvenance: "payment_authority_v1",
      portalUrl: `https://app.frihet.io/pay/ws_prod_01/inv_paid_1/${VALID_TOKEN}`,
    });
    assert.equal(paid.collectible, false);
    assert.equal(paid.unavailableReason, "already_paid");
    assert.equal(paid.amountRemainingMinor, 0);
    assert.equal(paid.authorizedPortalUrl, null);

    const cancelled = projectInvoicePaymentLinkOutput({
      invoiceId: "inv_canc_1",
      workspaceId: "ws_prod_01",
      status: "cancelled",
      collectible: false,
      currency: "EUR",
      amountRemainingMinor: 10000,
      balanceProvenance: "payment_authority_v1",
    });
    assert.equal(cancelled.collectible, false);
    assert.equal(cancelled.unavailableReason, "cancelled_invoice");
    assert.equal(cancelled.authorizedPortalUrl, null);

    const unknownBalance = projectInvoicePaymentLinkOutput({
      invoiceId: "inv_degraded_1",
      workspaceId: "ws_prod_01",
      status: "issued",
      collectible: true,
      currency: "EUR",
      amountRemainingMinor: null,
      balanceProvenance: "unknown_degraded",
      portalUrl: `https://app.frihet.io/pay/ws_prod_01/inv_degraded_1/${VALID_TOKEN}`,
    });
    assert.equal(unknownBalance.collectible, false);
    assert.equal(unknownBalance.unavailableReason, "unknown_balance");
    assert.equal(unknownBalance.amountRemainingMinor, null, "Unknown balance must never be coerced to 0");
    assert.equal(unknownBalance.amountRemainingFormatted, null);
    assert.equal(unknownBalance.authorizedPortalUrl, null);
  });

  test("4. Tenant mismatch and tampered / cross-origin / query-leaking portal URLs are rejected (#2724 / #2896)", () => {
    const crossTenant = projectInvoicePaymentLinkOutput(
      {
        invoiceId: "inv_2026_104",
        workspaceId: "ws_other_tenant",
        status: "issued",
        collectible: true,
        currency: "EUR",
        amountRemainingMinor: 121000,
        balanceProvenance: "payment_authority_v1",
        portalUrl: `https://app.frihet.io/pay/ws_other_tenant/inv_2026_104/${VALID_TOKEN}`,
      },
      "ws_prod_01",
    );
    assert.equal(crossTenant.collectible, false);
    assert.equal(crossTenant.unavailableReason, "tenant_mismatch");
    assert.equal(crossTenant.authorizedPortalUrl, null);
    assert.equal(crossTenant.amountRemainingMinor, null);

    for (const badUrl of [
      "http://app.frihet.io/pay/ws_prod_01/inv_2026_104/" + VALID_TOKEN,
      "https://evil.example.com/pay/ws_prod_01/inv_2026_104/" + VALID_TOKEN,
      `https://user:pass@app.frihet.io/pay/ws_prod_01/inv_2026_104/${VALID_TOKEN}`,
      `${VALID_PORTAL_URL}?redirect=https://evil.example.com`,
      `${VALID_PORTAL_URL}#secret`,
      `https://app.frihet.io/pay/ws_other/inv_2026_104/${VALID_TOKEN}`,
      `https://app.frihet.io/pay/ws_prod_01/inv_other/${VALID_TOKEN}`,
      "https://app.frihet.io/pay/ws_prod_01/inv_2026_104/short",
    ]) {
      const check = validatePortalPayUrl(badUrl, "ws_prod_01", "inv_2026_104");
      assert.equal(check.valid, false, `Expected invalid URL: ${badUrl}`);
    }
  });

  test("5. Generic invoice redaction continues to strip paymentUrl/paymentLink while trace redaction masks capability tokens", () => {
    const genericInvoicePayload = {
      id: "inv_2026_104",
      status: "issued",
      total: 1210,
      paymentUrl: VALID_PORTAL_URL,
      payment_url: VALID_PORTAL_URL,
      paymentLink: VALID_PORTAL_URL,
      payment_link: VALID_PORTAL_URL,
      clientTaxId: "B12345678",
    };

    enforceGenericInvoiceRedaction(genericInvoicePayload);
    assert.equal("paymentUrl" in genericInvoicePayload, false);
    assert.equal("payment_url" in genericInvoicePayload, false);
    assert.equal("paymentLink" in genericInvoicePayload, false);
    assert.equal("payment_link" in genericInvoicePayload, false);
    assert.equal("clientTaxId" in genericInvoicePayload, false);

    const projected = projectInvoicePaymentLinkOutput({
      invoiceId: "inv_2026_104",
      workspaceId: "ws_prod_01",
      status: "issued",
      collectible: true,
      currency: "EUR",
      amountRemainingMinor: 121000,
      balanceProvenance: "payment_authority_v1",
      portalUrl: VALID_PORTAL_URL,
    });

    const traceSafe = redactPaymentLinkForTrace(projected);
    assert.equal(
      traceSafe.authorizedPortalUrl,
      "https://app.frihet.io/pay/ws_prod_01/inv_2026_104/[redacted-token]",
    );
    assert.equal(String(traceSafe.authorizedPortalUrl).includes(VALID_TOKEN), false);
  });

  test("6. MCP tool end-to-end: happy path, idempotency convergence, cross-invoice idempotency conflict, and schema rejection", async () => {
    let upstreamCalls = 0;
    const seenKeys: Array<string | undefined> = [];

    const transport: InvoicePaymentLinkTransport = {
      async requestInvoicePaymentLink(invoiceId, options) {
        upstreamCalls += 1;
        seenKeys.push(options?.idempotencyKey);
        return {
          invoiceId,
          workspaceId: "ws_prod_01",
          status: "issued",
          collectible: true,
          currency: "EUR",
          amountRemainingMinor: 121000,
          balanceProvenance: "payment_authority_v1",
          asOf: "2026-11-08T20:10:00.000Z",
          portalUrl: `https://app.frihet.io/pay/ws_prod_01/${invoiceId}/${VALID_TOKEN}`,
        };
      },
    };

    const server = new McpServer({ name: "frihet-paylink-test", version: "2.0.2" });
    registerInvoicePaymentLinkTool(server, transport, { expectedWorkspaceId: "ws_prod_01" });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // Happy path + idempotency convergence
    const first = await client.callTool({
      name: "get_invoice_payment_link",
      arguments: { id: "inv_2026_104", idempotencyKey: "idem_paylink_001" },
    });
    const second = await client.callTool({
      name: "get_invoice_payment_link",
      arguments: { id: "inv_2026_104", idempotencyKey: "idem_paylink_001" },
    });

    assert.equal(first.isError, undefined);
    assert.equal(upstreamCalls, 1, "Idempotent retry for the same invoice must converge without a second upstream call");
    assert.deepEqual(seenKeys, ["idem_paylink_001"]);
    assert.deepEqual(first.structuredContent, second.structuredContent);
    assert.equal(
      (first.structuredContent as Record<string, unknown>).authorizedPortalUrl,
      VALID_PORTAL_URL,
    );

    // Same idempotencyKey with a DIFFERENT invoiceId fails closed
    const conflict = await client.callTool({
      name: "get_invoice_payment_link",
      arguments: { id: "inv_2026_999", idempotencyKey: "idem_paylink_001" },
    });
    assert.equal(conflict.isError, true);

    // Path traversal / invalid ID rejection
    const traversal = await client.callTool({
      name: "get_invoice_payment_link",
      arguments: { id: "../inv_2026_104" },
    });
    assert.equal(traversal.isError, true);

    // Schema rejection (missing required id)
    const badSchema = await client.callTool({
      name: "get_invoice_payment_link",
      arguments: {},
    });
    assert.equal(badSchema.isError, true);

    await client.close();
    await server.close();
  });
});
