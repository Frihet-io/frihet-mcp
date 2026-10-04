/** Fetch-compatible sink shared by Node and Workers; credentials never follow redirects. */
export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function fetchWithoutRedirect(
  input: string | URL | Request,
  init?: RequestInit,
  fetchImpl: FetchImplementation = globalThis.fetch,
): Promise<Response> {
  // workerd deliberately does not implement redirect:"error". Manual prevents
  // any second request, including same-origin redirects, before inspecting status.
  const response = await fetchImpl(input, { ...init, redirect: "manual" });
  if (REDIRECT_STATUSES.has(response.status)) {
    try {
      await response.body?.cancel();
    } catch {
      /* Best effort; still reject. */
    }
    // Never include Location, URL, headers or body in the error.
    throw new TypeError("Redirect responses are not allowed");
  }
  return response;
}
