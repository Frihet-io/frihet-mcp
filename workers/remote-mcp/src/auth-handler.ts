/**
 * Hono app handling the OAuth authorization flow and public endpoints.
 *
 * Routes:
 *   GET  /           — Server info JSON
 *   GET  /health     — Health check
 *   GET  /authorize  — OAuth authorize: show Firebase login page
 *   POST /callback   — Receive Firebase ID token, verify, provision API key, complete OAuth
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import {
  parseProvisionedOAuthApiKey,
  provisionOAuthApiKey,
  revokeOAuthApiKey,
} from "./oauth-provisioning.js";
import { resolveOAuthApiKeyUrl } from "./api-url.js";
import { getLoginPage } from "./login-page.js";
import { consumeOAuthState, storeOAuthState } from "./oauth-state-store.js";
import {
  BoundedRequestBodyError,
  readBoundedTextRequest,
} from "./bounded-request-body.js";
import { log } from "../../../src/logger.js";
import {
  MCP_SERVER_VERSION,
  FULL_REMOTE_PROMPT_COUNT,
  FULL_REMOTE_RESOURCE_COUNT,
  FULL_REMOTE_TOOL_COUNT,
  FULL_TOOL_COUNT,
  FISCAL_ALIAS_TOOL_COUNT,
} from "./server-meta.js";
import { GROUPED_META_TOOL_COUNT } from "../../../src/tool-exposure.js";
import { OPENAI_ALLOWED_TOOL_COUNT } from "../../../src/openai-profile.js";
import {
  FRIHET_CONNECTOR_SCOPE,
  FULL_MCP_ORIGIN,
  isValidS256CodeChallenge,
  OPENAI_REVIEW_ORIGIN,
  resolveFrihetAccessProfile,
  validateOAuthBoundary,
} from "../../../src/openai-review-oauth.js";

type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };
const OAUTH_CALLBACK_MAX_BODY_BYTES = 20 * 1024;

import { readRecoveryBody } from "./recovery-body.js";
export { readRecoveryBody } from "./recovery-body.js";

const app = new Hono<{ Bindings: AuthEnv }>();

function validateReviewedAuthorizeQuery(request: Request): string | undefined {
  const params = new URL(request.url).searchParams;
  const critical = [
    "response_type",
    "client_id",
    "redirect_uri",
    "resource",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
  ];
  const duplicate = critical.find((key) => params.getAll(key).length !== 1);
  if (duplicate) return `OAuth parameter ${duplicate} must appear exactly once.`;
  if (!(params.get("state") ?? "").trim()) {
    return "OAuth parameter state must be non-empty.";
  }
  if (params.get("response_type") !== "code") {
    return "Only the OAuth authorization code response type is supported.";
  }
  if (params.get("code_challenge_method") !== "S256") {
    return "PKCE code_challenge_method must be S256.";
  }
  const challenge = params.get("code_challenge") ?? "";
  if (!isValidS256CodeChallenge(challenge)) {
    return "PKCE S256 code_challenge must be exactly 43 base64url characters.";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public endpoints
// ---------------------------------------------------------------------------

app.get("/", (c) => {
  const openai = resolveFrihetAccessProfile(c.env.FRIHET_OPENAI_MODE) === "openai";
  const host = openai ? "https://openai-mcp.frihet.io" : "https://mcp.frihet.io";
  return c.json({
    name: "Frihet MCP Server",
    version: MCP_SERVER_VERSION,
    description:
      "AI-native business management — invoices, expenses, clients, products, quotes",
    docs: "https://docs.frihet.io/desarrolladores/mcp-server",
    openapi: "https://api.frihet.io/openapi.yaml",
    mcp: `${host}/mcp`,
    status: "https://status.frihet.io",
    auth: {
      type: "oauth2",
      authorization_server: `${host}/.well-known/oauth-authorization-server`,
    },
    tools: openai
      ? OPENAI_ALLOWED_TOOL_COUNT
      : FULL_REMOTE_TOOL_COUNT,
    ...(openai
      ? { reviewedBusinessOperations: OPENAI_ALLOWED_TOOL_COUNT }
      : {
          catalogueOperations: FULL_TOOL_COUNT,
          aliasNames: FISCAL_ALIAS_TOOL_COUNT,
          capabilityMetadata: "io.frihet/capability",
        }),
    discoveryNames: openai ? 0 : GROUPED_META_TOOL_COUNT,
    resources: openai ? 0 : FULL_REMOTE_RESOURCE_COUNT,
    prompts: openai ? 0 : FULL_REMOTE_PROMPT_COUNT,
  });
});

app.get("/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);


// ---------------------------------------------------------------------------
// OAuth: Authorization — show Firebase login page
// ---------------------------------------------------------------------------

app.get("/authorize", async (c) => {
  const accessProfile = resolveFrihetAccessProfile(c.env.FRIHET_OPENAI_MODE);
  if (accessProfile === "openai") {
    const queryError = validateReviewedAuthorizeQuery(c.req.raw);
    if (queryError) {
      return c.json({ error: "invalid_request", error_description: queryError }, 400);
    }
  }
  let oauthReq;
  try {
    oauthReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (err) {
    log({
      level: "warn",
      message: "Invalid OAuth authorize request",
      operation: "oauth_authorize",
      error: { message: err instanceof Error ? err.message : String(err) },
    });
    return c.text(
      "Invalid OAuth request. Ensure client_id is registered via /register first.",
      400,
    );
  }
  if (!oauthReq) {
    log({
      level: "warn",
      message: "OAuth authorize request parsed to null",
      operation: "oauth_authorize",
    });
    return c.text("Invalid OAuth request", 400);
  }

  if (accessProfile === "openai") {
    const boundary = validateOAuthBoundary(
      {
        resource: oauthReq.resource,
        scope: oauthReq.scope,
        requireResource: true,
        requireScope: true,
      },
      OPENAI_REVIEW_ORIGIN,
    );
    if (!boundary.ok) {
      log({
        level: "warn",
        message: "OAuth authorize request rejected by host boundary",
        operation: "oauth_authorize",
        metadata: { error: boundary.error },
      });
      return c.json(
        { error: boundary.error, error_description: boundary.description },
        400,
      );
    }
  }

  log({
    level: "info",
    message: `OAuth authorize started for client ${oauthReq.clientId}`,
    operation: "oauth_authorize",
    metadata: { clientId: oauthReq.clientId },
  });

  // Resolve the registered client before allocating one-time state. Besides
  // grounding the consent screen in the registered name/callback, this avoids
  // giving unknown client IDs a state-allocation primitive.
  let clientInfo;
  try {
    clientInfo = await c.env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  } catch (err) {
    log({
      level: "warn",
      message: "OAuth client lookup failed",
      operation: "oauth_authorize",
      error: { message: err instanceof Error ? err.message : String(err) },
    });
    return c.json({ error: "invalid_client" }, 400);
  }
  if (!clientInfo) {
    return c.json({ error: "invalid_client" }, 400);
  }

  // Store the request in a single-use Durable Object. KV cannot atomically
  // get-and-delete, which lets concurrent callbacks replay one state value.
  const stateKey = crypto.randomUUID();
  await storeOAuthState(c.env.OAUTH_STATE, stateKey, JSON.stringify(oauthReq));

  return c.html(
    getLoginPage({
      stateKey,
      clientId: oauthReq.clientId,
      firebaseProjectId: c.env.FIREBASE_PROJECT_ID,
      accessProfile,
      clientName: clientInfo?.clientName,
      redirectUri: oauthReq.redirectUri,
    }),
  );
});

// ---------------------------------------------------------------------------
// OAuth: Callback — after Firebase auth, receive ID token via POST
// ---------------------------------------------------------------------------

app.post("/callback", async (c) => {
  let body: {
    stateKey: string;
    idToken: string;
    locale?: string;
  };
  try {
    const bounded = await readBoundedTextRequest(
      c.req.raw,
      OAUTH_CALLBACK_MAX_BODY_BYTES,
    );
    const parsed: unknown = JSON.parse(bounded.text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SyntaxError("Callback body must be an object");
    }
    body = parsed as typeof body;
  } catch (error) {
    if (
      error instanceof BoundedRequestBodyError
      && error.code === "too_large"
    ) {
      return c.json({ error: "Callback body is too large" }, 413);
    }
    return c.json({ error: "Invalid callback body" }, 400);
  }
  if (
    typeof body.stateKey !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(body.stateKey)
    || typeof body.idToken !== "string"
    || body.idToken.length === 0
    || body.idToken.length > 16_384
    || (
      body.locale !== undefined
      && (typeof body.locale !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/u.test(body.locale))
    )
  ) {
    return c.json({ error: "Invalid callback body" }, 400);
  }

  // Atomically consume the original request before any credential provisioning
  // or code issuance. A failed callback must restart authorization; this is the
  // fail-closed tradeoff that guarantees one state cannot mint two grants.
  const oauthReq = await consumeOAuthState<AuthRequest>(c.env.OAUTH_STATE, body.stateKey);
  if (!oauthReq) {
    log({
      level: "warn",
      message: "OAuth callback with invalid or expired state",
      operation: "oauth_callback",
    });
    return c.json({ error: "Invalid or expired state" }, 400);
  }
  const accessProfile = resolveFrihetAccessProfile(c.env.FRIHET_OPENAI_MODE);
  if (accessProfile === "openai") {
    const boundary = validateOAuthBoundary(
      {
        resource: oauthReq.resource,
        scope: oauthReq.scope,
        requireResource: true,
        requireScope: true,
      },
      OPENAI_REVIEW_ORIGIN,
    );
    if (!boundary.ok) {
      log({
        level: "warn",
        message: "OAuth callback state rejected by host boundary",
        operation: "oauth_callback",
        metadata: { error: boundary.error },
      });
      return c.json(
        { error: boundary.error, error_description: boundary.description },
        400,
      );
    }
  }
  // Verify Firebase ID token using firebase-auth-cloudflare-workers
  const { Auth, WorkersKVStoreSingle } = await import(
    "firebase-auth-cloudflare-workers"
  );
  const keyStore = WorkersKVStoreSingle.getOrInitialize(
    "firebase-public-keys",
    c.env.OAUTH_KV,
  );
  const auth = Auth.getOrInitialize(c.env.FIREBASE_PROJECT_ID, keyStore);

  let decoded: { uid: string; email?: string; name?: string };
  try {
    decoded = await auth.verifyIdToken(body.idToken);
  } catch (err) {
    log({
      level: "warn",
      message: "OAuth callback: invalid Firebase token",
      operation: "oauth_callback",
      error: { message: err instanceof Error ? err.message : String(err) },
    });
    return c.json({ error: "Invalid Firebase token" }, 401);
  }

  const oauthServiceSecret = c.env.FRIHET_OAUTH_API_KEY;
  if (
    typeof oauthServiceSecret !== "string"
    || new TextEncoder().encode(oauthServiceSecret).byteLength < 32
  ) {
    log({
      level: "error",
      message: "OAuth callback: API-key lifecycle authentication is unavailable",
      operation: "oauth_callback",
    });
    return c.json({ error: "OAuth credential lifecycle is unavailable" }, 503);
  }

  const provisioningUrl = resolveOAuthApiKeyUrl(c.env.FRIHET_API_BASE);
  const provisioningBinding = {
    uid: decoded.uid,
    accessProfile,
    oauthResource: accessProfile === "openai" ? OPENAI_REVIEW_ORIGIN : FULL_MCP_ORIGIN,
  } as const;

  // Provision an API key for this user via the Frihet Cloud Function.
  // The provisioning endpoint lives at the API ORIGIN ROOT, never under /v1 —
  // resolveOAuthApiKeyUrl strips a trailing /v1 so a FRIHET_API_BASE configured
  // in either form (origin or /v1) resolves correctly. Passing the raw env var
  // with a /v1 suffix produced /v1/oauth/api-key → 401 → 500 for every OAuth grant.
  let apiKeyResponse: Response;
  try {
    apiKeyResponse = await provisionOAuthApiKey(
      provisioningUrl,
      body.idToken,
      oauthServiceSecret,
      provisioningBinding,
      body.stateKey,
    );
  } catch (error) {
    // The POST outcome may be unknown after a timeout. The backend keeps the
    // bound OAuth pool finite, while this callback fails closed before issuing
    // an authorization code. Never log the Firebase token or request URL.
    log({
      level: "error",
      message: "OAuth callback: API-key provisioning transport failed",
      operation: "oauth_callback",
      error: { message: error instanceof Error ? error.name : typeof error },
    });
    return c.json({ error: "Failed to provision API key" }, 502);
  }

  if (!apiKeyResponse.ok) {
    const upstreamStatus = apiKeyResponse.status;
    // Do NOT log the upstream response body: it is unmasked and could carry PII
    // (the PII policy in this worker forbids it). The provisioning CF logs its own
    // error detail; the status code is enough to correlate here.
    log({
      level: "error",
      message: "OAuth callback: failed to provision API key",
      operation: "oauth_callback",
      error: {
        message: `API key provisioning returned ${upstreamStatus}`,
        statusCode: upstreamStatus,
      },
    });
    // State is single-use, so any retry starts a fresh authorization flow.
    //
    // The provisioning endpoint (oauthApiKeyHandler) is contract-bound
    // to emit 409 with a recovery state for an idempotent replay of a
    // committed credential, and 410 for revoked/expired same-tuple
    // requests that require a NEW correlationId. The OAuth caller
    // (ChatGPT connector, Claude Desktop, etc.) needs the recovery
    // state in the body so it can decide between "credential exists,
    // user must revoke and re-auth" (409) and "credential gone, start
    // fresh" (410). Folding both to 502 here is what masked the
    // recovery contract in PR #1784 review.
    if (upstreamStatus === 409 || upstreamStatus === 410) {
      const recoveryBody = await readRecoveryBody(apiKeyResponse);
      return c.json(recoveryBody, upstreamStatus as 409 | 410);
    }
    // Preserve common client errors (400/401/403/429) verbatim; map every other
    // status (including opaque 5xx) to 502 Bad Gateway.
    const clientStatus: 400 | 401 | 403 | 429 | 502 =
      upstreamStatus === 400
        ? 400
        : upstreamStatus === 401
          ? 401
          : upstreamStatus === 403
            ? 403
            : upstreamStatus === 429
              ? 429
              : 502;
    return c.json({ error: "Failed to provision API key", upstreamStatus }, clientStatus);
  }

  let provisionedPayload: unknown;
  try {
    provisionedPayload = await apiKeyResponse.json();
  } catch {
    log({
      level: "error",
      message: "OAuth callback: API key provisioning returned invalid JSON",
      operation: "oauth_callback",
      error: { message: "Invalid provisioning response" },
    });
    return c.json({ error: "Failed to provision API key" }, 502);
  }
  const provisioned = parseProvisionedOAuthApiKey(
    provisionedPayload,
    provisioningBinding,
  );
  if (!provisioned) {
    // Never log the payload: even a malformed response could still contain a
    // raw credential or user data.
    log({
      level: "error",
      message: "OAuth callback: API key provisioning response failed validation",
      operation: "oauth_callback",
      error: { message: "Invalid provisioning response" },
    });
    return c.json({ error: "Failed to provision API key" }, 502);
  }

  // Complete OAuth authorization. The raw API key never leaves encrypted grant
  // props; its opaque keyId is retained so refresh-family replay or explicit
  // grant revocation can disable the exact backend credential later.
  let redirectTo: string;
  try {
    ({ redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReq,
      userId: decoded.uid,
      metadata: {
        label: decoded.email || decoded.uid,
      },
      scope: oauthReq.scope,
      props: accessProfile === "openai"
        ? {
            apiKey: provisioned.apiKey,
            keyId: provisioned.keyId,
            apiKeyExpiresAt: provisioned.expiresAt,
            userId: decoded.uid,
            accessProfile,
            oauthScope: FRIHET_CONNECTOR_SCOPE,
            oauthResource: OPENAI_REVIEW_ORIGIN,
            authMethod: "oauth",
          }
        : {
            apiKey: provisioned.apiKey,
            keyId: provisioned.keyId,
            apiKeyExpiresAt: provisioned.expiresAt,
            locale: body.locale || "es",
            userId: decoded.uid,
            email: decoded.email,
            name: decoded.name,
            accessProfile,
            oauthResource: FULL_MCP_ORIGIN,
            authMethod: "oauth",
          },
    }));
  } catch (error) {
    let compensationStatus: number | undefined;
    try {
      const compensation = await revokeOAuthApiKey(
        provisioningUrl,
        oauthServiceSecret,
        {
          ...provisioningBinding,
          keyId: provisioned.keyId,
        },
      );
      compensationStatus = compensation.status;
    } catch {
      compensationStatus = undefined;
    }
    log({
      level: "error",
      message: "OAuth callback: authorization completion failed after provisioning",
      operation: "oauth_callback",
      error: { message: error instanceof Error ? error.name : typeof error },
      metadata: {
        compensationStatus: compensationStatus ?? "transport_error",
      },
    });
    return c.json({ error: "Failed to complete OAuth authorization" }, 502);
  }

  log({
    level: "info",
    message: "OAuth callback: success",
    operation: "oauth_callback",
  });

  return c.json({ redirectTo });
});

export const authHandler = app;
