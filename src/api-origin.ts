/**
 * Validate the optional public API base URL accepted by the stdio entrypoint.
 *
 * The returned base is canonical and always ends in `/v1`. Validation happens
 * before a FrihetClient is constructed, so an API key cannot be sent to an
 * attacker-controlled origin through the public environment override.
 */
export function normalizePublicApiBaseUrl(value: string): string {
  if (value !== value.trim()) {
    throw new Error("FRIHET_API_URL must not contain surrounding whitespace");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("FRIHET_API_URL must be a valid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("FRIHET_API_URL must use https");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.split(".").some((label) => label.length === 0)
    || !(hostname === "frihet.io" || hostname.endsWith(".frihet.io"))) {
    throw new Error("FRIHET_API_URL hostname must be under frihet.io");
  }
  if (parsed.username || parsed.password) {
    throw new Error("FRIHET_API_URL must not contain URL credentials");
  }
  if (parsed.port) {
    throw new Error("FRIHET_API_URL must use the default HTTPS port");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("FRIHET_API_URL must not contain a query or fragment");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "/v1" && parsed.pathname !== "/v1/") {
    throw new Error("FRIHET_API_URL path must be / or /v1");
  }

  return `https://${hostname}/v1`;
}
