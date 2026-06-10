/**
 * Frihet API client for the Cloudflare Workers runtime.
 *
 * Thin adapter over the root fetch-only client (src/client.ts) so the worker
 * exposes the FULL IFrihetClient surface (143 methods) that registerAllTools
 * wires into the 151 bundled tools. The previous version of this file
 * re-implemented ~50 methods by hand, so every tool backed by an
 * unimplemented method failed at runtime with "client.<method> is not a
 * function".
 *
 * Worker-specific configuration:
 *  - 25s per-request timeout (Workers have a ~30s limit; leave margin).
 *  - Base URL resolved from env FRIHET_API_BASE (injected by index.ts);
 *    falls back to the root default https://api.frihet.io/v1.
 *  - Auth: per-session API key (OAuth-provisioned or Bearer fri_*) is
 *    injected by index.ts via the constructor and sent as X-API-Key on
 *    every request by the inherited request() method.
 */

import {
  FrihetClient as BaseFrihetClient,
  FrihetApiError,
} from "../../../src/client.js";

export { FrihetApiError };
export type { PaginatedResponse, ApiError } from "../../../src/types.js";

/** Workers have a ~30s wall-clock limit — keep requests under it. */
const WORKER_REQUEST_TIMEOUT_MS = 25000;

/**
 * Normalize FRIHET_API_BASE into the /v1 base URL the client expects.
 * Accepts both the origin form ("https://api.frihet.io") and the full
 * form ("https://api.frihet.io/v1"); trailing slashes are stripped.
 * Returns undefined for empty/missing input so the root default applies.
 */
export function resolveApiBaseUrl(apiBase?: string): string | undefined {
  if (!apiBase) return undefined;
  const trimmed = apiBase.replace(/\/+$/, "");
  if (trimmed === "") return undefined;
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export class FrihetClient extends BaseFrihetClient {
  constructor(apiKey: string, baseUrl?: string) {
    super(apiKey, resolveApiBaseUrl(baseUrl), {
      timeoutMs: WORKER_REQUEST_TIMEOUT_MS,
    });
  }
}
