type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const OAUTH_LIFECYCLE_TIMEOUT_MS = 10_000;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FRIHET_OAUTH_API_KEY_URL = "https://api.frihet.io/oauth/api-key";
const CLOUD_FUNCTION_OAUTH_API_KEY_URL =
  "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/publicApi/api/oauth/api-key";
const TRUSTED_OAUTH_API_KEY_URLS = new Set([
  FRIHET_OAUTH_API_KEY_URL,
  CLOUD_FUNCTION_OAUTH_API_KEY_URL,
]);

/**
 * Cross-repo golden shared with the ERP provisioning authority.
 *
 * Keep this literal byte-for-byte aligned with ERP's exported golden. Runtime
 * checks below consume its response/lifetime/key-id fields so a contract edit
 * cannot turn this into inert documentation.
 */
export const OAUTH_PROVISIONING_CONTRACT = {
  contractVersion: "2026-08-30",
  candidateRequestKeys: ["accessProfile", "correlationId", "oauthResource", "uid"],
  legacyRequestKeys: ["uid"],
  responseKeys: ["apiKey", "expiresAt", "keyId"],
  candidateLifetimeDays: 30,
  legacyLifetimeDays: 365,
  keyIdPattern: "^[A-Za-z0-9]{20}$",
  bindings: {
    openai: "https://openai-mcp.frihet.io",
    full: "https://mcp.frihet.io",
  },
  /**
   * Baseline permissions written to legacy (1.16.x-compatible) keys and to
   * candidate keys when the caller does not match a registered profile.
   * Mirror of ERP @berthelius/Frihet-ERP OAUTH_PROVISIONING_CONTRACT — keep
   * byte-for-byte identical.
   */
  permissions: ["read", "write"],
  /**
   * Profile-keyed permission matrix for candidate keys. The MCP side does
   * NOT consume this at runtime (the ERP is the authority on persisted
   * scope), but the literal is mirrored so the cross-repo test pins
   * byte-for-byte parity.
   */
  permissionsByProfile: {
    openai: ["read", "write"],
    full: ["read", "write", "einvoice:*"],
  },
} as const;

export type OAuthProvisioningBinding = {
  uid: string;
  accessProfile: "openai" | "full";
  oauthResource: (typeof OAUTH_PROVISIONING_CONTRACT.bindings)["openai" | "full"];
};

export type ProvisionedOAuthApiKey = OAuthProvisioningBinding & {
  apiKey: string;
  keyId: string;
  expiresAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isValidOAuthServiceSecret(value: unknown): value is string {
  return typeof value === "string"
    && new TextEncoder().encode(value).byteLength >= 32
    && !/[\r\n\0]/u.test(value);
}

/**
 * Leaf-level authority check for requests carrying Firebase/service secrets.
 * Keep this exact rather than suffix-based: URL credentials, ports, queries,
 * fragments, alternate paths, and lookalike hosts must all fail closed.
 */
export function isTrustedOAuthApiKeyUrl(value: string): boolean {
  return TRUSTED_OAUTH_API_KEY_URLS.has(value);
}

/** Accept only the exact one-time credential tuple issued by Frihet. */
export function parseProvisionedOAuthApiKey(
  payload: unknown,
  binding: OAuthProvisioningBinding,
): ProvisionedOAuthApiKey | undefined {
  if (!isRecord(payload)) return undefined;
  const payloadKeys = Object.keys(payload).sort();
  if (
    payloadKeys.length !== OAUTH_PROVISIONING_CONTRACT.responseKeys.length
    || payloadKeys.some((key, index) => key !== OAUTH_PROVISIONING_CONTRACT.responseKeys[index])
  ) {
    return undefined;
  }
  const { apiKey, keyId, expiresAt } = payload;
  const expiresAtMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  const remainingMs = expiresAtMs - Date.now();
  if (
    typeof apiKey !== "string"
    || !/^fri_[A-Za-z0-9_-]{43}$/u.test(apiKey)
    || typeof keyId !== "string"
    || !new RegExp(OAUTH_PROVISIONING_CONTRACT.keyIdPattern, "u").test(keyId)
    || typeof expiresAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(expiresAt)
    || !Number.isFinite(expiresAtMs)
    || new Date(expiresAtMs).toISOString() !== expiresAt
    || remainingMs <= 60_000
    || remainingMs > (OAUTH_PROVISIONING_CONTRACT.candidateLifetimeDays + 1) * 24 * 60 * 60 * 1000
  ) {
    return undefined;
  }
  return { apiKey, keyId, expiresAt, ...binding };
}

/**
 * Credential-bearing OAuth provisioning request.
 *
 * URL authorization is resolved before this leaf is called. Redirects are
 * disabled here, at the fetch that owns the Firebase Bearer header, so a
 * second origin never receives the request.
 */
export function provisionOAuthApiKey(
  provisioningUrl: string,
  idToken: string,
  serviceSecret: string,
  binding: OAuthProvisioningBinding,
  correlationId: string,
  fetchImpl: FetchImplementation = globalThis.fetch,
): Promise<Response> {
  if (!isTrustedOAuthApiKeyUrl(provisioningUrl)) {
    throw new Error("OAuth API-key lifecycle authority is not trusted");
  }
  if (!isValidOAuthServiceSecret(serviceSecret)) {
    throw new Error("OAuth API-key service authentication is not configured");
  }
  if (!UUID_V4_PATTERN.test(correlationId)) {
    throw new Error("OAuth API-key correlation is invalid");
  }
  return fetchImpl(provisioningUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(OAUTH_LIFECYCLE_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
      "x-frihet-oauth-key": serviceSecret,
    },
    body: JSON.stringify({ ...binding, correlationId }),
  });
}

/** Revoke one exact bound key without ever retransmitting its raw credential. */
export function revokeOAuthApiKey(
  provisioningUrl: string,
  serviceSecret: string,
  binding: OAuthProvisioningBinding & { keyId: string },
  fetchImpl: FetchImplementation = globalThis.fetch,
): Promise<Response> {
  if (!isTrustedOAuthApiKeyUrl(provisioningUrl)) {
    throw new Error("OAuth API-key lifecycle authority is not trusted");
  }
  if (!isValidOAuthServiceSecret(serviceSecret)) {
    throw new Error("OAuth API-key service authentication is not configured");
  }
  return fetchImpl(provisioningUrl, {
    method: "DELETE",
    redirect: "error",
    signal: AbortSignal.timeout(OAUTH_LIFECYCLE_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      "x-frihet-oauth-key": serviceSecret,
    },
    body: JSON.stringify(binding),
  });
}
