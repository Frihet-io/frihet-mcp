const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Validate a manual-mode fetch response without owning any network authority. */
export async function rejectRedirectResponse(
  response: Response,
): Promise<Response> {
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
