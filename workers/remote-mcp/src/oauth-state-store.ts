/**
 * Single-use OAuth authorization state backed by a Durable Object.
 *
 * Cloudflare KV is eventually consistent and cannot atomically get-and-delete
 * a value. A Durable Object serializes access to each state key, so concurrent
 * callbacks cannot both provision credentials or mint authorization codes.
 */

const STATE_STORAGE_KEY = "oauth_request";
const STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_FAMILY_STORAGE_KEY = "oauth_token_family";
const TOKEN_FAMILY_SPENT_PREFIX = "oauth_token_spent:";
const TOKEN_FAMILY_INFLIGHT_TTL_MS = 60 * 1000;
const INTERNAL_ORIGIN = "https://oauth-state.internal";

export type OAuthTokenKind = "authorization_code" | "refresh_token";

export type OAuthApiKeyBinding = {
  uid: string;
  keyId: string;
  accessProfile: "openai";
  oauthResource: "https://openai-mcp.frihet.io";
};

type TokenFamilyRecord = {
  version: 1;
  status: "active" | "revoked";
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

export class OAuthStateStore {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
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
        await this.state.storage.put(STATE_STORAGE_KEY, payload);
        await this.state.storage.setAlarm(Date.now() + STATE_TTL_MS);
        return new Response(null, { status: 204 });
      }

      if (request.method === "POST" && pathname === "/consume") {
        const payload = await this.state.storage.get<string>(STATE_STORAGE_KEY);
        if (!payload) return new Response(null, { status: 404 });
        await this.state.storage.deleteAll();
        return new Response(payload, {
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
            new Set(["currentKind", "currentHash", "expiresAtMs", "apiKeyBinding"]),
          )
          || !isTokenKind(currentKind)
          || !isSha256(currentHash)
          || typeof expiresAtMs !== "number"
          || !Number.isSafeInteger(expiresAtMs)
          || expiresAtMs <= Date.now()
          || expiresAtMs > Date.now() + 366 * 24 * 60 * 60 * 1000
          || (body.apiKeyBinding !== undefined && !apiKeyBinding)
        ) {
          return noStoreJson({ outcome: "invalid" }, 400);
        }

        const existing = await this.state.storage.get<TokenFamilyRecord>(
          TOKEN_FAMILY_STORAGE_KEY,
        );
        if (existing) {
          if (
            existing.status === "active"
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
          record.status = "revoked";
          delete record.inflight;
          await this.state.storage.put(TOKEN_FAMILY_STORAGE_KEY, record);
          return noStoreJson({ outcome: "revoked", apiKeyBinding: record.apiKeyBinding });
        }

        const wasSpent = await this.state.storage.get<boolean>(
          `${TOKEN_FAMILY_SPENT_PREFIX}${credentialHash}`,
        );
        if (wasSpent === true) {
          record.status = "revoked";
          delete record.inflight;
          await this.state.storage.put(TOKEN_FAMILY_STORAGE_KEY, record);
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
            record.status = "revoked";
            delete record.inflight;
            await this.state.storage.put(TOKEN_FAMILY_STORAGE_KEY, record);
            return noStoreJson({ outcome: "replay", apiKeyBinding: record.apiKeyBinding });
          }
          // The provider may have persisted a rotation after the Worker died but
          // before this lease could commit. Never guess which token is current.
          record.status = "revoked";
          delete record.inflight;
          await this.state.storage.put(TOKEN_FAMILY_STORAGE_KEY, record);
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
          record.status = "revoked";
          delete record.inflight;
          await this.state.storage.put(TOKEN_FAMILY_STORAGE_KEY, record);
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
        record.status = "revoked";
        delete record.inflight;
        await this.state.storage.put(TOKEN_FAMILY_STORAGE_KEY, record);
        return noStoreJson({ outcome: "revoked", apiKeyBinding: record.apiKeyBinding });
      }

      return new Response(null, { status: 405 });
    });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
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
