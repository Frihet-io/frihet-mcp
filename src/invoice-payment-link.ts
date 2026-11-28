/** Dedicated read-only payment-link projection for ERP #3161 / #4033. */
import { z } from "zod/v4";
import { deepRedact, redactClone, SENSITIVE_FIELD_NAMES } from "./redaction.js";

export const CANONICAL_PORTAL_ORIGIN = "https://app.frihet.io";
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_HMAC_TOKEN_RE = /^[A-Za-z0-9._-]{16,256}$/;

export const paymentLinkInvoiceId = z.string().regex(SAFE_PATH_SEGMENT_RE)
  .describe("Invoice ID / ID de la factura");

export const PORTAL_UNAVAILABLE_REASONS = [
  "invoice_draft", "historical_import", "credit_note_not_payable", "already_paid",
  "cancelled", "client_portal_plan_required", "connect_not_configured",
  "authority_state_unknown", "zero_balance_due", "payment_processing",
  "payment_state_unknown", "portal_secret_not_configured", "invalid_portal_id",
] as const;

const paymentLinkFields = {
  invoiceId: paymentLinkInvoiceId,
  invoiceNumber: z.string().nullable(),
  status: z.string(),
  currency: z.string(),
  // Values are already in major currency units. Preserve them verbatim;
  // never derive a balance from legacy totals or convert unknown to zero.
  totalAmount: z.number().finite().nullable(),
  amountPaid: z.number().finite().nullable(),
  amountDue: z.number().finite().nullable(),
  payable: z.boolean(),
  unavailableReason: z.enum(PORTAL_UNAVAILABLE_REASONS).nullable(),
  paymentState: z.enum(["ready", "processing", "stale", "paid", "cancelled", "unknown"]),
  authoritySource: z.enum(["payment_authority_v1", "legacy_projection"]),
  authorityState: z.enum(["verified", "unknown"]),
  tokenPolicy: z.object({
    version: z.literal("v1"),
    expires: z.literal(false),
    revalidatesOnOpenAndPay: z.literal(true),
  }).strict(),
  observedAt: z.iso.datetime(),
  _demo: z.literal(true).optional(),
  _demoNotice: z.string().optional(),
};

const upstreamPaymentLinkSchema = z.object({
  ...paymentLinkFields,
  paymentUrl: z.string().nullable(),
});
export type UpstreamInvoicePaymentLinkResponse = z.infer<typeof upstreamPaymentLinkSchema>;

export const InvoicePaymentLinkOutputSchema = z.object({
  ...paymentLinkFields,
  // Narrow exception to generic paymentUrl/paymentLink redaction. The URL
  // reaches only this dedicated tool, after canonical origin/path validation.
  authorizedPortalUrl: z.string().nullable()
    .describe("Validated signed payment portal URL, or null / URL firmada del portal de pago o null"),
}).strict();
export type InvoicePaymentLinkOutput = z.infer<typeof InvoicePaymentLinkOutputSchema>;

export function validatePortalPayUrl(
  rawUrl: unknown,
  expectedWorkspaceId: string | undefined,
  expectedInvoiceId: string,
): { valid: true; url: string; maskedUrl: string } | { valid: false; reason: string } {
  if (typeof rawUrl !== "string") return { valid: false, reason: "empty_or_non_string_url" };
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: "malformed_url" };
  }
  if (parsed.origin !== CANONICAL_PORTAL_ORIGIN || parsed.username || parsed.password
    || parsed.search || parsed.hash) {
    return { valid: false, reason: "invalid_portal_origin_or_components" };
  }
  const segments = parsed.pathname.split("/");
  const [, prefix, workspaceId, invoiceId, token] = segments;
  if (segments.length !== 5 || prefix !== "pay"
    || !SAFE_PATH_SEGMENT_RE.test(workspaceId) || !SAFE_PATH_SEGMENT_RE.test(invoiceId)
    || !SAFE_HMAC_TOKEN_RE.test(token) || invoiceId !== expectedInvoiceId
    || (expectedWorkspaceId !== undefined && workspaceId !== expectedWorkspaceId)) {
    return { valid: false, reason: "invalid_portal_path" };
  }
  const url = `${CANONICAL_PORTAL_ORIGIN}/pay/${workspaceId}/${invoiceId}/${token}`;
  // Reject normalization tricks (dot segments, escapes, whitespace), too.
  if (rawUrl !== url) return { valid: false, reason: "non_canonical_portal_url" };
  return { valid: true, url, maskedUrl: `${CANONICAL_PORTAL_ORIGIN}/pay/${workspaceId}/${invoiceId}/[redacted-token]` };
}

export function projectInvoicePaymentLinkOutput(
  upstream: UpstreamInvoicePaymentLinkResponse,
  expectedInvoiceId: string,
): InvoicePaymentLinkOutput {
  const { paymentUrl, ...data } = upstreamPaymentLinkSchema.parse(upstream);
  if (data.invoiceId !== expectedInvoiceId) {
    throw new Error("Invoice payment link response does not match the requested invoice");
  }
  // No local cache: each read must re-evaluate the current server authority.
  let authorizedPortalUrl: string | null = null;
  if (data.authorityState === "unknown") {
    data.totalAmount = null;
    data.amountPaid = null;
    data.amountDue = null;
    data.payable = false;
    data.unavailableReason ??= "authority_state_unknown";
  } else if (data.status === "draft" || data.status === "paid" || data.status === "cancelled") {
    data.payable = false;
    data.unavailableReason ??= data.status === "draft" ? "invoice_draft"
      : data.status === "paid" ? "already_paid" : "cancelled";
  } else if (data.amountDue === null || data.amountDue <= 0) {
    data.payable = false;
    data.unavailableReason ??= data.amountDue === null ? "authority_state_unknown" : "zero_balance_due";
  } else if (data.paymentState === "processing" || data.paymentState === "unknown"
    || data.paymentState === "paid" || data.paymentState === "cancelled") {
    data.payable = false;
    data.unavailableReason ??= data.paymentState === "processing" ? "payment_processing" : "payment_state_unknown";
  } else if (data.payable && data.unavailableReason === null) {
    // The authenticated API owns tenant isolation; the route returns no
    // workspace ID. Bind the URL to the requested invoice and canonical host.
    const check = validatePortalPayUrl(paymentUrl, undefined, expectedInvoiceId);
    if (check.valid) authorizedPortalUrl = check.url;
    else data.unavailableReason = "invalid_portal_id";
  }
  data.payable = authorizedPortalUrl !== null;
  return InvoicePaymentLinkOutputSchema.parse({ ...data, authorizedPortalUrl });
}

export function redactPaymentLinkForTrace(output: InvoicePaymentLinkOutput): Record<string, unknown> {
  const cloned = redactClone(output) as Record<string, unknown>;
  const check = validatePortalPayUrl(output.authorizedPortalUrl, undefined, output.invoiceId);
  cloned.authorizedPortalUrl = check.valid ? check.maskedUrl : null;
  return cloned;
}

export function enforceGenericInvoiceRedaction<T extends Record<string, unknown>>(record: T): T {
  deepRedact(record, SENSITIVE_FIELD_NAMES);
  return record;
}
