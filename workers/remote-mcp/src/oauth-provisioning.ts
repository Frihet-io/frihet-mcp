type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

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
