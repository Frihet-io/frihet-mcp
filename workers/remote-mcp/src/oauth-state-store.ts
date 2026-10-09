/**
 * Retry-safe OAuth authorization state backed by a Durable Object.
 *
 * Cloudflare KV is eventually consistent and cannot atomically get-and-delete
 * a value. A Durable Object serializes access to each state key, so concurrent
 * callbacks cannot both provision credentials or mint authorization codes.
 *
 * Callback lifecycle: `pending -> leased -> committed`. A callback reserves a
 * bounded lease (one live lease per state, each with a fresh provisioning
 * correlation), arms it with the verified uid immediately before the
 * credential request, and commits only after the authorization code exists.
 * A failed attempt releases the lease so the same login can retry. An attempt
 * whose backend outcome is unknown stays recorded until a revocation by
 * correlation proves it left no active credential: the next attempt cannot
 * arm while one is unproven, and an abandoned state is reconciled by its alarm.
 *
 * Rollback: a Worker that only reads the v1 envelope deletes these records,
 * including unproven attempts. Let pending states expire and their alarms
 * reconcile before rolling back.
 */

import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";

const STATE_STORAGE_KEY = "oauth_request";
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_LEASE_TTL_MS = 60 * 1000;
// Arming starts the credential request; leave the attempt room to commit
// before the state itself expires.
const STATE_ARM_MIN_REMAINING_MS = 30 * 1000;
const STATE_MAX_ATTEMPTS = 5;
// Candidate OAuth keys expire after 30 days; past that horizon an unproven
// attempt can no longer hold an active credential.
const STATE_RECONCILE_HORIZON_MS = 31 * 24 * 60 * 60 * 1000;
const TOKEN_FAMILY_STORAGE_KEY = "oauth_token_family";
const TOKEN_FAMILY_SPENT_PREFIX = "oauth_token_spent:";
const TOKEN_FAMILY_INFLIGHT_TTL_MS = 60 * 1000;
const TOKEN_FAMILY_CLEANUP_STORAGE_KEY = "oauth_token_family_cleanup";
const CLEANUP_INITIAL_BACKOFF_MS = 1_000;
const CLEANUP_MAX_BACKOFF_MS = 5 * 60 * 1000;
// One storage entry per previously-bound keyId that a rotation left behind.
// A rotation can leave multiple keyIds behind in sequence (A→B→C), so each one
// has its own retry counter keyed by the exact keyId the outbox must revoke.
const PREVIOUS_BINDING_REVOKE_PREFIX = "oauth_revoke_previous_binding:";
const PREVIOUS_BINDING_REVOKE_INITIAL_BACKOFF_MS = 1_000;
const PREVIOUS_BINDING_REVOKE_MAX_BACKOFF_MS = 5 * 60 * 1000;
const INTERNAL_ORIGIN = "https://oauth-state.internal";

export type OAuthTokenKind = "authorization_code" | "refresh_token";

export type OAuthApiKeyBinding = {
  uid: string;
  keyId: string;
  accessProfile: "openai";
  oauthResource: "https://openai-mcp.frihet.io";
};

/** One provisioning request that may have reached the ERP authority. */
export type OAuthStateAttempt = {
  uid: string;
  correlationId: string;
};

/** Pre-lease envelope written by earlier Workers; read as a fresh pending state. */
type LegacyOAuthStateEnvelope = {
  version: 1;
  payload: string;
  expiresAtMs: number;
};

type OAuthStateLease = {
  leaseId: string;
  correlationId: string;
  expiresAtMs: number;
  /** Set by `/attempt` before the credential request; absent = never sent. */
  uid?: string;
};

type OAuthStateRecord = {
  version: 2;
  status: "pending" | "committed";
  /** Serialized authorization request; present only while pending. */
  payload?: string;
  expiresAtMs: number;
  attempts: number;
  lease?: OAuthStateLease;
  unreconciled: OAuthStateAttempt[];
  committedLeaseId?: string;
  reconcileAttempt?: number;
};

export type OAuthStateReservation<T> =
  | {
      outcome: "reserved";
      leaseId: string;
      correlationId: string;
      attempt: number;
      request: T;
      reconcile: OAuthStateAttempt[];
    }
  | { outcome: "missing" | "expired" | "committed" | "busy" | "exhausted" };

export type OAuthStateArmResult = "armed" | "expired" | "lease_lost" | "unreconciled";
export type OAuthStateCommitResult = "committed" | "lease_lost";
export type OAuthStateReleaseOutcome = "clean" | "unknown";

type TokenFamilyRecord = {
  version: 1;
  status: "active" | "revoked";
  userId: string;
  grantId: string;
  currentKind: OAuthTokenKind;
  currentHash: string;
  expiresAtMs: number;
  apiKeyBinding?: OAuthApiKeyBinding;
  inflight?: {
    leaseId: string;
    kind: OAuthTokenKind;
    credentialHash: string;
    startedAtMs: number;
  };
};

type TokenFamilyCleanupIntent = {
  version: 1;
  userId: string;
  grantId: string;
  apiKeyBinding?: OAuthApiKeyBinding;
  grantRevoked: boolean;
  backendRevoked: boolean;
  attempt: number;
};

/**
 * Asks the OAuthStateStore to revoke one exact `keyId` that a rotation left
 * behind. It survives a Worker restart because the alarm is rearmed every
 * attempt before external I/O; replay is idempotent because
 * `revokeOAuthApiKey` accepts either `200` or `404` for an already-revoked key.
 */
type PreviousBindingRevokeIntent = {
  version: 1;
  userId: string;
  keyId: string;
  attempt: number;
};

type OAuthStateStoreEnv = {
  OAUTH_KV: KVNamespace;
  FRIHET_API_BASE: string;
  FRIHET_OAUTH_API_KEY: string;
};

export type OAuthCleanupAuthorities = {
  revokeGrant(env: OAuthStateStoreEnv, userId: string, grantId: string): Promise<void>;
  revokeBackend(
    env: OAuthStateStoreEnv,
    binding: OAuthApiKeyBinding | undefined,
  ): Promise<boolean>;
  /** True only with the authority's tombstone + zero-active-key readback. */
  revokeBackendCorrelation(
    env: OAuthStateStoreEnv,
    attempt: OAuthStateAttempt,
  ): Promise<boolean>;
};

export type OAuthTokenFamilyBeginResult =
  | { outcome: "started"; leaseId: string; apiKeyBinding?: OAuthApiKeyBinding }
  | { outcome: "busy" | "invalid" | "missing" | "replay" | "revoked"; apiKeyBinding?: OAuthApiKeyBinding };

export type OAuthTokenFamilyCheckResult = {
  outcome: "current" | "spent" | "unknown" | "missing" | "revoked";
  apiKeyBinding?: OAuthApiKeyBinding;
};

export type OAuthTokenFamilyCommitResult =
  | { outcome: "committed"; apiKeyBinding?: OAuthApiKeyBinding }
  | { outcome: "invalid" | "revoked"; apiKeyBinding?: OAuthApiKeyBinding };

const UNUSED_OAUTH_HANDLER = {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};

// Reuse the provider package's own paginated grant/token revocation instead of
// maintaining a second interpretation of its KV schema. These handlers are
// constructor requirements only; cleanup never routes a request through them.
const CLEANUP_OAUTH_OPTIONS: OAuthProviderOptions<OAuthStateStoreEnv> = {
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: [],
  apiHandler: UNUSED_OAUTH_HANDLER,
  defaultHandler: UNUSED_OAUTH_HANDLER,
};

const DEFAULT_CLEANUP_AUTHORITIES: OAuthCleanupAuthorities = {
  async revokeGrant(env, userId, grantId): Promise<void> {
    const { getOAuthApi } = await import("@cloudflare/workers-oauth-provider");
    await getOAuthApi(CLEANUP_OAUTH_OPTIONS, env).revokeGrant(grantId, userId);
  },
  async revokeBackend(env, binding): Promise<boolean> {
    if (!binding) return true;
    const [{ resolveOAuthApiKeyUrl }, { revokeOAuthApiKey }] = await Promise.all([
      import("./api-url.js"),
      import("./oauth-provisioning.js"),
    ]);
    const response = await revokeOAuthApiKey(
      resolveOAuthApiKeyUrl(env.FRIHET_API_BASE),
      env.FRIHET_OAUTH_API_KEY,
      binding,
    );
    return response.ok || response.status === 404;
  },
  async revokeBackendCorrelation(env, attempt): Promise<boolean> {
    const [{ resolveOAuthApiKeyUrl }, { reconcileOAuthApiKeyCorrelation }] = await Promise.all([
      import("./api-url.js"),
      import("./oauth-provisioning.js"),
    ]);
    return reconcileOAuthApiKeyCorrelation(
      resolveOAuthApiKeyUrl(env.FRIHET_API_BASE),
      env.FRIHET_OAUTH_API_KEY,
      {
        uid: attempt.uid,
        accessProfile: "openai",
        oauthResource: "https://openai-mcp.frihet.io",
        correlationId: attempt.correlationId,
      },
    );
  },
};

function noStoreJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
    },
  });
}

/**
 * Emit a single structured log line for an OAuth-state lifecycle outcome.
 * The Durable Object bundle cannot share the Worker `log()` helper, but the
 * test harness captures `console.error` lines, so JSON-encoded records keep
 * the same observability story for both paths without pulling a module in
 * across the bundle boundary.
 */
function logOAuthStateEvent(event: Record<string, unknown>): void {
  console.error(JSON.stringify({ component: "oauth-state-store", ...event }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseLegacyStateEnvelope(value: Record<string, unknown>): LegacyOAuthStateEnvelope | undefined {
  if (!hasOnlyKeys(value, new Set(["version", "payload", "expiresAtMs"]))) {
    return undefined;
  }
  const { version, payload, expiresAtMs } = value;
  if (
    version !== 1
    || typeof payload !== "string"
    || payload.length === 0
    || typeof expiresAtMs !== "number"
    || !Number.isSafeInteger(expiresAtMs)
  ) {
    return undefined;
  }
  return { version, payload, expiresAtMs };
}

function parseStateAttempt(value: unknown): OAuthStateAttempt | undefined {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, new Set(["uid", "correlationId"]))
    || !isSafeUid(value.uid)
    || !isUuidV4(value.correlationId)
  ) {
    return undefined;
  }
  return { uid: value.uid, correlationId: value.correlationId };
}

function parseStateLease(value: unknown): OAuthStateLease | undefined {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, new Set(["leaseId", "correlationId", "expiresAtMs", "uid"]))
    || !isUuidV4(value.leaseId)
    || !isUuidV4(value.correlationId)
    || typeof value.expiresAtMs !== "number"
    || !Number.isSafeInteger(value.expiresAtMs)
    || (value.uid !== undefined && !isSafeUid(value.uid))
  ) {
    return undefined;
  }
  return {
    leaseId: value.leaseId,
    correlationId: value.correlationId,
    expiresAtMs: value.expiresAtMs,
    ...(value.uid === undefined ? {} : { uid: value.uid as string }),
  };
}

/** Strictly parse the stored state; anything unexpected reads as missing. */
function parseStateRecord(value: unknown): OAuthStateRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version === 1) {
    const legacy = parseLegacyStateEnvelope(value);
    return legacy
      ? {
          version: 2,
          status: "pending",
          payload: legacy.payload,
          expiresAtMs: legacy.expiresAtMs,
          attempts: 0,
          unreconciled: [],
        }
      : undefined;
  }
  if (
    !hasOnlyKeys(
      value,
      new Set([
        "version",
        "status",
        "payload",
        "expiresAtMs",
        "attempts",
        "lease",
        "unreconciled",
        "committedLeaseId",
        "reconcileAttempt",
      ]),
    )
    || value.version !== 2
    || (value.status !== "pending" && value.status !== "committed")
    || typeof value.expiresAtMs !== "number"
    || !Number.isSafeInteger(value.expiresAtMs)
    || typeof value.attempts !== "number"
    || !Number.isSafeInteger(value.attempts)
    || value.attempts < 0
    || value.attempts > STATE_MAX_ATTEMPTS
    || !Array.isArray(value.unreconciled)
    || value.unreconciled.length > STATE_MAX_ATTEMPTS
    || (
      value.reconcileAttempt !== undefined
      && (
        typeof value.reconcileAttempt !== "number"
        || !Number.isSafeInteger(value.reconcileAttempt)
        || value.reconcileAttempt < 0
      )
    )
  ) {
    return undefined;
  }
  const unreconciled = value.unreconciled.map(parseStateAttempt);
  if (unreconciled.some((attempt) => attempt === undefined)) return undefined;
  const lease = value.lease === undefined ? undefined : parseStateLease(value.lease);
  if (value.lease !== undefined && !lease) return undefined;
  const record: OAuthStateRecord = {
    version: 2,
    status: value.status,
    expiresAtMs: value.expiresAtMs,
    attempts: value.attempts,
    unreconciled: unreconciled as OAuthStateAttempt[],
    ...(lease ? { lease } : {}),
    ...(value.reconcileAttempt === undefined
      ? {}
      : { reconcileAttempt: value.reconcileAttempt as number }),
  };
  if (value.status === "pending") {
    if (
      typeof value.payload !== "string"
      || value.payload.length === 0
      || value.committedLeaseId !== undefined
      // Every lease and every unproven attempt consumed one reservation.
      || record.unreconciled.length + (lease ? 1 : 0) > record.attempts
    ) {
      return undefined;
    }
    record.payload = value.payload;
    return record;
  }
  if (
    value.payload !== undefined
    || lease
    || record.unreconciled.length > 0
    || !isUuidV4(value.committedLeaseId)
  ) {
    return undefined;
  }
  record.committedLeaseId = value.committedLeaseId;
  return record;
}

/** Attempts that may still hold an active backend credential. */
function stateAttemptsToReconcile(record: OAuthStateRecord): OAuthStateAttempt[] {
  if (record.status !== "pending") return [];
  return record.lease?.uid === undefined
    ? [...record.unreconciled]
    : [
        ...record.unreconciled,
        { uid: record.lease.uid, correlationId: record.lease.correlationId },
      ];
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isTokenKind(value: unknown): value is OAuthTokenKind {
  return value === "authorization_code" || value === "refresh_token";
}

function isGrantId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16}$/u.test(value);
}

function isUuidV4(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isLeaseId(value: unknown): value is string {
  return isUuidV4(value);
}

function isSafeUid(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 128
    // Provider 0.3.0 emits the verified Firebase UID verbatim before the first
    // `:` delimiter. Firebase UIDs may contain slashes, controls, dots, spaces,
    // or Unicode; only `:` is structurally impossible in a provider-valid token.
    && !value.includes(":");
}

function parseApiKeyBinding(value: unknown): OAuthApiKeyBinding | undefined {
  if (!isRecord(value)) return undefined;
  const { uid, keyId, accessProfile, oauthResource } = value;
  if (
    !isSafeUid(uid)
    || typeof keyId !== "string"
    || !/^[A-Za-z0-9]{20}$/u.test(keyId)
    || accessProfile !== "openai"
    || oauthResource !== "https://openai-mcp.frihet.io"
  ) {
    return undefined;
  }
  return {
    uid,
    keyId,
    accessProfile,
    oauthResource: "https://openai-mcp.frihet.io",
  };
}

async function readJsonBody(message: Request | Response): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await message.json<unknown>();
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function sameBinding(
  left: OAuthApiKeyBinding | undefined,
  right: OAuthApiKeyBinding | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.uid === right.uid
    && left.keyId === right.keyId
    && left.accessProfile === right.accessProfile
    && left.oauthResource === right.oauthResource;
}

function isCleanupIntent(value: unknown): value is TokenFamilyCleanupIntent {
  if (!isRecord(value)) return false;
  const binding = value.apiKeyBinding === undefined
    ? undefined
    : parseApiKeyBinding(value.apiKeyBinding);
  return hasOnlyKeys(
    value,
    new Set([
      "version",
      "userId",
      "grantId",
      "apiKeyBinding",
      "grantRevoked",
      "backendRevoked",
      "attempt",
    ]),
  )
    && value.version === 1
    && isSafeUid(value.userId)
    && isGrantId(value.grantId)
    && (value.apiKeyBinding === undefined || binding !== undefined)
    && (binding === undefined || binding.uid === value.userId)
    && typeof value.grantRevoked === "boolean"
    && typeof value.backendRevoked === "boolean"
    && typeof value.attempt === "number"
    && Number.isSafeInteger(value.attempt)
    && value.attempt >= 0;
}

function cleanupBackoffMs(attempt: number): number {
  return Math.min(
    CLEANUP_INITIAL_BACKOFF_MS * 2 ** Math.min(attempt, 8),
    CLEANUP_MAX_BACKOFF_MS,
  );
}

function previousBindingRevokeBackoffMs(attempt: number): number {
  return Math.min(
    PREVIOUS_BINDING_REVOKE_INITIAL_BACKOFF_MS * 2 ** Math.min(attempt, 8),
    PREVIOUS_BINDING_REVOKE_MAX_BACKOFF_MS,
  );
}

function isPreviousBindingRevokeIntent(value: unknown): value is PreviousBindingRevokeIntent {
  return isRecord(value)
    && hasOnlyKeys(value, new Set(["version", "userId", "keyId", "attempt"]))
    && value.version === 1
    && isSafeUid(value.userId)
    && typeof value.keyId === "string"
    && /^[A-Za-z0-9]{20}$/u.test(value.keyId)
    && typeof value.attempt === "number"
    && Number.isSafeInteger(value.attempt)
    && value.attempt >= 0;
}

function previousBindingRevokeStorageKey(keyId: string): string {
  return `${PREVIOUS_BINDING_REVOKE_PREFIX}${keyId}`;
}

export class OAuthStateStore {
  private readonly state: DurableObjectState;
  private readonly env: OAuthStateStoreEnv | undefined;
  private readonly cleanupAuthorities: OAuthCleanupAuthorities;

  constructor(
    state: DurableObjectState,
    env?: OAuthStateStoreEnv,
    cleanupAuthorities: OAuthCleanupAuthorities = DEFAULT_CLEANUP_AUTHORITIES,
  ) {
    this.state = state;
    this.env = env;
    this.cleanupAuthorities = cleanupAuthorities;
  }

  /** Atomically make the family unusable and register its durable cleanup. */
  private async tombstoneTokenFamily(record: TokenFamilyRecord): Promise<void> {
    const tombstoned: TokenFamilyRecord = { ...record, status: "revoked" };
    delete tombstoned.inflight;
    const now = Date.now();
    await this.state.storage.transaction(async (transaction) => {
      const storedIntent = await transaction.get<unknown>(
        TOKEN_FAMILY_CLEANUP_STORAGE_KEY,
      );
      if (storedIntent !== undefined && !isCleanupIntent(storedIntent)) {
        throw new Error("OAuth token-family cleanup intent is invalid");
      }
      const existing = storedIntent as TokenFamilyCleanupIntent | undefined;
      if (
        existing
        && (existing.userId !== tombstoned.userId || existing.grantId !== tombstoned.grantId)
      ) {
        throw new Error("OAuth token-family cleanup identity changed");
      }
      const intent: TokenFamilyCleanupIntent = existing ?? {
        version: 1,
        userId: tombstoned.userId,
        grantId: tombstoned.grantId,
        ...(tombstoned.apiKeyBinding ? { apiKeyBinding: tombstoned.apiKeyBinding } : {}),
        grantRevoked: false,
        backendRevoked: tombstoned.apiKeyBinding === undefined,
        attempt: 0,
      };
      await transaction.put(TOKEN_FAMILY_STORAGE_KEY, tombstoned);
      await transaction.put(TOKEN_FAMILY_CLEANUP_STORAGE_KEY, intent);
      // Pre-arm inside the same transaction: a crash after the tombstone can
      // never leave cleanup without a future alarm.
      await transaction.setAlarm(now + 1);
    });
  }

  private async processCleanup(intent: TokenFamilyCleanupIntent): Promise<void> {
    if (!this.env) {
      throw new Error("OAuth token-family cleanup environment is unavailable");
    }

    const attempt = Math.min(intent.attempt + 1, Number.MAX_SAFE_INTEGER);
    const retryAtMs = Date.now() + cleanupBackoffMs(attempt);
    const armedIntent = { ...intent, attempt };
    // Arm the next attempt before external I/O. A Worker termination at any
    // later point is therefore an idempotent retry, never an abandoned outbox.
    await this.state.storage.transaction(async (transaction) => {
      await transaction.put(TOKEN_FAMILY_CLEANUP_STORAGE_KEY, armedIntent);
      await transaction.setAlarm(retryAtMs);
    });

    const [grantResult, backendResult] = await Promise.allSettled([
      intent.grantRevoked
        ? Promise.resolve()
        : this.cleanupAuthorities.revokeGrant(this.env, intent.userId, intent.grantId),
      intent.backendRevoked
        ? Promise.resolve(true)
        : this.cleanupAuthorities.revokeBackend(this.env, intent.apiKeyBinding),
    ]);
    const updated: TokenFamilyCleanupIntent = {
      ...armedIntent,
      grantRevoked: intent.grantRevoked || grantResult.status === "fulfilled",
      backendRevoked: intent.backendRevoked
        || (backendResult.status === "fulfilled" && backendResult.value === true),
    };
    if (!updated.grantRevoked || !updated.backendRevoked) {
      await this.state.storage.put(TOKEN_FAMILY_CLEANUP_STORAGE_KEY, updated);
      return;
    }

    const record = await this.state.storage.get<TokenFamilyRecord>(
      TOKEN_FAMILY_STORAGE_KEY,
    );
    if (!record || record.expiresAtMs <= Date.now()) {
      await this.state.storage.deleteAll();
      return;
    }
    await this.state.storage.transaction(async (transaction) => {
      await transaction.delete(TOKEN_FAMILY_CLEANUP_STORAGE_KEY);
      await transaction.setAlarm(record.expiresAtMs);
    });
    // A previous-binding revoke outbox for an earlier rotation (A→...→current)
    // survives the family tombstone and still needs an alarm to fire. Always
    // re-arm so the soonest of the two deadlines wins.
    await this.rearmAlarmForPendingOutboxes();
  }

  /**
   * Revoke one previously-bound keyId a rotation left behind. Separate from
   * `processCleanup` because the family stays active — the old credential is
   * the only thing we want gone. Same outbox discipline: the next alarm is
   * armed before any external I/O, and the call to `revokeBackend` is
   * idempotent at the authority (200 or 404 both mean the key is gone).
   */
  private async processPreviousBindingRevoke(
    intent: PreviousBindingRevokeIntent,
  ): Promise<void> {
    if (!this.env) {
      throw new Error("OAuth previous-binding revoke environment is unavailable");
    }

    const nextAttempt = Math.min(intent.attempt + 1, Number.MAX_SAFE_INTEGER);
    const retryAtMs = Date.now() + previousBindingRevokeBackoffMs(nextAttempt);
    await this.state.storage.transaction(async (transaction) => {
      await transaction.put(
        previousBindingRevokeStorageKey(intent.keyId),
        { ...intent, attempt: nextAttempt },
      );
      await transaction.setAlarm(retryAtMs);
    });

    const result = await Promise.allSettled([
      this.cleanupAuthorities.revokeBackend(this.env, {
        uid: intent.userId,
        keyId: intent.keyId,
        accessProfile: "openai",
        oauthResource: "https://openai-mcp.frihet.io",
      }),
    ]);
    const fulfilled = result[0];
    if (fulfilled.status === "fulfilled" && fulfilled.value === true) {
      await this.state.storage.delete(previousBindingRevokeStorageKey(intent.keyId));
      // Re-arm for any other pending outbox of the same family. If none,
      // `alarm()` will clear or hand back to the family expiresAtMs alarm.
      await this.rearmAlarmForPendingOutboxes();
    }
  }

  /**
   * Reposition the alarm so the next pending outbox fires at or before its
   * own backoff horizon. Always re-arms with the soonest deadline; the alarm
   * body itself re-evaluates which slot to process.
   */
  private async rearmAlarmForPendingOutboxes(): Promise<void> {
    const listed = await this.state.storage.list({ prefix: PREVIOUS_BINDING_REVOKE_PREFIX });
    let earliest = Number.POSITIVE_INFINITY;
    for (const [key, value] of listed) {
      if (!isPreviousBindingRevokeIntent(value)) {
        throw new Error(`OAuth previous-binding revoke intent at ${key} is invalid`);
      }
      const deadline = Date.now() + previousBindingRevokeBackoffMs(value.attempt + 1);
      if (deadline < earliest) earliest = deadline;
    }
    if (!Number.isFinite(earliest)) {
      const family = await this.state.storage.get<TokenFamilyRecord>(
        TOKEN_FAMILY_STORAGE_KEY,
      );
      if (family) {
        await this.state.storage.setAlarm(family.expiresAtMs);
      } else {
        await this.state.storage.deleteAll();
      }
      return;
    }
    await this.state.storage.setAlarm(earliest);
  }

  /**
   * Revoke, by correlation, every attempt of an expired state whose backend
   * outcome was never proven. Same outbox discipline as token-family cleanup:
   * the next alarm is armed before any external I/O.
   */
  private async processStateReconcile(record: OAuthStateRecord): Promise<void> {
    const pending = stateAttemptsToReconcile(record);
    const now = Date.now();
    if (pending.length === 0 || now >= record.expiresAtMs + STATE_RECONCILE_HORIZON_MS) {
      await this.state.storage.deleteAll();
      return;
    }
    logOAuthStateEvent({
      outcome: "expired",
      stage: "alarm_reconcile",
      reason: "state_ttl_reached",
      pendingCount: pending.length,
    });
    if (!this.env) {
      throw new Error("OAuth state reconciliation environment is unavailable");
    }
    const reconcileAttempt = Math.min((record.reconcileAttempt ?? 0) + 1, Number.MAX_SAFE_INTEGER);
    const armed: OAuthStateRecord = { ...record, unreconciled: pending, reconcileAttempt };
    delete armed.lease;
    await this.state.storage.transaction(async (transaction) => {
      await transaction.put(STATE_STORAGE_KEY, armed);
      await transaction.setAlarm(now + cleanupBackoffMs(reconcileAttempt));
    });

    const env = this.env;
    const results = await Promise.allSettled(
      pending.map((attempt) => this.cleanupAuthorities.revokeBackendCorrelation(env, attempt)),
    );
    const remaining = pending.filter((_, index) => {
      const result = results[index];
      return result?.status !== "fulfilled" || result.value !== true;
    });
    if (remaining.length === 0) {
      await this.state.storage.deleteAll();
      return;
    }
    await this.state.storage.put(STATE_STORAGE_KEY, { ...armed, unreconciled: remaining });
  }

  private async readStateRecord(): Promise<OAuthStateRecord | undefined> {
    return parseStateRecord(await this.state.storage.get<unknown>(STATE_STORAGE_KEY));
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    return this.state.blockConcurrencyWhile(async () => {
      if (request.method === "PUT" && pathname === "/state") {
        if (await this.state.storage.get(STATE_STORAGE_KEY)) {
          return new Response(null, { status: 409 });
        }
        const payload = await request.text();
        if (!payload) return new Response(null, { status: 400 });
        const now = Date.now();
        const record: OAuthStateRecord = {
          version: 2,
          status: "pending",
          payload,
          expiresAtMs: now + STATE_TTL_MS,
          attempts: 0,
          unreconciled: [],
        };
        await this.state.storage.put(STATE_STORAGE_KEY, record);
        await this.state.storage.setAlarm(record.expiresAtMs);
        return new Response(null, { status: 204 });
      }

      if (request.method === "POST" && pathname === "/reserve") {
        const stored = await this.state.storage.get<unknown>(STATE_STORAGE_KEY);
        const record = parseStateRecord(stored);
        if (!record) {
          // Never leave an unparseable record for a later reader to trust.
          if (stored !== undefined) await this.state.storage.deleteAll();
          return noStoreJson({ outcome: "missing" });
        }
        if (record.status === "committed") return noStoreJson({ outcome: "committed" });
        const now = Date.now();
        if (now >= record.expiresAtMs) {
          // Unproven attempts stay for the alarm; nothing else survives expiry.
          if (stateAttemptsToReconcile(record).length === 0) {
            await this.state.storage.deleteAll();
          }
          return noStoreJson({ outcome: "expired" });
        }
        if (record.lease && now < record.lease.expiresAtMs) {
          return noStoreJson({ outcome: "busy" });
        }
        if (record.lease) {
          // The previous holder lost its lease without settling it. If it had
          // armed, its credential request may have landed: keep it unproven.
          if (record.lease.uid !== undefined) {
            record.unreconciled.push({
              uid: record.lease.uid,
              correlationId: record.lease.correlationId,
            });
          }
          delete record.lease;
        }
        if (record.attempts >= STATE_MAX_ATTEMPTS) {
          await this.state.storage.put(STATE_STORAGE_KEY, record);
          return noStoreJson({ outcome: "exhausted" });
        }
        const lease: OAuthStateLease = {
          leaseId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          expiresAtMs: now + STATE_LEASE_TTL_MS,
        };
        record.lease = lease;
        record.attempts += 1;
        await this.state.storage.put(STATE_STORAGE_KEY, record);
        return noStoreJson({
          outcome: "reserved",
          leaseId: lease.leaseId,
          correlationId: lease.correlationId,
          attempt: record.attempts,
          payload: record.payload,
          reconcile: record.unreconciled,
        });
      }

      if (request.method === "POST" && pathname === "/attempt") {
        const body = await readJsonBody(request);
        const leaseId = body?.leaseId;
        const uid = body?.uid;
        const reconciled = body?.reconciled;
        if (
          !body
          || !hasOnlyKeys(body, new Set(["leaseId", "uid", "reconciled"]))
          || !isLeaseId(leaseId)
          || !isSafeUid(uid)
          || !Array.isArray(reconciled)
          || reconciled.length > STATE_MAX_ATTEMPTS
          || !reconciled.every(isUuidV4)
        ) {
          return noStoreJson({ outcome: "invalid" }, 400);
        }
        const record = await this.readStateRecord();
        const now = Date.now();
        if (!record || record.status !== "pending") {
          return noStoreJson({ outcome: "lease_lost" });
        }
        if (record.expiresAtMs - now < STATE_ARM_MIN_REMAINING_MS) {
          logOAuthStateEvent({ outcome: "expired", stage: "attempt", reason: "below_arm_min_remaining" });
          return noStoreJson({ outcome: "expired" });
        }
        if (
          !record.lease
          || record.lease.leaseId !== leaseId
          // Arming is the last step before the credential request, so it
          // must happen inside the lease; a late holder cannot start sending.
          || now >= record.lease.expiresAtMs
          || (record.lease.uid !== undefined && record.lease.uid !== uid)
        ) {
          return noStoreJson({ outcome: "lease_lost" });
        }
        const proven = new Set<string>(reconciled);
        record.unreconciled = record.unreconciled.filter(
          (attempt) => !proven.has(attempt.correlationId),
        );
        if (record.unreconciled.length > 0) {
          await this.state.storage.put(STATE_STORAGE_KEY, record);
          return noStoreJson({ outcome: "unreconciled" });
        }
        record.lease.uid = uid;
        // Renew on arming so a holder provisioning at normal speed is not
        // taken over mid-request. Safety does not rest on this window (the
        // grant write and the commit have no deadline): a holder resuming
        // after a takeover cannot commit, revokes its own correlation, and
        // never replaces other grants, which only happens after a commit.
        record.lease.expiresAtMs = now + STATE_LEASE_TTL_MS;
        await this.state.storage.put(STATE_STORAGE_KEY, record);
        return noStoreJson({ outcome: "armed" });
      }

      if (request.method === "POST" && pathname === "/commit") {
        const body = await readJsonBody(request);
        const leaseId = body?.leaseId;
        if (!body || !hasOnlyKeys(body, new Set(["leaseId"])) || !isLeaseId(leaseId)) {
          return noStoreJson({ outcome: "invalid" }, 400);
        }
        const record = await this.readStateRecord();
        if (record?.status === "committed" && record.committedLeaseId === leaseId) {
          // Idempotent: a retried commit whose first response was lost.
          return noStoreJson({ outcome: "committed" });
        }
        if (
          !record
          || record.status !== "pending"
          || Date.now() >= record.expiresAtMs
          || !record.lease
          || record.lease.leaseId !== leaseId
          || record.lease.uid === undefined
          || record.unreconciled.length > 0
        ) {
          // A lease past its TTL still commits while nobody took it over:
          // takeover is the only path that reconciles the holder's correlation.
          return noStoreJson({ outcome: "lease_lost" });
        }
        const committed: OAuthStateRecord = {
          version: 2,
          status: "committed",
          expiresAtMs: record.expiresAtMs,
          attempts: record.attempts,
          unreconciled: [],
          committedLeaseId: leaseId,
        };
        await this.state.storage.put(STATE_STORAGE_KEY, committed);
        return noStoreJson({ outcome: "committed" });
      }

      if (request.method === "POST" && pathname === "/release") {
        const body = await readJsonBody(request);
        const leaseId = body?.leaseId;
        const outcome = body?.outcome;
        if (
          !body
          || !hasOnlyKeys(body, new Set(["leaseId", "outcome"]))
          || !isLeaseId(leaseId)
          || (outcome !== "clean" && outcome !== "unknown")
        ) {
          return new Response(null, { status: 400 });
        }
        const record = await this.readStateRecord();
        if (record?.status === "pending" && record.lease?.leaseId === leaseId) {
          if (outcome === "unknown" && record.lease.uid !== undefined) {
            record.unreconciled.push({
              uid: record.lease.uid,
              correlationId: record.lease.correlationId,
            });
          }
          delete record.lease;
          await this.state.storage.put(STATE_STORAGE_KEY, record);
        }
        return new Response(null, { status: 204 });
      }

      if (request.method === "PUT" && pathname === "/token-family") {
        const body = await readJsonBody(request);
        const userId = body?.userId;
        const grantId = body?.grantId;
        const currentKind = body?.currentKind;
        const currentHash = body?.currentHash;
        const expiresAtMs = body?.expiresAtMs;
        const apiKeyBinding = body?.apiKeyBinding === undefined
          ? undefined
          : parseApiKeyBinding(body.apiKeyBinding);
        if (
          !body
          || !hasOnlyKeys(
            body,
            new Set([
              "userId",
              "grantId",
              "currentKind",
              "currentHash",
              "expiresAtMs",
              "apiKeyBinding",
            ]),
          )
          || !isSafeUid(userId)
          || !isGrantId(grantId)
          || !isTokenKind(currentKind)
          || !isSha256(currentHash)
          || typeof expiresAtMs !== "number"
          || !Number.isSafeInteger(expiresAtMs)
          || expiresAtMs <= Date.now()
          || expiresAtMs > Date.now() + 366 * 24 * 60 * 60 * 1000
          || (body.apiKeyBinding !== undefined && !apiKeyBinding)
          || (apiKeyBinding !== undefined && apiKeyBinding.uid !== userId)
        ) {
          return noStoreJson({ outcome: "invalid" }, 400);
        }

        const existing = await this.state.storage.get<TokenFamilyRecord>(
          TOKEN_FAMILY_STORAGE_KEY,
        );
        if (existing) {
          if (
            existing.status === "active"
            && existing.userId === userId
            && existing.grantId === grantId
            && existing.currentKind === currentKind
            && existing.currentHash === currentHash
            && sameBinding(existing.apiKeyBinding, apiKeyBinding)
          ) {
            return new Response(null, { status: 204 });
          }
          return noStoreJson({ outcome: "conflict" }, 409);
        }

        const record: TokenFamilyRecord = {
          version: 1,
          status: "active",
          userId,
          grantId,
          currentKind,
          currentHash,
          expiresAtMs,
          ...(apiKeyBinding ? { apiKeyBinding } : {}),
        };
        await this.state.storage.put(TOKEN_FAMILY_STORAGE_KEY, record);
        await this.state.storage.setAlarm(expiresAtMs);
        return new Response(null, { status: 204 });
      }

      if (request.method === "POST" && pathname === "/token-family/begin") {
        const body = await readJsonBody(request);
        const kind = body?.kind;
        const credentialHash = body?.credentialHash;
        if (
          !body
          || !hasOnlyKeys(body, new Set(["kind", "credentialHash"]))
          || !isTokenKind(kind)
          || !isSha256(credentialHash)
        ) {
          return noStoreJson({ outcome: "invalid" }, 400);
        }

        const record = await this.state.storage.get<TokenFamilyRecord>(
          TOKEN_FAMILY_STORAGE_KEY,
        );
        if (!record) return noStoreJson({ outcome: "missing" });
        if (record.status === "revoked") {
          return noStoreJson({ outcome: "revoked", apiKeyBinding: record.apiKeyBinding });
        }
        if (record.expiresAtMs <= Date.now()) {
          await this.tombstoneTokenFamily(record);
          return noStoreJson({ outcome: "revoked", apiKeyBinding: record.apiKeyBinding });
        }

        const wasSpent = await this.state.storage.get<boolean>(
          `${TOKEN_FAMILY_SPENT_PREFIX}${credentialHash}`,
        );
        if (wasSpent === true) {
          await this.tombstoneTokenFamily(record);
          return noStoreJson({ outcome: "replay", apiKeyBinding: record.apiKeyBinding });
        }
        if (record.currentKind !== kind || record.currentHash !== credentialHash) {
          return noStoreJson({ outcome: "invalid", apiKeyBinding: record.apiKeyBinding });
        }

        if (record.inflight) {
          if (Date.now() - record.inflight.startedAtMs <= TOKEN_FAMILY_INFLIGHT_TTL_MS) {
            // The provider invokes this only after it has independently
            // validated the same credential and client. Two accepted uses are
            // therefore a replay, not an innocent unknown-token probe.
            await this.tombstoneTokenFamily(record);
            return noStoreJson({ outcome: "replay", apiKeyBinding: record.apiKeyBinding });
          }
          // The provider may have persisted a rotation after the Worker died but
          // before this lease could commit. Never guess which token is current.
          await this.tombstoneTokenFamily(record);
          return noStoreJson({ outcome: "revoked", apiKeyBinding: record.apiKeyBinding });
        }

        const leaseId = crypto.randomUUID();
        record.inflight = {
          leaseId,
          kind,
          credentialHash,
          startedAtMs: Date.now(),
        };
        await this.state.storage.put(TOKEN_FAMILY_STORAGE_KEY, record);
        return noStoreJson({ outcome: "started", leaseId, apiKeyBinding: record.apiKeyBinding });
      }

      if (request.method === "POST" && pathname === "/token-family/check") {
        const body = await readJsonBody(request);
        const kind = body?.kind;
        const credentialHash = body?.credentialHash;
        if (
          !body
          || !hasOnlyKeys(body, new Set(["kind", "credentialHash"]))
          || !isTokenKind(kind)
          || !isSha256(credentialHash)
        ) {
          return noStoreJson({ outcome: "unknown" }, 400);
        }
        const record = await this.state.storage.get<TokenFamilyRecord>(
          TOKEN_FAMILY_STORAGE_KEY,
        );
        if (!record) return noStoreJson({ outcome: "missing" });
        if (record.status === "revoked") {
          return noStoreJson({ outcome: "revoked", apiKeyBinding: record.apiKeyBinding });
        }
        if (
          await this.state.storage.get<boolean>(
            `${TOKEN_FAMILY_SPENT_PREFIX}${credentialHash}`,
          ) === true
        ) {
          return noStoreJson({ outcome: "spent", apiKeyBinding: record.apiKeyBinding });
        }
        if (record.currentKind === kind && record.currentHash === credentialHash) {
          return noStoreJson({ outcome: "current", apiKeyBinding: record.apiKeyBinding });
        }
        return noStoreJson({ outcome: "unknown", apiKeyBinding: record.apiKeyBinding });
      }

      if (request.method === "GET" && pathname === "/token-family/status") {
        const record = await this.state.storage.get<TokenFamilyRecord>(
          TOKEN_FAMILY_STORAGE_KEY,
        );
        if (!record) return noStoreJson({ outcome: "missing" });
        if (record.status === "active" && record.expiresAtMs <= Date.now()) {
          await this.tombstoneTokenFamily(record);
          return noStoreJson({ outcome: "revoked" });
        }
        return noStoreJson({ outcome: record.status });
      }

      if (request.method === "POST" && pathname === "/token-family/commit") {
        const body = await readJsonBody(request);
        const leaseId = body?.leaseId;
        const newRefreshTokenHash = body?.newRefreshTokenHash;
        const apiKeyBinding = body?.apiKeyBinding === undefined
          ? undefined
          : parseApiKeyBinding(body.apiKeyBinding);
        if (
          !body
          || !hasOnlyKeys(
            body,
            new Set(["leaseId", "newRefreshTokenHash", "apiKeyBinding"]),
          )
          || !isLeaseId(leaseId)
          || !isSha256(newRefreshTokenHash)
          || (body.apiKeyBinding !== undefined && !apiKeyBinding)
        ) {
          return noStoreJson({ outcome: "invalid" }, 400);
        }

        const record = await this.state.storage.get<TokenFamilyRecord>(
          TOKEN_FAMILY_STORAGE_KEY,
        );
        if (!record) return noStoreJson({ outcome: "invalid" });
        if (record.status === "revoked") {
          return noStoreJson({ outcome: "revoked", apiKeyBinding: record.apiKeyBinding });
        }
        if (!record.inflight || record.inflight.leaseId !== leaseId) {
          return noStoreJson({ outcome: "invalid", apiKeyBinding: record.apiKeyBinding });
        }
        // A binding whose uid, access profile, or resource is not the same
        // identity the family knows is the sign of a forged commit and must
        // tombstone the family. A different keyId against an otherwise
        // matching identity is a legitimate rotation: the new binding
        // replaces the old one and the OLD keyId is revoked asynchronously
        // through the rotation outbox further down.
        if (
          apiKeyBinding
          && record.apiKeyBinding
          && (
            record.apiKeyBinding.uid !== apiKeyBinding.uid
            || record.apiKeyBinding.accessProfile !== apiKeyBinding.accessProfile
            || record.apiKeyBinding.oauthResource !== apiKeyBinding.oauthResource
          )
        ) {
          await this.tombstoneTokenFamily(record);
          return noStoreJson({ outcome: "revoked", apiKeyBinding: record.apiKeyBinding });
        }

        await this.state.storage.put(
          `${TOKEN_FAMILY_SPENT_PREFIX}${record.currentHash}`,
          true,
        );
        const previousBinding = record.apiKeyBinding;
        record.currentKind = "refresh_token";
        record.currentHash = newRefreshTokenHash;
        // A commit that omits `apiKeyBinding` keeps the one the family already
        // carries; only an EXPLICIT new binding can rotate. Distinguishing the
        // two matters: only the rotation case leaves a previously-bound keyId
        // alive on the backend that an outbox must revoke.
        record.apiKeyBinding = apiKeyBinding ?? record.apiKeyBinding;
        delete record.inflight;
        // Detect a rotation against the same family: a different keyId, the
        // same uid, the same OpenAI profile. Persist the outbox to revoke the
        // OLD keyId atomically with the new binding, and pre-arm the alarm
        // inside the same transaction so a Worker termination between commit
        // and alarm can never leave the outbox unattended.
        const rotated = previousBinding
          && apiKeyBinding
          && previousBinding.keyId !== apiKeyBinding.keyId
          && previousBinding.uid === apiKeyBinding.uid
          && previousBinding.accessProfile === apiKeyBinding.accessProfile
          && previousBinding.oauthResource === apiKeyBinding.oauthResource
          ? previousBinding
          : undefined;
        await this.state.storage.transaction(async (transaction) => {
          await transaction.put(TOKEN_FAMILY_STORAGE_KEY, record);
          if (rotated) {
            const intent: PreviousBindingRevokeIntent = {
              version: 1,
              userId: rotated.uid,
              keyId: rotated.keyId,
              attempt: 0,
            };
            await transaction.put(
              previousBindingRevokeStorageKey(rotated.keyId),
              intent,
            );
            await transaction.setAlarm(Date.now() + 1);
          }
        });
        return noStoreJson({ outcome: "committed", apiKeyBinding: record.apiKeyBinding });
      }

      if (request.method === "POST" && pathname === "/token-family/abort") {
        const body = await readJsonBody(request);
        const leaseId = body?.leaseId;
        if (
          !body
          || !hasOnlyKeys(body, new Set(["leaseId"]))
          || !isLeaseId(leaseId)
        ) {
          return new Response(null, { status: 400 });
        }
        const record = await this.state.storage.get<TokenFamilyRecord>(
          TOKEN_FAMILY_STORAGE_KEY,
        );
        if (record?.status === "active" && record.inflight?.leaseId === leaseId) {
          delete record.inflight;
          await this.state.storage.put(TOKEN_FAMILY_STORAGE_KEY, record);
        }
        return new Response(null, { status: 204 });
      }

      if (request.method === "POST" && pathname === "/token-family/revoke") {
        const record = await this.state.storage.get<TokenFamilyRecord>(
          TOKEN_FAMILY_STORAGE_KEY,
        );
        if (!record) return noStoreJson({ outcome: "invalid" });
        await this.tombstoneTokenFamily(record);
        return noStoreJson({ outcome: "revoked", apiKeyBinding: record.apiKeyBinding });
      }

      return new Response(null, { status: 405 });
    });
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const cleanup = await this.state.storage.get<unknown>(
        TOKEN_FAMILY_CLEANUP_STORAGE_KEY,
      );
      if (cleanup !== undefined) {
        if (!isCleanupIntent(cleanup)) {
          throw new Error("OAuth token-family cleanup intent is invalid");
        }
        await this.processCleanup(cleanup);
        return;
      }

      // Previous-binding revokes are keyed by their keyId so multiple pending
      // revokes can queue independently. Process the soonest-due one and let
      // it re-arm the alarm if others are still outstanding.
      const listed = await this.state.storage.list({
        prefix: PREVIOUS_BINDING_REVOKE_PREFIX,
      });
      let soonest: { keyId: string; intent: PreviousBindingRevokeIntent } | undefined;
      for (const [key, value] of listed) {
        if (!isPreviousBindingRevokeIntent(value)) {
          throw new Error(`OAuth previous-binding revoke intent at ${key} is invalid`);
        }
        if (
          !soonest
          || previousBindingRevokeBackoffMs(value.attempt + 1)
            < previousBindingRevokeBackoffMs(soonest.intent.attempt + 1)
        ) {
          soonest = { keyId: value.keyId, intent: value };
        }
      }
      if (soonest) {
        await this.processPreviousBindingRevoke(soonest.intent);
        return;
      }

      const storedState = await this.state.storage.get<unknown>(STATE_STORAGE_KEY);
      if (storedState !== undefined) {
        const record = parseStateRecord(storedState);
        if (!record) {
          await this.state.storage.deleteAll();
        } else if (record.expiresAtMs > Date.now()) {
          await this.state.storage.setAlarm(record.expiresAtMs);
        } else {
          await this.processStateReconcile(record);
        }
        return;
      }

      const family = await this.state.storage.get<TokenFamilyRecord>(
        TOKEN_FAMILY_STORAGE_KEY,
      );
      if (family && family.expiresAtMs > Date.now()) {
        await this.state.storage.setAlarm(family.expiresAtMs);
        return;
      }
      await this.state.storage.deleteAll();
    });
  }
}

function stateStub(namespace: DurableObjectNamespace, stateKey: string): DurableObjectStub {
  return namespace.get(namespace.idFromName(stateKey));
}

export async function storeOAuthState(
  namespace: DurableObjectNamespace,
  stateKey: string,
  payload: string,
): Promise<void> {
  const response = await stateStub(namespace, stateKey).fetch(`${INTERNAL_ORIGIN}/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  if (!response.ok) {
    throw new Error(`OAuth state store rejected a new state (${response.status})`);
  }
}

async function readStateOutcome(response: Response, operation: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new Error(`OAuth state store failed to ${operation} (${response.status})`);
  }
  const body = await readJsonBody(response);
  if (!body || typeof body.outcome !== "string") {
    throw new Error(`OAuth state store returned an invalid ${operation} outcome`);
  }
  return body;
}

/**
 * Lease the stored authorization request for one callback attempt. Every
 * `reserved` result must be settled by `commitOAuthState` or
 * `releaseOAuthState`; an unsettled lease expires and is reconciled later.
 */
export async function reserveOAuthState<T>(
  namespace: DurableObjectNamespace,
  stateKey: string,
): Promise<OAuthStateReservation<T>> {
  const body = await readStateOutcome(
    await stateStub(namespace, stateKey).fetch(`${INTERNAL_ORIGIN}/reserve`, {
      method: "POST",
    }),
    "reserve state",
  );
  if (body.outcome !== "reserved") {
    if (
      body.outcome === "missing"
      || body.outcome === "expired"
      || body.outcome === "committed"
      || body.outcome === "busy"
      || body.outcome === "exhausted"
    ) {
      return { outcome: body.outcome };
    }
    throw new Error("OAuth state store returned an invalid reserve outcome");
  }
  const reconcile = Array.isArray(body.reconcile)
    ? body.reconcile.map(parseStateAttempt)
    : undefined;
  if (
    !isLeaseId(body.leaseId)
    || !isUuidV4(body.correlationId)
    || typeof body.attempt !== "number"
    || !Number.isSafeInteger(body.attempt)
    || body.attempt < 1
    || body.attempt > STATE_MAX_ATTEMPTS
    || typeof body.payload !== "string"
    || !reconcile
    || reconcile.some((attempt) => attempt === undefined)
  ) {
    throw new Error("OAuth state store returned an invalid reservation");
  }
  return {
    outcome: "reserved",
    leaseId: body.leaseId,
    correlationId: body.correlationId,
    attempt: body.attempt,
    request: JSON.parse(body.payload) as T,
    reconcile: reconcile as OAuthStateAttempt[],
  };
}

/**
 * Bind the lease to the verified uid immediately before the credential
 * request, after proving every earlier unknown attempt revoked.
 */
export async function armOAuthStateAttempt(
  namespace: DurableObjectNamespace,
  stateKey: string,
  leaseId: string,
  uid: string,
  reconciledCorrelationIds: readonly string[],
): Promise<OAuthStateArmResult> {
  const body = await readStateOutcome(
    await stateStub(namespace, stateKey).fetch(`${INTERNAL_ORIGIN}/attempt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leaseId, uid, reconciled: reconciledCorrelationIds }),
    }),
    "arm attempt",
  );
  if (
    body.outcome === "armed"
    || body.outcome === "expired"
    || body.outcome === "lease_lost"
    || body.outcome === "unreconciled"
  ) {
    return body.outcome;
  }
  throw new Error("OAuth state store returned an invalid attempt outcome");
}

export async function commitOAuthState(
  namespace: DurableObjectNamespace,
  stateKey: string,
  leaseId: string,
): Promise<OAuthStateCommitResult> {
  const body = await readStateOutcome(
    await stateStub(namespace, stateKey).fetch(`${INTERNAL_ORIGIN}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leaseId }),
    }),
    "commit state",
  );
  if (body.outcome === "committed" || body.outcome === "lease_lost") return body.outcome;
  throw new Error("OAuth state store returned an invalid commit outcome");
}

/**
 * Return the lease so the same login can retry. `clean` asserts the attempt
 * left no active credential (never sent, rejected, or revocation proven);
 * `unknown` keeps it recorded until a revocation proves it.
 */
export async function releaseOAuthState(
  namespace: DurableObjectNamespace,
  stateKey: string,
  leaseId: string,
  outcome: OAuthStateReleaseOutcome,
): Promise<void> {
  const response = await stateStub(namespace, stateKey).fetch(`${INTERNAL_ORIGIN}/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leaseId, outcome }),
  });
  if (!response.ok) {
    throw new Error(`OAuth state store failed to release state (${response.status})`);
  }
}
