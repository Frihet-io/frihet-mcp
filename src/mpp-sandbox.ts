/**
 * Machine Payments Protocol (MPP) Sell-Side Sandbox Proof (#269 / Frihet-ERP #3127).
 *
 * Implements M0–M4 sandbox eligibility, HTTP 402 challenge/credential/receipt
 * state machine (`challenged` -> `pending` -> `verified` -> `delivered` |
 * `failed_delivery_recovery`), and MCP JSON-RPC transport binding (`-32042` /
 * `-32043`, `_meta['org.paymentauth/credential']`, `_meta['org.paymentauth/receipt']`).
 *
 * Strictly gated behind `FRIHET_MPP_EXPERIMENTAL=true` and `profile_test_*`
 * test profiles. Frozen public connector profiles (`ChatGPT`, `Claude`,
 * `Google`, `Muse`) are strictly isolated and never modified.
 */

import { z } from "zod/v4";
import { READ_ONLY_ANNOTATIONS } from "./tools/shared.js";

export const MPP_PROTOCOL_VERSION = "2026-04-sandbox" as const;
export const MPP_MCP_PAYMENT_REQUIRED_CODE = -32042 as const;
export const MPP_MCP_VERIFICATION_FAILED_CODE = -32043 as const;
export const MPP_META_CREDENTIAL_KEY = "org.paymentauth/credential" as const;
export const MPP_META_RECEIPT_KEY = "org.paymentauth/receipt" as const;
export const MPP_SPT_SUPPORTED_REGIONS = ["US", "CA", "ES", "SE"] as const;
export const MPP_SPT_MIN_AMOUNT_MINOR_USD = 50 as const; // $0.50 USD
export const MPP_USDC_MIN_AMOUNT_MINOR = 1 as const; // $0.01 USDC

export type MppPaymentMethod = "stripe_spt" | "tempo_usdc";
export type MppSandboxState =
  | "challenged"
  | "pending"
  | "verified"
  | "delivered"
  | "failed_delivery_recovery";

export type MppEligibilityReasonCode =
  | "ELIGIBLE"
  | "MPP_EXPERIMENTAL_DISABLED"
  | "MPP_FROZEN_PROFILE_FORBIDDEN"
  | "MPP_TEST_PROFILE_REQUIRED"
  | "MPP_MUTATING_RESOURCE_UNSUPPORTED"
  | "MPP_SPT_UNSUPPORTED_REGION"
  | "MPP_SPT_CURRENCY_MISMATCH"
  | "MPP_SPT_BELOW_MINIMUM"
  | "MPP_STABLECOIN_APPROVAL_REQUIRED"
  | "MPP_STABLECOIN_CURRENCY_MISMATCH"
  | "MPP_STABLECOIN_BELOW_MINIMUM";

export interface MppEligibilityInput {
  readonly env?: Record<string, string | undefined>;
  readonly profileId: string;
  readonly region: string;
  readonly paymentMethod: MppPaymentMethod;
  readonly amountMinor: number;
  readonly currency: string;
  readonly effect: "read" | "write" | "fiscal";
  readonly stablecoinApprovalGranted?: boolean;
  readonly activeConnectorModes?: {
    readonly openaiMode?: boolean;
    readonly claudeMode?: boolean;
    readonly googleMode?: boolean;
    readonly museMode?: boolean;
  };
}

export interface MppEligibilityVerdict {
  readonly eligible: boolean;
  readonly reasonCode: MppEligibilityReasonCode;
  readonly reason: string;
  readonly minimumAmountMinor: number;
  readonly normalizedCurrency: string;
}

/**
 * Deterministic, runtime-neutral FNV-1a 64-bit hex fingerprint for sandbox
 * payment artifacts so raw secrets, SPT tokens, or wallet signatures are never
 * stored or echoed in receipts or logs.
 */
export function fingerprintMppArtifact(
  kind: "challenge" | "credential" | "settlement" | "receipt",
  rawValue: string,
): string {
  let h1 = 0xdeadbeef ^ kind.length;
  let h2 = 0x41c6ce57 ^ rawValue.length;
  const input = `${kind}:${rawValue}`;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const hex2 = (h2 >>> 0).toString(16).padStart(8, "0");
  return `fp_${kind}_${hex1}${hex2}`;
}

/**
 * M0 — Evaluates whether an operation is eligible for the MPP sell-side sandbox.
 */
export function evaluateMppSandboxEligibility(
  input: MppEligibilityInput,
): MppEligibilityVerdict {
  const env = input.env ?? {};
  const normalizedCurrency = input.currency.trim().toUpperCase();
  const normalizedRegion = input.region.trim().toUpperCase();

  if (env.FRIHET_MPP_EXPERIMENTAL !== "true") {
    return {
      eligible: false,
      reasonCode: "MPP_EXPERIMENTAL_DISABLED",
      reason: "FRIHET_MPP_EXPERIMENTAL=true is required to enable the MPP sell-side sandbox.",
      minimumAmountMinor: 0,
      normalizedCurrency,
    };
  }

  const modes = input.activeConnectorModes;
  if (modes?.openaiMode || modes?.claudeMode || modes?.googleMode || modes?.museMode) {
    return {
      eligible: false,
      reasonCode: "MPP_FROZEN_PROFILE_FORBIDDEN",
      reason: "MPP experimental bindings are strictly excluded from frozen public connector profiles (ChatGPT, Claude, Google, Muse).",
      minimumAmountMinor: 0,
      normalizedCurrency,
    };
  }

  if (!input.profileId.startsWith("profile_test_")) {
    return {
      eligible: false,
      reasonCode: "MPP_TEST_PROFILE_REQUIRED",
      reason: "MPP sandbox requires a test profile with the 'profile_test_' prefix.",
      minimumAmountMinor: 0,
      normalizedCurrency,
    };
  }

  if (input.effect !== "read") {
    return {
      eligible: false,
      reasonCode: "MPP_MUTATING_RESOURCE_UNSUPPORTED",
      reason: "Only read-only, non-fiscal resources may participate in the MPP sell-side sandbox.",
      minimumAmountMinor: 0,
      normalizedCurrency,
    };
  }

  if (input.paymentMethod === "stripe_spt") {
    if (!(MPP_SPT_SUPPORTED_REGIONS as readonly string[]).includes(normalizedRegion)) {
      return {
        eligible: false,
        reasonCode: "MPP_SPT_UNSUPPORTED_REGION",
        reason: `Stripe Shared Payment Token (SPT) is only supported in ${MPP_SPT_SUPPORTED_REGIONS.join(", ")} (received '${normalizedRegion}').`,
        minimumAmountMinor: MPP_SPT_MIN_AMOUNT_MINOR_USD,
        normalizedCurrency,
      };
    }
    if (normalizedCurrency !== "USD") {
      return {
        eligible: false,
        reasonCode: "MPP_SPT_CURRENCY_MISMATCH",
        reason: `Stripe SPT sandbox requires USD currency code (received '${normalizedCurrency}').`,
        minimumAmountMinor: MPP_SPT_MIN_AMOUNT_MINOR_USD,
        normalizedCurrency,
      };
    }
    if (!Number.isInteger(input.amountMinor) || input.amountMinor < MPP_SPT_MIN_AMOUNT_MINOR_USD) {
      return {
        eligible: false,
        reasonCode: "MPP_SPT_BELOW_MINIMUM",
        reason: `Stripe SPT requires at least ${MPP_SPT_MIN_AMOUNT_MINOR_USD} minor units ($0.50 USD).`,
        minimumAmountMinor: MPP_SPT_MIN_AMOUNT_MINOR_USD,
        normalizedCurrency,
      };
    }
    return {
      eligible: true,
      reasonCode: "ELIGIBLE",
      reason: "Eligible for Stripe SPT sell-side sandbox.",
      minimumAmountMinor: MPP_SPT_MIN_AMOUNT_MINOR_USD,
      normalizedCurrency,
    };
  }

  // tempo_usdc
  if (input.stablecoinApprovalGranted !== true) {
    return {
      eligible: false,
      reasonCode: "MPP_STABLECOIN_APPROVAL_REQUIRED",
      reason: "Stablecoin (USDC on Tempo) requires explicit Stripe stablecoin approval gate (stablecoinApprovalGranted=true).",
      minimumAmountMinor: MPP_USDC_MIN_AMOUNT_MINOR,
      normalizedCurrency,
    };
  }

  if (normalizedCurrency !== "USDC" && normalizedCurrency !== "USD") {
    return {
      eligible: false,
      reasonCode: "MPP_STABLECOIN_CURRENCY_MISMATCH",
      reason: `Tempo stablecoin sandbox requires USDC/USD currency code (received '${normalizedCurrency}').`,
      minimumAmountMinor: MPP_USDC_MIN_AMOUNT_MINOR,
      normalizedCurrency,
    };
  }

  if (!Number.isInteger(input.amountMinor) || input.amountMinor < MPP_USDC_MIN_AMOUNT_MINOR) {
    return {
      eligible: false,
      reasonCode: "MPP_STABLECOIN_BELOW_MINIMUM",
      reason: `Tempo USDC requires at least ${MPP_USDC_MIN_AMOUNT_MINOR} minor unit ($0.01).`,
      minimumAmountMinor: MPP_USDC_MIN_AMOUNT_MINOR,
      normalizedCurrency,
    };
  }

  return {
    eligible: true,
    reasonCode: "ELIGIBLE",
    reason: "Eligible for Tempo USDC sell-side sandbox.",
    minimumAmountMinor: MPP_USDC_MIN_AMOUNT_MINOR,
    normalizedCurrency,
  };
}

export interface MppSandboxPrincipal {
  readonly authenticatedSubjectId?: string;
  readonly workspaceUid?: string;
  readonly hasReadPermission: boolean;
  readonly bearerTokenPresent: boolean;
}

export interface MppSandboxResource {
  readonly workspaceUid: string;
  readonly resourceId: string;
  readonly realm: string;
  readonly effect: "read" | "write" | "fiscal";
  readonly requestDigest: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly paymentMethod: MppPaymentMethod;
  readonly profileId: string;
  readonly region: string;
  readonly stablecoinApprovalGranted?: boolean;
}

export interface MppSandboxChallenge {
  readonly challengeId: string;
  readonly protocolVersion: typeof MPP_PROTOCOL_VERSION;
  readonly workspaceUid: string;
  readonly resourceId: string;
  readonly realm: string;
  readonly requestDigest: string;
  readonly paymentMethod: MppPaymentMethod;
  readonly amountMinor: number;
  readonly currency: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly challengeFingerprint: string;
}

export interface MppPaymentCredentialInput {
  readonly challengeId: string;
  readonly credentialId: string;
  readonly rawCredentialToken: string;
  readonly settlementReference: string;
  readonly workspaceUid: string;
  readonly resourceId: string;
  readonly requestDigest: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly paymentMethod: MppPaymentMethod;
  readonly reportedFinality: "settled" | "pending" | "declined";
  readonly observedAt: string;
}

export interface MppPaymentReceipt {
  readonly receiptId: string;
  readonly challengeId: string;
  readonly protocolVersion: typeof MPP_PROTOCOL_VERSION;
  readonly sandbox: true;
  readonly paymentMethod: MppPaymentMethod;
  readonly amountMinor: number;
  readonly currency: string;
  readonly resourceId: string;
  readonly requestDigest: string;
  readonly credentialFingerprint: string;
  readonly settlementFingerprint: string;
  readonly settledAt: string;
  readonly accountingDisposition: "unmapped_sandbox";
}

export interface MppSandboxAttemptRecord {
  readonly challenge: MppSandboxChallenge;
  state: MppSandboxState;
  credentialId?: string;
  credentialFingerprint?: string;
  settlementFingerprint?: string;
  receipt?: MppPaymentReceipt;
  cachedDeliveryPayload?: Record<string, unknown>;
  recoveryDisposition: "none" | "refund_or_idempotent_retry_required";
  lastErrorCode?: string;
}

export interface MppHttpSandboxResponse {
  readonly status: 200 | 401 | 402 | 403 | 502;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly mcpErrorCode?: typeof MPP_MCP_PAYMENT_REQUIRED_CODE | typeof MPP_MCP_VERIFICATION_FAILED_CODE;
  readonly mcpMeta?: Record<string, unknown>;
}

/**
 * M1 / M2 / M3 — Stateful sell-side sandbox coordinator enforcing:
 * 1. RBAC 401 -> 403 pre-condition before any 402 Payment Required challenge.
 * 2. Challenge binding (`WWW-Authenticate: Payment` + `Cache-Control: no-store`).
 * 3. Coexistence of `Authorization: Bearer` and `Payment-Authorization: Payment`.
 * 4. Anti-substitution & anti-replay guards across workspace, resource, digest, and amount.
 * 5. State machine: `challenged` -> `pending` -> `verified` -> `delivered` | `failed_delivery_recovery`.
 * 6. Sanitized `Payment-Receipt` (`Cache-Control: private`) and MCP `_meta['org.paymentauth/receipt']`.
 */
export class MppSandboxCoordinator {
  private readonly attemptsByChallengeId = new Map<string, MppSandboxAttemptRecord>();
  private readonly challengeIdByCredentialId = new Map<string, string>();
  private readonly env: Record<string, string | undefined>;
  private readonly activeConnectorModes?: MppEligibilityInput["activeConnectorModes"];

  constructor(options: {
    readonly env?: Record<string, string | undefined>;
    readonly activeConnectorModes?: MppEligibilityInput["activeConnectorModes"];
  } = {}) {
    this.env = options.env ?? {};
    this.activeConnectorModes = options.activeConnectorModes;
  }

  getAttempt(challengeId: string): MppSandboxAttemptRecord | undefined {
    return this.attemptsByChallengeId.get(challengeId);
  }

  async handleRequest(params: {
    readonly principal: MppSandboxPrincipal;
    readonly targetResource: MppSandboxResource;
    readonly credential?: MppPaymentCredentialInput;
    readonly nowIso?: string;
    readonly executeReadResource: () => Promise<Record<string, unknown>>;
  }): Promise<MppHttpSandboxResponse> {
    const nowIso = params.nowIso ?? "2026-11-02T00:00:00.000Z";
    const { principal, targetResource, credential } = params;
    const resource = targetResource;

    // 1. Strict 401 authentication pre-condition (before any 402 challenge)
    if (
      !principal.bearerTokenPresent ||
      !principal.authenticatedSubjectId?.trim() ||
      !principal.workspaceUid?.trim()
    ) {
      return {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Bearer realm="frihet-api", error="invalid_token"',
          "Cache-Control": "no-store",
        },
        body: {
          error: "AUTHENTICATION_REQUIRED",
          message: "Valid Bearer authentication is required before evaluating MPP resource access.",
        },
      };
    }

    // 2. Strict 403 tenant/RBAC authorization pre-condition (before any 402 challenge)
    if (
      principal.workspaceUid !== resource.workspaceUid ||
      !principal.hasReadPermission
    ) {
      return {
        status: 403,
        headers: {
          "Cache-Control": "no-store",
        },
        body: {
          error: "ACCESS_DENIED",
          message: "Caller does not have read permission for the target workspace resource.",
        },
      };
    }

    // 3. M0 Sandbox Eligibility check
    const eligibility = evaluateMppSandboxEligibility({
      env: this.env,
      profileId: resource.profileId,
      region: resource.region,
      paymentMethod: resource.paymentMethod,
      amountMinor: resource.amountMinor,
      currency: resource.currency,
      effect: resource.effect,
      stablecoinApprovalGranted: resource.stablecoinApprovalGranted,
      activeConnectorModes: this.activeConnectorModes,
    });

    if (!eligibility.eligible) {
      return {
        status: 403,
        headers: {
          "Cache-Control": "no-store",
        },
        body: {
          error: eligibility.reasonCode,
          message: eligibility.reason,
        },
      };
    }

    // 4. Issue HTTP 402 / MCP -32042 Challenge when no payment credential is provided
    if (!credential) {
      const challengeMaterial = `${resource.workspaceUid}:${resource.resourceId}:${resource.requestDigest}:${resource.amountMinor}:${eligibility.normalizedCurrency}:${resource.paymentMethod}:${nowIso}`;
      const challengeFingerprint = fingerprintMppArtifact("challenge", challengeMaterial);
      const challengeId = `chk_${challengeFingerprint.slice(13, 29)}`;
      const expiresAt = new Date(Date.parse(nowIso) + 5 * 60 * 1000).toISOString();

      const challenge: MppSandboxChallenge = {
        challengeId,
        protocolVersion: MPP_PROTOCOL_VERSION,
        workspaceUid: resource.workspaceUid,
        resourceId: resource.resourceId,
        realm: resource.realm,
        requestDigest: resource.requestDigest,
        paymentMethod: resource.paymentMethod,
        amountMinor: resource.amountMinor,
        currency: eligibility.normalizedCurrency,
        issuedAt: nowIso,
        expiresAt,
        challengeFingerprint,
      };

      this.attemptsByChallengeId.set(challengeId, {
        challenge,
        state: "challenged",
        recoveryDisposition: "none",
      });

      const wwwAuth =
        `Payment realm="${resource.realm}", ` +
        `challenge_id="${challengeId}", ` +
        `method="${resource.paymentMethod}", ` +
        `amount_minor="${resource.amountMinor}", ` +
        `currency="${eligibility.normalizedCurrency}", ` +
        `expires_at="${expiresAt}"`;

      return {
        status: 402,
        headers: {
          "WWW-Authenticate": wwwAuth,
          "Cache-Control": "no-store",
        },
        body: {
          error: "PAYMENT_REQUIRED",
          challenge: {
            challengeId: challenge.challengeId,
            protocolVersion: challenge.protocolVersion,
            realm: challenge.realm,
            resourceId: challenge.resourceId,
            requestDigest: challenge.requestDigest,
            paymentMethod: challenge.paymentMethod,
            amountMinor: challenge.amountMinor,
            currency: challenge.currency,
            expiresAt: challenge.expiresAt,
          },
        },
        mcpErrorCode: MPP_MCP_PAYMENT_REQUIRED_CODE,
        mcpMeta: {
          [MPP_META_CREDENTIAL_KEY]: {
            challengeId: challenge.challengeId,
            realm: challenge.realm,
            paymentMethod: challenge.paymentMethod,
            amountMinor: challenge.amountMinor,
            currency: challenge.currency,
            expiresAt: challenge.expiresAt,
          },
        },
      };
    }

    // 5. Validate Credential against bound Challenge
    const attempt = this.attemptsByChallengeId.get(credential.challengeId);
    if (!attempt) {
      return {
        status: 402,
        headers: {
          "WWW-Authenticate": `Payment realm="${resource.realm}", error="challenge_not_found"`,
          "Cache-Control": "no-store",
        },
        body: {
          error: "CHALLENGE_NOT_FOUND",
          message: "Payment credential references an unknown challengeId.",
        },
        mcpErrorCode: MPP_MCP_VERIFICATION_FAILED_CODE,
      };
    }

    if (Date.parse(nowIso) > Date.parse(attempt.challenge.expiresAt)) {
      return {
        status: 402,
        headers: {
          "WWW-Authenticate": `Payment realm="${resource.realm}", error="challenge_expired"`,
          "Cache-Control": "no-store",
        },
        body: {
          error: "CHALLENGE_EXPIRED",
          message: "Payment challenge has expired.",
        },
        mcpErrorCode: MPP_MCP_VERIFICATION_FAILED_CODE,
      };
    }

    // Anti-substitution check: credential & request must match bound challenge
    const bound = attempt.challenge;
    if (
      credential.workspaceUid !== bound.workspaceUid ||
      credential.resourceId !== bound.resourceId ||
      credential.requestDigest !== bound.requestDigest ||
      credential.amountMinor !== bound.amountMinor ||
      credential.currency.trim().toUpperCase() !== bound.currency ||
      credential.paymentMethod !== bound.paymentMethod ||
      resource.workspaceUid !== bound.workspaceUid ||
      resource.resourceId !== bound.resourceId ||
      resource.requestDigest !== bound.requestDigest ||
      resource.amountMinor !== bound.amountMinor ||
      eligibility.normalizedCurrency !== bound.currency
    ) {
      return {
        status: 402,
        headers: {
          "WWW-Authenticate": `Payment realm="${resource.realm}", error="challenge_substitution_rejected"`,
          "Cache-Control": "no-store",
        },
        body: {
          error: "CHALLENGE_SUBSTITUTION_REJECTED",
          message: "Payment credential does not match the bound challenge workspace, resource, digest, currency, or amount.",
        },
        mcpErrorCode: MPP_MCP_VERIFICATION_FAILED_CODE,
      };
    }

    // Anti-replay check across distinct challenges
    const existingChallengeForCredential = this.challengeIdByCredentialId.get(credential.credentialId);
    if (
      existingChallengeForCredential !== undefined &&
      existingChallengeForCredential !== credential.challengeId
    ) {
      return {
        status: 402,
        headers: {
          "WWW-Authenticate": `Payment realm="${resource.realm}", error="credential_replayed"`,
          "Cache-Control": "no-store",
        },
        body: {
          error: "CREDENTIAL_REPLAY_REJECTED",
          message: "Payment credentialId was already bound to a different challengeId.",
        },
        mcpErrorCode: MPP_MCP_VERIFICATION_FAILED_CODE,
      };
    }

    // Idempotent replay of an already-delivered attempt with the same credentialId
    if (
      attempt.state === "delivered" &&
      attempt.credentialId === credential.credentialId &&
      attempt.receipt &&
      attempt.cachedDeliveryPayload
    ) {
      return {
        status: 200,
        headers: {
          "Payment-Receipt": attempt.receipt.receiptId,
          "Cache-Control": "private",
        },
        body: {
          data: attempt.cachedDeliveryPayload,
          receipt: attempt.receipt,
          replayedIdempotent: true,
        },
        mcpMeta: {
          [MPP_META_RECEIPT_KEY]: attempt.receipt,
        },
      };
    }

    if (
      attempt.credentialId !== undefined &&
      attempt.credentialId !== credential.credentialId
    ) {
      return {
        status: 402,
        headers: {
          "WWW-Authenticate": `Payment realm="${resource.realm}", error="credential_mismatch"`,
          "Cache-Control": "no-store",
        },
        body: {
          error: "CREDENTIAL_MISMATCH",
          message: "Challenge is already bound to a different credentialId.",
        },
        mcpErrorCode: MPP_MCP_VERIFICATION_FAILED_CODE,
      };
    }

    // Bind credential fingerprints (never persisting raw token/secret)
    const credentialFingerprint = fingerprintMppArtifact(
      "credential",
      `${credential.credentialId}:${credential.rawCredentialToken}`,
    );
    const settlementFingerprint = fingerprintMppArtifact(
      "settlement",
      credential.settlementReference,
    );
    this.challengeIdByCredentialId.set(credential.credentialId, credential.challengeId);
    attempt.credentialId = credential.credentialId;
    attempt.credentialFingerprint = credentialFingerprint;
    attempt.settlementFingerprint = settlementFingerprint;

    // 6. Settlement finality check
    if (credential.reportedFinality === "pending") {
      attempt.state = "pending";
      return {
        status: 402,
        headers: {
          "WWW-Authenticate": `Payment realm="${resource.realm}", challenge_id="${bound.challengeId}", error="settlement_pending"`,
          "Cache-Control": "no-store",
        },
        body: {
          error: "PAYMENT_SETTLEMENT_PENDING",
          state: "pending",
          message: "Payment authorization observed, but settlement is still pending. Resource delivery is withheld until settled.",
        },
        mcpErrorCode: MPP_MCP_VERIFICATION_FAILED_CODE,
      };
    }

    if (credential.reportedFinality === "declined") {
      attempt.state = "challenged";
      return {
        status: 402,
        headers: {
          "WWW-Authenticate": `Payment realm="${resource.realm}", challenge_id="${bound.challengeId}", error="payment_declined"`,
          "Cache-Control": "no-store",
        },
        body: {
          error: "PAYMENT_VERIFICATION_FAILED",
          state: "challenged",
          message: "Payment credential settlement was declined.",
        },
        mcpErrorCode: MPP_MCP_VERIFICATION_FAILED_CODE,
      };
    }

    // Transition to `verified`
    attempt.state = "verified";

    // 7. Execute read-only resource and handle post-settlement failure recovery
    try {
      const payload = await params.executeReadResource();
      const receiptHash = fingerprintMppArtifact(
        "receipt",
        `${bound.challengeId}:${credentialFingerprint}:${settlementFingerprint}:${bound.requestDigest}`,
      );
      const receipt: MppPaymentReceipt = {
        receiptId: `rcpt_${receiptHash.slice(11, 27)}`,
        challengeId: bound.challengeId,
        protocolVersion: MPP_PROTOCOL_VERSION,
        sandbox: true,
        paymentMethod: bound.paymentMethod,
        amountMinor: bound.amountMinor,
        currency: bound.currency,
        resourceId: bound.resourceId,
        requestDigest: bound.requestDigest,
        credentialFingerprint,
        settlementFingerprint,
        settledAt: credential.observedAt,
        accountingDisposition: "unmapped_sandbox",
      };

      attempt.state = "delivered";
      attempt.receipt = receipt;
      attempt.cachedDeliveryPayload = payload;
      attempt.recoveryDisposition = "none";
      attempt.lastErrorCode = undefined;

      return {
        status: 200,
        headers: {
          "Payment-Receipt": receipt.receiptId,
          "Cache-Control": "private",
        },
        body: {
          data: payload,
          receipt,
        },
        mcpMeta: {
          [MPP_META_RECEIPT_KEY]: receipt,
        },
      };
    } catch (err) {
      attempt.state = "failed_delivery_recovery";
      attempt.recoveryDisposition = "refund_or_idempotent_retry_required";
      attempt.lastErrorCode = err instanceof Error ? err.message : "RESOURCE_EXECUTION_FAILED";

      return {
        status: 502,
        headers: {
          "Cache-Control": "no-store",
        },
        body: {
          error: "DELIVERY_FAILED_AFTER_VERIFICATION",
          state: "failed_delivery_recovery",
          challengeId: bound.challengeId,
          receiptIssued: false,
          recoveryDisposition: attempt.recoveryDisposition,
          accountingDisposition: "unmapped_sandbox",
          message:
            "Payment was verified in sandbox, but downstream read resource execution failed. No receipt was issued; retry with the same credentialId and challengeId to recover without re-charging.",
        },
      };
    }
  }
}

/**
 * M2 — Optional experimental MCP tool registration for local/sandbox verification.
 * Strictly no-ops unless `env.FRIHET_MPP_EXPERIMENTAL === "true"` and no frozen
 * connector profile (`openaiMode`, `claudeMode`, `googleMode`, `museMode`) is active.
 */
export function attachExperimentalMppSandboxTool(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server: any,
  options: {
    readonly env?: Record<string, string | undefined>;
    readonly openaiMode?: boolean;
    readonly claudeMode?: boolean;
    readonly googleMode?: boolean;
    readonly museMode?: boolean;
  } = {},
): MppSandboxCoordinator | undefined {
  const env = options.env ?? {};
  if (env.FRIHET_MPP_EXPERIMENTAL !== "true") {
    return undefined;
  }
  if (options.openaiMode || options.claudeMode || options.googleMode || options.museMode) {
    return undefined;
  }

  const coordinator = new MppSandboxCoordinator({
    env,
    activeConnectorModes: {
      openaiMode: options.openaiMode,
      claudeMode: options.claudeMode,
      googleMode: options.googleMode,
      museMode: options.museMode,
    },
  });

  server.registerTool(
    "mpp_sandbox_verify_read",
    {
      title: "MPP Sandbox Read Verification (Experimental)",
      description:
        "Experimental sandbox-only read tool verifying Machine Payments Protocol (MPP) M0–M4 challenge, credential, and receipt semantics. Never enabled on public connector profiles.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        profileId: z.string().describe("Test profile ID (must start with profile_test_)"),
        workspaceUid: z.string().describe("Target sandbox workspace UID"),
        resourceId: z.string().describe("Read-only resource identifier"),
        requestDigest: z.string().describe("Deterministic digest of the read request"),
        region: z.string().describe("Merchant ISO country code (US, CA, ES, SE for SPT)"),
        paymentMethod: z.enum(["stripe_spt", "tempo_usdc"]).describe("Sandbox payment method"),
        amountMinor: z.number().int().positive().describe("Amount in minor units"),
        currency: z.string().describe("Currency code (USD or USDC)"),
        stablecoinApprovalGranted: z.boolean().optional().describe("Whether Stripe stablecoin approval gate is granted"),
        credential: z
          .object({
            challengeId: z.string(),
            credentialId: z.string(),
            rawCredentialToken: z.string(),
            settlementReference: z.string(),
            reportedFinality: z.enum(["settled", "pending", "declined"]),
            observedAt: z.string(),
          })
          .optional()
          .describe("Optional MPP payment credential (_meta['org.paymentauth/credential'])"),
      },
    },
    async (args: {
      profileId: string;
      workspaceUid: string;
      resourceId: string;
      requestDigest: string;
      region: string;
      paymentMethod: MppPaymentMethod;
      amountMinor: number;
      currency: string;
      stablecoinApprovalGranted?: boolean;
      credential?: {
        challengeId: string;
        credentialId: string;
        rawCredentialToken: string;
        settlementReference: string;
        reportedFinality: "settled" | "pending" | "declined";
        observedAt: string;
      };
    }) => {
      const response = await coordinator.handleRequest({
        principal: {
          authenticatedSubjectId: "sandbox_subject_test",
          workspaceUid: args.workspaceUid,
          hasReadPermission: true,
          bearerTokenPresent: true,
        },
        targetResource: {
          workspaceUid: args.workspaceUid,
          resourceId: args.resourceId,
          realm: "mcp.frihet.io/sandbox",
          effect: "read",
          requestDigest: args.requestDigest,
          amountMinor: args.amountMinor,
          currency: args.currency,
          paymentMethod: args.paymentMethod,
          profileId: args.profileId,
          region: args.region,
          stablecoinApprovalGranted: args.stablecoinApprovalGranted,
        },
        credential: args.credential
          ? {
              ...args.credential,
              workspaceUid: args.workspaceUid,
              resourceId: args.resourceId,
              requestDigest: args.requestDigest,
              amountMinor: args.amountMinor,
              currency: args.currency,
              paymentMethod: args.paymentMethod,
            }
          : undefined,
        executeReadResource: async () => ({
          resourceId: args.resourceId,
          workspaceUid: args.workspaceUid,
          sandboxRead: true,
          summary: "Sandbox read-only resource delivered under verified MPP receipt.",
        }),
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response.body, null, 2) }],
        structuredContent: response.body,
        isError: response.status !== 200,
        ...(response.mcpMeta ? { _meta: response.mcpMeta } : {}),
      };
    },
  );

  return coordinator;
}
