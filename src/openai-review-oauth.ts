/**
 * OAuth contract inputs shared by the real Worker and the OpenAI descriptor
 * freeze gate. Values in this module are public protocol metadata, not secrets.
 */

export const OPENAI_REVIEW_ORIGIN = "https://openai-mcp.frihet.io";
export const FULL_MCP_ORIGIN = "https://mcp.frihet.io";
export const FRIHET_CONNECTOR_SCOPE = "frihet:workspace.manage";

/** RFC 7636 S256 challenges are the 32-byte SHA-256 digest encoded as
 * unpadded base64url, which is always exactly 43 characters. */
export function isValidS256CodeChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/u.test(value);
}

/** RFC 7636 code_verifier ABNF: 43–128 unreserved URI characters. */
export function isValidPKCECodeVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/u.test(value);
}

export type FrihetAccessProfile = "openai" | "full";

/** Fail closed if a Worker deploy omits or mistypes its profile binding. */
export function resolveFrihetAccessProfile(value: string | undefined): FrihetAccessProfile {
  if (value === "true") return "openai";
  if (value === "false") return "full";
  throw new Error("FRIHET_OPENAI_MODE must be explicitly set to true or false");
}

interface FrozenOAuthProviderOptions {
  apiRoute: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  clientRegistrationEndpoint: string;
  scopesSupported: string[];
  accessTokenTTL: number;
  refreshTokenTTL: number;
  allowPlainPKCE: boolean;
  resourceMetadata: {
    resource: string;
    authorization_servers: string[];
    scopes_supported: string[];
    bearer_methods_supported: string[];
    resource_name: string;
  };
}

/**
 * Byte-compatible extraction of the options previously inlined in the Worker.
 * index.ts spreads this object into the real OAuthProvider constructor.
 */
export const OAUTH_PROVIDER_REVIEW_OPTIONS = {
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  // This provider does not implement per-tool OAuth authorization. Advertise
  // one honest connector-wide scope instead of implying that `read` prevents
  // writes. Every mutating reviewed tool still requires confirm=true.
  scopesSupported: [FRIHET_CONNECTOR_SCOPE],
  accessTokenTTL: 3600,
  refreshTokenTTL: 2592000,
  allowPlainPKCE: false,
  resourceMetadata: {
    resource: OPENAI_REVIEW_ORIGIN,
    authorization_servers: [OPENAI_REVIEW_ORIGIN],
    scopes_supported: [FRIHET_CONNECTOR_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Frihet ChatGPT connector",
  },
} satisfies FrozenOAuthProviderOptions;

export type OAuthBoundaryError = "invalid_target" | "invalid_scope";

export type OAuthBoundaryResult =
  | { ok: true }
  | { ok: false; error: OAuthBoundaryError; description: string };

interface OAuthBoundaryParameters {
  resource?: string | string[];
  scope?: string | string[];
  /** The authorization request creates the grant and must carry the canonical
   * resource. Later token/refresh requests may omit it because the provider
   * inherits the already-validated value stored on that grant. */
  requireResource: boolean;
  /** Authorization requests must include the advertised scope. Token refresh
   * requests may omit it because the provider reuses the validated grant. */
  requireScope: boolean;
}

/**
 * Validate the two OAuth values that form the reviewed-host authorization
 * boundary. RFC 8707 resource comparison is exact by design: accepting an
 * arbitrary absolute URI would let a token minted by one Frihet Worker target
 * the other Worker. Unknown or empty scopes are rejected instead of silently
 * downscoping to an empty token.
 */
export function validateOAuthBoundary(
  parameters: OAuthBoundaryParameters,
  expectedResource: string,
): OAuthBoundaryResult {
  if (parameters.resource === undefined && !parameters.requireResource) {
    // The provider will inherit the exact resource stored on the grant.
  } else if (
    typeof parameters.resource !== "string"
    || parameters.resource !== expectedResource
  ) {
    return {
      ok: false,
      error: "invalid_target",
      description: "The OAuth resource must exactly match this Frihet MCP server.",
    };
  }

  if (parameters.scope === undefined && !parameters.requireScope) return { ok: true };
  const scopes = Array.isArray(parameters.scope)
    ? parameters.scope
    : typeof parameters.scope === "string"
      ? parameters.scope.split(/\s+/u).filter(Boolean)
      : [];
  if (scopes.length !== 1 || scopes[0] !== FRIHET_CONNECTOR_SCOPE) {
    return {
      ok: false,
      error: "invalid_scope",
      description: `The only supported OAuth scope is ${FRIHET_CONNECTOR_SCOPE}.`,
    };
  }
  return { ok: true };
}

function endpoint(origin: string, path: string): string {
  return new URL(path, new URL(origin).origin).toString();
}

export function buildOpenAIUnauthorizedChallenge(
  origin = OPENAI_REVIEW_ORIGIN,
): string {
  const resourceMetadataUrl = endpoint(
    new URL(origin).origin,
    "/.well-known/oauth-protected-resource",
  );
  return `Bearer realm="OAuth", resource_metadata="${resourceMetadataUrl}", ` +
    `scope="${FRIHET_CONNECTOR_SCOPE}", error="invalid_token", ` +
    'error_description="Missing or invalid access token"';
}

/**
 * Materialize the public metadata generated by workers-oauth-provider 0.3.0
 * from the same options used by the Worker. The dependency version is pinned
 * separately in the canonical descriptor snapshot.
 */
export function buildOpenAIReviewOAuthContract(origin = OPENAI_REVIEW_ORIGIN) {
  const normalizedOrigin = new URL(origin).origin;
  const authorizationEndpoint = endpoint(
    normalizedOrigin,
    OAUTH_PROVIDER_REVIEW_OPTIONS.authorizeEndpoint,
  );
  const tokenEndpoint = endpoint(
    normalizedOrigin,
    OAUTH_PROVIDER_REVIEW_OPTIONS.tokenEndpoint,
  );
  const registrationEndpoint = endpoint(
    normalizedOrigin,
    OAUTH_PROVIDER_REVIEW_OPTIONS.clientRegistrationEndpoint,
  );
  const resourceMetadataUrl = endpoint(
    normalizedOrigin,
    "/.well-known/oauth-protected-resource",
  );

  return {
    authorizationServer: {
      issuer: normalizedOrigin,
      authorization_endpoint: authorizationEndpoint,
      token_endpoint: tokenEndpoint,
      registration_endpoint: registrationEndpoint,
      scopes_supported: [...OAUTH_PROVIDER_REVIEW_OPTIONS.scopesSupported],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
        "none",
      ],
      revocation_endpoint: tokenEndpoint,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: false,
    },
    protectedResource: {
      resource: normalizedOrigin,
      authorization_servers: [normalizedOrigin],
      scopes_supported: [...OAUTH_PROVIDER_REVIEW_OPTIONS.scopesSupported],
      bearer_methods_supported: ["header"],
      resource_name: OAUTH_PROVIDER_REVIEW_OPTIONS.resourceMetadata.resource_name,
    },
    wwwAuthenticate: {
      resourceMetadataUrl,
      missingTokenHeader: buildOpenAIUnauthorizedChallenge(normalizedOrigin),
    },
  };
}
