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
import type { PaginatedResponse } from "./types.js";
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
  async getInvoicePdf(id: string): Promise<Rec> {
    return { id, url: "https://app.frihet.io/demo/invoice.pdf", contentType: "application/pdf", ...READ_STAMP };
  }
  async getInvoiceEInvoice(invoiceId: string): Promise<Rec> {
    return {
      xml: `<?xml version="1.0" encoding="UTF-8"?>\n<Invoice><!-- DEMO example e-invoice for ${invoiceId} --></Invoice>`,
      filename: `${invoiceId}.xml`,
      format: "facturae",
      ...FISCAL_STAMP,
    };
  }
  async createCreditNote(invoiceId: string, data: { reason: string; reasonDescription?: string; fullCredit?: boolean; issueDate?: string }): Promise<Rec> {
    return {
      success: true,
      creditNote: {
        id: demoId("demo_cn"),
        documentNumber: "R4-DEMO-001",
        originalInvoiceId: invoiceId,
        reason: data.reason,
        fullCredit: data.fullCredit ?? true,
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
  async listWebhooks(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }
  async getWebhook(id: string): Promise<Rec> {
    return { id, ...READ_STAMP };
  }
  async createWebhook(data: Rec): Promise<Rec> {
    return simulateWrite("demo_wh", data, { active: data.active ?? true });
  }
  async updateWebhook(id: string, data: Rec): Promise<Rec> {
    return simulateAction(id, { ...data });
  }
  async deleteWebhook(_id: string): Promise<void> {
    return;
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
  async logClientActivity(clientId: string, data: Rec): Promise<Rec> {
    return simulateWrite("demo_act", data, { clientId });
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
      businessName: "Demo Studio SL",
      fiscalRegime: "autonomo",
      currency: "EUR",
      country: "ES",
      metrics: { openInvoices: 4, overdueInvoices: 1, totalClients: demoClients.length, totalProducts: demoProducts.length },
      ...READ_STAMP,
    };
  }
  async getMonthlySummary(month?: string): Promise<Rec> {
    return {
      month: month ?? "2026-07",
      revenue: 3960.4,
      expenses: 405.6,
      net: 3554.8,
      invoiceCount: 5,
      expenseCount: demoExpenses.length,
      currency: "EUR",
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
  async exportEInvoice(params: { invoiceId: string; format: string; signed?: boolean }): Promise<{ xmlUrl: string; filename: string; format: string; signed: boolean }> {
    return { xmlUrl: "https://app.frihet.io/demo/einvoice.xml", filename: `${params.invoiceId}.xml`, format: params.format, signed: params.signed ?? false, ...FISCAL_STAMP };
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
  async rejectGLEntry(entryId: string, reason: string): Promise<Rec> {
    return simulateAction(entryId, { status: "rejected", reason });
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
  async createBankRule(data: { name: string; conditions: Array<{ field: string; operator: string; value: string }>; actions: Array<{ type: string; value: string }>; isActive?: boolean }): Promise<Rec> {
    return simulateWrite("demo_rule", { name: data.name, conditions: data.conditions, actions: data.actions }, { isActive: data.isActive ?? true });
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
  async getGestoriaAgingConsolidated(_params?: { ownerUid?: string }): Promise<Rec> {
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
  async attendanceClockIn(data: { employeeId: string; mood?: string; location?: string }): Promise<Rec> {
    return simulateWrite("demo_att", { employeeId: data.employeeId, ...(data.mood ? { mood: data.mood } : {}), ...(data.location ? { location: data.location } : {}) }, { status: "open", clockInAt: DEMO_NOW });
  }
  async attendanceClockOut(entryId: string): Promise<Rec> {
    return simulateAction(entryId, { status: "closed", clockOutAt: DEMO_NOW });
  }
  async getOvertimeReport(params: { period: string; employeeId?: string }): Promise<Rec> {
    return { period: params.period, totalRegularHours: 0, totalOvertimeHours: 0, byEmployee: [], generatedAt: DEMO_NOW, ...READ_STAMP };
  }
  async listAnomalies(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Rec>> {
    return demoEmptyPage(params);
  }

  // ---------------------------------------------------------------- Webhook test
  async testWebhook(id: string, data?: { eventType?: string }): Promise<Rec> {
    return { webhookId: id, delivered: true, statusCode: 200, responseTimeMs: 42, eventType: data?.eventType ?? "ping", attemptedAt: DEMO_NOW, ...FISCAL_STAMP };
  }

  // ---------------------------------------------------------------- Payroll (simulated fiscal)
  async exportPayroll(params: { format: "a3" | "contasol" | "sage" | "holded" | "siltra"; month: string }): Promise<Rec> {
    return { format: params.format, month: params.month, fileUrl: "https://app.frihet.io/demo/payroll.txt", filename: "demo-payroll.txt", rowCount: 0, generatedAt: DEMO_NOW, ...FISCAL_STAMP };
  }
  async getPayrollChecklist(params: { month: string }): Promise<Rec> {
    return { month: params.month, totalEmployees: 0, readyEmployees: 0, missingEmployees: 0, employees: [], generatedAt: DEMO_NOW, ...FISCAL_STAMP };
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
    return { roles: [{ role: "owner", permissions: ["*"] }], resources: ["invoices", "expenses", "clients"], generatedAt: DEMO_NOW, ...READ_STAMP };
  }
  async getMyPermissions(): Promise<Rec> {
    return { userId: "demo_user_001", role: "owner", permissions: ["*"], workspaceId: "demo_ws_001", ...READ_STAMP };
  }

  // ---------------------------------------------------------------- Period close
  async getCurrentPeriod(params?: { periodId?: string }): Promise<Rec> {
    return { id: params?.periodId ?? "demo_period_2026_07", type: "monthly", status: "open", startDate: "2026-07-01", endDate: "2026-07-31", ...READ_STAMP };
  }
  async closePeriod(data: { type: "monthly" | "quarterly" }): Promise<Rec> {
    return simulateWrite("demo_period", { type: data.type }, { status: "closed", closedAt: DEMO_NOW });
  }
  async reopenPeriod(data: { periodId: string; reason: string }): Promise<Rec> {
    return simulateAction(data.periodId, { status: "reopened", reopenReason: data.reason });
  }
}
