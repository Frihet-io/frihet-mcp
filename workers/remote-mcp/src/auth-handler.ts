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
import { getLoginPage } from "./login-page.js";
import { log } from "../../../src/logger.js";

type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: AuthEnv }>();

/**
 * One-way SHA-256 fingerprint (first 12 hex) of a PII value for LOG lines only.
 *
 * The submission claims "No PII logged" — so uid/email must never appear in
 * cleartext in logs. The raw values still flow where the protocol needs them
 * (API-key provisioning body, OAuth session props); this only guards log output.
 * Returns "none" for an absent value and "hash-error" if WebCrypto is missing.
 */
async function fingerprintPii(value: string | undefined): Promise<string> {
  if (!value) return "none";
  try {
    const data = new TextEncoder().encode(value);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 12);
  } catch {
    return "hash-error";
  }
}

// ---------------------------------------------------------------------------
// Public endpoints
// ---------------------------------------------------------------------------

app.get("/", (c) => {
  return c.json({
    name: "Frihet MCP Server",
    version: "1.5.2",
    description:
      "AI-native business management — invoices, expenses, clients, products, quotes",
    docs: "https://docs.frihet.io/desarrolladores/mcp-server",
    openapi: "https://api.frihet.io/openapi.yaml",
    mcp: "https://mcp.frihet.io/mcp",
    status: "https://status.frihet.io",
    auth: {
      type: "oauth2",
      authorization_server:
        "https://mcp.frihet.io/.well-known/oauth-authorization-server",
    },
    tools: 52,
    resources: 11,
    prompts: 10,
  });
});

app.get("/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);


// ---------------------------------------------------------------------------
// OAuth: Authorization — show Firebase login page
// ---------------------------------------------------------------------------

app.get("/authorize", async (c) => {
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

  log({
    level: "info",
    message: `OAuth authorize started for client ${oauthReq.clientId}`,
    operation: "oauth_authorize",
    metadata: { clientId: oauthReq.clientId },
  });

  // Store OAuth request in short-lived KV entry (10 min TTL)
  const stateKey = crypto.randomUUID();
  await c.env.OAUTH_KV.put(
    `auth_state:${stateKey}`,
    JSON.stringify(oauthReq),
    { expirationTtl: 600 },
  );

  // Serve the login page
  return c.html(
    getLoginPage({
      stateKey,
      clientId: oauthReq.clientId,
      firebaseProjectId: c.env.FIREBASE_PROJECT_ID,
    }),
  );
});

// ---------------------------------------------------------------------------
// OAuth: Callback — after Firebase auth, receive ID token via POST
// ---------------------------------------------------------------------------

app.post("/callback", async (c) => {
  const body = await c.req.json<{
    stateKey: string;
    idToken: string;
    locale?: string;
  }>();

  // Retrieve the original OAuth request from KV
  const oauthReqJson = await c.env.OAUTH_KV.get(`auth_state:${body.stateKey}`);
  if (!oauthReqJson) {
    log({
      level: "warn",
      message: "OAuth callback with invalid or expired state",
      operation: "oauth_callback",
    });
    return c.json({ error: "Invalid or expired state" }, 400);
  }
  const oauthReq = JSON.parse(oauthReqJson) as AuthRequest;
  await c.env.OAUTH_KV.delete(`auth_state:${body.stateKey}`);

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

  // Provision an API key for this user via the Frihet Cloud Function
  const apiKeyResponse = await fetch(
    `${c.env.FRIHET_API_BASE}/oauth/api-key`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${body.idToken}`,
      },
      body: JSON.stringify({ uid: decoded.uid }),
    },
  );

  if (!apiKeyResponse.ok) {
    log({
      level: "error",
      message: `OAuth callback: failed to provision API key for uid:${await fingerprintPii(decoded.uid)}`,
      operation: "oauth_callback",
      error: { message: `API key provisioning returned ${apiKeyResponse.status}`, statusCode: apiKeyResponse.status },
    });
    return c.json({ error: "Failed to provision API key" }, 500);
  }

  const { apiKey } = (await apiKeyResponse.json()) as { apiKey: string };

  // Complete OAuth authorization — issues access + refresh tokens
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: decoded.uid,
    metadata: {
      label: decoded.email || decoded.uid,
    },
    scope: oauthReq.scope,
    props: {
      apiKey,
      locale: body.locale || "es",
      userId: decoded.uid,
      email: decoded.email,
      name: decoded.name,
    },
  });

  log({
    level: "info",
    message: `OAuth callback: success for uid:${await fingerprintPii(decoded.uid)}`,
    operation: "oauth_callback",
    metadata: {
      userId: await fingerprintPii(decoded.uid),
      email: await fingerprintPii(decoded.email),
    },
  });

  return c.json({ redirectTo });
});

export const authHandler = app;
