import type { TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import type {
  OAuthApiKeyBinding,
  OAuthTokenFamilyBeginResult,
  OAuthTokenFamilyCheckResult,
  OAuthTokenFamilyCommitResult,
  OAuthTokenKind,
} from "./oauth-state-store.js";

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TOKEN_RESPONSE_BYTES = 16 * 1024;
const INTERNAL_ORIGIN = "https://oauth-state.internal";
const REVIEWED_RESOURCE = "https://openai-mcp.frihet.io";
const REVIEWED_SCOPE = "frihet:workspace.manage";

type StructuredOAuthCredential = {
  raw: string;
  userId: string;
  grantId: string;
};

type OAuthGrantRecord = {
  clientId?: unknown;
  authCodeId?: unknown;
  refreshTokenId?: unknown;
  previousRefreshTokenId?: unknown;
  expiresAt?: unknown;
};

type OAuthAccessTokenRecord = {
  expiresAt?: unknown;
  grant?: {
    clientId?: unknown;
  };
};

export type OAuthTokenFamilySettlement = {
  response: Response;
  revokeGrant: boolean;
  apiKeyBinding?: OAuthApiKeyBinding;
};

export class OAuthTokenFamilyGuardError extends Error {
  readonly reason: "invalid" | "replay" | "revoked";
  readonly apiKeyBinding?: OAuthApiKeyBinding;

  constructor(
    reason: "invalid" | "replay" | "revoked",
    apiKeyBinding?: OAuthApiKeyBinding,
  ) {
    super(`OAuth token family guard rejected the exchange (${reason})`);
    this.name = "OAuthTokenFamilyGuardError";
    this.reason = reason;
    this.apiKeyBinding = apiKeyBinding;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseStructuredOAuthCredential(raw: string): StructuredOAuthCredential | undefined {
  if (raw.length > 512) return undefined;
  const parts = raw.split(":");
  if (parts.length !== 3) return undefined;
  const [userId, grantId, secret] = parts;
  if (
    !userId
    || userId.length > 128
    || !/^[A-Za-z0-9_-]{16}$/u.test(grantId ?? "")
    || !/^[A-Za-z0-9_-]{32}$/u.test(secret ?? "")
  ) {
    return undefined;
  }
  return { raw, userId, grantId };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function tokenFamilyStub(
  namespace: DurableObjectNamespace,
  userId: string,
  grantId: string,
): Promise<DurableObjectStub> {
  const tuple = new TextEncoder().encode(`openai-token-family\0${userId}\0${grantId}`);
  const digest = await crypto.subtle.digest("SHA-256", tuple);
  const familyId = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return namespace.get(namespace.idFromName(`oauth-token-family:${familyId}`));
}

async function initializeOAuthTokenFamily(
  namespace: DurableObjectNamespace,
  userId: string,
  grantId: string,
  input: {
    currentKind: OAuthTokenKind;
    currentHash: string;
    expiresAtMs: number;
    apiKeyBinding?: OAuthApiKeyBinding;
  },
): Promise<void> {
  const response = await (await tokenFamilyStub(namespace, userId, grantId)).fetch(
    `${INTERNAL_ORIGIN}/token-family`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, grantId, ...input }),
    },
  );
  if (!response.ok) {
    throw new Error(`OAuth token family initialization failed (${response.status})`);
  }
}

/**
 * Strongly-consistent guard for an access token already accepted from OAuth KV.
 * KV revocation is eventually consistent, so the Durable Object tombstone is
 * checked before the token can reach the MCP session or backend credential.
 */
export async function isOAuthAccessTokenFamilyActive(
  namespace: DurableObjectNamespace,
  request: Request,
  expectedUserId: string | undefined,
): Promise<boolean> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || !expectedUserId) return false;
  const credential = parseStructuredOAuthCredential(authorization.slice(7));
  if (!credential || credential.userId !== expectedUserId) return false;
  const response = await (await tokenFamilyStub(
    namespace,
    credential.userId,
    credential.grantId,
  )).fetch(`${INTERNAL_ORIGIN}/token-family/status`);
  if (!response.ok) return false;
  try {
    const body = await response.json<unknown>();
    return isRecord(body)
      && Object.keys(body).length === 1
      && body.outcome === "active";
  } catch {
    return false;
  }
}

async function beginOAuthTokenFamilyUse(
  namespace: DurableObjectNamespace,
  userId: string,
  grantId: string,
  input: { kind: OAuthTokenKind; credentialHash: string },
): Promise<OAuthTokenFamilyBeginResult> {
  const response = await (await tokenFamilyStub(namespace, userId, grantId)).fetch(
    `${INTERNAL_ORIGIN}/token-family/begin`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    throw new Error(`OAuth token family begin failed (${response.status})`);
  }
  return response.json<OAuthTokenFamilyBeginResult>();
}

async function checkOAuthTokenFamilyUse(
  namespace: DurableObjectNamespace,
  userId: string,
  grantId: string,
  input: { kind: OAuthTokenKind; credentialHash: string },
): Promise<OAuthTokenFamilyCheckResult> {
  const response = await (await tokenFamilyStub(namespace, userId, grantId)).fetch(
    `${INTERNAL_ORIGIN}/token-family/check`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    throw new Error(`OAuth token family check failed (${response.status})`);
  }
  return response.json<OAuthTokenFamilyCheckResult>();
}

async function commitOAuthTokenFamilyUse(
  namespace: DurableObjectNamespace,
  userId: string,
  grantId: string,
  input: {
    leaseId: string;
    newRefreshTokenHash: string;
    apiKeyBinding?: OAuthApiKeyBinding;
  },
): Promise<OAuthTokenFamilyCommitResult> {
  const response = await (await tokenFamilyStub(namespace, userId, grantId)).fetch(
    `${INTERNAL_ORIGIN}/token-family/commit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    throw new Error(`OAuth token family commit failed (${response.status})`);
  }
  return response.json<OAuthTokenFamilyCommitResult>();
}

async function revokeOAuthTokenFamily(
  namespace: DurableObjectNamespace,
  userId: string,
  grantId: string,
): Promise<OAuthApiKeyBinding | undefined> {
  const response = await (await tokenFamilyStub(namespace, userId, grantId)).fetch(
    `${INTERNAL_ORIGIN}/token-family/revoke`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new Error(`OAuth token family revoke failed (${response.status})`);
  }
  const result = await response.json<{
    outcome: string;
    apiKeyBinding?: OAuthApiKeyBinding;
  }>();
  return result.apiKeyBinding;
}

export async function hashOAuthFamilyCredential(
  kind: OAuthTokenKind,
  rawCredential: string,
): Promise<string> {
  return sha256Hex(`${kind}\0${rawCredential}`);
}

function invalidGrantResponse(description: string): Response {
  return new Response(JSON.stringify({
    error: "invalid_grant",
    error_description: description,
  }), {
    status: 400,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
    },
  });
}

function extractPresentedClientId(request: Request, form: URLSearchParams): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Basic ")) {
    try {
      const decoded = atob(authorization.slice(6));
      const separator = decoded.indexOf(":");
      const encodedId = separator >= 0 ? decoded.slice(0, separator) : decoded;
      const clientId = decodeURIComponent(encodedId);
      return clientId || undefined;
    } catch {
      return undefined;
    }
  }
  return form.get("client_id") || undefined;
}

function replaceRevocationToken(request: Request, form: URLSearchParams): Request {
  const sanitized = new URLSearchParams(form);
  sanitized.set("token", "invalid");
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request, {
    headers,
    body: sanitized.toString(),
  });
}

async function parseBoundedJson(response: Response): Promise<Record<string, unknown> | undefined> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TOKEN_RESPONSE_BYTES) {
    return undefined;
  }
  const text = await response.clone().text();
  if (new TextEncoder().encode(text).byteLength > MAX_TOKEN_RESPONSE_BYTES) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function expiryFromGrant(record: OAuthGrantRecord | null): number {
  const expiresAt = record?.expiresAt;
  if (typeof expiresAt === "number" && Number.isSafeInteger(expiresAt)) {
    const millis = expiresAt * 1000;
    if (millis > Date.now()) return millis;
  }
  return Date.now() + REFRESH_TOKEN_TTL_MS;
}

/**
 * Per-request coordinator for the package-owned `/token` handler.
 *
 * The provider callback runs after it validates the credential/client and
 * before it writes a rotated grant. This coordinator captures the raw request
 * credential only in Worker memory, reserves the family in a Durable Object,
 * and withholds the provider's 200 response until the new token hash commits.
 */
export class OAuthTokenFamilyExchange {
  private leaseId?: string;
  private providerValidatedCredential = false;
  private storedApiKeyBinding?: OAuthApiKeyBinding;
  private readonly familyHashPromise: Promise<string>;
  private readonly providerHashPromise: Promise<string>;
  private readonly kind: OAuthTokenKind;
  private readonly credential: StructuredOAuthCredential;
  private readonly namespace: DurableObjectNamespace;
  private readonly oauthKv: KVNamespace;

  private constructor(
    kind: OAuthTokenKind,
    credential: StructuredOAuthCredential,
    namespace: DurableObjectNamespace,
    oauthKv: KVNamespace,
  ) {
    this.kind = kind;
    this.credential = credential;
    this.namespace = namespace;
    this.oauthKv = oauthKv;
    this.familyHashPromise = hashOAuthFamilyCredential(kind, credential.raw);
    this.providerHashPromise = sha256Hex(credential.raw);
  }

  static fromForm(
    form: URLSearchParams,
    namespace: DurableObjectNamespace,
    oauthKv: KVNamespace,
  ): OAuthTokenFamilyExchange | undefined {
    const grantType = form.get("grant_type");
    const kind = grantType === "authorization_code"
      ? "authorization_code"
      : grantType === "refresh_token"
        ? "refresh_token"
        : undefined;
    if (!kind) return undefined;
    const raw = form.get(kind === "authorization_code" ? "code" : "refresh_token");
    if (!raw) return undefined;
    const credential = parseStructuredOAuthCredential(raw);
    return credential
      ? new OAuthTokenFamilyExchange(kind, credential, namespace, oauthKv)
      : undefined;
  }

  get family(): { userId: string; grantId: string } {
    return {
      userId: this.credential.userId,
      grantId: this.credential.grantId,
    };
  }

  hasLease(): boolean {
    return this.leaseId !== undefined;
  }

  /** True only after the provider callback proves the submitted credential. */
  hasValidatedCredential(): boolean {
    return this.providerValidatedCredential;
  }

  get apiKeyBinding(): OAuthApiKeyBinding | undefined {
    return this.storedApiKeyBinding;
  }

  /** Called only from the provider's already-validated token callback. */
  async reserve(
    options: TokenExchangeCallbackOptions,
    apiKeyBinding: OAuthApiKeyBinding,
  ): Promise<void> {
    if (
      options.userId !== this.credential.userId
      || apiKeyBinding.uid !== options.userId
    ) {
      throw new OAuthTokenFamilyGuardError("invalid", apiKeyBinding);
    }
    this.providerValidatedCredential = true;
    this.storedApiKeyBinding = apiKeyBinding;

    const [familyHash, providerHash, grant] = await Promise.all([
      this.familyHashPromise,
      this.providerHashPromise,
      this.oauthKv.get<OAuthGrantRecord>(
        `grant:${this.credential.userId}:${this.credential.grantId}`,
        { type: "json" },
      ),
    ]);
    const currentProviderHash = this.kind === "authorization_code"
      ? grant?.authCodeId
      : grant?.refreshTokenId;
    const previousProviderHash = this.kind === "refresh_token"
      ? grant?.previousRefreshTokenId
      : undefined;

    let begin = await beginOAuthTokenFamilyUse(
      this.namespace,
      this.credential.userId,
      this.credential.grantId,
      { kind: this.kind, credentialHash: familyHash },
    );

    if (begin.outcome === "missing") {
      if (currentProviderHash === providerHash) {
        await initializeOAuthTokenFamily(
          this.namespace,
          this.credential.userId,
          this.credential.grantId,
          {
            currentKind: this.kind,
            currentHash: familyHash,
            expiresAtMs: expiryFromGrant(grant),
            apiKeyBinding,
          },
        );
        begin = await beginOAuthTokenFamilyUse(
          this.namespace,
          this.credential.userId,
          this.credential.grantId,
          { kind: this.kind, credentialHash: familyHash },
        );
      } else if (previousProviderHash === providerHash) {
        // Legacy family first seen through the provider's deliberately accepted
        // previous token. Tombstone it rather than blessing the replay as head.
        await initializeOAuthTokenFamily(
          this.namespace,
          this.credential.userId,
          this.credential.grantId,
          {
            currentKind: this.kind,
            currentHash: familyHash,
            expiresAtMs: expiryFromGrant(grant),
            apiKeyBinding,
          },
        );
        await revokeOAuthTokenFamily(
          this.namespace,
          this.credential.userId,
          this.credential.grantId,
        );
        throw new OAuthTokenFamilyGuardError("replay", apiKeyBinding);
      } else {
        // The provider validated a credential that a second KV read cannot
        // confirm. Persist a tombstone/outbox before withholding the response;
        // eventual-consistency ambiguity must not issue or retain tokens.
        await initializeOAuthTokenFamily(
          this.namespace,
          this.credential.userId,
          this.credential.grantId,
          {
            currentKind: this.kind,
            currentHash: familyHash,
            expiresAtMs: expiryFromGrant(grant),
            apiKeyBinding,
          },
        );
        await revokeOAuthTokenFamily(
          this.namespace,
          this.credential.userId,
          this.credential.grantId,
        );
        throw new OAuthTokenFamilyGuardError("revoked", apiKeyBinding);
      }
    }

    if (begin.outcome !== "started") {
      if (begin.outcome === "invalid" || begin.outcome === "busy") {
        await revokeOAuthTokenFamily(
          this.namespace,
          this.credential.userId,
          this.credential.grantId,
        );
      }
      throw new OAuthTokenFamilyGuardError(
        begin.outcome === "replay" || begin.outcome === "busy" ? "replay" : "revoked",
        begin.apiKeyBinding ?? apiKeyBinding,
      );
    }

    this.leaseId = begin.leaseId;
    this.storedApiKeyBinding = begin.apiKeyBinding ?? apiKeyBinding;
  }

  async settle(response: Response): Promise<OAuthTokenFamilySettlement> {
    const parsed = await parseBoundedJson(response);
    if (!this.leaseId) {
      if (response.status === 400 && parsed?.error === "invalid_grant") {
        const check = await checkOAuthTokenFamilyUse(
          this.namespace,
          this.credential.userId,
          this.credential.grantId,
          { kind: this.kind, credentialHash: await this.familyHashPromise },
        );
        if (check.outcome === "spent" || check.outcome === "revoked") {
          const apiKeyBinding = await revokeOAuthTokenFamily(
            this.namespace,
            this.credential.userId,
            this.credential.grantId,
          );
          return {
            response,
            revokeGrant: true,
            apiKeyBinding: apiKeyBinding ?? check.apiKeyBinding,
          };
        }
      }
      return { response, revokeGrant: false };
    }

    if (
      !response.ok
      || !parsed
      || parsed.token_type !== "bearer"
      || parsed.scope !== REVIEWED_SCOPE
      || parsed.resource !== REVIEWED_RESOURCE
      || typeof parsed.expires_in !== "number"
      || !Number.isSafeInteger(parsed.expires_in)
      || parsed.expires_in < 1
      || parsed.expires_in > 3600
    ) {
      const apiKeyBinding = await this.revoke();
      return {
        response: invalidGrantResponse("OAuth token rotation could not be completed safely."),
        revokeGrant: true,
        apiKeyBinding,
      };
    }

    const accessToken = typeof parsed.access_token === "string"
      ? parseStructuredOAuthCredential(parsed.access_token)
      : undefined;
    const refreshToken = typeof parsed.refresh_token === "string"
      ? parseStructuredOAuthCredential(parsed.refresh_token)
      : undefined;
    if (
      !accessToken
      || !refreshToken
      || accessToken.userId !== this.credential.userId
      || accessToken.grantId !== this.credential.grantId
      || refreshToken.userId !== this.credential.userId
      || refreshToken.grantId !== this.credential.grantId
      || accessToken.raw === refreshToken.raw
      || accessToken.raw === this.credential.raw
      || refreshToken.raw === this.credential.raw
    ) {
      const apiKeyBinding = await this.revoke();
      return {
        response: invalidGrantResponse("OAuth token rotation returned an invalid family."),
        revokeGrant: true,
        apiKeyBinding,
      };
    }

    const newRefreshTokenHash = await hashOAuthFamilyCredential(
      "refresh_token",
      refreshToken.raw,
    );
    const committed = await commitOAuthTokenFamilyUse(
      this.namespace,
      this.credential.userId,
      this.credential.grantId,
      {
        leaseId: this.leaseId,
        newRefreshTokenHash,
        apiKeyBinding: this.storedApiKeyBinding,
      },
    );
    this.leaseId = undefined;
    if (committed.outcome !== "committed") {
      const apiKeyBinding = await this.revoke();
      return {
        response: invalidGrantResponse("OAuth token family was revoked."),
        revokeGrant: true,
        apiKeyBinding: apiKeyBinding ?? committed.apiKeyBinding,
      };
    }
    return {
      response,
      revokeGrant: false,
      apiKeyBinding: committed.apiKeyBinding,
    };
  }

  async settleThrown(error: unknown): Promise<OAuthTokenFamilySettlement | undefined> {
    if (error instanceof OAuthTokenFamilyGuardError) {
      return {
        response: invalidGrantResponse("OAuth refresh-token replay was detected; reconnect Frihet."),
        revokeGrant: error.reason !== "invalid",
        apiKeyBinding: error.apiKeyBinding,
      };
    }
    if (!this.leaseId) return undefined;
    const apiKeyBinding = await this.revoke();
    return {
      response: invalidGrantResponse("OAuth token rotation failed closed; reconnect Frihet."),
      revokeGrant: true,
      apiKeyBinding,
    };
  }

  async revoke(): Promise<OAuthApiKeyBinding | undefined> {
    this.leaseId = undefined;
    const apiKeyBinding = await revokeOAuthTokenFamily(
      this.namespace,
      this.credential.userId,
      this.credential.grantId,
    );
    return apiKeyBinding ?? this.storedApiKeyBinding;
  }
}

/**
 * Mirrors the provider's RFC 7009 token classification before it mutates KV.
 * Version 0.3 authenticates the submitting client but does not verify that the
 * token belongs to that client. A cross-client token is therefore replaced by
 * an invalid opaque value while leaving client authentication to the provider.
 * A same-client refresh-token revocation also tombstones the local family so
 * its bound Frihet API key can be revoked after the provider returns success.
 */
export class OAuthTokenFamilyRevocation {
  private shouldRevokeFamily = false;
  private storedApiKeyBinding?: OAuthApiKeyBinding;
  private readonly credential: StructuredOAuthCredential;
  private readonly namespace: DurableObjectNamespace;
  private readonly oauthKv: KVNamespace;

  private constructor(
    credential: StructuredOAuthCredential,
    namespace: DurableObjectNamespace,
    oauthKv: KVNamespace,
  ) {
    this.credential = credential;
    this.namespace = namespace;
    this.oauthKv = oauthKv;
  }

  static fromForm(
    form: URLSearchParams,
    namespace: DurableObjectNamespace,
    oauthKv: KVNamespace,
  ): OAuthTokenFamilyRevocation | undefined {
    // The provider treats an absent OR empty grant_type as revocation.
    if (form.get("grant_type")) return undefined;
    const raw = form.get("token");
    if (!raw) return undefined;
    const credential = parseStructuredOAuthCredential(raw);
    return credential
      ? new OAuthTokenFamilyRevocation(credential, namespace, oauthKv)
      : undefined;
  }

  get family(): { userId: string; grantId: string } {
    return {
      userId: this.credential.userId,
      grantId: this.credential.grantId,
    };
  }

  get apiKeyBinding(): OAuthApiKeyBinding | undefined {
    return this.storedApiKeyBinding;
  }

  async protectRequest(request: Request, form: URLSearchParams): Promise<Request> {
    const providerHash = await sha256Hex(this.credential.raw);
    const grantKey = `grant:${this.credential.userId}:${this.credential.grantId}`;
    const accessKey = `token:${this.credential.userId}:${this.credential.grantId}:${providerHash}`;
    const [grant, accessToken] = await Promise.all([
      this.oauthKv.get<OAuthGrantRecord>(grantKey, { type: "json" }),
      this.oauthKv.get<OAuthAccessTokenRecord>(accessKey, { type: "json" }),
    ]);

    const now = Math.floor(Date.now() / 1000);
    const isAccessToken = typeof accessToken?.expiresAt === "number"
      && Number.isFinite(accessToken.expiresAt)
      && accessToken.expiresAt >= now;
    const isRefreshToken = !isAccessToken
      && (
        grant?.refreshTokenId === providerHash
        || grant?.previousRefreshTokenId === providerHash
      );
    const ownerClientId = isAccessToken
      ? accessToken.grant?.clientId
      : isRefreshToken
        ? grant?.clientId
        : undefined;

    if (typeof ownerClientId !== "string") {
      return request;
    }
    if (extractPresentedClientId(request, form) !== ownerClientId) {
      return replaceRevocationToken(request, form);
    }

    this.shouldRevokeFamily = isRefreshToken;
    return request;
  }

  async settle(response: Response): Promise<OAuthTokenFamilySettlement> {
    if (!response.ok || !this.shouldRevokeFamily) {
      return { response, revokeGrant: false };
    }
    this.storedApiKeyBinding = await revokeOAuthTokenFamily(
      this.namespace,
      this.credential.userId,
      this.credential.grantId,
    );
    return {
      response,
      revokeGrant: true,
      apiKeyBinding: this.storedApiKeyBinding,
    };
  }
}
