/**
 * DemoFrihetClient — the `FRIHET_DEMO=1` seam.
 *
 * A drop-in IFrihetClient that makes ZERO network calls: it serves the canned
 * PII-safe fixtures in demo-fixtures.ts. index.ts swaps this in for FrihetClient
 * when demo mode is on, so tools (which stringify the client's return value)
 * automatically propagate the `_demo`/`_demoNotice` banner without any change
 * under src/tools/.
 *
 * Response contract (see SPEC-mcp-demo-mode.md option B/C):
 *   - reads/lists → fixture data stamped `_demo:true` (READ notice).
 *   - lists without fixtures → EMPTY PaginatedResponse, still stamped.
 *   - writes → plausible fixture-shaped object with a `demo_`-prefixed id
 *     (WRITE notice "…Simulated — not persisted.").
 *   - fiscal / e-invoice / email / payroll → SIMULATED labeled response, NEVER
 *     a real submission (FISCAL notice).
 *   - delete / remove methods → resolve void (interface return type forbids a
 *     stamp; this is the one accepted, documented gap).
 */

import type { IFrihetClient } from "./client-interface.js";
import type {
  CreateWebhookInput,
  CreateWebhookResult,
  PaginatedResponse,
  UpdateWebhookInput,
  Webhook,
} from "./types.js";
import {
  toApiEInvoiceExportFormat,
  type BinaryDocument,
  type EInvoiceDocument,
  type EInvoiceExportResult,
  type McpEInvoiceExportFormat,
} from "./client.js";
import { Buffer } from "node:buffer";
import {
  READ_STAMP,
  FISCAL_STAMP,
  DEMO_NOW,
  demoPage,
  demoEmptyPage,
  findOrStub,
  demoId,
  simulateWrite,
  simulateAction,
  demoClients,
  demoProducts,
  demoInvoices,
  demoExpenses,
  demoQuotes,
  demoVendors,
  demoBankAccounts,
  demoTransactions,
} from "./demo-fixtures.js";

type Rec = Record<string, unknown>;

const DEMO_RBAC_ROLES = ["owner", "admin", "manager", "sales", "accountant", "employee", "viewer"];
const DEMO_RBAC_RESOURCES = [
  "workspace", "invoices", "quotes", "expenses", "clients", "products", "accounting",
  "people", "payroll", "integrations", "banking", "settings", "audit_log", "billing",
];
const DEMO_RBAC_ACTIONS = ["read", "create", "update", "delete", "bulk_delete", "export"];
const DEMO_FULL_ACTIONS = [...DEMO_RBAC_ACTIONS];
const DEMO_PERMISSION_MATRIX: Record<string, Record<string, string[]>> = {
  owner: {
    workspace: ["read", "update", "export"],
    invoices: DEMO_FULL_ACTIONS, quotes: DEMO_FULL_ACTIONS, expenses: DEMO_FULL_ACTIONS,
    clients: DEMO_FULL_ACTIONS, products: DEMO_FULL_ACTIONS, accounting: DEMO_FULL_ACTIONS,
    people: DEMO_FULL_ACTIONS, payroll: DEMO_FULL_ACTIONS, integrations: DEMO_FULL_ACTIONS,
    banking: ["read", "create", "update", "delete", "export"],
    settings: ["read", "update"], audit_log: ["read", "export"],
    billing: ["read", "create", "update", "delete", "export"],
  },
  admin: {
    workspace: ["read", "update", "export"],
    invoices: DEMO_FULL_ACTIONS, quotes: DEMO_FULL_ACTIONS, expenses: DEMO_FULL_ACTIONS,
    clients: DEMO_FULL_ACTIONS, products: DEMO_FULL_ACTIONS, accounting: DEMO_FULL_ACTIONS,
    people: DEMO_FULL_ACTIONS, payroll: DEMO_FULL_ACTIONS, integrations: DEMO_FULL_ACTIONS,
    banking: ["read", "create", "update", "delete", "export"],
    settings: ["read", "update"], audit_log: ["read", "export"],
  },
  manager: {
    workspace: ["read"], invoices: ["read", "export"], quotes: ["read", "export"],
    clients: ["read", "export"], products: ["read", "export"], expenses: ["read", "export"],
    banking: ["read"], people: DEMO_FULL_ACTIONS, payroll: ["read", "export"],
    settings: ["read"], integrations: ["read"], audit_log: ["read"],
  },
  sales: {
    workspace: ["read"], invoices: ["read", "create", "update", "export"],
    quotes: ["read", "create", "update", "export"], clients: ["read", "create", "update", "export"],
    products: ["read", "export"], expenses: ["read", "export"],
  },
  accountant: {
    workspace: ["read"], invoices: ["read", "create", "update", "export"],
    quotes: ["read", "export"], expenses: ["read", "create", "update", "export"],
    clients: ["read", "export"], products: ["read", "export"],
    banking: ["read", "create", "update", "export"], accounting: ["read", "create", "update", "export"],
    people: ["read"], audit_log: ["read", "export"],
  },
  employee: { workspace: ["read"] },
  viewer: {
    workspace: ["read", "export"], invoices: ["read", "export"], quotes: ["read", "export"],
    expenses: ["read", "export"], clients: ["read", "export"], products: ["read", "export"],
    banking: ["read"], accounting: ["read", "export"], people: ["read"], payroll: ["read"],
    settings: ["read"], integrations: ["read"], audit_log: ["read"],
  },
};

const DEMO_OWNER_CAPABILITIES = Object.entries(DEMO_PERMISSION_MATRIX.owner!)
  .flatMap(([resource, actions]) => actions.map((action) => `${resource}:${action}`))
  .sort();

export class DemoFrihetClient implements IFrihetClient {
  // ---------------------------------------------------------------- Invoices
  async listInvoices(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoPage(demoInvoices, params);
  }
  async getInvoice(id: string): Promise<Rec> {
    return findOrStub(demoInvoices, id);
  }
  async createInvoice(data: Rec): Promise<Rec> {
    const items = Array.isArray(data.items) ? (data.items as { quantity: number; unitPrice: number }[]) : [];
    const subtotal = Math.round(items.reduce((s, i) => s + (i.quantity || 0) * (i.unitPrice || 0), 0) * 100) / 100;
    const taxRate = typeof data.taxRate === "number" ? data.taxRate : 21;
    const taxAmount = Math.round(subtotal * (taxRate / 100) * 100) / 100;
    return simulateWrite("demo_inv", data, {
      status: data.status ?? "draft",
      subtotal,
      taxAmount,
      total: Math.round((subtotal + taxAmount) * 100) / 100,
      currency: "EUR",
    });
  }
  async updateInvoice(id: string, data: Rec): Promise<Rec> {
    return simulateAction(id, { ...data });
  }
  async deleteInvoice(_id: string): Promise<void> {
    return;
  }
  async searchInvoices(query: string, params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    const q = query.toLowerCase();
    const matched = demoInvoices.filter((inv) => JSON.stringify(inv).toLowerCase().includes(q));
    return demoPage(matched, params);
  }

  // ---------------------------------------------------------------- Expenses
  async listExpenses(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoPage(demoExpenses, params);
  }
  async getExpense(id: string): Promise<Rec> {
    return findOrStub(demoExpenses, id);
  }
  async createExpense(data: Rec): Promise<Rec> {
    return simulateWrite("demo_exp", data, { taxDeductible: data.taxDeductible ?? true });
  }
  async updateExpense(id: string, data: Rec): Promise<Rec> {
    return simulateAction(id, { ...data });
  }
  async deleteExpense(_id: string): Promise<void> {
    return;
  }

  // ---------------------------------------------------------------- Clients
  async listClients(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoPage(demoClients, params);
  }
  async getClient(id: string): Promise<Rec> {
    return findOrStub(demoClients, id);
  }
  async createClient(data: Rec): Promise<Rec> {
    return simulateWrite("demo_cli", data);
  }
  async updateClient(id: string, data: Rec): Promise<Rec> {
    return simulateAction(id, { ...data });
  }
  async deleteClient(_id: string): Promise<void> {
    return;
  }

  // ---------------------------------------------------------------- Products
  async listProducts(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoPage(demoProducts, params);
  }
  async getProduct(id: string): Promise<Rec> {
    return findOrStub(demoProducts, id);
  }
  async createProduct(data: Rec): Promise<Rec> {
    return simulateWrite("demo_prd", data);
  }
  async updateProduct(id: string, data: Rec): Promise<Rec> {
    return simulateAction(id, { ...data });
  }
  async deleteProduct(_id: string): Promise<void> {
    return;
  }

  // ---------------------------------------------------------------- Quotes
  async listQuotes(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoPage(demoQuotes, params);
  }
  async getQuote(id: string): Promise<Rec> {
    return findOrStub(demoQuotes, id);
  }
  async createQuote(data: Rec): Promise<Rec> {
    return simulateWrite("demo_quo", data, { status: data.status ?? "draft" });
  }
  async updateQuote(id: string, data: Rec): Promise<Rec> {
    return simulateAction(id, { ...data });
  }
  async deleteQuote(_id: string): Promise<void> {
    return;
  }

  // ---------------------------------------------------------------- Vendors
  async listVendors(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoPage(demoVendors, params);
  }
  async getVendor(id: string): Promise<Rec> {
    return findOrStub(demoVendors, id);
  }
  async createVendor(data: Rec): Promise<Rec> {
    return simulateWrite("demo_ven", data);
  }
  async updateVendor(id: string, data: Rec): Promise<Rec> {
    return simulateAction(id, { ...data });
  }
  async deleteVendor(_id: string): Promise<void> {
    return;
  }

  // ---------------------------------------------------------------- Invoice actions
  async sendInvoice(id: string, to?: string): Promise<Rec> {
    // Email dispatch — simulated, no email is actually sent.
    return { id, status: "sent", sentAt: DEMO_NOW, ...(to ? { to } : {}), ...FISCAL_STAMP };
  }
  async markInvoicePaid(id: string, paidDate?: string): Promise<Rec> {
    return simulateAction(id, { status: "paid", paidAt: paidDate ?? DEMO_NOW });
  }
  async getInvoicePdf(id: string): Promise<BinaryDocument> {
    // #1393: shape mirrors the live BinaryDocument contract (id,
    // contentType, sizeBytes, base64) so demo-mode outputSchema validation
    // runs against the same fields as the live path.
    const demoPdfBytes = Buffer.from("%PDF-1.4\n%%DEMO e-invoice for " + id + "\n%%EOF\n", "utf8");
    return {
      id,
      contentType: "application/pdf",
      sizeBytes: demoPdfBytes.byteLength,
      base64: demoPdfBytes.toString("base64"),
      ...READ_STAMP,
    };
  }
  async getInvoiceEInvoice(invoiceId: string): Promise<EInvoiceDocument> {
    // #1393: mirrors the live XML arm of the MIME-discriminated contract.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Invoice><!-- DEMO example e-invoice for ${invoiceId} --></Invoice>`;
    return {
      id: invoiceId,
      xml,
      contentType: "application/xml; charset=utf-8",
      sizeBytes: Buffer.byteLength(xml, "utf8"),
      filename: `${invoiceId}.xml`,
      ...FISCAL_STAMP,
    };
  }
  // Mirrors the live 201 body: a DRAFT rectificativa, always by differences
  // (`rectificationMethod: "I"`), R-type derived from `reason` server-side
  // (`error` → R1, everything else → R4 — R2/R3/R5 are unreachable via the API).
  async createCreditNote(invoiceId: string, data: { reason: string; reasonDescription?: string; fullCredit?: boolean; issueDate?: string }, _idempotencyKey?: string): Promise<Rec> {
    // Shape rules taken from the live 201 (functions/src/publicApi.ts) rather
    // than invented:
    //  - documentNumber is `CN-<original document number>` and NEVER encodes
    //    the R-type (creditNoteService.ts: `CN-${originalDocNumber}`). An
    //    earlier fixture emitted `R1-DEMO-001`, teaching an agent to parse a
    //    field that carries no R-type live.
    //  - fullCredit is hardcoded `true` in the live body: `false` never
    //    reaches a 201, it is refused with 400 PARTIAL_CREDIT_NOT_IMPLEMENTED.
    //    Echoing the input would contradict this tool's own description.
    // Documented divergence: demo mode never throws (the seam's contract), so
    // `fullCredit: false` returns the same simulated draft instead of the live
    // 400. Pinned in src/__tests__/demo-mode.test.ts.
    const original = findOrStub(demoInvoices, invoiceId);
    const originalNumber = typeof original.documentNumber === "string" ? original.documentNumber : "DEMO-001";
    return {
      success: true,
      creditNote: {
        id: demoId("demo_cn"),
        documentNumber: `CN-${originalNumber}`,
        originalInvoiceId: invoiceId,
        reason: data.reason,
        fullCredit: true,
        status: "draft",
        rectificationMethod: "I",
        totalCredited: 1210.0,
      },
      ...FISCAL_STAMP,
    };
  }
  async applyLateFee(invoiceId: string, data?: { amount?: number; daysOverdue?: number }): Promise<Rec> {
    return simulateAction(invoiceId, { lateFeeApplied: true, amount: data?.amount ?? 45.0, daysOverdue: data?.daysOverdue ?? 30 });
  }

  // ---------------------------------------------------------------- Quote actions
  async sendQuote(id: string, to?: string): Promise<Rec> {
    return { id, status: "sent", sentAt: DEMO_NOW, ...(to ? { to } : {}), ...FISCAL_STAMP };
  }

  // ---------------------------------------------------------------- Webhooks
  async listWebhooks(): Promise<{ data: Webhook[]; total: number; _demo?: true; _demoNotice?: string }> {
    const { data, total } = demoEmptyPage();
    return { data: data as unknown as Webhook[], total };
  }
  async getWebhook(id: string): Promise<Webhook> {
    return {
      id,
      name: "Demo webhook",
      url: "https://example.com/webhooks/frihet",
      events: ["invoice.paid"],
      status: "active",
      metadata: { demo: true },
      hasSecret: false,
      createdAt: DEMO_NOW,
      updatedAt: DEMO_NOW,
      ...READ_STAMP,
    };
  }
  async createWebhook(data: CreateWebhookInput): Promise<CreateWebhookResult> {
    return simulateWrite("demo_wh", { ...data }, {
      status: data.status ?? "active",
      hasSecret: typeof data.secret === "string" && data.secret.length > 0,
    }) as unknown as CreateWebhookResult;
  }
  async updateWebhook(id: string, data: UpdateWebhookInput): Promise<Webhook> {
    const { secret, ...fields } = data;
    const { success: _success, ...result } = simulateAction(id, {
      name: "Demo webhook",
      url: "https://example.com/webhooks/frihet",
      events: ["invoice.paid"],
      status: "active",
      metadata: { demo: true },
      hasSecret: typeof secret === "string" && secret.length > 0,
      ...fields,
    });
    return result as unknown as Webhook;
  }
  async deleteWebhook(_id: string): Promise<void> {
    return;
  }

  // ---------------------------------------------------------------- Cross-resource search
  // ----------------------------------------------------------------
  async globalSearch(params: {
    q: string;
    types?: ReadonlyArray<"invoices" | "expenses" | "vendors" | "clients" | "products">;
    limit?: number;
    offset?: number;
  }): Promise<{
    data: Record<string, unknown>[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    query: string;
    types: ReadonlyArray<"invoices" | "expenses" | "vendors" | "clients" | "products">;
    truncated?: boolean;
  }> {
    return {
      data: [],
      total: 0,
      limit: params.limit ?? 25,
      offset: params.offset ?? 0,
      hasMore: false,
      query: params.q,
      types: params.types ?? ["invoices", "expenses", "vendors", "clients", "products"],
      truncated: false,
    };
  }

  // ---------------------------------------------------------------- CRM: Contacts
  async listClientContacts(_clientId: string, params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }
  async createClientContact(clientId: string, data: Rec): Promise<Rec> {
    return simulateWrite("demo_contact", data, { clientId });
  }
  async deleteClientContact(_clientId: string, _contactId: string): Promise<void> {
    return;
  }

  // ---------------------------------------------------------------- CRM: Activities
  async listClientActivities(_clientId: string, params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }
  async logClientActivity(_clientId: string, data: Rec): Promise<Rec> {
    return simulateWrite("demo_act", data, {
      type: data.type === "email" ? "email_sent" : data.type,
      timestamp: DEMO_NOW,
      createdBy: "user",
      metadata: {},
    });
  }

  // ---------------------------------------------------------------- CRM: Notes
  async listClientNotes(_clientId: string, params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }
  async createClientNote(clientId: string, data: Rec): Promise<Rec> {
    return simulateWrite("demo_note", data, { clientId });
  }
  async deleteClientNote(_clientId: string, _noteId: string): Promise<void> {
    return;
  }

  // ---------------------------------------------------------------- Deposits
  async listDeposits(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }
  async getDeposit(id: string): Promise<Rec> {
    return { id, ...READ_STAMP };
  }
  async createDeposit(data: Rec): Promise<Rec> {
    return simulateWrite("demo_dep", data, { status: data.status ?? "held" });
  }
  async updateDeposit(id: string, data: Rec): Promise<Rec> {
    return simulateAction(id, { ...data });
  }
  async deleteDeposit(_id: string): Promise<void> {
    return;
  }
  async applyDeposit(id: string, data?: Rec): Promise<Rec> {
    return simulateAction(id, { ...(data ?? {}), status: "applied" });
  }
  async refundDeposit(id: string, data?: Rec): Promise<Rec> {
    return simulateAction(id, { ...(data ?? {}), status: "refunded" });
  }

  // ---------------------------------------------------------------- Intelligence
  async getBusinessContext(): Promise<Rec> {
    return {
      business: {
        name: "Demo Studio SL",
        fiscalZone: "IVA",
        currency: "EUR",
        language: "es",
        country: "ES",
      },
      defaults: { taxRate: 21, irpfRate: 15, dueDays: 30, currency: "EUR" },
      plan: {
        name: "free",
        invoices: { used: 5, limit: 999 },
        expenses: { used: demoExpenses.length, limit: 5 },
        aiMessages: { used: 2, limit: 30 },
      },
      series: [{ id: "default", prefix: "F", current: 5, year: 2026 }],
      recentActivity: {
        lastInvoice: { number: "F-2026-005", date: "2026-07-18", client: "Acme Studio" },
        lastExpense: { date: "2026-07-17", vendor: "Demo Supplies", amount: 405.6 },
        overdueCount: 1,
        overdueAmount: 640,
        unpaidCount: 2,
      },
      topClients: [{ name: "Acme Studio", totalRevenue: 2200, invoiceCount: 2 }],
      currentMonth: {
        revenue: 3960.4,
        expenses: 405.6,
        profit: 3554.8,
        invoiceCount: 5,
        expenseCount: demoExpenses.length,
      },
      ...READ_STAMP,
    };
  }
  async getMonthlySummary(month?: string): Promise<Rec> {
    return {
      period: month ?? "2026-07",
      revenue: { total: 3960.4, taxBase: 3273.06, tax: 687.34, irpf: 0 },
      expenses: { total: 405.6, deductible: 405.6, tax: 70.4 },
      profit: { gross: 3554.8, net: 2937.86 },
      invoices: { created: 5, sent: 1, paid: 3, overdue: 1 },
      topClients: [{ name: "Acme Studio", totalRevenue: 2200, invoiceCount: 2 }],
      byCategory: { supplies: 405.6 },
      taxLiability: { vatPayable: 616.94, irpfRetained: 0, estimatedModel303: 616.94 },
      ...READ_STAMP,
    };
  }
  async getQuarterlyTaxes(quarter?: string): Promise<Rec> {
    return {
      quarter: quarter ?? "2026-Q2",
      modelo303: { cuotaRepercutida: 1620.0, cuotaDeducible: 85.15, resultado: 1534.85 },
      modelo130: { rendimientoNeto: 8200.0, pagoFraccionado: 1640.0 },
      currency: "EUR",
      readonly: true,
      ...READ_STAMP,
    };
  }

  // ---------------------------------------------------------------- E-Invoicing (simulated fiscal)
  async sendEInvoice(_params: { invoiceId: string; format: string; dispatchMode: string }): Promise<{ workflowRunId: string; status: "queued"; estimatedCompletionSec: number }> {
    return { workflowRunId: demoId("demo_wf"), status: "queued" as const, estimatedCompletionSec: 8, ...FISCAL_STAMP };
  }
  async getEInvoiceStatus(_workflowRunId: string): Promise<{ status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; step: string; error?: string; ackId?: string; pdfA3Url?: string; xmlUrl?: string }> {
    return { status: "succeeded" as const, step: "completed", ackId: "DEMO-ACK-001", ...FISCAL_STAMP };
  }
  async validateEInvoiceXml(_params: { xml: string; format: string }): Promise<{ valid: boolean; errors: Array<{ severity: string; location: string; message: string; rule: string }>; validator: "kosit" | "mustang" | "xsd" | "schematron"; durationMs: number }> {
    return { valid: true, errors: [], validator: "xsd" as const, durationMs: 12, ...FISCAL_STAMP };
  }
  async exportDatev(params: { periodStart: string; periodEnd: string; format: string }): Promise<{ fileUrl: string; filename: string; rowCount: number; fiscalPeriod: string; encoding: "cp1252" }> {
    return { fileUrl: "https://app.frihet.io/demo/datev.csv", filename: "demo-datev.csv", rowCount: 24, fiscalPeriod: `${params.periodStart}..${params.periodEnd}`, encoding: "cp1252" as const, ...FISCAL_STAMP };
  }
  async exportEInvoice(params: {
    invoiceId: string;
    format: McpEInvoiceExportFormat;
    signed?: boolean;
  }): Promise<EInvoiceExportResult> {
    const format = toApiEInvoiceExportFormat(params.format);
    return {
      xml: `<?xml version="1.0" encoding="UTF-8"?><DemoEInvoice format="${format}"/>`,
      contentType: "application/xml",
      filename: `${params.invoiceId}.xml`,
      format,
      signed: params.signed ?? false,
      ...FISCAL_STAMP,
    };
  }
  async faceSubmit(params: { invoiceId: string; mode: "mock" | "sandbox" | "production" }): Promise<{ registroFACe: string; status: "submitted" | "error"; submittedAt: string; mode: string }> {
    return { registroFACe: "DEMO-FACE-0001", status: "submitted" as const, submittedAt: DEMO_NOW, mode: params.mode, ...FISCAL_STAMP };
  }
  async faceStatus(_params: { invoiceId: string }): Promise<{ registroFACe: string; statusCode: string; statusDescription: string; rejectionReason?: string }> {
    return { registroFACe: "DEMO-FACE-0001", statusCode: "1200", statusDescription: "Registrada (demo)", ...FISCAL_STAMP };
  }
  async ticketbaiSubmit(params: { invoiceId: string; sandbox: boolean }): Promise<{ tbaiId: string; territory: "bizkaia" | "gipuzkoa" | "araba"; status: "submitted" | "accepted" | "rejected" | "error"; sandbox: boolean; qrUrl?: string }> {
    return { tbaiId: "DEMO-TBAI-0001", territory: "bizkaia" as const, status: "submitted" as const, sandbox: params.sandbox, qrUrl: "https://app.frihet.io/demo/tbai-qr.png", ...FISCAL_STAMP };
  }
  async ticketbaiStatus(_params: { invoiceId: string }): Promise<{ tbaiId: string; territory: "bizkaia" | "gipuzkoa" | "araba"; status: "submitted" | "accepted" | "rejected" | "error"; rejectionReason?: string; error?: string }> {
    return { tbaiId: "DEMO-TBAI-0001", territory: "bizkaia" as const, status: "accepted" as const, ...FISCAL_STAMP };
  }

  // ---------------------------------------------------------------- Stay
  async listReservations(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }
  async getReservation(id: string): Promise<Rec> {
    return { id, ...READ_STAMP };
  }
  async createReservation(data: Rec): Promise<Rec> {
    return simulateWrite("demo_res", data, { status: data.status ?? "confirmed" });
  }
  async listProperties(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }
  async syncChannel(channelId: string, direction: "pull" | "push" | "both"): Promise<Rec> {
    return simulateAction(channelId, { direction, synced: 0 });
  }

  // ---------------------------------------------------------------- POS
  async listTerminals(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }
  async getSale(id: string): Promise<Rec> {
    return { id, ...READ_STAMP };
  }
  async listSales(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }
  async refundSale(id: string, data?: { amountCents?: number; reason?: string }): Promise<Rec> {
    return simulateAction(id, { status: "refunded", refundedAmountCents: data?.amountCents ?? 0 });
  }

  // ---------------------------------------------------------------- Kitchen
  async listKitchenTickets(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }
  async getKitchenTicket(id: string): Promise<Rec> {
    return { id, ...READ_STAMP };
  }
  async updateKitchenTicket(id: string, data: Rec): Promise<Rec> {
    return simulateAction(id, { ...data });
  }
  async listKitchenStations(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }
  async listMenuItems(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }

  // ---------------------------------------------------------------- Banking
  async listBankAccounts(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoPage(demoBankAccounts, params);
  }
  async getBankAccount(id: string): Promise<Rec> {
    return findOrStub(demoBankAccounts, id);
  }
  async listTransactions(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoPage(demoTransactions, params);
  }
  async categorizeTransaction(id: string, data: { category: string; notes?: string }): Promise<Rec> {
    return simulateAction(id, { category: data.category, ...(data.notes ? { notes: data.notes } : {}) });
  }
  async matchTransactionToDocument(transactionId: string, data: { documentId: string; documentType: "invoice" | "expense"; notes?: string }): Promise<Rec> {
    return simulateAction(transactionId, { matchedDocId: data.documentId, documentType: data.documentType });
  }

  // ---------------------------------------------------------------- Fiscal (simulated / read summaries)
  async getFiscalModeloSummary(modeloCode: string, period?: string): Promise<Rec> {
    return { model: modeloCode, period: period ?? "2026-Q2", readonly: true, summary: { totalRevenue: 3960.4, totalExpenses: 405.6 }, ...FISCAL_STAMP };
  }
  async getVerifactuStatus(invoiceId: string): Promise<Rec> {
    return { invoiceId, status: "accepted", accepted: true, submittedAt: DEMO_NOW, ...FISCAL_STAMP };
  }
  async resubmitVerifactu(invoiceId: string): Promise<Rec> {
    return { invoiceId, status: "queued", ...FISCAL_STAMP };
  }
  async getTicketbaiStatus(invoiceId: string): Promise<Rec> {
    return { invoiceId, status: "success", province: "bizkaia", ...FISCAL_STAMP };
  }

  // ---------------------------------------------------------------- Time tracking
  async listTimeEntries(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }
  async getTimeEntry(id: string): Promise<Rec> {
    return { id, ...READ_STAMP };
  }
  async createTimeEntry(data: Rec): Promise<Rec> {
    return simulateWrite("demo_time", data);
  }
  async updateTimeEntry(id: string, data: Rec): Promise<Rec> {
    return simulateAction(id, { ...data });
  }
  async deleteTimeEntry(_id: string): Promise<void> {
    return;
  }
  async getTimeSummary(params: { from: string; to: string }): Promise<Rec> {
    return { from: params.from, to: params.to, totalHours: 0, billableHours: 0, nonBillableHours: 0, groups: [], ...READ_STAMP };
  }

  // ---------------------------------------------------------------- Recurring invoices
  async listRecurringInvoices(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }
  async getRecurringInvoice(id: string): Promise<Rec> {
    return { id, ...READ_STAMP };
  }
  async createRecurringInvoice(data: Rec): Promise<Rec> {
    return simulateWrite("demo_rec", data, { status: "active" });
  }
  async updateRecurringInvoice(id: string, data: Rec): Promise<Rec> {
    return simulateAction(id, { ...data });
  }
  async pauseRecurringInvoice(id: string): Promise<Rec> {
    return simulateAction(id, { status: "paused" });
  }
  async resumeRecurringInvoice(id: string): Promise<Rec> {
    return simulateAction(id, { status: "active" });
  }
  async deleteRecurringInvoice(_id: string): Promise<void> {
    return;
  }
  async runRecurringNow(templateId: string, options?: { draftOnly?: boolean }): Promise<Rec> {
    return simulateAction(templateId, { generatedInvoiceId: demoId("demo_inv"), draftOnly: options?.draftOnly ?? true });
  }

  // ---------------------------------------------------------------- Team management
  async listTeamMembers(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }
  async inviteTeamMember(data: { email: string; role: string; name?: string }): Promise<Rec> {
    return simulateWrite("demo_member", { email: data.email, role: data.role, ...(data.name ? { name: data.name } : {}) }, { status: "pending" });
  }
  async updateTeamMemberRole(memberId: string, role: string): Promise<Rec> {
    return simulateAction(memberId, { role });
  }
  async removeTeamMember(_memberId: string): Promise<void> {
    return;
  }

  // ---------------------------------------------------------------- Audit GL
  async approveGLEntry(entryId: string, notes?: string): Promise<Rec> {
    return simulateAction(entryId, { status: "approved", ...(notes ? { notes } : {}) });
  }
  async rejectGLEntry(entryId: string, note: string): Promise<Rec> {
    return simulateAction(entryId, { status: "rejected", note });
  }
  async getGLEntryAuditLog(entryId: string): Promise<Rec> {
    return { entryId, log: [], ...READ_STAMP };
  }

  // ---------------------------------------------------------------- White-label portal domain
  async addCustomPortalDomain(data: { domain: string; workspaceId?: string }): Promise<Rec> {
    return simulateWrite("demo_domain", { domain: data.domain }, { status: "pending_verification" });
  }
  async verifyCustomPortalDomain(data: { domain: string }): Promise<Rec> {
    return { domain: data.domain, verified: true, ...FISCAL_STAMP };
  }
  async removeCustomPortalDomain(data: { domain: string }): Promise<Rec> {
    return { domain: data.domain, removed: true, ...READ_STAMP };
  }

  // ---------------------------------------------------------------- Self-onboard + VIES
  async generatePortalOnboardLink(data: { email: string; name?: string; expiresInHours?: number; workspaceId?: string }): Promise<Rec> {
    return { email: data.email, url: "https://app.frihet.io/demo/onboard/DEMO-TOKEN", expiresInHours: data.expiresInHours ?? 72, ...READ_STAMP };
  }
  async lookupTaxIdViaVIES(data: { vatNumber: string; countryCode: string }): Promise<Rec> {
    return { vatNumber: data.vatNumber, countryCode: data.countryCode, valid: true, name: "Demo EU Company", ...FISCAL_STAMP };
  }

  // ---------------------------------------------------------------- IGIC
  async getIgicModeloSummary(modeloCode: string, params?: { year?: string; period?: string }): Promise<Rec> {
    return { model: modeloCode, year: params?.year ?? "2026", period: params?.period ?? "2T", readonly: true, ...FISCAL_STAMP };
  }
  async calculateAiem(data: { ncCode: string; amount: number; description?: string }): Promise<Rec> {
    return { ncCode: data.ncCode, base: data.amount, aiemRate: 5, aiemAmount: Math.round(data.amount * 0.05 * 100) / 100, ...FISCAL_STAMP };
  }

  // ---------------------------------------------------------------- Impuesto Sociedades
  async getISSummary(modeloCode: string, params?: { year?: string; installment?: string }): Promise<Rec> {
    return { model: modeloCode, year: params?.year ?? "2026", installment: params?.installment ?? "1P", readonly: true, ...FISCAL_STAMP };
  }

  // ---------------------------------------------------------------- Bank rules
  async listBankRules(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }
  async createBankRule(data: { name: string; bankConditions: Array<{ field: string; operator: string; value: string }>; action: string; actionConfig: Record<string, unknown>; isActive?: boolean }): Promise<Rec> {
    return simulateWrite("demo_rule", { name: data.name, bankConditions: data.bankConditions, action: data.action, actionConfig: data.actionConfig }, { isActive: data.isActive ?? true });
  }

  // ---------------------------------------------------------------- Gestoria
  async sendGestoriaMessage(data: { workspaceId: string; parentType: "documentRequest" | "filingItem" | "obligation"; parentId: string; body: string }): Promise<Rec> {
    return simulateWrite("demo_gmsg", { parentType: data.parentType, parentId: data.parentId, body: data.body });
  }
  async listGestoriaMessages(_params: { workspaceId: string; parentType: "documentRequest" | "filingItem" | "obligation"; parentId: string; limit?: number; before?: string }): Promise<{ messages: Array<Rec>; hasMore: boolean }> {
    return { messages: [], hasMore: false, ...READ_STAMP };
  }
  async createGestoriaTemplate(data: { name: string; title: string; description: string; dueDateOffsetDays: number; attachmentRequired?: boolean; variables?: Array<{ key: string; label?: string; defaultValue?: string }> }): Promise<{ templateId: string }> {
    return { templateId: demoId("demo_tpl"), ...FISCAL_STAMP };
  }
  async bulkSendGestoriaTemplate(data: { templateId: string; clientWorkspaceIds: string[]; periodOverrides?: { quarter?: string | number; year?: string | number; month?: string | number } }): Promise<Rec> {
    return { success: data.clientWorkspaceIds.length, failed: [], ...FISCAL_STAMP };
  }
  async getGestoriaAgingConsolidated(_params?: { workspaceIds?: string[]; asOf?: string; bustCache?: boolean }): Promise<Rec> {
    return { totals: { current: 0, "30_60": 0, "60_90": 0, "90_plus": 0 }, byWorkspace: [], topOverdue: [], generatedAt: DEMO_NOW, ...READ_STAMP };
  }

  // ---------------------------------------------------------------- HR
  async listLeaves(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }
  async createLeaveRequest(data: { employeeId: string; type: string; startDate: string; endDate: string; reason?: string }): Promise<Rec> {
    return simulateWrite("demo_leave", { ...data }, { status: "pending" });
  }
  async approveLeave(leaveId: string, data?: { reason?: string }): Promise<Rec> {
    return simulateAction(leaveId, { status: "approved", ...(data?.reason ? { decisionReason: data.reason } : {}) });
  }
  async rejectLeave(leaveId: string, data: { reason: string }): Promise<Rec> {
    return simulateAction(leaveId, { status: "rejected", decisionReason: data.reason });
  }
  async cancelLeave(leaveId: string): Promise<Rec> {
    return simulateAction(leaveId, { status: "cancelled" });
  }
  async attendanceClockIn(data: { employeeId: string; mood?: string; location?: string }, _idempotencyKey?: string): Promise<Rec> {
    return simulateWrite("demo_att", { employeeId: data.employeeId, ...(data.mood ? { mood: data.mood } : {}), ...(data.location ? { location: data.location } : {}) }, { status: "open", clockInAt: DEMO_NOW });
  }
  async attendanceClockOut(entryId: string, _idempotencyKey?: string): Promise<Rec> {
    return simulateAction(entryId, { status: "closed", clockOutAt: DEMO_NOW });
  }
  async getOvertimeReport(params: { period: string; employeeId?: string }): Promise<Rec> {
    return {
      period: params.period,
      employeeId: params.employeeId ?? null,
      recordCount: 0,
      dailyOvertime: [],
      weeklyOvertime: [],
      monthlyTotal: { workedMinutes: 0, overtimeMinutes: 0, regularMinutes: 0 },
      annualOvertimeHours: 0,
      alerts: [],
      ...READ_STAMP,
    };
  }
  async listAnomalies(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }

  // ---------------------------------------------------------------- Webhook test
  async testWebhook(id: string, data?: { eventType?: string }): Promise<Rec> {
    return { webhookId: id, delivered: true, statusCode: 200, responseTimeMs: 42, eventType: data?.eventType ?? "ping", attemptedAt: DEMO_NOW, ...FISCAL_STAMP };
  }

  // ---------------------------------------------------------------- Payroll (read-only demo)
  async exportPayroll(params: { format: "a3" | "contasol" | "sage" | "siltra"; month: string }): Promise<Rec> {
    return {
      month: params.month,
      format: params.format,
      employees: [],
      summary: { exportedCount: 0, skippedNotReady: 0, totalGrossAnnual: 0 },
      ...READ_STAMP,
    };
  }
  async getPayrollChecklist(params: { month: string }): Promise<Rec> {
    return {
      month: params.month,
      employees: [],
      summary: { total: 0, ready: 0, notReady: 0, reviewedThisMonth: 0 },
      ...READ_STAMP,
    };
  }

  // ---------------------------------------------------------------- Onboarding
  async getOnboardingStatus(): Promise<Rec> {
    return { workspaceId: "demo_ws_001", persona: "autonomo", completedSteps: ["profile"], pendingSteps: ["bank", "invoice"], percentComplete: 33, startedAt: DEMO_NOW, ...READ_STAMP };
  }
  async setOnboardingPersona(data: { persona: "autonomo" | "empresa" | "agencia" | "gestoria" }): Promise<Rec> {
    return { workspaceId: "demo_ws_001", persona: data.persona, updatedAt: DEMO_NOW, ...READ_STAMP };
  }

  // ---------------------------------------------------------------- Permissions
  async getPermissionsMatrix(): Promise<Rec> {
    return {
      roles: DEMO_RBAC_ROLES,
      resources: DEMO_RBAC_RESOURCES,
      actions: DEMO_RBAC_ACTIONS,
      legacyAliases: { editor: "sales" },
      matrix: DEMO_PERMISSION_MATRIX,
      source: "hand-maintained demo snapshot of the Frihet RBAC model; not derived from firestore.rules and not verified against it",
      ...READ_STAMP,
    };
  }
  async getMyPermissions(): Promise<Rec> {
    return {
      role: "owner",
      isOwner: true,
      resources: DEMO_PERMISSION_MATRIX.owner,
      scopes: DEMO_OWNER_CAPABILITIES,
      legacyFieldSemantics: { resources: "rbacResources", scopes: "rbacCapabilities" },
      rbac: {
        role: "owner",
        isOwner: true,
        resources: DEMO_PERMISSION_MATRIX.owner,
        capabilities: DEMO_OWNER_CAPABILITIES,
      },
      apiKeyScopes: [],
      apiKeyUnrestricted: true,
      denied: { einvoice: false },
      deniedSemantics: "Known API-key scope denials only; not an exhaustive effective-authorization report.",
      notIncluded: ["featureFlags", "deployedEndpoints"],
      ...READ_STAMP,
    };
  }

  // ---------------------------------------------------------------- Period close
  async getCurrentPeriod(params?: { fiscalYear?: string }): Promise<Rec> {
    const fiscalYear = params?.fiscalYear ?? "2026";
    return {
      fiscalYear,
      fiscalYearStart: "01-01",
      status: "open",
      dateRange: { from: `${fiscalYear}-01-01`, to: `${fiscalYear}-12-31` },
      closing: null,
      ...READ_STAMP,
    };
  }
  async closePeriod(data: { type: "monthly" | "quarterly" }): Promise<Rec> {
    return simulateWrite("demo_period", { type: data.type }, { status: "closed", closedAt: DEMO_NOW });
  }
  async reopenPeriod(data: { periodId: string; reason: string }): Promise<Rec> {
    return simulateAction(data.periodId, { status: "reopened", reopenReason: data.reason });
  }
}
