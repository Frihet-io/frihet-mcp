type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Accept only the exact 32-byte base64url key format issued by Frihet. */
export function parseProvisionedApiKey(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const apiKey = (payload as Record<string, unknown>).apiKey;
  return typeof apiKey === "string" && /^fri_[A-Za-z0-9_-]{43}$/u.test(apiKey)
    ? apiKey
    : undefined;
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
  uid: string,
  fetchImpl: FetchImplementation = globalThis.fetch,
): Promise<Response> {
  return fetchImpl(provisioningUrl, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ uid }),
  });
}
