/**
 * Hono app handling the OAuth authorization flow and public endpoints.
 *
 * Routes:
 *   GET  /           — Server info JSON
 *   GET  /health     — Health check
 *   GET  /authorize  — OAuth authorize: show Firebase login page
 *   POST /callback   — Lease state, verify Firebase ID token, provision API key, complete + commit OAuth
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import {
  oauthProvisioningPreflightError,
  parseProvisionedOAuthApiKey,
  provisionOAuthApiKey,
  reconcileOAuthApiKeyCorrelation,
} from "./oauth-provisioning.js";
import { resolveOAuthApiKeyUrl } from "./api-url.js";
import { getLoginPage } from "./login-page.js";
import {
  armOAuthStateAttempt,
  commitOAuthState,
  releaseOAuthState,
  reserveOAuthState,
  storeOAuthState,
  type OAuthStateCommitResult,
  type OAuthStateReleaseOutcome,
  type OAuthStateReservation,
} from "./oauth-state-store.js";
import { isOAuthAccessTokenFamilyActive } from "./oauth-token-family.js";
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
import {
  buildOpenAIUnauthorizedChallenge,
  buildOpenAIUserInfo,
  FRIHET_CONNECTOR_SCOPE,
  FULL_MCP_ORIGIN,
  isVerifiedOpenAIIdentity,
  isValidS256CodeChallenge,
  OPENAI_REVIEW_OAUTH_SCOPES,
  OPENAI_REVIEW_OAUTH_RESOURCES,
  OPENAI_REVIEW_ORIGIN,
  resolveFrihetAccessProfile,
  validateOAuthBoundary,
} from "../../../src/openai-review-oauth.js";

type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };
const OAUTH_CALLBACK_MAX_BODY_BYTES = 20 * 1024;

const app = new Hono<{ Bindings: AuthEnv }>();

/** Grants the user already holds for this client, listed before a new one exists. */
async function listClientGrantIds(
  helpers: OAuthHelpers,
  userId: string,
  clientId: string,
): Promise<string[]> {
  const grantIds: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await helpers.listUserGrants(userId, cursor ? { cursor } : undefined);
    for (const grant of page.items) {
      if (grant.clientId === clientId) grantIds.push(grant.id);
    }
    cursor = page.cursor;
  } while (cursor);
  return grantIds;
}

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

// The reviewed (ChatGPT-connector) host intercepts "GET /" before the request
// ever reaches OAuthProvider's default handler — see the static
// AI-discoverability block in index.ts. This handler is therefore only ever
// reached on the full host. It still refuses explicitly on the reviewed
// profile rather than relying on that upstream routing alone: if a future
// change ever forwards a reviewed-host request here in error, it must not
// fall through to the full catalogue below.
app.get("/", (c) => {
  if (resolveFrihetAccessProfile(c.env.FRIHET_OPENAI_MODE) === "openai") {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({
    name: "Frihet MCP Server",
    version: MCP_SERVER_VERSION,
    description:
      "AI-native business management — invoices, expenses, clients, products, quotes",
    docs: "https://docs.frihet.io/desarrolladores/mcp-server",
    openapi: "https://api.frihet.io/openapi.yaml",
    mcp: `${FULL_MCP_ORIGIN}/mcp`,
    status: "https://status.frihet.io",
    auth: {
      type: "oauth2",
      authorization_server: `${FULL_MCP_ORIGIN}/.well-known/oauth-authorization-server`,
    },
    tools: FULL_REMOTE_TOOL_COUNT,
    catalogueOperations: FULL_TOOL_COUNT,
    aliasNames: FISCAL_ALIAS_TOOL_COUNT,
    capabilityMetadata: "io.frihet/capability",
    discoveryNames: GROUPED_META_TOOL_COUNT,
    resources: FULL_REMOTE_RESOURCE_COUNT,
    prompts: FULL_REMOTE_PROMPT_COUNT,
  });
});

app.get("/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);

app.get("/userinfo", async (c) => {
  if (resolveFrihetAccessProfile(c.env.FRIHET_OPENAI_MODE) !== "openai") {
    return c.json({ error: "Not found" }, 404);
  }
  const authorization = c.req.header("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : undefined;
  let userInfo;
  try {
    userInfo = token
      ? buildOpenAIUserInfo(await c.env.OAUTH_PROVIDER.unwrapToken(token))
      : undefined;
    if (
      userInfo
      && !await isOAuthAccessTokenFamilyActive(
        c.env.OAUTH_STATE,
        c.req.raw,
        userInfo.sub,
      )
    ) {
      userInfo = undefined;
    }
  } catch {
    userInfo = undefined;
  }
  if (!userInfo) {
    return c.json(
      { error: "invalid_token" },
      401,
      {
        "WWW-Authenticate": buildOpenAIUnauthorizedChallenge(),
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    );
  }
  return c.json(userInfo, 200, {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  });
});


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
      OPENAI_REVIEW_OAUTH_RESOURCES,
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

  // Lease the original request instead of consuming it before I/O: a failed
  // attempt releases the lease so the same login can retry, while the Durable
  // Object still guarantees one live attempt and at most one committed grant.
  let reservation: OAuthStateReservation<AuthRequest>;
  try {
    reservation = await reserveOAuthState<AuthRequest>(c.env.OAUTH_STATE, body.stateKey);
  } catch (error) {
    log({
      level: "error",
      message: "OAuth callback: authorization state is unavailable",
      operation: "oauth_callback",
      error: { message: error instanceof Error ? error.name : typeof error },
    });
    return c.json({ error: "Authorization state is temporarily unavailable" }, 503);
  }
  if (reservation.outcome !== "reserved") {
    log({
      level: "warn",
      message: `OAuth callback state is not reservable (${reservation.outcome})`,
      operation: "oauth_callback",
    });
    if (reservation.outcome === "busy") {
      return c.json({ error: "Authorization is already in progress" }, 409);
    }
    if (reservation.outcome === "exhausted") {
      return c.json({ error: "Too many attempts for this authorization request" }, 429);
    }
    // Missing, expired and already-committed (replayed) states look the same.
    return c.json({ error: "Invalid or expired state" }, 400);
  }
  const lease = reservation;
  const progress = { sent: false };

  // Runs one attempt under the lease. Every exit says how the lease settles:
  // "clean" = this attempt left no active credential (never sent, rejected
  // before any write, or revocation by correlation proven); "unknown" = a
  // credential may exist and the attempt must stay recorded until proven.
  const runAttempt = async (): Promise<{
    settlement: "committed" | OAuthStateReleaseOutcome;
    response: Response;
  }> => {
    const oauthReq = lease.request;
    const accessProfile = resolveFrihetAccessProfile(c.env.FRIHET_OPENAI_MODE);
    if (accessProfile === "openai") {
      const boundary = validateOAuthBoundary(
        {
          resource: oauthReq.resource,
          scope: oauthReq.scope,
          requireResource: true,
          requireScope: true,
        },
        OPENAI_REVIEW_OAUTH_RESOURCES,
      );
      if (!boundary.ok) {
        log({
          level: "warn",
          message: "OAuth callback state rejected by host boundary",
          operation: "oauth_callback",
          metadata: { error: boundary.error },
        });
        return {
          settlement: "clean",
          response: c.json(
            { error: boundary.error, error_description: boundary.description },
            400,
          ),
        };
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

    let decoded: {
      uid: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
    };
    try {
      decoded = await auth.verifyIdToken(body.idToken);
    } catch (err) {
      log({
        level: "warn",
        message: "OAuth callback: invalid Firebase token",
        operation: "oauth_callback",
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      return {
        settlement: "clean",
        response: c.json({ error: "Invalid Firebase token" }, 401),
      };
    }

    const verifiedIdentity = {
      uid: decoded.uid,
      email: decoded.email,
      emailVerified: decoded.email_verified,
    };
    if (
      accessProfile === "openai"
      && !isVerifiedOpenAIIdentity(verifiedIdentity)
    ) {
      log({
        level: "warn",
        message: "OAuth callback: verified email claim is unavailable",
        operation: "oauth_callback",
      });
      return {
        settlement: "clean",
        response: c.json({ error: "A verified email address is required" }, 403),
      };
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
      return {
        settlement: "clean",
        response: c.json({ error: "OAuth credential lifecycle is unavailable" }, 503),
      };
    }

    const provisioningUrl = resolveOAuthApiKeyUrl(c.env.FRIHET_API_BASE);
    const provisioningBinding = {
      uid: decoded.uid,
      accessProfile,
      oauthResource: accessProfile === "openai" ? OPENAI_REVIEW_ORIGIN : FULL_MCP_ORIGIN,
    } as const;

    // Refuse here what the provisioning leaf would refuse, before the attempt
    // is recorded as possibly sent (an armed attempt must be reconcilable).
    if (
      oauthProvisioningPreflightError(
        provisioningUrl,
        oauthServiceSecret,
        provisioningBinding,
        lease.correlationId,
      )
    ) {
      log({
        level: "error",
        message: "OAuth callback: API-key provisioning was refused before sending",
        operation: "oauth_callback",
      });
      return {
        settlement: "clean",
        response: c.json({ error: "Failed to provision API key" }, 502),
      };
    }

    // An earlier attempt of this state whose outcome is unknown may still hold
    // an active key. Prove each one revoked before this attempt may send, so
    // one authorization never leaves two live backend credentials.
    const reconciled: string[] = [];
    for (const previous of lease.reconcile) {
      const proven = await reconcileOAuthApiKeyCorrelation(
        provisioningUrl,
        oauthServiceSecret,
        {
          uid: previous.uid,
          accessProfile: provisioningBinding.accessProfile,
          oauthResource: provisioningBinding.oauthResource,
          correlationId: previous.correlationId,
        },
      );
      if (!proven) {
        log({
          level: "error",
          message: "OAuth callback: an earlier attempt could not be reconciled",
          operation: "oauth_callback",
          metadata: { retryCount: lease.attempt - 1 },
        });
        return {
          settlement: "clean",
          response: c.json({ error: "Failed to provision API key" }, 503),
        };
      }
      reconciled.push(previous.correlationId);
    }

    const armed = await armOAuthStateAttempt(
      c.env.OAUTH_STATE,
      body.stateKey,
      lease.leaseId,
      decoded.uid,
      reconciled,
    );
    if (armed === "expired") {
      return {
        settlement: "clean",
        response: c.json({ error: "Invalid or expired state" }, 400),
      };
    }
    if (armed !== "armed") {
      log({
        level: "warn",
        message: `OAuth callback: lease could not be armed (${armed})`,
        operation: "oauth_callback",
      });
      return {
        settlement: "clean",
        response: c.json({ error: "Authorization is already in progress" }, 409),
      };
    }

    // Provision an API key through the exact dedicated OpenAI lifecycle function.
    // resolveOAuthApiKeyUrl validates FRIHET_API_BASE but never derives the
    // credential-bearing destination from it, so neither the publicApi function
    // nor the api.frihet.io proxy can become a fallback authority. Each attempt
    // sends its own fresh correlation: the authority accepts a correlation once.
    let pendingProvisioning: Promise<Response>;
    try {
      pendingProvisioning = provisionOAuthApiKey(
        provisioningUrl,
        body.idToken,
        oauthServiceSecret,
        provisioningBinding,
        lease.correlationId,
      );
    } catch (error) {
      // The leaf refused before sending anything (profile/authority/secret).
      log({
        level: "error",
        message: "OAuth callback: API-key provisioning was refused before sending",
        operation: "oauth_callback",
        error: { message: error instanceof Error ? error.name : typeof error },
      });
      return {
        settlement: "clean",
        response: c.json({ error: "Failed to provision API key" }, 502),
      };
    }
    progress.sent = true;

    const reconcileThisAttempt = async (): Promise<OAuthStateReleaseOutcome> =>
      await reconcileOAuthApiKeyCorrelation(
        provisioningUrl,
        oauthServiceSecret,
        { ...provisioningBinding, correlationId: lease.correlationId },
      )
        ? "clean"
        : "unknown";

    let apiKeyResponse: Response;
    try {
      apiKeyResponse = await pendingProvisioning;
    } catch (error) {
      // Timeout or lost response: the key may exist. Revoke by correlation
      // (which also fences a delayed POST) before the lease is released.
      // Never log the Firebase token or request URL.
      const settlement = await reconcileThisAttempt();
      log({
        level: "error",
        message: "OAuth callback: API-key provisioning transport failed",
        operation: "oauth_callback",
        error: { message: error instanceof Error ? error.name : typeof error },
        metadata: { success: settlement === "clean", retryCount: lease.attempt - 1 },
      });
      return {
        settlement,
        response: c.json({ error: "Failed to provision API key" }, 502),
      };
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
        metadata: { retryCount: lease.attempt - 1 },
      });
      // The authority rejects 400/401/403 before any credential write, and a
      // 429 never reaches it: those attempts are clean and keep their status.
      if (
        upstreamStatus === 400
        || upstreamStatus === 401
        || upstreamStatus === 403
        || upstreamStatus === 429
      ) {
        return {
          settlement: "clean",
          response: c.json(
            { error: "Failed to provision API key", upstreamStatus },
            upstreamStatus,
          ),
        };
      }
      // 409 (correlation already used), 410, 5xx and anything else: a key may
      // exist under this correlation. Reconcile; never retry the same POST.
      return {
        settlement: await reconcileThisAttempt(),
        response: c.json({ error: "Failed to provision API key", upstreamStatus }, 502),
      };
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
      return {
        settlement: await reconcileThisAttempt(),
        response: c.json({ error: "Failed to provision API key" }, 502),
      };
    }
    const provisioned = parseProvisionedOAuthApiKey(
      provisionedPayload,
      provisioningBinding,
    );
    if (!provisioned) {
      // Never log the payload: even a malformed response could still contain a
      // raw credential or user data. The authority answered 200, so a key
      // exists: revoke it by correlation.
      log({
        level: "error",
        message: "OAuth callback: API key provisioning response failed validation",
        operation: "oauth_callback",
        error: { message: "Invalid provisioning response" },
      });
      return {
        settlement: await reconcileThisAttempt(),
        response: c.json({ error: "Failed to provision API key" }, 502),
      };
    }

    // Complete OAuth authorization. The raw API key never leaves encrypted grant
    // props; its opaque keyId is retained so refresh-family replay or explicit
    // grant revocation can disable the exact backend credential later.
    // Earlier grants for this user+client are replaced only after the commit:
    // a holder that loses its lease must never revoke the winner's grant.
    let redirectTo: string;
    let replacedGrantIds: string[];
    try {
      replacedGrantIds = await listClientGrantIds(
        c.env.OAUTH_PROVIDER,
        decoded.uid,
        oauthReq.clientId,
      );
      ({ redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReq,
        userId: decoded.uid,
        revokeExistingGrants: false,
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
              email: verifiedIdentity.email,
              emailVerified: true,
              accessProfile,
              oauthScope: FRIHET_CONNECTOR_SCOPE,
              oauthScopes: [...OPENAI_REVIEW_OAUTH_SCOPES],
              oauthIssuer: OPENAI_REVIEW_ORIGIN,
              oauthAudience: oauthReq.resource,
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
      const settlement = await reconcileThisAttempt();
      log({
        level: "error",
        message: "OAuth callback: authorization completion failed after provisioning",
        operation: "oauth_callback",
        error: { message: error instanceof Error ? error.name : typeof error },
        metadata: { success: settlement === "clean" },
      });
      return {
        settlement,
        response: c.json({ error: "Failed to complete OAuth authorization" }, 502),
      };
    }

    // Commit is idempotent per lease, so one retry covers a lost response.
    let committed: OAuthStateCommitResult | undefined;
    for (let round = 0; round < 2 && committed === undefined; round += 1) {
      try {
        committed = await commitOAuthState(c.env.OAUTH_STATE, body.stateKey, lease.leaseId);
      } catch {
        committed = undefined;
      }
    }
    if (committed !== "committed") {
      // This lease no longer owns the state (taken over after its TTL, state
      // expired, or the store is unreachable). Withhold the code: the grant it
      // unlocks is unreachable and expires with the provider's code TTL. Its
      // backend credential is revoked so nothing usable remains.
      const settlement = await reconcileThisAttempt();
      log({
        level: "error",
        message: "OAuth callback: authorization state could not be committed",
        operation: "oauth_callback",
        error: { message: committed ?? "commit_unavailable" },
        metadata: { success: settlement === "clean" },
      });
      return {
        settlement,
        response: c.json(
          { error: "Failed to complete OAuth authorization" },
          committed === "lease_lost" ? 409 : 503,
        ),
      };
    }

    const replaced = await Promise.allSettled(
      replacedGrantIds.map(async (grantId) =>
        c.env.OAUTH_PROVIDER.revokeGrant(grantId, decoded.uid)),
    );
    if (replaced.some((result) => result.status === "rejected")) {
      // Same tolerance as the provider's own replacement: the new grant is
      // committed; a surviving older grant only keeps its own family usable.
      log({
        level: "warn",
        message: "OAuth callback: an earlier grant could not be replaced",
        operation: "oauth_callback",
      });
    }

    log({
      level: "info",
      message: "OAuth callback: success",
      operation: "oauth_callback",
      metadata: { retryCount: lease.attempt - 1 },
    });
    return { settlement: "committed", response: c.json({ redirectTo }) };
  };

  let attempt: Awaited<ReturnType<typeof runAttempt>>;
  try {
    attempt = await runAttempt();
  } catch (error) {
    log({
      level: "error",
      message: "OAuth callback: attempt failed unexpectedly",
      operation: "oauth_callback",
      error: { message: error instanceof Error ? error.name : typeof error },
    });
    attempt = {
      settlement: progress.sent ? "unknown" : "clean",
      response: c.json({ error: "Failed to complete OAuth authorization" }, 502),
    };
  }
  if (attempt.settlement !== "committed") {
    try {
      await releaseOAuthState(
        c.env.OAUTH_STATE,
        body.stateKey,
        lease.leaseId,
        attempt.settlement,
      );
    } catch (error) {
      // The lease then expires on its own; an armed attempt is reconciled by
      // the next reservation or by the state alarm.
      log({
        level: "error",
        message: "OAuth callback: lease release failed",
        operation: "oauth_callback",
        error: { message: error instanceof Error ? error.name : typeof error },
      });
    }
  }
  return attempt.response;
});

export const authHandler = app;
