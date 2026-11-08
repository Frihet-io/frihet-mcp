/**
 * Dedicated Invoice Portal Payment Link adapter & MCP tool (#3161).
 *
 * Implements the MCP/SDK contract for `berthelius/Frihet-ERP#3161`:
 *   "Dame el enlace para cobrar esta factura y dime qué queda pendiente"
 *
 * Architectural & Security Invariants:
 *   1. Single Authority: consumes server-computed Payment Authority V1 / portal
 *      state (`computePortalUrlV1` / `generatePortalToken`). Never computes
 *      balances by summing legacy client fields, and never coerces an unknown
 *      or degraded balance (`null`) to `0`.
 *   2. Narrow Redaction Exception: generic invoice tools (`get_invoice`,
 *      `list_invoices`, `search_invoices`, `send_invoice`) and observability
 *      traces continue to strip `paymentUrl` / `paymentLink` via `src/redaction.ts`.
 *      Only `get_invoice_payment_link` projects `authorizedPortalUrl` in its
 *      dedicated `outputSchema`, and only after passing `validatePortalPayUrl()`.
 *   3. No Implicit Side Effects: retrieving a portal link never sends an email,
 *      never issues a draft invoice, never creates a Stripe PaymentIntent or
 *      Checkout Session reservation, never initiates a charge, and never marks
 *      an invoice paid or reconciled.
 *   4. Honest Token Lifetime Disclosure: Frihet HMAC `invoice:v1` portal tokens
 *      are stateless HMAC capability links whose collectibility and remaining
 *      balance are revalidated server-side on every open and payment attempt.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { deepRedact, redactClone, SENSITIVE_FIELD_NAMES } from "./redaction.js";
import { READ_ONLY_ANNOTATIONS, withToolLogging } from "./tools/shared.js";

export const CANONICAL_PORTAL_ORIGIN = "https://app.frihet.io";
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_HMAC_TOKEN_RE = /^[A-Za-z0-9._-]{16,256}$/;
const ISO_CURRENCY_RE = /^[A-Z]{3}$/;

export const INVOICE_PORTAL_STATUSES = [
  "issued",
  "sent",
  "overdue",
  "partially_paid",
  "draft",
  "paid",
  "cancelled",
  "unknown",
] as const;
export type InvoicePortalStatus = (typeof INVOICE_PORTAL_STATUSES)[number];

export const PORTAL_UNAVAILABLE_REASONS = [
  "draft_invoice",
  "already_paid",
  "cancelled_invoice",
  "unknown_balance",
  "connect_not_ready",
  "unsupported_currency",
  "portal_disabled",
  "permission_denied",
  "tenant_mismatch",
  "invalid_portal_url",
  "not_collectible",
] as const;
export type PortalUnavailableReason = (typeof PORTAL_UNAVAILABLE_REASONS)[number];

export const BALANCE_PROVENANCE_VALUES = [
  "payment_authority_v1",
  "server_computed",
  "unknown_degraded",
] as const;
export type BalanceProvenance = (typeof BALANCE_PROVENANCE_VALUES)[number];

export interface UpstreamInvoicePaymentLinkResponse {
  invoiceId: string;
  workspaceId: string;
  documentNumber?: string | null;
  status: InvoicePortalStatus;
  collectible: boolean;
  unavailableReason?: PortalUnavailableReason | null;
  currency: string;
  amountRemainingMinor: number | null;
  totalAmountMinor?: number | null;
  paidAmountMinor?: number | null;
  balanceProvenance: BalanceProvenance;
  asOf?: string;
  portalUrl?: string | null;
  paymentUrl?: string | null;
}

export interface InvoicePaymentLinkTransport {
  requestInvoicePaymentLink(
    invoiceId: string,
    options?: { idempotencyKey?: string },
  ): Promise<UpstreamInvoicePaymentLinkResponse>;
}

export const invoicePaymentLinkOutputShape = {
  invoiceId: z.string().describe("Invoice record ID / ID de la factura"),
  workspaceId: z.string().describe("Authenticated workspace ID / ID del workspace"),
  status: z.enum(INVOICE_PORTAL_STATUSES).describe("Server-reported invoice lifecycle status / Estado de la factura"),
  collectible: z.boolean().describe("Whether the invoice can currently be paid through the portal / Si la factura es cobrable actualmente en el portal"),
  unavailableReason: z
    .enum(PORTAL_UNAVAILABLE_REASONS)
    .nullable()
    .describe("Reason why the payment link is unavailable when collectible=false / Motivo de no disponibilidad"),
  currency: z.string().describe("ISO 4217 3-letter currency code / Código de divisa ISO 4217"),
  amountRemainingMinor: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("Server-computed remaining unpaid balance in minor units, or null when unknown (never coerced to 0) / Saldo pendiente en unidades menores o null si es desconocido"),
  amountRemainingFormatted: z
    .string()
    .nullable()
    .describe("Human-readable remaining balance with currency, or null when unknown / Saldo pendiente formateado"),
  balanceProvenance: z
    .enum(BALANCE_PROVENANCE_VALUES)
    .describe("Server authority source for the remaining balance / Procedencia del saldo en el servidor"),
  asOf: z.string().describe("ISO-8601 timestamp of the server evaluation / Marca temporal ISO-8601"),
  authorizedPortalUrl: z
    .string()
    .nullable()
    .describe("Signed Frihet invoice portal URL (/pay/{workspace}/{invoice}/{token}) when collectible=true; null otherwise / URL firmada del portal de pago"),
  tokenLifetimePolicy: z
    .literal("hmac_v1_stateless_revalidated_on_open")
    .describe("Real token lifetime semantics: HMAC invoice:v1 link revalidated against live server collectibility and balance on open and payment / Semántica real de vigencia del enlace"),
  sideEffects: z
    .object({
      emailSent: z.literal(false),
      paymentInitiated: z.literal(false),
      ledgerMutated: z.literal(false),
      checkoutSessionCreated: z.literal(false),
    })
    .strict()
    .describe("Explicit guarantee that retrieving a payment link performs no email, charge, or accounting mutation / Garantía explícita de cero efectos colaterales"),
};

export const InvoicePaymentLinkOutputSchema = z.object(invoicePaymentLinkOutputShape).strict();
export type InvoicePaymentLinkOutput = z.infer<typeof InvoicePaymentLinkOutputSchema>;

export function assertSafePathSegment(value: string, label: string): string {
  if (typeof value !== "string" || !SAFE_PATH_SEGMENT_RE.test(value)) {
    throw new Error(`Invalid ${label}: must be a safe non-empty path identifier without traversal segments`);
  }
  return value;
}

/**
 * Validates that a candidate URL is strictly a canonical Frihet invoice portal
 * URL (`https://app.frihet.io/pay/{workspaceId}/{invoiceId}/{token}`) bound to
 * the exact `expectedWorkspaceId` and `expectedInvoiceId`, with no query
 * parameters, fragments, credentials, or alternate origins.
 */
export function validatePortalPayUrl(
  rawUrl: unknown,
  expectedWorkspaceId: string,
  expectedInvoiceId: string,
): { valid: true; url: string; maskedUrl: string } | { valid: false; reason: string } {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return { valid: false, reason: "empty_or_non_string_url" };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: "malformed_url" };
  }
  if (parsed.protocol !== "https:") {
    return { valid: false, reason: "non_https_protocol" };
  }
  if (parsed.origin !== CANONICAL_PORTAL_ORIGIN) {
    return { valid: false, reason: "unapproved_origin" };
  }
  if (parsed.username || parsed.password) {
    return { valid: false, reason: "embedded_credentials_forbidden" };
  }
  if (parsed.search || parsed.hash) {
    return { valid: false, reason: "query_or_fragment_forbidden" };
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[0] !== "pay") {
    return { valid: false, reason: "invalid_portal_path_shape" };
  }
  const [, workspaceSegment, invoiceSegment, tokenSegment] = segments;
  if (
    !SAFE_PATH_SEGMENT_RE.test(workspaceSegment) ||
    !SAFE_PATH_SEGMENT_RE.test(invoiceSegment) ||
    !SAFE_HMAC_TOKEN_RE.test(tokenSegment)
  ) {
    return { valid: false, reason: "invalid_portal_segment_encoding" };
  }
  if (workspaceSegment !== expectedWorkspaceId) {
    return { valid: false, reason: "workspace_segment_mismatch" };
  }
  if (invoiceSegment !== expectedInvoiceId) {
    return { valid: false, reason: "invoice_segment_mismatch" };
  }
  const canonicalUrl = `${CANONICAL_PORTAL_ORIGIN}/pay/${workspaceSegment}/${invoiceSegment}/${tokenSegment}`;
  const maskedUrl = `${CANONICAL_PORTAL_ORIGIN}/pay/${workspaceSegment}/${invoiceSegment}/[redacted-token]`;
  return { valid: true, url: canonicalUrl, maskedUrl };
}

function formatMinorAmount(amountMinor: number | null, currency: string): string | null {
  if (amountMinor === null || !Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    return null;
  }
  const major = (amountMinor / 100).toFixed(2);
  return `${major} ${currency}`;
}

/**
 * Evaluates and normalizes the upstream server response into the fail-closed
 * `InvoicePaymentLinkOutput` contract.
 */
export function projectInvoicePaymentLinkOutput(
  upstream: UpstreamInvoicePaymentLinkResponse,
  expectedWorkspaceId?: string,
): InvoicePaymentLinkOutput {
  const invoiceId = assertSafePathSegment(upstream.invoiceId, "invoiceId");
  const workspaceId = assertSafePathSegment(upstream.workspaceId, "workspaceId");

  const currency = typeof upstream.currency === "string" ? upstream.currency.trim().toUpperCase() : "";
  if (!ISO_CURRENCY_RE.test(currency)) {
    throw new Error("Upstream invoice payment link response returned an invalid ISO currency code");
  }

  const asOf =
    typeof upstream.asOf === "string" && !Number.isNaN(Date.parse(upstream.asOf))
      ? upstream.asOf
      : new Date().toISOString();

  // Tenant isolation check when caller supplies expectedWorkspaceId
  if (expectedWorkspaceId && workspaceId !== expectedWorkspaceId) {
    return {
      invoiceId,
      workspaceId: expectedWorkspaceId,
      status: "unknown",
      collectible: false,
      unavailableReason: "tenant_mismatch",
      currency,
      amountRemainingMinor: null,
      amountRemainingFormatted: null,
      balanceProvenance: "unknown_degraded",
      asOf,
      authorizedPortalUrl: null,
      tokenLifetimePolicy: "hmac_v1_stateless_revalidated_on_open",
      sideEffects: {
        emailSent: false,
        paymentInitiated: false,
        ledgerMutated: false,
        checkoutSessionCreated: false,
      },
    };
  }

  // Never coerce unknown/degraded balances to zero
  const rawMinor = upstream.amountRemainingMinor;
  const hasKnownValidBalance =
    upstream.balanceProvenance !== "unknown_degraded" &&
    typeof rawMinor === "number" &&
    Number.isSafeInteger(rawMinor) &&
    rawMinor >= 0;

  const amountRemainingMinor: number | null = hasKnownValidBalance ? rawMinor : null;

  // Determine collectibility fail-closed
  let collectible = Boolean(upstream.collectible);
  let unavailableReason: PortalUnavailableReason | null = upstream.unavailableReason ?? null;

  if (upstream.status === "draft") {
    collectible = false;
    unavailableReason = unavailableReason ?? "draft_invoice";
  } else if (upstream.status === "paid") {
    collectible = false;
    unavailableReason = unavailableReason ?? "already_paid";
  } else if (upstream.status === "cancelled") {
    collectible = false;
    unavailableReason = unavailableReason ?? "cancelled_invoice";
  } else if (upstream.status === "unknown" || !hasKnownValidBalance || amountRemainingMinor === null) {
    collectible = false;
    unavailableReason = unavailableReason ?? "unknown_balance";
  } else if (amountRemainingMinor <= 0) {
    collectible = false;
    unavailableReason = unavailableReason ?? "already_paid";
  }

  let authorizedPortalUrl: string | null = null;
  if (collectible) {
    const candidateUrl = upstream.portalUrl ?? upstream.paymentUrl;
    const validation = validatePortalPayUrl(candidateUrl, workspaceId, invoiceId);
    if (!validation.valid) {
      collectible = false;
      unavailableReason = "invalid_portal_url";
      authorizedPortalUrl = null;
    } else {
      authorizedPortalUrl = validation.url;
      unavailableReason = null;
    }
  } else if (!unavailableReason) {
    unavailableReason = "not_collectible";
  }

  return InvoicePaymentLinkOutputSchema.parse({
    invoiceId,
    workspaceId,
    status: upstream.status,
    collectible,
    unavailableReason,
    currency,
    amountRemainingMinor,
    amountRemainingFormatted: formatMinorAmount(amountRemainingMinor, currency),
    balanceProvenance: hasKnownValidBalance ? upstream.balanceProvenance : "unknown_degraded",
    asOf,
    authorizedPortalUrl,
    tokenLifetimePolicy: "hmac_v1_stateless_revalidated_on_open",
    sideEffects: {
      emailSent: false,
      paymentInitiated: false,
      ledgerMutated: false,
      checkoutSessionCreated: false,
    },
  });
}

/**
 * Redacts a projected `InvoicePaymentLinkOutput` for logs/traces so capability
 * URLs never leak into Langfuse or generic stderr logs.
 */
export function redactPaymentLinkForTrace(output: InvoicePaymentLinkOutput): Record<string, unknown> {
  const cloned = redactClone(output, [...SENSITIVE_FIELD_NAMES]) as Record<string, unknown>;
  if (typeof cloned.authorizedPortalUrl === "string") {
    const check = validatePortalPayUrl(cloned.authorizedPortalUrl, output.workspaceId, output.invoiceId);
    cloned.authorizedPortalUrl = check.valid ? check.maskedUrl : "[redacted]";
  }
  return cloned;
}

/**
 * Verifies that generic invoice payloads continue to have `paymentUrl` and
 * `paymentLink` stripped in-place by `deepRedact`.
 */
export function enforceGenericInvoiceRedaction<T extends Record<string, unknown>>(record: T): T {
  deepRedact(record, SENSITIVE_FIELD_NAMES);
  return record;
}

/**
 * In-memory idempotency coordinator for `get_invoice_payment_link` retries.
 * Ensures that retrying with the same `(idempotencyKey, invoiceId)` converges
 * on the same response, while reusing the same `idempotencyKey` for a DIFFERENT
 * `invoiceId` fails closed with `IDEMPOTENCY_KEY_CONFLICT`.
 */
export class PaymentLinkIdempotencyCoordinator {
  private readonly records = new Map<
    string,
    { invoiceId: string; promise: Promise<InvoicePaymentLinkOutput> }
  >();

  async execute(
    invoiceId: string,
    idempotencyKey: string | undefined,
    runner: () => Promise<InvoicePaymentLinkOutput>,
  ): Promise<InvoicePaymentLinkOutput> {
    const safeInvoiceId = assertSafePathSegment(invoiceId, "invoiceId");
    if (!idempotencyKey) {
      return runner();
    }
    const trimmedKey = idempotencyKey.trim();
    if (!trimmedKey || trimmedKey.length > 128) {
      throw new Error("Invalid idempotencyKey: must be 1..128 characters");
    }
    const existing = this.records.get(trimmedKey);
    if (existing) {
      if (existing.invoiceId !== safeInvoiceId) {
        const conflict = new Error(
          `IDEMPOTENCY_KEY_CONFLICT: idempotencyKey "${trimmedKey}" was already used for a different invoice`,
        );
        (conflict as Error & { code?: string; statusCode?: number }).code = "IDEMPOTENCY_KEY_CONFLICT";
        (conflict as Error & { code?: string; statusCode?: number }).statusCode = 409;
        throw conflict;
      }
      return existing.promise;
    }
    const promise = runner().catch((err) => {
      this.records.delete(trimmedKey);
      throw err;
    });
    this.records.set(trimmedKey, { invoiceId: safeInvoiceId, promise });
    return promise;
  }
}

export function registerInvoicePaymentLinkTool(
  server: McpServer,
  transport: InvoicePaymentLinkTransport,
  options?: { expectedWorkspaceId?: string },
): void {
  const coordinator = new PaymentLinkIdempotencyCoordinator();

  server.registerTool(
    "get_invoice_payment_link",
    {
      title: "Get Invoice Payment Link",
      description:
        "Retrieve the signed Frihet payment portal link (/pay/{workspace}/{invoice}/{token}) and server-authoritative remaining balance for an issued collectible invoice. " +
        "Does NOT send an email, issue a draft, initiate a charge, create a Checkout Session reservation, or mark the invoice paid. " +
        "/ Obtiene el enlace firmado al portal de cobro y el saldo pendiente calculado por el servidor para una factura emitida cobrable. " +
        "NO envía correos, no emite borradores, no inicia cargos ni marca la factura como pagada.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        id: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .describe("The invoice ID / ID de la factura"),
        idempotencyKey: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .optional()
          .describe("Optional idempotency key for safe retries / Clave de idempotencia opcional"),
      },
      outputSchema: invoicePaymentLinkOutputShape,
    },
    async ({ id, idempotencyKey }) =>
      withToolLogging("get_invoice_payment_link", async () => {
        const safeId = assertSafePathSegment(id, "id");
        const output = await coordinator.execute(safeId, idempotencyKey, async () => {
          const upstream = await transport.requestInvoicePaymentLink(safeId, {
            ...(idempotencyKey ? { idempotencyKey } : {}),
          });
          return projectInvoicePaymentLinkOutput(upstream, options?.expectedWorkspaceId);
        });

        const summaryLines = [
          `Invoice: ${output.invoiceId} (workspace: ${output.workspaceId})`,
          `Status: ${output.status} | Collectible: ${output.collectible ? "yes" : "no"}${output.unavailableReason ? ` (${output.unavailableReason})` : ""}`,
          `Remaining balance: ${output.amountRemainingFormatted ?? "unknown (degraded authority — not coerced to 0)"} [source: ${output.balanceProvenance}]`,
          `Portal URL: ${output.authorizedPortalUrl ?? "unavailable"}`,
          `Token policy: ${output.tokenLifetimePolicy}`,
          `Side effects: emailSent=false, paymentInitiated=false, ledgerMutated=false, checkoutSessionCreated=false`,
        ];

        return {
          content: [{ type: "text" as const, text: summaryLines.join("\n") }],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      }),
  );
}
