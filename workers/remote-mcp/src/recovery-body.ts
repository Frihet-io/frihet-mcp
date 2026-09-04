function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const OAUTH_RECOVERY_STATES = [
  "IDEMPOTENT_REPLAY_REQUIRES_REVOKE_AND_REISSUE",
  "IDEMPOTENT_TUPLE_REVOKED_USE_NEW_CORRELATION",
  "IDEMPOTENT_TUPLE_EXPIRED_USE_NEW_CORRELATION",
] as const;

export type OAuthRecoveryState = (typeof OAUTH_RECOVERY_STATES)[number];

export interface OAuthRecoveryPayload {
  recoveryState: OAuthRecoveryState;
  keyId?: string;
  expiresAt?: string;
  revokeHint?: string;
}

const KEY_ID_PATTERN = /^[A-Za-z0-9]{20}$/u;

/**
 * Validate bounded recovery metadata returned by the upstream provisioning endpoint on 409 or 410.
 * Rejects any payload carrying unknown fields, raw secrets, or invalid formats.
 */
export function parseOAuthRecoveryPayload(
  payload: unknown,
): OAuthRecoveryPayload | undefined {
  if (!isRecord(payload)) return undefined;
  const { recoveryState } = payload;
  if (
    recoveryState === "IDEMPOTENT_REPLAY_REQUIRES_REVOKE_AND_REISSUE"
    && typeof payload.keyId === "string"
    && KEY_ID_PATTERN.test(payload.keyId)
    && typeof payload.expiresAt === "string"
    && !Object.keys(payload).some((k) => !["recoveryState", "keyId", "expiresAt", "revokeHint"].includes(k))
  ) {
    return {
      recoveryState,
      keyId: payload.keyId,
      expiresAt: payload.expiresAt,
      ...(typeof payload.revokeHint === "string" ? { revokeHint: payload.revokeHint } : {}),
    };
  }
  if (
    (recoveryState === "IDEMPOTENT_TUPLE_REVOKED_USE_NEW_CORRELATION"
      || recoveryState === "IDEMPOTENT_TUPLE_EXPIRED_USE_NEW_CORRELATION")
    && !Object.keys(payload).some((k) => !["recoveryState"].includes(k))
  ) {
    return { recoveryState };
  }
  return undefined;
}

/**
 * Read the recovery-state body from the upstream provisioner response.
 * Returns the parsed JSON body verbatim so the OAuth caller observes
 * the recovery contract (keyId / expiresAt / recoveryState / revokeHint).
 * On parse failure, non-record payload, or invalid recovery state/format,
 * the default error envelope is the failsafe.
 * Raw credentials (apiKey) are rejected unconditionally.
 */
export async function readRecoveryBody(
  response: Response,
): Promise<unknown> {
  try {
    const cloned = response.clone();
    const data = await cloned.json();
    const parsed = parseOAuthRecoveryPayload(data);
    if (!parsed) {
      return { error: "OAuth API key lifecycle unavailable" };
    }
    return parsed;
  } catch {
    return { error: "OAuth API key lifecycle unavailable" };
  }
}
