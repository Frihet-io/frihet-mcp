/**
 * HTTP client wrapping the Frihet ERP REST API.
 *
 * Handles authentication, pagination, rate-limit retries, and error mapping.
 */

import type { PaginatedResponse, ApiError } from "./types.js";
import { logApiCall, logRetry } from "./logger.js";

const BASE_URL = "https://api.frihet.io/v1";

const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 30000;

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
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);

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
    };

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
      return this.request<T>(method, path, body, query, retryCount + 1);
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Wrapper for SINGLE-OBJECT endpoints whose backend wraps the item in a
   * `{ data, meta }` envelope (e.g. the shipped `/v1/fiscal/modelo/:code` CF).
   *
   * The Cloudflare Function returns `res.json({ data: <item>, meta: {...} })`
   * for single-object reads, so the raw HTTP body is the envelope — NOT the
   * item. Passing that envelope straight into a tool's `structuredContent`
   * surfaces `{ data, meta }` instead of the modelo summary, breaking the
   * tool's output schema. This unwraps to `body.data`.
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
  ): Promise<T> {
    const raw = await this.request<unknown>(method, path, body, query);

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
      after: params?.after,
      fields: params?.fields,
      status: params?.status,
      from: params?.from,
      to: params?.to,
      clientId: params?.clientId,
      seriesId: params?.seriesId,
    });
  }

  async getInvoice(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/invoices/${encodeURIComponent(id)}`);
  }

  async createInvoice(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/invoices", data);
  }

  async updateInvoice(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/invoices/${encodeURIComponent(id)}`, data);
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
      after: params?.after,
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
      after: params?.after,
      fields: params?.fields,
      from: params?.from,
      to: params?.to,
      vendorId: params?.vendorId,
      category: params?.category,
    });
  }

  async getExpense(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/expenses/${encodeURIComponent(id)}`);
  }

  async createExpense(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/expenses", data);
  }

  async updateExpense(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/expenses/${encodeURIComponent(id)}`, data);
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
      after: params?.after,
      fields: params?.fields,
      q: params?.q,
      stage: params?.stage,
    });
  }

  async getClient(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/clients/${encodeURIComponent(id)}`);
  }

  async createClient(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/clients", data);
  }

  async updateClient(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/clients/${encodeURIComponent(id)}`, data);
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
      after: params?.after,
      fields: params?.fields,
      q: params?.q,
      isActive: params?.isActive !== undefined ? (params.isActive ? 1 : 0) : undefined,
    });
  }

  async getProduct(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/products/${encodeURIComponent(id)}`);
  }

  async createProduct(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/products", data);
  }

  async updateProduct(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/products/${encodeURIComponent(id)}`, data);
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
      after: params?.after,
      fields: params?.fields,
      status: params?.status,
      from: params?.from,
      to: params?.to,
      clientId: params?.clientId,
      seriesId: params?.seriesId,
    });
  }

  async getQuote(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/quotes/${encodeURIComponent(id)}`);
  }

  async createQuote(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/quotes", data);
  }

  async updateQuote(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/quotes/${encodeURIComponent(id)}`, data);
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
      after: params?.after,
      fields: params?.fields,
    });
  }

  async getVendor(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/vendors/${encodeURIComponent(id)}`);
  }

  async createVendor(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/vendors", data);
  }

  async updateVendor(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/vendors/${encodeURIComponent(id)}`, data);
  }

  async deleteVendor(id: string): Promise<void> {
    return this.request("DELETE", `/vendors/${encodeURIComponent(id)}`);
  }

  // ---------------------------------------------------------------- Invoice Actions
  // ----------------------------------------------------------------

  async sendInvoice(id: string, to?: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/invoices/${encodeURIComponent(id)}/send`, to ? { to } : undefined);
  }

  async markInvoicePaid(id: string, paidDate?: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/invoices/${encodeURIComponent(id)}/paid`, paidDate ? { paidDate } : undefined);
  }

  async getInvoicePdf(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/invoices/${encodeURIComponent(id)}/pdf`);
  }

  async getInvoiceEInvoice(invoiceId: string): Promise<any> {
    return this.request("GET", `/invoices/${encodeURIComponent(invoiceId)}/xml`);
  }

  async createCreditNote(
    invoiceId: string,
    data: { reason: string; reasonDescription?: string; fullCredit?: boolean; issueDate?: string },
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/invoices/${encodeURIComponent(invoiceId)}/credit-note`, data);
  }

  async applyLateFee(invoiceId: string, data?: { amount?: number; daysOverdue?: number }): Promise<any> {
    return this.request("POST", `/invoices/${encodeURIComponent(invoiceId)}/late-fee`, data ?? {});
  }

  // ---------------------------------------------------------------- Quote Actions
  // ----------------------------------------------------------------

  async sendQuote(id: string, to?: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/quotes/${encodeURIComponent(id)}/send`, to ? { to } : undefined);
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
    return this.request("GET", `/webhooks/${encodeURIComponent(id)}`);
  }

  async createWebhook(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/webhooks", data);
  }

  async updateWebhook(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/webhooks/${encodeURIComponent(id)}`, data);
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
    return this.request("POST", `/clients/${encodeURIComponent(clientId)}/contacts`, data);
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
    return this.request("POST", `/clients/${encodeURIComponent(clientId)}/activities`, data);
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
    return this.request("POST", `/clients/${encodeURIComponent(clientId)}/notes`, data);
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
      after: params?.after,
      fields: params?.fields,
      from: params?.from,
      to: params?.to,
      clientId: params?.clientId,
      status: params?.status,
    });
  }

  async getDeposit(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/deposits/${encodeURIComponent(id)}`);
  }

  async createDeposit(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/deposits", data);
  }

  async updateDeposit(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/deposits/${encodeURIComponent(id)}`, data);
  }

  async deleteDeposit(id: string): Promise<void> {
    return this.request("DELETE", `/deposits/${encodeURIComponent(id)}`);
  }

  async applyDeposit(id: string, data?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/deposits/${encodeURIComponent(id)}/apply`, data ?? {});
  }

  async refundDeposit(id: string, data?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/deposits/${encodeURIComponent(id)}/refund`, data ?? {});
  }

  // ---------------------------------------------------------------- E-Invoicing
  // ----------------------------------------------------------------

  async sendEInvoice(params: {
    invoiceId: string;
    format: string;
    dispatchMode: string;
  }): Promise<{ workflowRunId: string; status: "queued"; estimatedCompletionSec: number }> {
    return this.request("POST", "/einvoice/send", params);
  }

  async getEInvoiceStatus(workflowRunId: string): Promise<{
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    step: string;
    error?: string;
    ackId?: string;
    pdfA3Url?: string;
    xmlUrl?: string;
  }> {
    return this.request("GET", `/einvoice/status/${encodeURIComponent(workflowRunId)}`);
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
    return this.request("POST", "/einvoice/validate", params);
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
    return this.request("POST", "/einvoice/export-datev", params);
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
    return this.request("POST", `/invoices/${encodeURIComponent(invoiceId)}/einvoice/export`, body);
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
    return this.request("POST", `/invoices/${encodeURIComponent(invoiceId)}/face/submit`, { mode });
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
    return this.request("POST", `/invoices/${encodeURIComponent(invoiceId)}/ticketbai/submit`, { sandbox });
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

  // kSeFSubmit intentionally omitted — ksef_submit tool is always-stub until PR #417 merges.

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
      after: params?.after,
    });
  }

  async getReservation(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/stay/reservations/${encodeURIComponent(id)}`);
  }

  async createReservation(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/stay/reservations", data);
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
      after: params?.after,
    });
  }

  async syncChannel(channelId: string, direction: "pull" | "push" | "both"): Promise<Record<string, unknown>> {
    return this.request("POST", `/stay/channels/${encodeURIComponent(channelId)}/sync`, { direction });
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
    return this.request("GET", `/pos/sales/${encodeURIComponent(id)}`);
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
      after: params?.after,
    });
  }

  async refundSale(id: string, data?: { amountCents?: number; reason?: string }): Promise<Record<string, unknown>> {
    return this.request("POST", `/pos/sales/${encodeURIComponent(id)}/refund`, data ?? {});
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
      after: params?.after,
    });
  }

  async getKitchenTicket(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/kitchen/tickets/${encodeURIComponent(id)}`);
  }

  async updateKitchenTicket(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/kitchen/tickets/${encodeURIComponent(id)}`, data);
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
      after: params?.after,
    });
  }

  // ---------------------------------------------------------------- Intelligence
  // ----------------------------------------------------------------

  async getBusinessContext(): Promise<Record<string, unknown>> {
    return this.request("GET", "/context");
  }

  async getMonthlySummary(month?: string): Promise<Record<string, unknown>> {
    return this.request("GET", "/monthly", undefined, {
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
    return this.request("GET", `/banking/accounts/${encodeURIComponent(id)}`);
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
      after: params?.after,
    });
  }

  async categorizeTransaction(
    id: string,
    data: { category: string; notes?: string },
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/banking/transactions/${encodeURIComponent(id)}/categorize`, data);
  }

  async matchTransactionToDocument(
    transactionId: string,
    data: { documentId: string; documentType: "invoice" | "expense"; notes?: string },
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/banking/transactions/${encodeURIComponent(transactionId)}/match`, data);
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
    return this.request("GET", `/fiscal/verifactu/${encodeURIComponent(invoiceId)}/status`);
  }

  async resubmitVerifactu(invoiceId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/fiscal/verifactu/${encodeURIComponent(invoiceId)}/resubmit`, {});
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
      after: params?.after,
    });
  }

  async getTimeEntry(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/time/entries/${encodeURIComponent(id)}`);
  }

  async createTimeEntry(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/time/entries", data);
  }

  async updateTimeEntry(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/time/entries/${encodeURIComponent(id)}`, data);
  }

  async deleteTimeEntry(id: string): Promise<void> {
    return this.request("DELETE", `/time/entries/${encodeURIComponent(id)}`);
  }

  async getTimeSummary(
    params: { from: string; to: string; userId?: string; projectId?: string; groupBy?: string },
  ): Promise<Record<string, unknown>> {
    return this.request("GET", "/time/summary", undefined, {
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
    return this.request("GET", `/recurring/invoices/${encodeURIComponent(id)}`);
  }

  async createRecurringInvoice(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/recurring/invoices", data);
  }

  async updateRecurringInvoice(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/recurring/invoices/${encodeURIComponent(id)}`, data);
  }

  async pauseRecurringInvoice(id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/recurring/invoices/${encodeURIComponent(id)}/pause`, {});
  }

  async resumeRecurringInvoice(id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/recurring/invoices/${encodeURIComponent(id)}/resume`, {});
  }

  async deleteRecurringInvoice(id: string): Promise<void> {
    return this.request("DELETE", `/recurring/invoices/${encodeURIComponent(id)}`);
  }

  async runRecurringNow(
    templateId: string,
    options?: { draftOnly?: boolean },
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/recurring/invoices/${encodeURIComponent(templateId)}/run`, {
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
    return this.request("POST", "/team/members/invite", data);
  }

  async updateTeamMemberRole(memberId: string, role: string): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/team/members/${encodeURIComponent(memberId)}/role`, { role });
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
    return this.request("POST", "/gestoria/messages", data);
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
    return this.request("POST", "/gestoria/templates", data);
  }

  async bulkSendGestoriaTemplate(data: {
    templateId: string;
    clientWorkspaceIds: string[];
    periodOverrides?: { quarter?: string | number; year?: string | number; month?: string | number };
  }): Promise<Record<string, unknown>> {
    return this.request("POST", "/gestoria/templates/bulk-send", data);
  }

  async getGestoriaAgingConsolidated(params?: { ownerUid?: string }): Promise<Record<string, unknown>> {
    return this.request("GET", "/gestoria/aging/consolidated", undefined, {
      ownerUid: params?.ownerUid,
    });
  }

  // ---------------------------------------------------------------- Audit GL
  // NOTE: /v1/gl/* endpoints proxy Firebase callables (PR #395). 404 until REST shell ships.

  async approveGLEntry(entryId: string, notes?: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/gl/entries/${encodeURIComponent(entryId)}/approve`, { notes });
  }

  async rejectGLEntry(entryId: string, reason: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/gl/entries/${encodeURIComponent(entryId)}/reject`, { reason });
  }

  async getGLEntryAuditLog(entryId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/gl/entries/${encodeURIComponent(entryId)}/audit-log`);
  }

  // ---------------------------------------------------------------- White-label Portal Domain
  // NOTE: /v1/portal/domain/* endpoints proxy Firebase callables (PR #397). 404 until REST shell ships.

  async addCustomPortalDomain(data: { domain: string; workspaceId?: string }): Promise<Record<string, unknown>> {
    return this.request("POST", "/portal/domain", data);
  }

  async verifyCustomPortalDomain(data: { domain: string }): Promise<Record<string, unknown>> {
    return this.request("POST", `/portal/domain/${encodeURIComponent(data.domain)}/verify`, {});
  }

  async removeCustomPortalDomain(data: { domain: string }): Promise<Record<string, unknown>> {
    return this.request("DELETE", `/portal/domain/${encodeURIComponent(data.domain)}`);
  }

  // ---------------------------------------------------------------- Self-onboard + VIES
  // NOTE: /v1/portal/onboard/* endpoints proxy Firebase callables (PR #398). 404 until REST shell ships.

  async generatePortalOnboardLink(data: { email: string; name?: string; expiresInHours?: number; workspaceId?: string }): Promise<Record<string, unknown>> {
    return this.request("POST", "/portal/onboard/link", data);
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
    return this.request("POST", "/igic/aiem/calculate", data);
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
    return this.request("POST", "/banking/rules", data);
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
      after: params?.after,
    });
  }

  async createLeaveRequest(
    data: { employeeId: string; type: string; startDate: string; endDate: string; reason?: string },
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/leaves", data);
  }

  async approveLeave(leaveId: string, data?: { reason?: string }): Promise<Record<string, unknown>> {
    return this.request("POST", `/leaves/${encodeURIComponent(leaveId)}/approve`, data ?? {});
  }

  async rejectLeave(leaveId: string, data: { reason: string }): Promise<Record<string, unknown>> {
    return this.request("POST", `/leaves/${encodeURIComponent(leaveId)}/reject`, data);
  }

  async cancelLeave(leaveId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/leaves/${encodeURIComponent(leaveId)}/cancel`, {});
  }

  async attendanceClockIn(
    data: { employeeId: string; mood?: string; location?: string },
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/time-entries/clock-in", data);
  }

  async attendanceClockOut(entryId: string): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/time-entries/${encodeURIComponent(entryId)}/clock-out`, {});
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
    return this.request("POST", `/webhooks/${encodeURIComponent(id)}/test`, data ?? {});
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
    return this.request("PATCH", "/onboarding/persona", data);
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
    return this.request("POST", "/periods/close", data);
  }

  async reopenPeriod(data: { periodId: string; reason: string }): Promise<Record<string, unknown>> {
    return this.request("POST", `/periods/${encodeURIComponent(data.periodId)}/reopen`, { reason: data.reason });
  }
}
