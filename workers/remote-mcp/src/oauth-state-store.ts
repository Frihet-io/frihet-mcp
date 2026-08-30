/**
 * Single-use OAuth authorization state backed by a Durable Object.
 *
 * Cloudflare KV is eventually consistent and cannot atomically get-and-delete
 * a value. A Durable Object serializes access to each state key, so concurrent
 * callbacks cannot both provision credentials or mint authorization codes.
 */

import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";

const STATE_STORAGE_KEY = "oauth_request";
const STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_FAMILY_STORAGE_KEY = "oauth_token_family";
const TOKEN_FAMILY_SPENT_PREFIX = "oauth_token_spent:";
const TOKEN_FAMILY_INFLIGHT_TTL_MS = 60 * 1000;
const TOKEN_FAMILY_CLEANUP_STORAGE_KEY = "oauth_token_family_cleanup";
const CLEANUP_INITIAL_BACKOFF_MS = 1_000;
const CLEANUP_MAX_BACKOFF_MS = 5 * 60 * 1000;
const INTERNAL_ORIGIN = "https://oauth-state.internal";

export type OAuthTokenKind = "authorization_code" | "refresh_token";

export type OAuthApiKeyBinding = {
  uid: string;
  keyId: string;
  accessProfile: "openai";
  oauthResource: "https://openai-mcp.frihet.io";
};

type OAuthStateEnvelope = {
  version: 1;
  payload: string;
  expiresAtMs: number;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseStateEnvelope(value: unknown): OAuthStateEnvelope | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["version", "payload", "expiresAtMs"]))) {
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

function isLeaseId(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
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

async function readJsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await request.json<unknown>();
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
        const envelope: OAuthStateEnvelope = {
          version: 1,
          payload,
          expiresAtMs: now + STATE_TTL_MS,
        };
        await this.state.storage.put(STATE_STORAGE_KEY, envelope);
        await this.state.storage.setAlarm(envelope.expiresAtMs);
        return new Response(null, { status: 204 });
      }

      if (request.method === "POST" && pathname === "/consume") {
        const envelope = parseStateEnvelope(
          await this.state.storage.get<unknown>(STATE_STORAGE_KEY),
        );
        if (!envelope || Date.now() >= envelope.expiresAtMs) {
          await this.state.storage.deleteAll();
          return new Response(null, { status: 404 });
        }
        await this.state.storage.deleteAll();
        return new Response(envelope.payload, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
          },
        });
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
        if (
          apiKeyBinding
          && record.apiKeyBinding
          && !sameBinding(record.apiKeyBinding, apiKeyBinding)
        ) {
          await this.tombstoneTokenFamily(record);
          return noStoreJson({ outcome: "revoked", apiKeyBinding: record.apiKeyBinding });
        }

        await this.state.storage.put(
          `${TOKEN_FAMILY_SPENT_PREFIX}${record.currentHash}`,
          true,
        );
        record.currentKind = "refresh_token";
        record.currentHash = newRefreshTokenHash;
        record.apiKeyBinding = record.apiKeyBinding ?? apiKeyBinding;
        delete record.inflight;
        await this.state.storage.put(TOKEN_FAMILY_STORAGE_KEY, record);
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

      const storedState = await this.state.storage.get<unknown>(STATE_STORAGE_KEY);
      if (storedState !== undefined) {
        const envelope = parseStateEnvelope(storedState);
        if (envelope && envelope.expiresAtMs > Date.now()) {
          await this.state.storage.setAlarm(envelope.expiresAtMs);
        } else {
          await this.state.storage.deleteAll();
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

export async function consumeOAuthState<T>(
  namespace: DurableObjectNamespace,
  stateKey: string,
): Promise<T | undefined> {
  const response = await stateStub(namespace, stateKey).fetch(`${INTERNAL_ORIGIN}/consume`, {
    method: "POST",
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`OAuth state store failed to consume state (${response.status})`);
  }
  return response.json<T>();
}
