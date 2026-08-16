/**
 * Pure URL-derivation helpers for the Frihet API base.
 *
 * Dependency-free on purpose: both the request client (src/client.ts) and the
 * OAuth auth handler (src/auth-handler.ts) consume these, and the regression
 * test imports them directly via `node --test` without pulling in the full
 * base-client chain.
 *
 * ⚠️ FRIHET_API_BASE MUST point at the Cloud Function origin directly
 * (`https://<region>-<project>.cloudfunctions.net/publicApi/api`), NOT at
 * `https://api.frihet.io`. Both this worker (mcp.frihet.io) and the API proxy
 * (api.frihet.io) live on the SAME Cloudflare zone — a Worker→same-zone-Worker
 * subrequest returns HTTP 522 (connection refused, ~140ms), so every API call
 * (tool calls AND OAuth provisioning) fails when the base is api.frihet.io.
 * The api proxy's own upstream (workers/api-proxy/wrangler.toml
 * FRIHET_UPSTREAM_URL) is the canonical value. Verified live 26-jun-2026.
 */

/**
 * Cloud Function origin — fallback when FRIHET_API_BASE is unset. Mirrors
 * workers/api-proxy FRIHET_UPSTREAM_URL. NOT api.frihet.io (see header note).
 */
const DEFAULT_API_BASE =
  "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/publicApi/api";

const TRUSTED_CLOUD_FUNCTION_HOST =
  "europe-west1-gen-lang-client-0335716041.cloudfunctions.net";

interface ParsedApiBase {
  toolBase: string;
  oauthRoot: string;
}

function parseApiBase(apiBase: string): ParsedApiBase {
  if (apiBase !== apiBase.trim()) {
    throw new Error("FRIHET_API_BASE must not contain surrounding whitespace");
  }

  let parsed: URL;
  try {
    parsed = new URL(apiBase);
  } catch {
    throw new Error("FRIHET_API_BASE must be a valid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("FRIHET_API_BASE must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("FRIHET_API_BASE must not contain URL credentials");
  }
  if (parsed.port) {
    throw new Error("FRIHET_API_BASE must use the default HTTPS port");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("FRIHET_API_BASE must not contain a query or fragment");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith(".")) {
    throw new Error("FRIHET_API_BASE hostname is not canonical");
  }
  const isFrihetHost = hostname === "frihet.io" || hostname.endsWith(".frihet.io");
  if (isFrihetHost) {
    if (parsed.pathname !== "/" && parsed.pathname !== "/v1" && parsed.pathname !== "/v1/") {
      throw new Error("FRIHET_API_BASE Frihet path must be / or /v1");
    }
    const origin = `https://${hostname}`;
    return { toolBase: `${origin}/v1`, oauthRoot: origin };
  }

  if (hostname === TRUSTED_CLOUD_FUNCTION_HOST) {
    const allowed = new Set([
      "/publicApi/api",
      "/publicApi/api/",
      "/publicApi/api/v1",
      "/publicApi/api/v1/",
    ]);
    if (!allowed.has(parsed.pathname)) {
      throw new Error("FRIHET_API_BASE Cloud Function path is not trusted");
    }
    const root = `https://${TRUSTED_CLOUD_FUNCTION_HOST}/publicApi/api`;
    return { toolBase: `${root}/v1`, oauthRoot: root };
  }

  throw new Error("FRIHET_API_BASE hostname is not trusted");
}

/**
 * Normalize FRIHET_API_BASE into the /v1 base URL the request client expects.
 * Accepts both the origin form ("https://api.frihet.io") and the full
 * form ("https://api.frihet.io/v1"); trailing slashes are stripped.
 * Returns undefined for empty/missing input so the root default applies.
 */
export function resolveApiBaseUrl(apiBase?: string): string | undefined {
  if (!apiBase) return undefined;
  return parseApiBase(apiBase).toolBase;
}

/**
 * Build the OAuth API-key provisioning URL from FRIHET_API_BASE.
 *
 * The provisioning endpoint lives at the API ORIGIN ROOT
 * (`https://api.frihet.io/oauth/api-key`), NOT under `/v1`. FRIHET_API_BASE
 * may be configured in either the origin form ("https://api.frihet.io") or
 * the full form ("https://api.frihet.io/v1"); the auth handler must strip a
 * trailing `/v1` segment before appending `/oauth/api-key`, otherwise it hits
 * `/v1/oauth/api-key` which does NOT match the provisioning route and the
 * Firebase Bearer token is rejected as an invalid API key (HTTP 401) →
 * "Failed to provision API key" for every OAuth connection.
 *
 * Falls back to the production origin when the env var is absent.
 */
export function resolveOAuthApiKeyUrl(apiBase?: string): string {
  const { oauthRoot } = parseApiBase(apiBase || DEFAULT_API_BASE);
  return `${oauthRoot}/oauth/api-key`;
}
