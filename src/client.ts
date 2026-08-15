/**
 * HTTP client wrapping the Frihet ERP REST API.
 *
 * Handles authentication, pagination, rate-limit retries, and error mapping.
 *
 * Pagination convention: every `list*`/`search*` method below keeps `after`
 * as its caller-facing param name (tools/*.ts and other callers pass
 * `{ after }` unchanged — it's a naming alias only), but the wire query
 * built for `requestPaginated` always sends it under the `cursor` key
 * (`cursor: params?.after`) — the query param the backend actually reads
 * (`req.query.cursor`, functions/src/publicApi.ts in Frihet-ERP). `after`
 * is never sent on the wire. See src/__tests__/pagination-cursor-param.test.ts.
 */

import type { PaginatedResponse, ApiError } from "./types.js";
import { logApiCall, logRetry } from "./logger.js";

const BASE_URL = "https://api.frihet.io/v1";

const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 30000;

/**
 * Hard size caps for document responses. Enforced TWICE: precheck on
 * `Content-Length` (so an honest server doesn't waste bandwidth) and after
 * streaming (so a missing/lying `Content-Length` still can't trigger an
 * unbounded allocation).
 *
 *  - PDF: 25 MiB — generous for any ERP-issued invoice PDF, including
 *    embedded logos, Facturae XML attachments, and stamp signatures.
 *  - XML:  5 MiB — UBL / Facturae / PEPPOL documents stay well under 1 MiB
 *    in practice; 5 MiB absorbs any historical / annex-laden outlier.
 *
 * Anything larger is rejected with `413 payload_too_large` BEFORE we allocate
 * — the user sees a clean error, the worker doesn't OOM.
 */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_XML_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

/**
 * Bounded binary document response. Always base64-encoded because MCP
 * `structuredContent` is JSON-only — raw `Uint8Array` would coerce to a
 * sparse object on the wire.
 */
export interface BinaryDocument {
  /** Echoed id from the request (invoice id), so callers can correlate. */
  id: string;
  /** Verbatim `Content-Type` from the response (e.g. `application/pdf`). */
  contentType: string;
  /** Byte length of the decoded body. Equal to `Buffer.byteLength(base64)` after round-trip. */
  sizeBytes: number;
  /** Base64-encoded bytes. Round-trip via `Buffer.from(b64, 'base64')`. */
  base64: string;
  /** Filename hint parsed from `Content-Disposition`, when present. */
  filename?: string;
}

/**
 * Bounded XML document response (UBL / CII / Facturae / PEPPOL / FatturaPA /
 * XRechnung — anything declared `application/xml` or `text/xml`).
 */
export interface XmlDocument {
  /** Echoed id from the request (invoice id). */
  id: string;
  /** Strictly decoded UTF-8 XML text. */
  xml: string;
  /** Verbatim `Content-Type` from the response. */
  contentType: string;
  /** Byte length of the decoded UTF-8 body. */
  sizeBytes: number;
  /** Filename hint parsed from `Content-Disposition`, when present. */
  filename?: string;
}

/** `/invoices/:id/xml` serves XML or a Factur-X PDF, depending on storage MIME. */
export type EInvoiceDocument = XmlDocument | BinaryDocument;

/**
 * HTTP methods for which the backend treats the request as a mutation and
 * therefore accepts (and for some endpoints REQUIRES) an `Idempotency-Key`
 * header. `POST /v1/invoices/:id/credit-note` rejects a keyless request with
 * `400 IDEMPOTENCY_KEY_REQUIRED`, so a client that never sends one fails 100%
 * of the time — see src/__tests__/idempotency-key-contract.test.ts.
 */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Origin marker sent on every request so the backend can tell an MCP-driven
 * create apart from a direct-API one.
 *
 * The backend classifier (`detectApiInvoiceSource`, Frihet-ERP
 * functions/src/publicApi.ts) matches `mcp` / `frihet-mcp` / `@frihet/mcp`
 * across three headers: `x-frihet-source`, `x-frihet-client` and `user-agent`.
 * We send TWO markers because they survive different network paths:
 *
 *  - `X-Frihet-Source: mcp` is the explicit, documented marker. It reaches the
 *    backend when the client talks to the Cloud Function directly (custom
 *    `baseUrl`, self-hosted proxy).
 *  - `User-Agent` is what actually reaches the backend on the DEFAULT baseUrl:
 *    `api.frihet.io` is fronted by workers/api-proxy/worker.js, whose
 *    `ALLOWED_REQUEST_HEADERS` allowlist forwards `user-agent` but drops
 *    `x-frihet-source` (verified live: /agents.json answers 200 at
 *    api.frihet.io and 401 at the Cloud Function, so the Worker is in path).
 *    Without the UA the source header is a phantom — set, then stripped at the
 *    edge, and every MCP invoice still lands as `source: 'api'`.
 *
 * Deliberately carries no version: the version lives in package.json only
 * (see src/index.ts PKG_VERSION) and a second hardcoded copy is exactly the
 * drift `scripts/audit-mcp-refs.mjs` exists to catch.
 *
 * Pinned on the wire by src/__tests__/source-header-contract.test.ts.
 */
const SOURCE_MARKER = "mcp";
const SOURCE_USER_AGENT = "frihet-mcp-server";

/**
 * Fresh idempotency key, always a syntactically valid UUID v4.
 *
 * `crypto.randomUUID` is a global on the Cloudflare Workers runtime and on
 * Node >= 19. On Node 18 — our declared `engines` floor — `globalThis.crypto`
 * is behind `--experimental-global-webcrypto`, so the fallback is a REAL code
 * path there, not a theoretical one. It therefore has to produce a UUID and
 * not an ad-hoc string: the backend documents "UUID v4 recommended", and
 * src/__tests__/idempotency-key-contract.test.ts asserts the shape.
 */
function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === "function") {
    return c.randomUUID();
  }
  // RFC 4122 v4 layout from Math.random. Weaker entropy than the CSPRNG, but
  // the key only has to be unique per caller, never unguessable.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * A caller-supplied key counts only if it carries a value. An empty or
 * whitespace-only string is what an LLM client emits for "I have nothing to
 * put here" on an optional string param — treating it as PRESENT would leave
 * the request keyless and reproduce the very `400 IDEMPOTENCY_KEY_REQUIRED`
 * this client exists to prevent.
 */
function normalizeIdempotencyKey(key: string | undefined): string | undefined {
  const trimmed = key?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizedContentType(contentType: string): string {
  return contentType.split(";", 1)[0]!.trim().toLowerCase();
}

function isXmlContentType(contentType: string): boolean {
  const normalized = normalizedContentType(contentType);
  return normalized === "application/xml" || normalized === "text/xml" || normalized.endsWith("+xml");
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d;
}

function attachmentFilename(contentDisposition: string | null): string | undefined {
  if (!contentDisposition) return undefined;
  const encoded = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quoted = contentDisposition.match(/filename="([^"]+)"/i)?.[1];
  const plain = contentDisposition.match(/filename=([^;]+)/i)?.[1];
  const candidate = (encoded ?? quoted ?? plain)?.trim();
  if (!candidate) return undefined;
  try {
    return decodeURIComponent(candidate).split(/[\\/]/).pop();
  } catch {
    return candidate.split(/[\\/]/).pop();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FrihetApiError(200, "invalid_response", `${label} is not valid UTF-8`);
  }
}

export class FrihetApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: string,
    message?: string,
  ) {
    super(message ?? errorCode);
    this.name = "FrihetApiError";
  }
}

export interface FrihetClientOptions {
  /**
   * Per-request timeout in milliseconds. Defaults to 30000.
   * Cloudflare Workers should pass ≤25000 to leave margin under the ~30s limit.
   */
  timeoutMs?: number;
}

export class FrihetClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, baseUrl?: string, options?: FrihetClientOptions) {
    if (!apiKey) {
      throw new Error(
        "FRIHET_API_KEY is required. Set it as an environment variable or pass it to the constructor.",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? BASE_URL;
    this.timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  // ------------------------------------------------------------------ HTTP
  // ------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
    retryCount = 0,
    idempotencyKey?: string,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);

    // Resolved once, at the top of the call chain: a caller-supplied key wins,
    // otherwise mutations get a freshly minted one. The resolved value is then
    // threaded through the 429 recursion below so a retry replays the SAME key
    // — retrying with a new key is exactly the duplicate the key exists to
    // prevent (a retried credit-note would create a second draft).
    const resolvedIdempotencyKey =
      normalizeIdempotencyKey(idempotencyKey) ??
      (MUTATING_METHODS.has(method) ? newIdempotencyKey() : undefined);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Frihet-Source": SOURCE_MARKER,
      "User-Agent": SOURCE_USER_AGENT,
    };

    if (resolvedIdempotencyKey) {
      headers["Idempotency-Key"] = resolvedIdempotencyKey;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    const startTime = Date.now();
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      const durationMs = Math.round(Date.now() - startTime);
      if (error instanceof Error && error.name === "AbortError") {
        logApiCall(method, path, 408, durationMs);
        throw new FrihetApiError(
          408,
          "request_timeout",
          `Request timed out after ${this.timeoutMs / 1000} seconds`,
        );
      }
      logApiCall(method, path, 0, durationMs);
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    const durationMs = Math.round(Date.now() - startTime);

    // Rate limit handling
    if (response.status === 429) {
      logApiCall(method, path, 429, durationMs);

      if (retryCount >= MAX_RETRIES) {
        throw new FrihetApiError(
          429,
          "rate_limit_exceeded",
          "Rate limit exceeded after multiple retries. Please try again later.",
        );
      }

      const retryAfter = response.headers.get("Retry-After");
      const delayMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : DEFAULT_RETRY_DELAY_MS * Math.pow(2, retryCount);

      logRetry(method, path, retryCount, delayMs);
      await this.sleep(delayMs);
      return this.request<T>(
        method,
        path,
        body,
        query,
        retryCount + 1,
        resolvedIdempotencyKey,
      );
    }

    // Error responses
    if (!response.ok) {
      logApiCall(method, path, response.status, durationMs);
      let errorBody: ApiError;
      try {
        errorBody = (await response.json()) as ApiError;
      } catch {
        errorBody = {
          error: `http_${response.status}`,
          message: response.statusText,
        };
      }
      throw new FrihetApiError(
        response.status,
        errorBody.error,
        errorBody.message ?? errorBody.error,
      );
    }

    logApiCall(method, path, response.status, durationMs);

    // 204 No Content (e.g. DELETE)
    if (response.status === 204) {
      return undefined as T;
    }

    const data = await response.json();

    // Basic response validation
    if (data === null || data === undefined) {
      throw new FrihetApiError(
        response.status,
        'invalid_response',
        'API returned empty response',
      );
    }

    return data as T;
  }

  /** Fetch a raw response. The caller owns timeout and body consumption. */
  private async fetchRaw(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const resolvedIdempotencyKey =
      normalizeIdempotencyKey(idempotencyKey) ??
      (MUTATING_METHODS.has(method) ? newIdempotencyKey() : undefined);

    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      "Content-Type": "application/json",
      // CRITICAL: do NOT set `Accept: application/json` here. The PDF / XML
      // endpoints must be allowed to return their native content type;
      // forcing `Accept: application/json` would make the server negotiate
      // an error envelope instead of the document bytes.
      Accept: "*/*",
      "X-Frihet-Source": SOURCE_MARKER,
      "User-Agent": SOURCE_USER_AGENT,
    };
    if (resolvedIdempotencyKey) {
      headers["Idempotency-Key"] = resolvedIdempotencyKey;
    }

    return fetch(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  }

  /** Consume one response body without ever retaining more than `maxBytes`. */
  private async readBoundedBody(
    response: Response,
    maxBytes: number,
    controller: AbortController,
  ): Promise<Uint8Array> {
    const declaredLengthRaw = response.headers.get("content-length")?.trim();
    const declaredLength = declaredLengthRaw && /^\d+$/.test(declaredLengthRaw)
      ? Number(declaredLengthRaw)
      : Number.NaN;

    if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
      controller.abort();
      try { await response.body?.cancel(); } catch { /* best effort */ }
      throw new FrihetApiError(
        413,
        "payload_too_large",
        `Document response exceeds ${maxBytes} bytes (Content-Length: ${declaredLength})`,
      );
    }

    if (!response.body) {
      throw new FrihetApiError(response.status, "invalid_response", "Response body is null");
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          controller.abort();
          try { await reader.cancel("document response exceeded size limit"); } catch { /* best effort */ }
          throw new FrihetApiError(
            413,
            "payload_too_large",
            `Document response exceeds ${maxBytes} bytes during streaming`,
          );
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof FrihetApiError || isAbortError(error)) throw error;
      try { await reader.cancel("document stream failed"); } catch { /* best effort */ }
      controller.abort();
      throw new FrihetApiError(
        response.status,
        "stream_failed",
        `Failed while reading document response: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      reader.releaseLock();
    }

    const flat = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      flat.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return flat;
  }

  /**
   * Bounded document fetch — ONE call, ONE Response, dispatch on Content-Type.
   *
   * Success and error bodies use the same bounded reader. The abort timer stays
   * active until the body is complete, and a normal success performs one GET.
   * A 429 may retry, matching the generic JSON client path.
   */
  private async requestDocument(
    method: string,
    path: string,
    body: unknown,
    query: Record<string, string | number | undefined> | undefined,
    idempotencyKey: string | undefined,
    maxBytesForContentType: (contentType: string) => number,
    retryCount = 0,
  ): Promise<{ contentType: string; bytes: Uint8Array; sizeBytes: number; filename?: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await this.fetchRaw(
        method,
        path,
        body,
        query,
        idempotencyKey,
        controller.signal,
      );
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      const maxBytes = response.ok ? maxBytesForContentType(contentType) : MAX_ERROR_BYTES;
      const bytes = await this.readBoundedBody(response, maxBytes, controller);
      const durationMs = Math.round(Date.now() - startedAt);

      if (response.status === 429) {
        logApiCall(method, path, 429, durationMs);
        if (retryCount >= MAX_RETRIES) {
          throw new FrihetApiError(
            429,
            "rate_limit_exceeded",
            "Rate limit exceeded after multiple retries. Please try again later.",
          );
        }
        const retryAfter = response.headers.get("Retry-After");
        const parsedRetryAfter = retryAfter ? Number.parseInt(retryAfter, 10) : Number.NaN;
        const delayMs = Number.isFinite(parsedRetryAfter)
          ? parsedRetryAfter * 1000
          : DEFAULT_RETRY_DELAY_MS * Math.pow(2, retryCount);
        logRetry(method, path, retryCount, delayMs);
        clearTimeout(timeoutId);
        await this.sleep(delayMs);
        return this.requestDocument(
          method,
          path,
          body,
          query,
          idempotencyKey,
          maxBytesForContentType,
          retryCount + 1,
        );
      }

      if (!response.ok) {
        logApiCall(method, path, response.status, durationMs);
        let errorBody: ApiError = {
          error: `http_${response.status}`,
          message: response.statusText,
        };
        try {
          const parsed = JSON.parse(decodeUtf8(bytes, "API error response")) as Partial<ApiError>;
          if (typeof parsed.error === "string") {
            errorBody = {
              error: parsed.error,
              ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
            };
          }
        } catch (error) {
          if (error instanceof FrihetApiError && error.errorCode !== "invalid_response") throw error;
        }
        throw new FrihetApiError(
          response.status,
          errorBody.error,
          errorBody.message ?? errorBody.error,
        );
      }

      logApiCall(method, path, response.status, durationMs);
      const filename = attachmentFilename(response.headers.get("content-disposition"));
      return {
        contentType,
        bytes,
        sizeBytes: bytes.byteLength,
        ...(filename ? { filename } : {}),
      };
    } catch (error) {
      if (isAbortError(error)) {
        const durationMs = Math.round(Date.now() - startedAt);
        logApiCall(method, path, 408, durationMs);
        throw new FrihetApiError(
          408,
          "request_timeout",
          `Request timed out after ${this.timeoutMs / 1000} seconds`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Wrapper for endpoints whose backend wraps the payload in a `{ data, meta }`
   * envelope. This is the UNIFORM convention across the Frihet `/v1` REST API:
   *   - single-object GET reads (`getResource` → `{ data: <item>, meta }`),
   *   - create/update mutations (201 / PUT / PATCH → `{ data: <resource>, meta }`,
   *     publicApi.ts response block), AND
   *   - action POSTs (`/invoices/:id/paid`, `/send`, `/credit-note`, deposit
   *     apply/refund, etc. → `{ data: <actionResult>, meta }`, publicApi.ts
   *     `actionResponse = { data: actionResult, meta }`).
   *
   * Passing that envelope straight into a tool's `structuredContent` surfaces
   * `{ data, meta }` instead of the resource/action result, breaking the tool's
   * output schema (id/clientName/items/success all read as `undefined`). This
   * unwraps to `body.data`. Every create/update/action mutation routes through
   * here for exactly this reason; single-object reads (`getInvoice`/…) have since
   * #64. `deleteX` methods deliberately keep `request` (they return `void` — the
   * tool discards the body and synthesizes `{ success, id }`, so there is nothing
   * to unwrap). Only unwraps a non-array-object `data` (see guard below), so an
   * array-`data` list envelope and any non-enveloped body pass through unchanged.
   *
   * Only unwraps when the body is an object carrying a `data` property that is
   * itself a (non-array) object — i.e. a genuine single-object envelope. It is
   * deliberately distinct from {@link requestPaginated}, which keeps the
   * `{ data: [...] , meta }` shape intact for list endpoints. If the body is
   * not an envelope (legacy endpoints that return the item directly), it is
   * returned unchanged so existing callers keep working.
   */
  private async requestUnwrapped<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
    idempotencyKey?: string,
  ): Promise<T> {
    const raw = await this.request<unknown>(method, path, body, query, 0, idempotencyKey);

    if (
      raw !== null &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      "data" in raw
    ) {
      const inner = (raw as { data: unknown }).data;
      // Single-object envelope only. An array `data` belongs to a paginated
      // response — never reachable here (those go through requestPaginated),
      // but guard anyway so we never silently strip a list.
      if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
        return inner as T;
      }
    }

    return raw as T;
  }

  /** Wrapper for paginated endpoints — validates response shape has `data` array. */
  private async requestPaginated<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<PaginatedResponse<T>> {
    const result = await this.request<PaginatedResponse<T>>(method, path, body, query);

    if (!result || !Array.isArray(result.data)) {
      throw new FrihetApiError(
        200,
        'invalid_response',
        'API returned invalid paginated response',
      );
    }

    return result;
  }

  // ---------------------------------------------------------------- Public
  // ----------------------------------------------------------------

  // ---------------------------------------------------------------- Invoices
  // ----------------------------------------------------------------

  async listInvoices(
    params?: { limit?: number; offset?: number; after?: string; fields?: string; status?: string; from?: string; to?: string; clientId?: string; seriesId?: string },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/invoices", undefined, {
      limit: params?.limit,
      offset: params?.offset,
      cursor: params?.after,
      fields: params?.fields,
      status: params?.status,
      from: params?.from,
      to: params?.to,
      clientId: params?.clientId,
      seriesId: params?.seriesId,
    });
  }

  async getInvoice(id: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", `/invoices/${encodeURIComponent(id)}`);
  }

  async createInvoice(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/invoices", data);
  }

  async updateInvoice(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("PATCH", `/invoices/${encodeURIComponent(id)}`, data);
  }

  async deleteInvoice(id: string): Promise<void> {
    return this.request("DELETE", `/invoices/${encodeURIComponent(id)}`);
  }

  async searchInvoices(
    query: string,
    params?: { limit?: number; offset?: number; after?: string; fields?: string; status?: string; from?: string; to?: string },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/invoices", undefined, {
      q: query,
      limit: params?.limit,
      offset: params?.offset,
      cursor: params?.after,
      fields: params?.fields,
      status: params?.status,
      from: params?.from,
      to: params?.to,
    });
  }

  // ---------------------------------------------------------------- Expenses
  // ----------------------------------------------------------------

  async listExpenses(
    params?: { limit?: number; offset?: number; after?: string; fields?: string; from?: string; to?: string; vendorId?: string; category?: string },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/expenses", undefined, {
      limit: params?.limit,
      offset: params?.offset,
      cursor: params?.after,
      fields: params?.fields,
      from: params?.from,
      to: params?.to,
      vendorId: params?.vendorId,
      category: params?.category,
    });
  }

  async getExpense(id: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", `/expenses/${encodeURIComponent(id)}`);
  }

  async createExpense(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/expenses", data);
  }

  async updateExpense(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("PATCH", `/expenses/${encodeURIComponent(id)}`, data);
  }

  async deleteExpense(id: string): Promise<void> {
    return this.request("DELETE", `/expenses/${encodeURIComponent(id)}`);
  }

  // ---------------------------------------------------------------- Clients
  // ----------------------------------------------------------------

  async listClients(
    params?: { limit?: number; offset?: number; after?: string; fields?: string; q?: string; stage?: string },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/clients", undefined, {
      limit: params?.limit,
      offset: params?.offset,
      cursor: params?.after,
      fields: params?.fields,
      q: params?.q,
      stage: params?.stage,
    });
  }

  async getClient(id: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", `/clients/${encodeURIComponent(id)}`);
  }

  async createClient(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/clients", data);
  }

  async updateClient(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("PATCH", `/clients/${encodeURIComponent(id)}`, data);
  }

  async deleteClient(id: string): Promise<void> {
    return this.request("DELETE", `/clients/${encodeURIComponent(id)}`);
  }

  // ---------------------------------------------------------------- Products
  // ----------------------------------------------------------------

  async listProducts(
    params?: { limit?: number; offset?: number; after?: string; fields?: string; q?: string; isActive?: boolean },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/products", undefined, {
      limit: params?.limit,
      offset: params?.offset,
      cursor: params?.after,
      fields: params?.fields,
      q: params?.q,
      isActive: params?.isActive !== undefined ? (params.isActive ? 1 : 0) : undefined,
    });
  }

  async getProduct(id: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", `/products/${encodeURIComponent(id)}`);
  }

  async createProduct(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/products", data);
  }

  async updateProduct(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("PATCH", `/products/${encodeURIComponent(id)}`, data);
  }

  async deleteProduct(id: string): Promise<void> {
    return this.request("DELETE", `/products/${encodeURIComponent(id)}`);
  }

  // ---------------------------------------------------------------- Quotes
  // ----------------------------------------------------------------

  async listQuotes(
    params?: { limit?: number; offset?: number; after?: string; fields?: string; status?: string; from?: string; to?: string; clientId?: string; seriesId?: string },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/quotes", undefined, {
      limit: params?.limit,
      offset: params?.offset,
      cursor: params?.after,
      fields: params?.fields,
      status: params?.status,
      from: params?.from,
      to: params?.to,
      clientId: params?.clientId,
      seriesId: params?.seriesId,
    });
  }

  async getQuote(id: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", `/quotes/${encodeURIComponent(id)}`);
  }

  async createQuote(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/quotes", data);
  }

  async updateQuote(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("PATCH", `/quotes/${encodeURIComponent(id)}`, data);
  }

  async deleteQuote(id: string): Promise<void> {
    return this.request("DELETE", `/quotes/${encodeURIComponent(id)}`);
  }

  // ---------------------------------------------------------------- Vendors
  // ----------------------------------------------------------------

  async listVendors(
    params?: { q?: string; limit?: number; offset?: number; after?: string; fields?: string },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/vendors", undefined, {
      q: params?.q,
      limit: params?.limit,
      offset: params?.offset,
      cursor: params?.after,
      fields: params?.fields,
    });
  }

  async getVendor(id: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", `/vendors/${encodeURIComponent(id)}`);
  }

  async createVendor(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/vendors", data);
  }

  async updateVendor(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("PATCH", `/vendors/${encodeURIComponent(id)}`, data);
  }

  async deleteVendor(id: string): Promise<void> {
    return this.request("DELETE", `/vendors/${encodeURIComponent(id)}`);
  }

  // ---------------------------------------------------------------- Invoice Actions
  // ----------------------------------------------------------------

  async sendInvoice(id: string, to?: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/invoices/${encodeURIComponent(id)}/send`, to ? { to } : undefined);
  }

  async markInvoicePaid(id: string, paidDate?: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/invoices/${encodeURIComponent(id)}/paid`, paidDate ? { paidDate } : undefined);
  }

  async getInvoicePdf(id: string): Promise<BinaryDocument> {
    // One fetch, one Response: validate MIME and signature only after the
    // bounded stream completes. The ERP endpoint has always returned bytes;
    // there is no pre-signed-URL JSON success contract to emulate.
    const url = `/invoices/${encodeURIComponent(id)}/pdf`;
    const doc = await this.requestDocument(
      "GET",
      url,
      undefined,
      undefined,
      undefined,
      (contentType) => normalizedContentType(contentType) === "application/pdf"
        ? MAX_PDF_BYTES
        : MAX_ERROR_BYTES,
    );
    if (normalizedContentType(doc.contentType) !== "application/pdf") {
      throw new FrihetApiError(
        200,
        "invalid_response",
        `Invoice PDF endpoint returned unexpected Content-Type: ${doc.contentType}`,
      );
    }
    if (!hasPdfSignature(doc.bytes)) {
      throw new FrihetApiError(200, "invalid_response", "Invoice PDF response is malformed");
    }

    return {
      id,
      contentType: doc.contentType,
      sizeBytes: doc.sizeBytes,
      base64: Buffer.from(doc.bytes.buffer, doc.bytes.byteOffset, doc.bytes.byteLength).toString("base64"),
      ...(doc.filename ? { filename: doc.filename } : {}),
    };
  }

  async getInvoiceEInvoice(invoiceId: string): Promise<EInvoiceDocument> {
    // Stored e-invoices are either XML or Factur-X PDF. Select the size cap
    // from the actual MIME before reading and preserve the request identity.
    const url = `/invoices/${encodeURIComponent(invoiceId)}/xml`;
    const doc = await this.requestDocument(
      "GET",
      url,
      undefined,
      undefined,
      undefined,
      (contentType) => {
        const normalized = normalizedContentType(contentType);
        if (normalized === "application/pdf") return MAX_PDF_BYTES;
        if (isXmlContentType(contentType)) return MAX_XML_BYTES;
        return MAX_ERROR_BYTES;
      },
    );
    const normalized = normalizedContentType(doc.contentType);

    if (normalized === "application/pdf") {
      if (!hasPdfSignature(doc.bytes)) {
        throw new FrihetApiError(200, "invalid_response", "Factur-X PDF response is malformed");
      }
      return {
        id: invoiceId,
        contentType: doc.contentType,
        sizeBytes: doc.sizeBytes,
        base64: Buffer.from(doc.bytes.buffer, doc.bytes.byteOffset, doc.bytes.byteLength).toString("base64"),
        ...(doc.filename ? { filename: doc.filename } : {}),
      };
    }

    if (!isXmlContentType(doc.contentType)) {
      throw new FrihetApiError(
        200,
        "invalid_response",
        `E-invoice endpoint returned unexpected Content-Type: ${doc.contentType}`,
      );
    }
    const xmlText = decodeUtf8(doc.bytes, "E-invoice XML response");
    if (!xmlText.trimStart().startsWith("<")) {
      throw new FrihetApiError(200, "invalid_response", "E-invoice XML response is malformed");
    }
    return {
      id: invoiceId,
      contentType: doc.contentType,
      xml: xmlText,
      sizeBytes: doc.sizeBytes,
      ...(doc.filename ? { filename: doc.filename } : {}),
    };
  }

  /**
   * `POST /v1/invoices/:id/credit-note` — creates a rectificativa DRAFT.
   *
   * The backend REQUIRES an `Idempotency-Key` header (`400
   * IDEMPOTENCY_KEY_REQUIRED` without it). `request` mints one for every
   * mutation, so passing `idempotencyKey` is optional: supply it to make a
   * caller-driven retry replay the stored 201 instead of creating a second
   * draft. The backend marks that replay with `X-Idempotent-Replayed: true`,
   * but this client reads no response headers, so the replayed 201 and the
   * original are indistinguishable to the caller — both are the same draft,
   * which is the property that matters here.
   */
  async createCreditNote(
    invoiceId: string,
    data: { reason: string; reasonDescription?: string; fullCredit?: boolean; issueDate?: string },
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    return this.requestUnwrapped(
      "POST",
      `/invoices/${encodeURIComponent(invoiceId)}/credit-note`,
      data,
      undefined,
      idempotencyKey,
    );
  }

  async applyLateFee(invoiceId: string, data?: { amount?: number; daysOverdue?: number }): Promise<any> {
    return this.requestUnwrapped("POST", `/invoices/${encodeURIComponent(invoiceId)}/late-fee`, data ?? {});
  }

  // ---------------------------------------------------------------- Quote Actions
  // ----------------------------------------------------------------

  async sendQuote(id: string, to?: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/quotes/${encodeURIComponent(id)}/send`, to ? { to } : undefined);
  }

  // ---------------------------------------------------------------- Webhooks
  // ----------------------------------------------------------------

  async listWebhooks(
    params?: { limit?: number; offset?: number },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/webhooks", undefined, {
      limit: params?.limit,
      offset: params?.offset,
    });
  }

  async getWebhook(id: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", `/webhooks/${encodeURIComponent(id)}`);
  }

  async createWebhook(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/webhooks", data);
  }

  async updateWebhook(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("PATCH", `/webhooks/${encodeURIComponent(id)}`, data);
  }

  async deleteWebhook(id: string): Promise<void> {
    return this.request("DELETE", `/webhooks/${encodeURIComponent(id)}`);
  }

  // ---------------------------------------------------------------- CRM: Contacts
  // ----------------------------------------------------------------

  async listClientContacts(
    clientId: string,
    params?: { limit?: number; offset?: number },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", `/clients/${encodeURIComponent(clientId)}/contacts`, undefined, {
      limit: params?.limit,
      offset: params?.offset,
    });
  }

  async createClientContact(clientId: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/clients/${encodeURIComponent(clientId)}/contacts`, data);
  }

  async deleteClientContact(clientId: string, contactId: string): Promise<void> {
    return this.request("DELETE", `/clients/${encodeURIComponent(clientId)}/contacts/${encodeURIComponent(contactId)}`);
  }

  // ---------------------------------------------------------------- CRM: Activities
  // ----------------------------------------------------------------

  async listClientActivities(
    clientId: string,
    params?: { limit?: number; offset?: number },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", `/clients/${encodeURIComponent(clientId)}/activities`, undefined, {
      limit: params?.limit,
      offset: params?.offset,
    });
  }

  async logClientActivity(clientId: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/clients/${encodeURIComponent(clientId)}/activities`, data);
  }

  // ---------------------------------------------------------------- CRM: Notes
  // ----------------------------------------------------------------

  async listClientNotes(
    clientId: string,
    params?: { limit?: number; offset?: number },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", `/clients/${encodeURIComponent(clientId)}/notes`, undefined, {
      limit: params?.limit,
      offset: params?.offset,
    });
  }

  async createClientNote(clientId: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/clients/${encodeURIComponent(clientId)}/notes`, data);
  }

  async deleteClientNote(clientId: string, noteId: string): Promise<void> {
    return this.request("DELETE", `/clients/${encodeURIComponent(clientId)}/notes/${encodeURIComponent(noteId)}`);
  }

  // ---------------------------------------------------------------- Deposits
  // ----------------------------------------------------------------

  async listDeposits(
    params?: { limit?: number; offset?: number; after?: string; fields?: string; from?: string; to?: string; clientId?: string; status?: string },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/deposits", undefined, {
      limit: params?.limit,
      offset: params?.offset,
      cursor: params?.after,
      fields: params?.fields,
      from: params?.from,
      to: params?.to,
      clientId: params?.clientId,
      status: params?.status,
    });
  }

  async getDeposit(id: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", `/deposits/${encodeURIComponent(id)}`);
  }

  async createDeposit(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/deposits", data);
  }

  async updateDeposit(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("PATCH", `/deposits/${encodeURIComponent(id)}`, data);
  }

  async deleteDeposit(id: string): Promise<void> {
    return this.request("DELETE", `/deposits/${encodeURIComponent(id)}`);
  }

  async applyDeposit(id: string, data?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/deposits/${encodeURIComponent(id)}/apply`, data ?? {});
  }

  async refundDeposit(id: string, data?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/deposits/${encodeURIComponent(id)}/refund`, data ?? {});
  }

  // ---------------------------------------------------------------- E-Invoicing
  // ----------------------------------------------------------------

  async sendEInvoice(params: {
    invoiceId: string;
    format: string;
    dispatchMode: string;
  }): Promise<{ workflowRunId: string; status: "queued"; estimatedCompletionSec: number }> {
    return this.requestUnwrapped("POST", "/einvoice/send", params);
  }

  async getEInvoiceStatus(workflowRunId: string): Promise<{
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    step: string;
    error?: string;
    ackId?: string;
    pdfA3Url?: string;
    xmlUrl?: string;
  }> {
    // get_einvoice_status's outputSchema (eInvoiceStatusOutput) expects the
    // flat status object, same single-object envelope convention as the rest
    // of the /v1 REST surface.
    return this.requestUnwrapped("GET", `/einvoice/status/${encodeURIComponent(workflowRunId)}`);
  }

  async validateEInvoiceXml(params: {
    xml: string;
    format: string;
  }): Promise<{
    valid: boolean;
    errors: Array<{ severity: string; location: string; message: string; rule: string }>;
    validator: "kosit" | "mustang" | "xsd" | "schematron";
    durationMs: number;
  }> {
    return this.requestUnwrapped("POST", "/einvoice/validate", params);
  }

  async exportDatev(params: {
    periodStart: string;
    periodEnd: string;
    format: string;
  }): Promise<{
    fileUrl: string;
    filename: string;
    rowCount: number;
    fiscalPeriod: string;
    encoding: "cp1252";
  }> {
    return this.requestUnwrapped("POST", "/einvoice/export-datev", params);
  }

  // ---------------------------------------------------------------- E-Invoice Day 4 (PR #414 + FACe PR #411 + TicketBAI PR #356)
  // ----------------------------------------------------------------
  // New per-invoice endpoints: /v1/invoices/:id/einvoice/export, /face/*, /ticketbai/*
  // 404 responses propagate to tool handlers which fall back to stub responses.

  async exportEInvoice(params: {
    invoiceId: string;
    format: string;
    signed?: boolean;
  }): Promise<{
    xmlUrl: string;
    filename: string;
    format: string;
    signed: boolean;
  }> {
    const { invoiceId, ...body } = params;
    return this.requestUnwrapped("POST", `/invoices/${encodeURIComponent(invoiceId)}/einvoice/export`, body);
  }

  async faceSubmit(params: {
    invoiceId: string;
    mode: "mock" | "sandbox" | "production";
  }): Promise<{
    registroFACe: string;
    status: "submitted" | "error";
    submittedAt: string;
    mode: string;
  }> {
    const { invoiceId, mode } = params;
    return this.requestUnwrapped("POST", `/invoices/${encodeURIComponent(invoiceId)}/face/submit`, { mode });
  }

  async faceStatus(params: {
    invoiceId: string;
  }): Promise<{
    registroFACe: string;
    statusCode: string;
    statusDescription: string;
    rejectionReason?: string;
  }> {
    return this.request("GET", `/invoices/${encodeURIComponent(params.invoiceId)}/face/status`);
  }

  async ticketbaiSubmit(params: {
    invoiceId: string;
    sandbox: boolean;
  }): Promise<{
    tbaiId: string;
    territory: "bizkaia" | "gipuzkoa" | "araba";
    status: "submitted" | "accepted" | "rejected" | "error";
    sandbox: boolean;
    qrUrl?: string;
  }> {
    const { invoiceId, sandbox } = params;
    return this.requestUnwrapped("POST", `/invoices/${encodeURIComponent(invoiceId)}/ticketbai/submit`, { sandbox });
  }

  async ticketbaiStatus(params: {
    invoiceId: string;
  }): Promise<{
    tbaiId: string;
    territory: "bizkaia" | "gipuzkoa" | "araba";
    status: "submitted" | "accepted" | "rejected" | "error";
    rejectionReason?: string;
    error?: string;
  }> {
    return this.request("GET", `/invoices/${encodeURIComponent(params.invoiceId)}/ticketbai/status`);
  }

  // kSeFSubmit intentionally omitted — ksef_submit tool is always-stub (public KSeF endpoint not yet exposed; transport infra-ready in Frihet-ERP).

  // ---------------------------------------------------------------- Stay (Vacation Rental)
  // ----------------------------------------------------------------
  // NOTE: ERP backend endpoints /v1/stay/* land in Frihet-ERP S2 sprint.
  // These methods target the documented v1 surface; 404 responses will
  // propagate as FrihetApiError(404) to tool handlers.

  async listReservations(
    params?: { propertyId?: string; status?: string; checkInFrom?: string; checkInTo?: string; fields?: string; limit?: number; offset?: number; after?: string },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/stay/reservations", undefined, {
      propertyId: params?.propertyId,
      status: params?.status,
      checkInFrom: params?.checkInFrom,
      checkInTo: params?.checkInTo,
      fields: params?.fields,
      limit: params?.limit,
      offset: params?.offset,
      cursor: params?.after,
    });
  }

  async getReservation(id: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", `/stay/reservations/${encodeURIComponent(id)}`);
  }

  async createReservation(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/stay/reservations", data);
  }

  async listProperties(
    params?: { q?: string; isActive?: boolean; fields?: string; limit?: number; offset?: number; after?: string },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/stay/properties", undefined, {
      q: params?.q,
      isActive: params?.isActive !== undefined ? (params.isActive ? 1 : 0) : undefined,
      fields: params?.fields,
      limit: params?.limit,
      offset: params?.offset,
      cursor: params?.after,
    });
  }

  async syncChannel(channelId: string, direction: "pull" | "push" | "both"): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/stay/channels/${encodeURIComponent(channelId)}/sync`, { direction });
  }

  // ---------------------------------------------------------------- POS (Point of Sale)
  // ----------------------------------------------------------------
  // NOTE: ERP backend endpoints /v1/pos/* land in Frihet-ERP S2 sprint.

  async listTerminals(
    params?: { locationId?: string; limit?: number; offset?: number },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/pos/terminals", undefined, {
      locationId: params?.locationId,
      limit: params?.limit,
      offset: params?.offset,
    });
  }

  async getSale(id: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", `/pos/sales/${encodeURIComponent(id)}`);
  }

  async listSales(
    params?: { terminalId?: string; status?: string; from?: string; to?: string; limit?: number; offset?: number; after?: string },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/pos/sales", undefined, {
      terminalId: params?.terminalId,
      status: params?.status,
      from: params?.from,
      to: params?.to,
      limit: params?.limit,
      offset: params?.offset,
      cursor: params?.after,
    });
  }

  async refundSale(id: string, data?: { amountCents?: number; reason?: string }): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/pos/sales/${encodeURIComponent(id)}/refund`, data ?? {});
  }

  // ---------------------------------------------------------------- Kitchen (KDS)
  // ----------------------------------------------------------------
  // NOTE: ERP backend endpoints /v1/kitchen/* target the live kitchen display system.

  async listKitchenTickets(
    params?: { status?: string; stationId?: string; limit?: number; offset?: number; after?: string },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/kitchen/tickets", undefined, {
      status: params?.status,
      stationId: params?.stationId,
      limit: params?.limit,
      offset: params?.offset,
      cursor: params?.after,
    });
  }

  async getKitchenTicket(id: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", `/kitchen/tickets/${encodeURIComponent(id)}`);
  }

  async updateKitchenTicket(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("PATCH", `/kitchen/tickets/${encodeURIComponent(id)}`, data);
  }

  async listKitchenStations(
    params?: { limit?: number; offset?: number },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/kitchen/stations", undefined, {
      limit: params?.limit,
      offset: params?.offset,
    });
  }

  async listMenuItems(
    params?: { q?: string; isActive?: boolean; limit?: number; offset?: number; after?: string },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/kitchen/menuItems", undefined, {
      q: params?.q,
      isActive: params?.isActive !== undefined ? (params.isActive ? 1 : 0) : undefined,
      limit: params?.limit,
      offset: params?.offset,
      cursor: params?.after,
    });
  }

  // ---------------------------------------------------------------- Intelligence
  // ----------------------------------------------------------------

  async getBusinessContext(): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", "/context");
  }

  async getMonthlySummary(month?: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", "/monthly", undefined, {
      month,
    });
  }

  async getQuarterlyTaxes(quarter?: string): Promise<Record<string, unknown>> {
    return this.request("GET", "/quarterly", undefined, {
      quarter,
    });
  }

  // ---------------------------------------------------------------- Banking
  // /v1/banking/* endpoints are LIVE in Frihet-ERP (#848): accounts list/get,
  // transactions list/categorize/match. Paths below match the shipped server
  // actions verbatim. Client contract smoke: src/__tests__/banking-client-contract.test.ts.

  async listBankAccounts(
    params?: { limit?: number; offset?: number },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/banking/accounts", undefined, {
      limit: params?.limit,
      offset: params?.offset,
    });
  }

  async getBankAccount(id: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", `/banking/accounts/${encodeURIComponent(id)}`);
  }

  async listTransactions(
    params?: { accountId?: string; from?: string; to?: string; status?: string; category?: string; limit?: number; offset?: number; after?: string },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/banking/transactions", undefined, {
      accountId: params?.accountId,
      from: params?.from,
      to: params?.to,
      status: params?.status,
      category: params?.category,
      limit: params?.limit,
      offset: params?.offset,
      cursor: params?.after,
    });
  }

  async categorizeTransaction(
    id: string,
    data: { category: string; notes?: string },
  ): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("PATCH", `/banking/transactions/${encodeURIComponent(id)}/categorize`, data);
  }

  async matchTransactionToDocument(
    transactionId: string,
    data: { documentId: string; documentType: "invoice" | "expense"; notes?: string },
  ): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/banking/transactions/${encodeURIComponent(transactionId)}/match`, data);
  }

  // ---------------------------------------------------------------- Fiscal
  // RESOLVED (was: "planned — 404 propagates until backend ships"). The
  // /v1/fiscal/modelo/:code summary backend (Modelo 303/130/390 READ-ONLY)
  // has SHIPPED in Frihet-ERP (publicApi.ts). The CF wraps the single-object
  // summary in a `{ data, meta }` envelope, so this read MUST unwrap to
  // `body.data` — otherwise the tool's structuredContent is the envelope, not
  // the modelo summary. See requestUnwrapped().
  // NOTE: /v1/fiscal/verifactu/* + /ticketbai/* below remain pending and 404
  // until those backends ship (they keep the raw `request` path for now).

  async getFiscalModeloSummary(
    modeloCode: string,
    period?: string,
  ): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", `/fiscal/modelo/${encodeURIComponent(modeloCode)}`, undefined, {
      period,
    });
  }

  async getVerifactuStatus(invoiceId: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", `/fiscal/verifactu/${encodeURIComponent(invoiceId)}/status`);
  }

  async resubmitVerifactu(invoiceId: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/fiscal/verifactu/${encodeURIComponent(invoiceId)}/resubmit`, {});
  }

  async getTicketbaiStatus(invoiceId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/fiscal/ticketbai/${encodeURIComponent(invoiceId)}/status`);
  }

  // ---------------------------------------------------------------- Time Tracking
  // Backend: /v1/time/* endpoints live as of Wave 4-A (Frihet-ERP functions/src/publicApi.ts).

  async listTimeEntries(
    params?: { userId?: string; projectId?: string; from?: string; to?: string; billable?: boolean; limit?: number; offset?: number; after?: string },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/time/entries", undefined, {
      userId: params?.userId,
      projectId: params?.projectId,
      from: params?.from,
      to: params?.to,
      billable: params?.billable !== undefined ? (params.billable ? 1 : 0) : undefined,
      limit: params?.limit,
      offset: params?.offset,
      cursor: params?.after,
    });
  }

  async getTimeEntry(id: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", `/time/entries/${encodeURIComponent(id)}`);
  }

  async createTimeEntry(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/time/entries", data);
  }

  async updateTimeEntry(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("PATCH", `/time/entries/${encodeURIComponent(id)}`, data);
  }

  async deleteTimeEntry(id: string): Promise<void> {
    return this.request("DELETE", `/time/entries/${encodeURIComponent(id)}`);
  }

  async getTimeSummary(
    params: { from: string; to: string; userId?: string; projectId?: string; groupBy?: string },
  ): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", "/time/summary", undefined, {
      from: params.from,
      to: params.to,
      userId: params?.userId,
      projectId: params?.projectId,
      groupBy: params?.groupBy,
    });
  }

  // ---------------------------------------------------------------- Recurring Invoices
  // Backend: /v1/recurring/* endpoints live as of Wave 4-A (Frihet-ERP functions/src/publicApi.ts).

  async listRecurringInvoices(
    params?: { status?: string; limit?: number; offset?: number },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/recurring/invoices", undefined, {
      status: params?.status,
      limit: params?.limit,
      offset: params?.offset,
    });
  }

  async getRecurringInvoice(id: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("GET", `/recurring/invoices/${encodeURIComponent(id)}`);
  }

  async createRecurringInvoice(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/recurring/invoices", data);
  }

  async updateRecurringInvoice(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("PATCH", `/recurring/invoices/${encodeURIComponent(id)}`, data);
  }

  async pauseRecurringInvoice(id: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/recurring/invoices/${encodeURIComponent(id)}/pause`, {});
  }

  async resumeRecurringInvoice(id: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/recurring/invoices/${encodeURIComponent(id)}/resume`, {});
  }

  async deleteRecurringInvoice(id: string): Promise<void> {
    return this.request("DELETE", `/recurring/invoices/${encodeURIComponent(id)}`);
  }

  async runRecurringNow(
    templateId: string,
    options?: { draftOnly?: boolean },
  ): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/recurring/invoices/${encodeURIComponent(templateId)}/run`, {
      draftOnly: options?.draftOnly ?? true,
    });
  }

  // ---------------------------------------------------------------- Team Management
  // Backend: /v1/team/* endpoints live as of Wave 4-A (Frihet-ERP functions/src/publicApi.ts).

  async listTeamMembers(
    params?: { role?: string; status?: string; limit?: number; offset?: number },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/team/members", undefined, {
      role: params?.role,
      status: params?.status,
      limit: params?.limit,
      offset: params?.offset,
    });
  }

  async inviteTeamMember(data: { email: string; role: string; name?: string }): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/team/members/invite", data);
  }

  async updateTeamMemberRole(memberId: string, role: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("PATCH", `/team/members/${encodeURIComponent(memberId)}/role`, { role });
  }

  async removeTeamMember(memberId: string): Promise<void> {
    return this.request("DELETE", `/team/members/${encodeURIComponent(memberId)}`);
  }

  // ---------------------------------------------------------------- Gestoria (Wave Fase 1)
  // Backend: /v1/gestoria/* endpoints land with Frihet-ERP Wave Fase 1 closure.
  // PRs: #383 gestoriaBulkSendRequests callable (live), #384 aging consolidated,
  // #385 contextual messaging. REST shell proxies the callables + Firestore reads.
  // Tools surface 404 until backend ships.

  async sendGestoriaMessage(data: {
    workspaceId: string;
    parentType: "documentRequest" | "filingItem" | "obligation";
    parentId: string;
    body: string;
  }): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/gestoria/messages", data);
  }

  async listGestoriaMessages(params: {
    workspaceId: string;
    parentType: "documentRequest" | "filingItem" | "obligation";
    parentId: string;
    limit?: number;
    before?: string;
  }): Promise<{ messages: Array<Record<string, unknown>>; hasMore: boolean }> {
    return this.request("GET", "/gestoria/messages", undefined, {
      workspaceId: params.workspaceId,
      parentType: params.parentType,
      parentId: params.parentId,
      limit: params.limit,
      before: params.before,
    });
  }

  async createGestoriaTemplate(data: {
    name: string;
    title: string;
    description: string;
    dueDateOffsetDays: number;
    attachmentRequired?: boolean;
    variables?: Array<{ key: string; label?: string; defaultValue?: string }>;
  }): Promise<{ templateId: string }> {
    return this.requestUnwrapped("POST", "/gestoria/templates", data);
  }

  async bulkSendGestoriaTemplate(data: {
    templateId: string;
    clientWorkspaceIds: string[];
    periodOverrides?: { quarter?: string | number; year?: string | number; month?: string | number };
  }): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/gestoria/templates/bulk-send", data);
  }

  async getGestoriaAgingConsolidated(params?: { ownerUid?: string }): Promise<Record<string, unknown>> {
    return this.request("GET", "/gestoria/aging/consolidated", undefined, {
      ownerUid: params?.ownerUid,
    });
  }

  // ---------------------------------------------------------------- Audit GL
  // NOTE: /v1/gl/* endpoints proxy Firebase callables (PR #395). 404 until REST shell ships.

  async approveGLEntry(entryId: string, notes?: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/gl/entries/${encodeURIComponent(entryId)}/approve`, { notes });
  }

  async rejectGLEntry(entryId: string, reason: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/gl/entries/${encodeURIComponent(entryId)}/reject`, { reason });
  }

  async getGLEntryAuditLog(entryId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/gl/entries/${encodeURIComponent(entryId)}/audit-log`);
  }

  // ---------------------------------------------------------------- White-label Portal Domain
  // NOTE: /v1/portal/domain/* endpoints proxy Firebase callables (PR #397). 404 until REST shell ships.

  async addCustomPortalDomain(data: { domain: string; workspaceId?: string }): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/portal/domain", data);
  }

  async verifyCustomPortalDomain(data: { domain: string }): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/portal/domain/${encodeURIComponent(data.domain)}/verify`, {});
  }

  async removeCustomPortalDomain(data: { domain: string }): Promise<Record<string, unknown>> {
    return this.request("DELETE", `/portal/domain/${encodeURIComponent(data.domain)}`);
  }

  // ---------------------------------------------------------------- Self-onboard + VIES
  // NOTE: /v1/portal/onboard/* endpoints proxy Firebase callables (PR #398). 404 until REST shell ships.

  async generatePortalOnboardLink(data: { email: string; name?: string; expiresInHours?: number; workspaceId?: string }): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/portal/onboard/link", data);
  }

  async lookupTaxIdViaVIES(data: { vatNumber: string; countryCode: string }): Promise<Record<string, unknown>> {
    return this.request("GET", "/tax/vies/lookup", undefined, {
      vatNumber: data.vatNumber,
      countryCode: data.countryCode,
    });
  }

  // ---------------------------------------------------------------- IGIC (Canary Islands)
  // NOTE: /v1/igic/* endpoints (PR #390). 404 until REST shell ships.

  async getIgicModeloSummary(modeloCode: string, params?: { year?: string; period?: string }): Promise<Record<string, unknown>> {
    return this.request("GET", `/igic/modelo/${encodeURIComponent(modeloCode)}`, undefined, {
      year: params?.year,
      period: params?.period,
    });
  }

  async calculateAiem(data: { ncCode: string; amount: number; description?: string }): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/igic/aiem/calculate", data);
  }

  // ---------------------------------------------------------------- Impuesto Sociedades (IS)
  // NOTE: /v1/is/* endpoints (PR #392). 404 until REST shell ships.

  async getISSummary(modeloCode: string, params?: { year?: string; installment?: string }): Promise<Record<string, unknown>> {
    return this.request("GET", `/is/modelo/${encodeURIComponent(modeloCode)}`, undefined, {
      year: params?.year,
      installment: params?.installment,
    });
  }

  // ---------------------------------------------------------------- Bank Rules
  // NOTE: /v1/banking/rules Q3-flagged (PR #394). 404 until callable wrapper ships.

  async listBankRules(params?: { isActive?: boolean; limit?: number; offset?: number }): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.request("GET", "/banking/rules", undefined, {
      isActive: params?.isActive !== undefined ? String(params.isActive) : undefined,
      limit: params?.limit,
      offset: params?.offset,
    });
  }

  async createBankRule(data: {
    name: string;
    conditions: Array<{ field: string; operator: string; value: string }>;
    actions: Array<{ type: string; value: string }>;
    isActive?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/banking/rules", data);
  }

  // ---------------------------------------------------------------- HR (Leaves + Attendance + Anomalies)
  // NOTE: /v1/leaves, /v1/time-entries, /v1/anomalies — D4-A parallel deploy. 404 propagates until backend ships.

  async listLeaves(
    params?: { employeeId?: string; status?: string; from?: string; to?: string; limit?: number; offset?: number; after?: string },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/leaves", undefined, {
      employeeId: params?.employeeId,
      status: params?.status,
      from: params?.from,
      to: params?.to,
      limit: params?.limit,
      offset: params?.offset,
      cursor: params?.after,
    });
  }

  async createLeaveRequest(
    data: { employeeId: string; type: string; startDate: string; endDate: string; reason?: string },
  ): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/leaves", data);
  }

  async approveLeave(leaveId: string, data?: { reason?: string }): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/leaves/${encodeURIComponent(leaveId)}/approve`, data ?? {});
  }

  async rejectLeave(leaveId: string, data: { reason: string }): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/leaves/${encodeURIComponent(leaveId)}/reject`, data);
  }

  async cancelLeave(leaveId: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/leaves/${encodeURIComponent(leaveId)}/cancel`, {});
  }

  async attendanceClockIn(
    data: { employeeId: string; mood?: string; location?: string },
  ): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/time-entries/clock-in", data);
  }

  async attendanceClockOut(entryId: string): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("PATCH", `/time-entries/${encodeURIComponent(entryId)}/clock-out`, {});
  }

  async getOvertimeReport(
    params: { period: string; employeeId?: string },
  ): Promise<Record<string, unknown>> {
    return this.request("GET", "/time-entries/overtime", undefined, {
      period: params.period,
      employeeId: params.employeeId,
    });
  }

  async listAnomalies(
    params?: { type?: string; severity?: string; from?: string; to?: string; limit?: number; offset?: number },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.requestPaginated("GET", "/anomalies", undefined, {
      type: params?.type,
      severity: params?.severity,
      from: params?.from,
      to: params?.to,
      limit: params?.limit,
      offset: params?.offset,
    });
  }

  // ---------------------------------------------------------------- Webhook Trust-Area Extensions
  // NOTE: /v1/webhooks/:id/test — D4-A parallel deploy. 404 propagates until backend ships.

  async testWebhook(id: string, data?: { eventType?: string }): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/webhooks/${encodeURIComponent(id)}/test`, data ?? {});
  }

  // ---------------------------------------------------------------- Payroll
  // NOTE: /v1/payroll/prep/* — D4-A parallel deploy. 404 propagates until backend ships.

  async exportPayroll(
    params: { format: "a3" | "contasol" | "sage" | "holded" | "siltra"; month: string },
  ): Promise<Record<string, unknown>> {
    return this.request("GET", "/payroll/prep/export", undefined, {
      format: params.format,
      month: params.month,
    });
  }

  async getPayrollChecklist(params: { month: string }): Promise<Record<string, unknown>> {
    return this.request("GET", "/payroll/prep/employees", undefined, {
      month: params.month,
    });
  }

  // ---------------------------------------------------------------- Onboarding
  // NOTE: /v1/onboarding/* — D4-A parallel deploy. 404 propagates until backend ships.

  async getOnboardingStatus(): Promise<Record<string, unknown>> {
    return this.request("GET", "/onboarding/status");
  }

  async setOnboardingPersona(
    data: { persona: "autonomo" | "empresa" | "agencia" | "gestoria" },
  ): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("PATCH", "/onboarding/persona", data);
  }

  // ---------------------------------------------------------------- Permissions
  // NOTE: /v1/permissions/* — D4-A parallel deploy. 404 propagates until backend ships.

  async getPermissionsMatrix(): Promise<Record<string, unknown>> {
    return this.request("GET", "/permissions/matrix");
  }

  async getMyPermissions(): Promise<Record<string, unknown>> {
    return this.request("GET", "/permissions/me");
  }

  // ---------------------------------------------------------------- Period Close
  // NOTE: /v1/periods/* — D4-A parallel deploy. 404 propagates until backend ships.

  async getCurrentPeriod(params?: { periodId?: string }): Promise<Record<string, unknown>> {
    if (params?.periodId) {
      return this.request("GET", `/periods/${encodeURIComponent(params.periodId)}`);
    }
    return this.request("GET", "/periods/current");
  }

  async closePeriod(data: { type: "monthly" | "quarterly" }): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", "/periods/close", data);
  }

  async reopenPeriod(data: { periodId: string; reason: string }): Promise<Record<string, unknown>> {
    return this.requestUnwrapped("POST", `/periods/${encodeURIComponent(data.periodId)}/reopen`, { reason: data.reason });
  }
}
