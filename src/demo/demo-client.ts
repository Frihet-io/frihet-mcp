/**
 * DemoClient — an IFrihetClient implementation that serves EVERYTHING from
 * embedded fixtures and an in-memory session store. Activated by index.ts when
 * FRIHET_DEMO=1 and no API key is present.
 *
 * GUARDRAILS (spec Viktor, opción B):
 *   #3 Fiscal/e-invoice/email surface (e-invoice export/submit, VeriFactu,
 *      FACe, TicketBAI, DATEV, email send) NEVER hits a real endpoint — it
 *      returns a clearly-labelled SIMULATION (`_simulated: true` + `nota`).
 *   #4 In demo mode NO code path performs any network/HTTP request. This class
 *      contains ZERO `fetch` calls — every method returns from memory.
 *      create_* writes are simulated in the session store (returned "created",
 *      never persisted beyond the process).
 *
 * The banner (`_demo: true` + text) is added on top of every response by the
 * server-side interceptor in demo-profile.ts, so it is not repeated per-method.
 */

import type { IFrihetClient } from "../client-interface.js";
import type { PaginatedResponse } from "../types.js";
import {
  demoInvoices,
  demoExpenses,
  demoClients,
  demoProducts,
  demoQuotes,
  demoVendors,
  demoBusinessContext,
  demoMonthlySummary,
  demoQuarterlyTaxes,
  DEMO_TEST_IBAN,
} from "./fixtures.js";

type Rec = Record<string, unknown>;

const SIM_NOTE =
  "Operación simulada en modo demo — no se realizó ninguna llamada real ni se envió/presentó nada.";

function clone<T>(value: T): T {
  // structuredClone is available in Node >= 17; falls back to JSON round-trip.
  const sc = (globalThis as { structuredClone?: <U>(v: U) => U }).structuredClone;
  return sc ? sc(value) : (JSON.parse(JSON.stringify(value)) as T);
}

function nowIso(): string {
  return new Date().toISOString();
}

interface PageParams {
  limit?: number;
  offset?: number;
  after?: string;
}

export class DemoClient implements IFrihetClient {
  // Session store — deep-cloned from fixtures so simulated writes never mutate
  // the shared fixture module.
  private invoices: Rec[] = clone(demoInvoices);
  private expenses: Rec[] = clone(demoExpenses);
  private clients: Rec[] = clone(demoClients);
  private products: Rec[] = clone(demoProducts);
  private quotes: Rec[] = clone(demoQuotes);
  private vendors: Rec[] = clone(demoVendors);
  private webhooks: Rec[] = [];
  private deposits: Rec[] = [];
  private timeEntries: Rec[] = [];
  private recurring: Rec[] = [];
  private teamMembers: Rec[] = [
    {
      id: "tm_demo_0001",
      name: "Propietario Demo",
      email: "owner@example.com",
      role: "owner",
      status: "active",
      joinedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  private clientContacts = new Map<string, Rec[]>();
  private clientActivities = new Map<string, Rec[]>();
  private clientNotes = new Map<string, Rec[]>();

  private seq = 1000;
  private genId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_demo_${this.seq}`;
  }

  /** Attach the simulation markers to a labelled fiscal/email/money response. */
  private sim<T>(obj: T): T {
    Object.assign(obj as object, {
      _demo: true,
      _simulated: true,
      nota: SIM_NOTE,
    });
    return obj;
  }

  private paginate(
    rows: Rec[],
    params?: PageParams,
  ): PaginatedResponse<Rec> {
    const limit = params?.limit ?? 50;
    const offset = params?.offset ?? 0;
    const page = rows.slice(offset, offset + limit);
    const result: PaginatedResponse<Rec> = {
      data: clone(page),
      total: rows.length,
      limit,
      offset,
    };
    if (offset + limit < rows.length && page.length > 0) {
      const last = page[page.length - 1] as Rec;
      result.nextCursor = String(last.id ?? offset + limit);
    }
    return result;
  }

  private findOr(rows: Rec[], id: string): Rec {
    const found = rows.find((r) => r.id === id);
    return clone(found ?? rows[0] ?? { id });
  }

  private applyUpdate(rows: Rec[], id: string, data: Rec): Rec {
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) {
      const created = { id, ...data, updatedAt: nowIso() };
      return clone(created);
    }
    rows[idx] = { ...rows[idx], ...data, updatedAt: nowIso() };
    return clone(rows[idx]);
  }

  private remove(rows: Rec[], id: string): void {
    const idx = rows.findIndex((r) => r.id === id);
    if (idx !== -1) rows.splice(idx, 1);
  }

  // -------------------------------------------------------------- Invoices

  async listInvoices(params?: {
    limit?: number;
    offset?: number;
    after?: string;
    fields?: string;
    status?: string;
    from?: string;
    to?: string;
    clientId?: string;
    seriesId?: string;
  }): Promise<PaginatedResponse<Rec>> {
    let rows = this.invoices;
    if (params?.status) rows = rows.filter((r) => r.status === params.status);
    if (params?.clientId) rows = rows.filter((r) => r.clientId === params.clientId);
    return this.paginate(rows, params);
  }

  async getInvoice(id: string): Promise<Rec> {
    return this.findOr(this.invoices, id);
  }

  async createInvoice(data: Rec): Promise<Rec> {
    const items = Array.isArray(data.items) ? (data.items as Rec[]) : [];
    const subtotal = items.reduce(
      (s, it) => s + Number(it.quantity ?? 0) * Number(it.unitPrice ?? 0),
      0,
    );
    const taxRate = Number(data.taxRate ?? 0);
    const irpfRate = Number(data.irpfRate ?? 0);
    const total =
      subtotal + (subtotal * taxRate) / 100 - (subtotal * irpfRate) / 100;
    const record: Rec = {
      id: this.genId("inv"),
      status: "draft",
      ...data,
      subtotal,
      total: Math.round(total * 100) / 100,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.invoices.unshift(record);
    return clone(record);
  }

  async updateInvoice(id: string, data: Rec): Promise<Rec> {
    return this.applyUpdate(this.invoices, id, data);
  }

  async deleteInvoice(id: string): Promise<void> {
    this.remove(this.invoices, id);
  }

  async searchInvoices(
    query: string,
    params?: {
      limit?: number;
      offset?: number;
      after?: string;
      fields?: string;
      status?: string;
      from?: string;
      to?: string;
    },
  ): Promise<PaginatedResponse<Rec>> {
    const q = query.toLowerCase();
    let rows = this.invoices.filter(
      (r) =>
        String(r.clientName ?? "").toLowerCase().includes(q) ||
        String(r.notes ?? "").toLowerCase().includes(q) ||
        String(r.documentNumber ?? "").toLowerCase().includes(q),
    );
    if (params?.status) rows = rows.filter((r) => r.status === params.status);
    return this.paginate(rows, params);
  }

  // -------------------------------------------------------------- Expenses

  async listExpenses(params?: {
    limit?: number;
    offset?: number;
    after?: string;
    fields?: string;
    from?: string;
    to?: string;
    vendorId?: string;
    category?: string;
  }): Promise<PaginatedResponse<Rec>> {
    let rows = this.expenses;
    if (params?.category) rows = rows.filter((r) => r.category === params.category);
    return this.paginate(rows, params);
  }

  async getExpense(id: string): Promise<Rec> {
    return this.findOr(this.expenses, id);
  }

  async createExpense(data: Rec): Promise<Rec> {
    const record: Rec = {
      id: this.genId("exp"),
      taxDeductible: true,
      ...data,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.expenses.unshift(record);
    return clone(record);
  }

  async updateExpense(id: string, data: Rec): Promise<Rec> {
    return this.applyUpdate(this.expenses, id, data);
  }

  async deleteExpense(id: string): Promise<void> {
    this.remove(this.expenses, id);
  }

  // --------------------------------------------------------------- Clients

  async listClients(params?: {
    limit?: number;
    offset?: number;
    after?: string;
    fields?: string;
    q?: string;
    stage?: string;
  }): Promise<PaginatedResponse<Rec>> {
    let rows = this.clients;
    if (params?.q) {
      const q = params.q.toLowerCase();
      rows = rows.filter((r) => String(r.name ?? "").toLowerCase().includes(q));
    }
    return this.paginate(rows, params);
  }

  async getClient(id: string): Promise<Rec> {
    return this.findOr(this.clients, id);
  }

  async createClient(data: Rec): Promise<Rec> {
    const record: Rec = {
      id: this.genId("cli"),
      ...data,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.clients.unshift(record);
    return clone(record);
  }

  async updateClient(id: string, data: Rec): Promise<Rec> {
    return this.applyUpdate(this.clients, id, data);
  }

  async deleteClient(id: string): Promise<void> {
    this.remove(this.clients, id);
  }

  // -------------------------------------------------------------- Products

  async listProducts(params?: {
    limit?: number;
    offset?: number;
    after?: string;
    fields?: string;
    q?: string;
    isActive?: boolean;
  }): Promise<PaginatedResponse<Rec>> {
    let rows = this.products;
    if (params?.q) {
      const q = params.q.toLowerCase();
      rows = rows.filter((r) => String(r.name ?? "").toLowerCase().includes(q));
    }
    return this.paginate(rows, params);
  }

  async getProduct(id: string): Promise<Rec> {
    return this.findOr(this.products, id);
  }

  async createProduct(data: Rec): Promise<Rec> {
    const record: Rec = {
      id: this.genId("prod"),
      ...data,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.products.unshift(record);
    return clone(record);
  }

  async updateProduct(id: string, data: Rec): Promise<Rec> {
    return this.applyUpdate(this.products, id, data);
  }

  async deleteProduct(id: string): Promise<void> {
    this.remove(this.products, id);
  }

  // ---------------------------------------------------------------- Quotes

  async listQuotes(params?: {
    limit?: number;
    offset?: number;
    after?: string;
    fields?: string;
    status?: string;
    from?: string;
    to?: string;
    clientId?: string;
    seriesId?: string;
  }): Promise<PaginatedResponse<Rec>> {
    let rows = this.quotes;
    if (params?.status) rows = rows.filter((r) => r.status === params.status);
    if (params?.clientId) rows = rows.filter((r) => r.clientId === params.clientId);
    return this.paginate(rows, params);
  }

  async getQuote(id: string): Promise<Rec> {
    return this.findOr(this.quotes, id);
  }

  async createQuote(data: Rec): Promise<Rec> {
    const items = Array.isArray(data.items) ? (data.items as Rec[]) : [];
    const subtotal = items.reduce(
      (s, it) => s + Number(it.quantity ?? 0) * Number(it.unitPrice ?? 0),
      0,
    );
    const taxRate = Number(data.taxRate ?? 0);
    const record: Rec = {
      id: this.genId("quo"),
      status: "draft",
      ...data,
      subtotal,
      total: Math.round((subtotal + (subtotal * taxRate) / 100) * 100) / 100,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.quotes.unshift(record);
    return clone(record);
  }

  async updateQuote(id: string, data: Rec): Promise<Rec> {
    return this.applyUpdate(this.quotes, id, data);
  }

  async deleteQuote(id: string): Promise<void> {
    this.remove(this.quotes, id);
  }

  // --------------------------------------------------------------- Vendors

  async listVendors(params?: {
    q?: string;
    limit?: number;
    offset?: number;
    after?: string;
    fields?: string;
  }): Promise<PaginatedResponse<Rec>> {
    return this.paginate(this.vendors, params);
  }

  async getVendor(id: string): Promise<Rec> {
    return this.findOr(this.vendors, id);
  }

  async createVendor(data: Rec): Promise<Rec> {
    const record: Rec = {
      id: this.genId("ven"),
      ...data,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.vendors.unshift(record);
    return clone(record);
  }

  async updateVendor(id: string, data: Rec): Promise<Rec> {
    return this.applyUpdate(this.vendors, id, data);
  }

  async deleteVendor(id: string): Promise<void> {
    this.remove(this.vendors, id);
  }

  // ------------------------------------------------------- Invoice actions
  // Fiscal / email surface — SIMULATED (guardrail #3).

  async sendInvoice(id: string, to?: string): Promise<Rec> {
    return this.sim({ success: true, id, message: "Factura enviada (simulado)", to });
  }

  async markInvoicePaid(id: string, paidDate?: string): Promise<Rec> {
    // Local status write (not a fiscal/email side effect) — mutate session store.
    this.applyUpdate(this.invoices, id, { status: "paid" });
    return { success: true, id, status: "paid", paidDate: paidDate ?? nowIso().slice(0, 10) };
  }

  async getInvoicePdf(id: string): Promise<Rec> {
    return this.sim({
      id,
      url: `https://demo.frihet.io/invoices/${id}.pdf`,
      contentType: "application/pdf",
    });
  }

  async getInvoiceEInvoice(invoiceId: string): Promise<Rec> {
    return this.sim({
      xml: `<?xml version="1.0"?><Invoice><ID>${invoiceId}</ID><DemoData/></Invoice>`,
      filename: `${invoiceId}-einvoice-demo.xml`,
      format: "UBL",
    });
  }

  async createCreditNote(
    invoiceId: string,
    data: { reason: string; reasonDescription?: string; fullCredit?: boolean; issueDate?: string },
  ): Promise<Rec> {
    return this.sim({
      success: true,
      creditNote: {
        id: this.genId("cn"),
        documentNumber: `R-2026-${String(this.seq)}`,
        originalInvoiceId: invoiceId,
        reason: data.reason,
        fullCredit: data.fullCredit ?? true,
      },
    });
  }

  async applyLateFee(invoiceId: string, data?: { amount?: number; daysOverdue?: number }): Promise<Rec> {
    return this.sim({
      success: true,
      id: invoiceId,
      message: "Interés de demora aplicado (simulado)",
      amount: data?.amount ?? 0,
      daysOverdue: data?.daysOverdue ?? 0,
    });
  }

  async sendQuote(id: string, to?: string): Promise<Rec> {
    return this.sim({ success: true, id, message: "Presupuesto enviado (simulado)", to });
  }

  // -------------------------------------------------------------- Webhooks

  async listWebhooks(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return this.paginate(this.webhooks, params);
  }

  async getWebhook(id: string): Promise<Rec> {
    return this.findOr(this.webhooks.length ? this.webhooks : [{ id, url: "https://example.com/hook", events: [] }], id);
  }

  async createWebhook(data: Rec): Promise<Rec> {
    const record: Rec = { id: this.genId("wh"), active: true, ...data, createdAt: nowIso() };
    this.webhooks.unshift(record);
    return clone(record);
  }

  async updateWebhook(id: string, data: Rec): Promise<Rec> {
    return this.applyUpdate(this.webhooks, id, data);
  }

  async deleteWebhook(id: string): Promise<void> {
    this.remove(this.webhooks, id);
  }

  async testWebhook(id: string, data?: { eventType?: string }): Promise<Rec> {
    return this.sim({
      webhookId: id,
      delivered: true,
      statusCode: 200,
      responseTimeMs: 12,
      eventType: data?.eventType ?? "ping",
      attemptedAt: nowIso(),
    });
  }

  // ------------------------------------------------------------------- CRM

  async listClientContacts(clientId: string, params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return this.paginate(this.clientContacts.get(clientId) ?? [], params);
  }

  async createClientContact(clientId: string, data: Rec): Promise<Rec> {
    const record: Rec = { id: this.genId("cnt"), clientId, ...data, createdAt: nowIso() };
    const arr = this.clientContacts.get(clientId) ?? [];
    arr.unshift(record);
    this.clientContacts.set(clientId, arr);
    return clone(record);
  }

  async deleteClientContact(clientId: string, contactId: string): Promise<void> {
    const arr = this.clientContacts.get(clientId);
    if (arr) this.remove(arr, contactId);
  }

  async listClientActivities(clientId: string, params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return this.paginate(this.clientActivities.get(clientId) ?? [], params);
  }

  async logClientActivity(clientId: string, data: Rec): Promise<Rec> {
    const record: Rec = { id: this.genId("act"), clientId, ...data, createdAt: nowIso() };
    const arr = this.clientActivities.get(clientId) ?? [];
    arr.unshift(record);
    this.clientActivities.set(clientId, arr);
    return clone(record);
  }

  async listClientNotes(clientId: string, params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return this.paginate(this.clientNotes.get(clientId) ?? [], params);
  }

  async createClientNote(clientId: string, data: Rec): Promise<Rec> {
    const record: Rec = { id: this.genId("note"), clientId, ...data, createdAt: nowIso() };
    const arr = this.clientNotes.get(clientId) ?? [];
    arr.unshift(record);
    this.clientNotes.set(clientId, arr);
    return clone(record);
  }

  async deleteClientNote(clientId: string, noteId: string): Promise<void> {
    const arr = this.clientNotes.get(clientId);
    if (arr) this.remove(arr, noteId);
  }

  // -------------------------------------------------------------- Deposits

  async listDeposits(params?: Rec): Promise<PaginatedResponse<Rec>> {
    return this.paginate(this.deposits, params as PageParams);
  }

  async getDeposit(id: string): Promise<Rec> {
    return this.findOr(this.deposits.length ? this.deposits : [{ id, status: "held", amount: 0 }], id);
  }

  async createDeposit(data: Rec): Promise<Rec> {
    const record: Rec = { id: this.genId("dep"), status: "held", ...data, createdAt: nowIso() };
    this.deposits.unshift(record);
    return clone(record);
  }

  async updateDeposit(id: string, data: Rec): Promise<Rec> {
    return this.applyUpdate(this.deposits, id, data);
  }

  async deleteDeposit(id: string): Promise<void> {
    this.remove(this.deposits, id);
  }

  async applyDeposit(id: string, data?: Rec): Promise<Rec> {
    return this.sim({ success: true, id, status: "applied", ...(data ?? {}) });
  }

  async refundDeposit(id: string, data?: Rec): Promise<Rec> {
    return this.sim({ success: true, id, status: "refunded", ...(data ?? {}) });
  }

  // --------------------------------------------------------- Intelligence

  async getBusinessContext(): Promise<Rec> {
    return clone(demoBusinessContext);
  }

  async getMonthlySummary(month?: string): Promise<Rec> {
    return { ...clone(demoMonthlySummary), ...(month ? { month } : {}) };
  }

  async getQuarterlyTaxes(quarter?: string): Promise<Rec> {
    return { ...clone(demoQuarterlyTaxes), ...(quarter ? { quarter } : {}) };
  }

  // ------------------------------------------------------------ E-Invoicing
  // ALL simulated (guardrail #3) — return shapes match client-interface.ts.

  async sendEInvoice(_params: { invoiceId: string; format: string; dispatchMode: string }): Promise<{ workflowRunId: string; status: "queued"; estimatedCompletionSec: number }> {
    return this.sim({ workflowRunId: this.genId("wf"), status: "queued" as const, estimatedCompletionSec: 5 });
  }

  async getEInvoiceStatus(_workflowRunId: string): Promise<{ status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; step: string; error?: string; ackId?: string; pdfA3Url?: string; xmlUrl?: string }> {
    return this.sim({ status: "succeeded" as const, step: "done", ackId: this.genId("ack") });
  }

  async validateEInvoiceXml(_params: { xml: string; format: string }): Promise<{ valid: boolean; errors: Array<{ severity: string; location: string; message: string; rule: string }>; validator: "kosit" | "mustang" | "xsd" | "schematron"; durationMs: number }> {
    return this.sim({ valid: true, errors: [], validator: "xsd" as const, durationMs: 3 });
  }

  async exportDatev(params: { periodStart: string; periodEnd: string; format: string }): Promise<{ fileUrl: string; filename: string; rowCount: number; fiscalPeriod: string; encoding: "cp1252" }> {
    return this.sim({
      fileUrl: "https://demo.frihet.io/exports/datev-demo.zip",
      filename: "datev-demo.zip",
      rowCount: 17,
      fiscalPeriod: `${params.periodStart}..${params.periodEnd}`,
      encoding: "cp1252" as const,
    });
  }

  async exportEInvoice(params: { invoiceId: string; format: string; signed?: boolean }): Promise<{ xmlUrl: string; filename: string; format: string; signed: boolean }> {
    return this.sim({
      xmlUrl: `https://demo.frihet.io/exports/${params.invoiceId}.xml`,
      filename: `${params.invoiceId}-${params.format}-demo.xml`,
      format: params.format,
      signed: params.signed ?? false,
    });
  }

  async faceSubmit(params: { invoiceId: string; mode: "mock" | "sandbox" | "production" }): Promise<{ registroFACe: string; status: "submitted" | "error"; submittedAt: string; mode: string }> {
    return this.sim({ registroFACe: this.genId("face"), status: "submitted" as const, submittedAt: nowIso(), mode: params.mode });
  }

  async faceStatus(_params: { invoiceId: string }): Promise<{ registroFACe: string; statusCode: string; statusDescription: string; rejectionReason?: string }> {
    return this.sim({ registroFACe: this.genId("face"), statusCode: "1200", statusDescription: "Registrada (simulado)" });
  }

  async ticketbaiSubmit(params: { invoiceId: string; sandbox: boolean }): Promise<{ tbaiId: string; territory: "bizkaia" | "gipuzkoa" | "araba"; status: "submitted" | "accepted" | "rejected" | "error"; sandbox: boolean; qrUrl?: string }> {
    return this.sim({ tbaiId: this.genId("tbai"), territory: "bizkaia" as const, status: "submitted" as const, sandbox: params.sandbox });
  }

  async ticketbaiStatus(_params: { invoiceId: string }): Promise<{ tbaiId: string; territory: "bizkaia" | "gipuzkoa" | "araba"; status: "submitted" | "accepted" | "rejected" | "error"; rejectionReason?: string; error?: string }> {
    return this.sim({ tbaiId: this.genId("tbai"), territory: "bizkaia" as const, status: "submitted" as const });
  }

  // ------------------------------------------------------------------ Stay

  async listReservations(params?: Rec): Promise<PaginatedResponse<Rec>> {
    return this.paginate([], params as PageParams);
  }

  async getReservation(id: string): Promise<Rec> {
    return this.sim({ id, status: "confirmed", note: "Reserva de ejemplo" });
  }

  async createReservation(data: Rec): Promise<Rec> {
    return { id: this.genId("res"), status: "confirmed", ...data, createdAt: nowIso() };
  }

  async listProperties(params?: Rec): Promise<PaginatedResponse<Rec>> {
    return this.paginate([], params as PageParams);
  }

  async syncChannel(channelId: string, direction: "pull" | "push" | "both"): Promise<Rec> {
    return this.sim({ channelId, direction, status: "ok" });
  }

  // ------------------------------------------------------------------- POS

  async listTerminals(params?: Rec): Promise<PaginatedResponse<Rec>> {
    return this.paginate([], params as PageParams);
  }

  async getSale(id: string): Promise<Rec> {
    return this.sim({ id, status: "completed", note: "Venta de ejemplo" });
  }

  async listSales(params?: Rec): Promise<PaginatedResponse<Rec>> {
    return this.paginate([], params as PageParams);
  }

  async refundSale(id: string, data?: { amountCents?: number; reason?: string }): Promise<Rec> {
    return this.sim({ success: true, id, status: "refunded", ...(data ?? {}) });
  }

  // --------------------------------------------------------------- Kitchen

  async listKitchenTickets(params?: Rec): Promise<PaginatedResponse<Rec>> {
    return this.paginate([], params as PageParams);
  }

  async getKitchenTicket(id: string): Promise<Rec> {
    return this.sim({ id, status: "pending" });
  }

  async updateKitchenTicket(id: string, data: Rec): Promise<Rec> {
    return { id, ...data, updatedAt: nowIso() };
  }

  async listKitchenStations(params?: Rec): Promise<PaginatedResponse<Rec>> {
    return this.paginate([], params as PageParams);
  }

  async listMenuItems(params?: Rec): Promise<PaginatedResponse<Rec>> {
    return this.paginate([], params as PageParams);
  }

  // --------------------------------------------------------------- Banking

  async listBankAccounts(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    const accounts: Rec[] = [
      {
        id: "bank_demo_0001",
        alias: "Cuenta principal (demo)",
        ibanLast4: DEMO_TEST_IBAN.slice(-4),
        currency: "EUR",
        balance: 14250.75,
        lastSyncedAt: nowIso(),
      },
    ];
    return this.paginate(accounts, params);
  }

  async getBankAccount(id: string): Promise<Rec> {
    return this.sim({ id, alias: "Cuenta principal (demo)", ibanLast4: DEMO_TEST_IBAN.slice(-4), currency: "EUR", balance: 14250.75 });
  }

  async listTransactions(params?: Rec): Promise<PaginatedResponse<Rec>> {
    const txns: Rec[] = [
      { id: "txn_demo_0001", accountId: "bank_demo_0001", amount: 1908, currency: "EUR", description: "Cobro FR-2026-0001", postedAt: "2026-02-20", category: "sales", status: "posted" },
      { id: "txn_demo_0002", accountId: "bank_demo_0001", amount: -74.19, currency: "EUR", description: "Adobe Creative Cloud", postedAt: "2026-01-12", category: "software", status: "posted" },
    ];
    return this.paginate(txns, params as PageParams);
  }

  async categorizeTransaction(id: string, data: { category: string; notes?: string }): Promise<Rec> {
    return { id, category: data.category, notes: data.notes, updatedAt: nowIso() };
  }

  async matchTransactionToDocument(transactionId: string, data: { documentId: string; documentType: "invoice" | "expense"; notes?: string }): Promise<Rec> {
    return { transactionId, matchedDocId: data.documentId, documentType: data.documentType, updatedAt: nowIso() };
  }

  // ---------------------------------------------------------------- Fiscal
  // Read summaries are informational (readonly); submissions are simulated.

  async getFiscalModeloSummary(modeloCode: string, period?: string): Promise<Rec> {
    return {
      model: modeloCode,
      modeloCode,
      period: period ?? "2026-Q1",
      readonly: true,
      modelo303: {
        baseImponible: 11615,
        cuotaRepercutida: 2439.75,
        baseDeducible: 2440,
        cuotaDeducible: 512.4,
        resultado: 1927.35,
      },
      note: "Resumen informativo de ejemplo — nunca presentado a la AEAT (demo).",
    };
  }

  async getVerifactuStatus(invoiceId: string): Promise<Rec> {
    return this.sim({ invoiceId, status: "not_submitted", accepted: false, sandbox: true });
  }

  async resubmitVerifactu(invoiceId: string): Promise<Rec> {
    return this.sim({ invoiceId, status: "pending", message: "Reenvío VeriFactu (simulado)" });
  }

  async getTicketbaiStatus(invoiceId: string): Promise<Rec> {
    return this.sim({ invoiceId, status: "pending", province: "bizkaia" });
  }

  // ------------------------------------------------------------------ Time

  async listTimeEntries(params?: Rec): Promise<PaginatedResponse<Rec>> {
    return this.paginate(this.timeEntries, params as PageParams);
  }

  async getTimeEntry(id: string): Promise<Rec> {
    return this.findOr(this.timeEntries.length ? this.timeEntries : [{ id, hours: 0 }], id);
  }

  async createTimeEntry(data: Rec): Promise<Rec> {
    const record: Rec = { id: this.genId("time"), billable: true, ...data, createdAt: nowIso() };
    this.timeEntries.unshift(record);
    return clone(record);
  }

  async updateTimeEntry(id: string, data: Rec): Promise<Rec> {
    return this.applyUpdate(this.timeEntries, id, data);
  }

  async deleteTimeEntry(id: string): Promise<void> {
    this.remove(this.timeEntries, id);
  }

  async getTimeSummary(params: { from: string; to: string; userId?: string; projectId?: string; groupBy?: string }): Promise<Rec> {
    return { from: params.from, to: params.to, totalHours: 0, billableHours: 0, nonBillableHours: 0, groups: [] };
  }

  // ------------------------------------------------------------- Recurring

  async listRecurringInvoices(params?: Rec): Promise<PaginatedResponse<Rec>> {
    return this.paginate(this.recurring, params as PageParams);
  }

  async getRecurringInvoice(id: string): Promise<Rec> {
    return this.findOr(this.recurring.length ? this.recurring : [{ id, status: "active" }], id);
  }

  async createRecurringInvoice(data: Rec): Promise<Rec> {
    const record: Rec = { id: this.genId("rec"), status: "active", ...data, createdAt: nowIso() };
    this.recurring.unshift(record);
    return clone(record);
  }

  async updateRecurringInvoice(id: string, data: Rec): Promise<Rec> {
    return this.applyUpdate(this.recurring, id, data);
  }

  async pauseRecurringInvoice(id: string): Promise<Rec> {
    return this.applyUpdate(this.recurring, id, { status: "paused" });
  }

  async resumeRecurringInvoice(id: string): Promise<Rec> {
    return this.applyUpdate(this.recurring, id, { status: "active" });
  }

  async deleteRecurringInvoice(id: string): Promise<void> {
    this.remove(this.recurring, id);
  }

  async runRecurringNow(templateId: string, options?: { draftOnly?: boolean }): Promise<Rec> {
    return this.sim({ templateId, generated: 1, draftOnly: options?.draftOnly ?? false });
  }

  // ------------------------------------------------------------------ Team

  async listTeamMembers(params?: { role?: string; status?: string; limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return this.paginate(this.teamMembers, params);
  }

  async inviteTeamMember(data: { email: string; role: string; name?: string }): Promise<Rec> {
    // Email side effect — simulated.
    return this.sim({ id: this.genId("tm"), email: data.email, role: data.role, name: data.name, status: "pending", invitedAt: nowIso() });
  }

  async updateTeamMemberRole(memberId: string, role: string): Promise<Rec> {
    return this.applyUpdate(this.teamMembers, memberId, { role });
  }

  async removeTeamMember(memberId: string): Promise<void> {
    this.remove(this.teamMembers, memberId);
  }

  // -------------------------------------------------------------- Audit GL

  async approveGLEntry(entryId: string, notes?: string): Promise<Rec> {
    return this.sim({ entryId, status: "approved", notes });
  }

  async rejectGLEntry(entryId: string, reason: string): Promise<Rec> {
    return this.sim({ entryId, status: "rejected", reason });
  }

  async getGLEntryAuditLog(entryId: string): Promise<Rec> {
    return { entryId, events: [] };
  }

  // -------------------------------------------------------- Portal domain

  async addCustomPortalDomain(data: { domain: string; workspaceId?: string }): Promise<Rec> {
    return this.sim({ domain: data.domain, status: "pending_verification" });
  }

  async verifyCustomPortalDomain(data: { domain: string }): Promise<Rec> {
    return this.sim({ domain: data.domain, verified: true });
  }

  async removeCustomPortalDomain(data: { domain: string }): Promise<Rec> {
    return this.sim({ domain: data.domain, removed: true });
  }

  // ------------------------------------------------------- Onboard + VIES

  async generatePortalOnboardLink(data: { email: string; name?: string; expiresInHours?: number; workspaceId?: string }): Promise<Rec> {
    return this.sim({ url: `https://demo.frihet.io/onboard/${this.genId("tok")}`, email: data.email });
  }

  async lookupTaxIdViaVIES(data: { vatNumber: string; countryCode: string }): Promise<Rec> {
    return this.sim({ valid: true, countryCode: data.countryCode, vatNumber: data.vatNumber, name: "Empresa de ejemplo", address: "Dirección de ejemplo" });
  }

  // ------------------------------------------------------------------ IGIC

  async getIgicModeloSummary(modeloCode: string, params?: { year?: string; period?: string }): Promise<Rec> {
    return { modeloCode, year: params?.year ?? "2026", period: params?.period ?? "1T", readonly: true, igicRepercutido: 343.1, igicSoportado: 0, resultado: 343.1, note: "Resumen IGIC informativo (demo)." };
  }

  async calculateAiem(data: { ncCode: string; amount: number; description?: string }): Promise<Rec> {
    return { ncCode: data.ncCode, amount: data.amount, aiemRate: 5, aiemAmount: Math.round(data.amount * 5) / 100 };
  }

  // ------------------------------------------------- Impuesto Sociedades

  async getISSummary(modeloCode: string, params?: { year?: string; installment?: string }): Promise<Rec> {
    return { modeloCode, year: params?.year ?? "2026", installment: params?.installment, readonly: true, baseImponible: 0, cuota: 0, note: "Resumen IS informativo (demo)." };
  }

  // ------------------------------------------------------------ Bank rules

  async listBankRules(params?: { isActive?: boolean; limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return this.paginate([], params);
  }

  async createBankRule(data: { name: string; conditions: Array<{ field: string; operator: string; value: string }>; actions: Array<{ type: string; value: string }>; isActive?: boolean }): Promise<Rec> {
    return { id: this.genId("rule"), name: data.name, conditions: data.conditions, actions: data.actions, isActive: data.isActive ?? true, createdAt: nowIso() };
  }

  // -------------------------------------------------------------- Gestoria

  async sendGestoriaMessage(data: { workspaceId: string; parentType: "documentRequest" | "filingItem" | "obligation"; parentId: string; body: string }): Promise<Rec> {
    return this.sim({ messageId: this.genId("gmsg"), createdAt: nowIso(), unreadCounts: { gestor: 0, client: 1 } });
  }

  async listGestoriaMessages(_params: { workspaceId: string; parentType: "documentRequest" | "filingItem" | "obligation"; parentId: string; limit?: number; before?: string }): Promise<{ messages: Rec[]; hasMore: boolean }> {
    return { messages: [], hasMore: false };
  }

  async createGestoriaTemplate(_data: { name: string; title: string; description: string; dueDateOffsetDays: number; attachmentRequired?: boolean; variables?: Array<{ key: string; label?: string; defaultValue?: string }> }): Promise<{ templateId: string }> {
    return { templateId: this.genId("gtpl") };
  }

  async bulkSendGestoriaTemplate(data: { templateId: string; clientWorkspaceIds: string[]; periodOverrides?: { quarter?: string | number; year?: string | number; month?: string | number } }): Promise<Rec> {
    return this.sim({ success: data.clientWorkspaceIds.length, failed: [], totalDuration: 15 });
  }

  async getGestoriaAgingConsolidated(_params?: { ownerUid?: string }): Promise<Rec> {
    return {
      totals: { current: 3300, "30_60": 715.5, "60_90": 3025, "90_plus": 0 },
      byWorkspace: [],
      topOverdue: [
        { invoiceId: "inv_demo_0007", clientName: "Consultoría Meridiana SL", amountDue: 3025, daysOverdue: 10, dueDate: "2026-03-19" },
      ],
      generatedAt: nowIso(),
    };
  }

  // -------------------------------------------------------------------- HR

  async listLeaves(params?: Rec): Promise<PaginatedResponse<Rec>> {
    return this.paginate([], params as PageParams);
  }

  async createLeaveRequest(data: { employeeId: string; type: string; startDate: string; endDate: string; reason?: string }): Promise<Rec> {
    return { id: this.genId("leave"), status: "pending", ...data, createdAt: nowIso() };
  }

  async approveLeave(leaveId: string, data?: { reason?: string }): Promise<Rec> {
    return this.sim({ id: leaveId, status: "approved", decisionReason: data?.reason });
  }

  async rejectLeave(leaveId: string, data: { reason: string }): Promise<Rec> {
    return this.sim({ id: leaveId, status: "rejected", decisionReason: data.reason });
  }

  async cancelLeave(leaveId: string): Promise<Rec> {
    return { id: leaveId, status: "cancelled" };
  }

  async attendanceClockIn(data: { employeeId: string; mood?: string; location?: string }): Promise<Rec> {
    return { id: this.genId("att"), employeeId: data.employeeId, clockInAt: nowIso(), status: "open", mood: data.mood, location: data.location };
  }

  async attendanceClockOut(entryId: string): Promise<Rec> {
    return { id: entryId, clockOutAt: nowIso(), status: "closed" };
  }

  async getOvertimeReport(params: { period: string; employeeId?: string }): Promise<Rec> {
    return { period: params.period, totalRegularHours: 0, totalOvertimeHours: 0, byEmployee: [], generatedAt: nowIso() };
  }

  async listAnomalies(params?: Rec): Promise<PaginatedResponse<Rec>> {
    return this.paginate([], params as PageParams);
  }

  // --------------------------------------------------------------- Payroll

  async exportPayroll(params: { format: "a3" | "contasol" | "sage" | "holded" | "siltra"; month: string }): Promise<Rec> {
    return this.sim({ format: params.format, month: params.month, fileUrl: "https://demo.frihet.io/exports/payroll-demo.txt", rowCount: 0 });
  }

  async getPayrollChecklist(params: { month: string }): Promise<Rec> {
    return { month: params.month, items: [], readyToExport: true };
  }

  // ------------------------------------------------------------ Onboarding

  async getOnboardingStatus(): Promise<Rec> {
    return { persona: "autonomo", completedSteps: ["profile"], pendingSteps: ["fiscal-profile"], progress: 50 };
  }

  async setOnboardingPersona(data: { persona: "autonomo" | "empresa" | "agencia" | "gestoria" }): Promise<Rec> {
    return { persona: data.persona, updated: true };
  }

  // ---------------------------------------------------------- Permissions

  async getPermissionsMatrix(): Promise<Rec> {
    return { roles: ["owner", "admin", "member", "viewer"], permissions: {} };
  }

  async getMyPermissions(): Promise<Rec> {
    return { role: "owner", permissions: ["*"] };
  }

  // -------------------------------------------------------- Period close

  async getCurrentPeriod(params?: { periodId?: string }): Promise<Rec> {
    return { periodId: params?.periodId ?? "2026-Q1", type: "quarterly", status: "open" };
  }

  async closePeriod(data: { type: "monthly" | "quarterly" }): Promise<Rec> {
    return this.sim({ type: data.type, status: "closed", closedAt: nowIso() });
  }

  async reopenPeriod(data: { periodId: string; reason: string }): Promise<Rec> {
    return this.sim({ periodId: data.periodId, status: "open", reason: data.reason });
  }
}
