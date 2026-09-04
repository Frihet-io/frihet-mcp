type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const OAUTH_LIFECYCLE_TIMEOUT_MS = 10_000;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OAUTH_API_KEY_PROVISIONING_URL =
  "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/oauthApiKeyProvisioning";
const FULL_MCP_OAUTH_RESOURCE = "https://mcp.frihet.io";

/**
 * Cross-repo golden shared with the ERP provisioning authority.
 *
 * Keep this literal byte-for-byte aligned with ERP's exported golden. Runtime
 * checks below consume its response/lifetime/key-id fields so a contract edit
 * cannot turn this into inert documentation.
 */
export const OAUTH_PROVISIONING_CONTRACT = {
  contractVersion: "2026-09-04",
  candidateRequestKeys: ["correlationId", "uid"],
  recoveryRequestKeys: [
    "correlationId",
    "identityEmail",
    "operation",
    "runId",
    "uid",
  ],
  legacyRequestKeys: ["uid"],
  responseKeys: ["apiKey", "expiresAt", "keyId"],
  candidateLifetimeDays: 30,
  legacyLifetimeDays: 365,
  keyIdPattern: "^[A-Za-z0-9]{20}$",
  bindings: {
    openai: "https://openai-mcp.frihet.io",
  },
  /**
   * Baseline permissions written to legacy (1.16.x-compatible) keys and to the
   * server-derived OpenAI candidate profile.
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
  },
  cleanupVerification: {
    deleteResponseIsIndependentProof: false,
    liveCanaryProbe: {
      requiredWhenRawKeyAvailable: true,
      method: "GET",
      path: "/api/v1/permissions/me",
      expectedActiveStatus: 200,
      expectedRevokedStatus: 401,
    },
    crashRecovery: {
      rawKeyMayBeUnavailable: true,
      evidence: "correlation-tombstone-plus-zero-active-keys",
      rollbackBlockedOnResidue: true,
    },
  },
} as const;

/**
 * The callback still models both Worker profiles locally so this leaf can
 * reject the full profile before any credential-bearing network request.
 */
export type OAuthProvisioningBinding = {
  uid: string;
  accessProfile: "openai" | "full";
  oauthResource:
    | (typeof OAUTH_PROVISIONING_CONTRACT.bindings)["openai"]
    | typeof FULL_MCP_OAUTH_RESOURCE;
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
  return value === OAUTH_API_KEY_PROVISIONING_URL;
}

function isExactOpenAiBinding(binding: OAuthProvisioningBinding): boolean {
  return binding.accessProfile === "openai"
    && binding.oauthResource === OAUTH_PROVISIONING_CONTRACT.bindings.openai;
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
  if (!isExactOpenAiBinding(binding)) {
    throw new Error("OAuth API-key provisioning is restricted to the OpenAI profile");
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
    body: JSON.stringify({ uid: binding.uid, correlationId }),
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
  if (!isExactOpenAiBinding(binding)) {
    throw new Error("OAuth API-key revocation is restricted to the OpenAI profile");
  }
  if (!new RegExp(OAUTH_PROVISIONING_CONTRACT.keyIdPattern, "u").test(binding.keyId)) {
    throw new Error("OAuth API-key identifier is invalid");
  }
  return fetchImpl(provisioningUrl, {
    method: "DELETE",
    redirect: "error",
    signal: AbortSignal.timeout(OAUTH_LIFECYCLE_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      "x-frihet-oauth-key": serviceSecret,
    },
    body: JSON.stringify({ uid: binding.uid, keyId: binding.keyId }),
  });
}
