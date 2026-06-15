/**
 * Shared interface for the Frihet ERP API client.
 *
 * Both the local (Node.js) and remote (Cloudflare Workers) FrihetClient
 * classes satisfy this interface via structural typing. Tool registration
 * functions depend on this interface so they can work with either client.
 */

import type { PaginatedResponse } from "./types.js";

export interface IFrihetClient {
  // Invoices
  listInvoices(params?: { limit?: number; offset?: number; after?: string; fields?: string; status?: string; from?: string; to?: string; clientId?: string; seriesId?: string }): Promise<PaginatedResponse<Record<string, unknown>>>;
  getInvoice(id: string): Promise<Record<string, unknown>>;
  createInvoice(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateInvoice(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteInvoice(id: string): Promise<void>;
  searchInvoices(query: string, params?: { limit?: number; offset?: number; after?: string; fields?: string; status?: string; from?: string; to?: string }): Promise<PaginatedResponse<Record<string, unknown>>>;

  // Expenses
  listExpenses(params?: { limit?: number; offset?: number; after?: string; fields?: string; from?: string; to?: string; vendorId?: string; category?: string }): Promise<PaginatedResponse<Record<string, unknown>>>;
  getExpense(id: string): Promise<Record<string, unknown>>;
  createExpense(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateExpense(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteExpense(id: string): Promise<void>;

  // Clients
  listClients(params?: { limit?: number; offset?: number; after?: string; fields?: string; q?: string; stage?: string }): Promise<PaginatedResponse<Record<string, unknown>>>;
  getClient(id: string): Promise<Record<string, unknown>>;
  createClient(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateClient(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteClient(id: string): Promise<void>;

  // Products
  listProducts(params?: { limit?: number; offset?: number; after?: string; fields?: string; q?: string; isActive?: boolean }): Promise<PaginatedResponse<Record<string, unknown>>>;
  getProduct(id: string): Promise<Record<string, unknown>>;
  createProduct(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateProduct(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteProduct(id: string): Promise<void>;

  // Quotes
  listQuotes(params?: { limit?: number; offset?: number; after?: string; fields?: string; status?: string; from?: string; to?: string; clientId?: string; seriesId?: string }): Promise<PaginatedResponse<Record<string, unknown>>>;
  getQuote(id: string): Promise<Record<string, unknown>>;
  createQuote(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateQuote(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteQuote(id: string): Promise<void>;

  // Vendors
  listVendors(params?: { q?: string; limit?: number; offset?: number; after?: string; fields?: string }): Promise<PaginatedResponse<Record<string, unknown>>>;
  getVendor(id: string): Promise<Record<string, unknown>>;
  createVendor(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateVendor(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteVendor(id: string): Promise<void>;

  // Invoice actions
  sendInvoice(id: string, to?: string): Promise<Record<string, unknown>>;
  markInvoicePaid(id: string, paidDate?: string): Promise<Record<string, unknown>>;
  getInvoicePdf(id: string): Promise<Record<string, unknown>>;
  getInvoiceEInvoice(invoiceId: string): Promise<any>;
  createCreditNote(invoiceId: string, data: { reason: string; reasonDescription?: string; fullCredit?: boolean; issueDate?: string }): Promise<Record<string, unknown>>;
  applyLateFee(invoiceId: string, data?: { amount?: number; daysOverdue?: number }): Promise<any>;

  // Quote actions
  sendQuote(id: string, to?: string): Promise<Record<string, unknown>>;

  // Webhooks
  listWebhooks(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Record<string, unknown>>>;
  getWebhook(id: string): Promise<Record<string, unknown>>;
  createWebhook(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateWebhook(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteWebhook(id: string): Promise<void>;

  // CRM: Contacts (subcollection of clients)
  listClientContacts(clientId: string, params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Record<string, unknown>>>;
  createClientContact(clientId: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteClientContact(clientId: string, contactId: string): Promise<void>;

  // CRM: Activities (subcollection of clients)
  listClientActivities(clientId: string, params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Record<string, unknown>>>;
  logClientActivity(clientId: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;

  // CRM: Notes (subcollection of clients)
  listClientNotes(clientId: string, params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Record<string, unknown>>>;
  createClientNote(clientId: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteClientNote(clientId: string, noteId: string): Promise<void>;

  // Deposits
  listDeposits(params?: { limit?: number; offset?: number; after?: string; fields?: string; from?: string; to?: string; clientId?: string; status?: string }): Promise<PaginatedResponse<Record<string, unknown>>>;
  getDeposit(id: string): Promise<Record<string, unknown>>;
  createDeposit(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateDeposit(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteDeposit(id: string): Promise<void>;
  applyDeposit(id: string, data?: Record<string, unknown>): Promise<Record<string, unknown>>;
  refundDeposit(id: string, data?: Record<string, unknown>): Promise<Record<string, unknown>>;

  // Intelligence endpoints
  getBusinessContext(): Promise<Record<string, unknown>>;
  getMonthlySummary(month?: string): Promise<Record<string, unknown>>;
  getQuarterlyTaxes(quarter?: string): Promise<Record<string, unknown>>;

  // E-Invoicing endpoints (CF rolling out 2026-04-21 to 2026-04-28; 404 → stub fallback)
  sendEInvoice(params: { invoiceId: string; format: string; dispatchMode: string }): Promise<{ workflowRunId: string; status: "queued"; estimatedCompletionSec: number }>;
  getEInvoiceStatus(workflowRunId: string): Promise<{ status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; step: string; error?: string; ackId?: string; pdfA3Url?: string; xmlUrl?: string }>;
  validateEInvoiceXml(params: { xml: string; format: string }): Promise<{ valid: boolean; errors: Array<{ severity: string; location: string; message: string; rule: string }>; validator: "kosit" | "mustang" | "xsd" | "schematron"; durationMs: number }>;
  exportDatev(params: { periodStart: string; periodEnd: string; format: string }): Promise<{ fileUrl: string; filename: string; rowCount: number; fiscalPeriod: string; encoding: "cp1252" }>;

  // E-Invoicing Day 4 endpoints (PR #414 + FACe PR #411 + TicketBAI PR #356; 404 → stub fallback)
  exportEInvoice(params: { invoiceId: string; format: string; signed?: boolean }): Promise<{ xmlUrl: string; filename: string; format: string; signed: boolean }>;
  faceSubmit(params: { invoiceId: string; mode: "mock" | "sandbox" | "production" }): Promise<{ registroFACe: string; status: "submitted" | "error"; submittedAt: string; mode: string }>;
  faceStatus(params: { invoiceId: string }): Promise<{ registroFACe: string; statusCode: string; statusDescription: string; rejectionReason?: string }>;
  ticketbaiSubmit(params: { invoiceId: string; sandbox: boolean }): Promise<{ tbaiId: string; territory: "bizkaia" | "gipuzkoa" | "araba"; status: "submitted" | "accepted" | "rejected" | "error"; sandbox: boolean; qrUrl?: string }>;
  ticketbaiStatus(params: { invoiceId: string }): Promise<{ tbaiId: string; territory: "bizkaia" | "gipuzkoa" | "araba"; status: "submitted" | "accepted" | "rejected" | "error"; rejectionReason?: string; error?: string }>;
  // kSeFSubmit omitted — stub only (PR #417 pending)

  // Stay — vacation rental endpoints (/v1/stay/*)
  listReservations(params?: { propertyId?: string; status?: string; checkInFrom?: string; checkInTo?: string; fields?: string; limit?: number; offset?: number; after?: string }): Promise<PaginatedResponse<Record<string, unknown>>>;
  getReservation(id: string): Promise<Record<string, unknown>>;
  createReservation(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  listProperties(params?: { q?: string; isActive?: boolean; fields?: string; limit?: number; offset?: number; after?: string }): Promise<PaginatedResponse<Record<string, unknown>>>;
  syncChannel(channelId: string, direction: "pull" | "push" | "both"): Promise<Record<string, unknown>>;

  // POS — point of sale endpoints (/v1/pos/*)
  listTerminals(params?: { locationId?: string; limit?: number; offset?: number }): Promise<PaginatedResponse<Record<string, unknown>>>;
  getSale(id: string): Promise<Record<string, unknown>>;
  listSales(params?: { terminalId?: string; status?: string; from?: string; to?: string; limit?: number; offset?: number; after?: string }): Promise<PaginatedResponse<Record<string, unknown>>>;
  refundSale(id: string, data?: { amountCents?: number; reason?: string }): Promise<Record<string, unknown>>;

  // Kitchen — kitchen display system endpoints (/v1/kitchen/*)
  listKitchenTickets(params?: { status?: string; stationId?: string; limit?: number; offset?: number; after?: string }): Promise<PaginatedResponse<Record<string, unknown>>>;
  getKitchenTicket(id: string): Promise<Record<string, unknown>>;
  updateKitchenTicket(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  listKitchenStations(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Record<string, unknown>>>;
  listMenuItems(params?: { q?: string; isActive?: boolean; limit?: number; offset?: number; after?: string }): Promise<PaginatedResponse<Record<string, unknown>>>;

  // Banking endpoints (/v1/banking/*)
  listBankAccounts(params?: { limit?: number; offset?: number }): Promise<PaginatedResponse<Record<string, unknown>>>;
  getBankAccount(id: string): Promise<Record<string, unknown>>;
  listTransactions(params?: { accountId?: string; from?: string; to?: string; status?: string; category?: string; limit?: number; offset?: number; after?: string }): Promise<PaginatedResponse<Record<string, unknown>>>;
  categorizeTransaction(id: string, data: { category: string; notes?: string }): Promise<Record<string, unknown>>;
  matchTransactionToDocument(transactionId: string, data: { documentId: string; documentType: "invoice" | "expense"; notes?: string }): Promise<Record<string, unknown>>;

  // Fiscal endpoints (/v1/fiscal/*)
  getFiscalModeloSummary(modeloCode: string, period?: string): Promise<Record<string, unknown>>;
  getVerifactuStatus(invoiceId: string): Promise<Record<string, unknown>>;
  resubmitVerifactu(invoiceId: string): Promise<Record<string, unknown>>;
  getTicketbaiStatus(invoiceId: string): Promise<Record<string, unknown>>;

  // Time tracking endpoints (/v1/time/*)
  listTimeEntries(params?: { userId?: string; projectId?: string; from?: string; to?: string; billable?: boolean; limit?: number; offset?: number; after?: string }): Promise<PaginatedResponse<Record<string, unknown>>>;
  getTimeEntry(id: string): Promise<Record<string, unknown>>;
  createTimeEntry(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateTimeEntry(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteTimeEntry(id: string): Promise<void>;
  getTimeSummary(params: { from: string; to: string; userId?: string; projectId?: string; groupBy?: string }): Promise<Record<string, unknown>>;

  // Recurring invoice endpoints (/v1/recurring/*)
  listRecurringInvoices(params?: { status?: string; limit?: number; offset?: number }): Promise<PaginatedResponse<Record<string, unknown>>>;
  getRecurringInvoice(id: string): Promise<Record<string, unknown>>;
  createRecurringInvoice(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateRecurringInvoice(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  pauseRecurringInvoice(id: string): Promise<Record<string, unknown>>;
  resumeRecurringInvoice(id: string): Promise<Record<string, unknown>>;
  deleteRecurringInvoice(id: string): Promise<void>;
  runRecurringNow(templateId: string, options?: { draftOnly?: boolean }): Promise<Record<string, unknown>>;

  // Team management endpoints (/v1/team/*)
  listTeamMembers(params?: { role?: string; status?: string; limit?: number; offset?: number }): Promise<PaginatedResponse<Record<string, unknown>>>;
  inviteTeamMember(data: { email: string; role: string; name?: string }): Promise<Record<string, unknown>>;
  updateTeamMemberRole(memberId: string, role: string): Promise<Record<string, unknown>>;
  removeTeamMember(memberId: string): Promise<void>;

  // Audit GL endpoints (/v1/gl/*) — Day 1 Megasprint PR #395.
  approveGLEntry(entryId: string, notes?: string): Promise<Record<string, unknown>>;
  rejectGLEntry(entryId: string, reason: string): Promise<Record<string, unknown>>;
  getGLEntryAuditLog(entryId: string): Promise<Record<string, unknown>>;

  // White-label portal domain endpoints (/v1/portal/domain/*) — Day 1 Megasprint PR #397.
  addCustomPortalDomain(data: { domain: string; workspaceId?: string }): Promise<Record<string, unknown>>;
  verifyCustomPortalDomain(data: { domain: string }): Promise<Record<string, unknown>>;
  removeCustomPortalDomain(data: { domain: string }): Promise<Record<string, unknown>>;

  // Self-onboard + VIES endpoints (/v1/portal/onboard/*) — Day 1 Megasprint PR #398.
  generatePortalOnboardLink(data: { email: string; name?: string; expiresInHours?: number; workspaceId?: string }): Promise<Record<string, unknown>>;
  lookupTaxIdViaVIES(data: { vatNumber: string; countryCode: string }): Promise<Record<string, unknown>>;

  // IGIC endpoints (/v1/igic/*) — Day 1 Megasprint PR #390.
  getIgicModeloSummary(modeloCode: string, params?: { year?: string; period?: string }): Promise<Record<string, unknown>>;
  calculateAiem(data: { ncCode: string; amount: number; description?: string }): Promise<Record<string, unknown>>;

  // Impuesto Sociedades endpoints (/v1/is/*) — Day 1 Megasprint PR #392.
  getISSummary(modeloCode: string, params?: { year?: string; installment?: string }): Promise<Record<string, unknown>>;

  // Bank rules endpoints (/v1/banking/rules) — Day 1 Megasprint PR #394 (Q3-flagged).
  listBankRules(params?: { isActive?: boolean; limit?: number; offset?: number }): Promise<import("./types.js").PaginatedResponse<Record<string, unknown>>>;
  createBankRule(data: { name: string; conditions: Array<{ field: string; operator: string; value: string }>; actions: Array<{ type: string; value: string }>; isActive?: boolean }): Promise<Record<string, unknown>>;

  // Gestoria endpoints (/v1/gestoria/*) — Wave Fase 1 surface for accountants.
  // Backend lands with Frihet-ERP PRs #383 (bulk send), #384 (aging), #385
  // (messaging). REST routes will proxy callables + Firestore reads.
  sendGestoriaMessage(data: {
    workspaceId: string;
    parentType: "documentRequest" | "filingItem" | "obligation";
    parentId: string;
    body: string;
  }): Promise<Record<string, unknown>>;
  listGestoriaMessages(params: {
    workspaceId: string;
    parentType: "documentRequest" | "filingItem" | "obligation";
    parentId: string;
    limit?: number;
    before?: string;
  }): Promise<{ messages: Array<Record<string, unknown>>; hasMore: boolean }>;
  createGestoriaTemplate(data: {
    name: string;
    title: string;
    description: string;
    dueDateOffsetDays: number;
    attachmentRequired?: boolean;
    variables?: Array<{ key: string; label?: string; defaultValue?: string }>;
  }): Promise<{ templateId: string }>;
  bulkSendGestoriaTemplate(data: {
    templateId: string;
    clientWorkspaceIds: string[];
    periodOverrides?: { quarter?: string | number; year?: string | number; month?: string | number };
  }): Promise<Record<string, unknown>>;
  getGestoriaAgingConsolidated(params?: { ownerUid?: string }): Promise<Record<string, unknown>>;

  // HR endpoints (/v1/leaves, /v1/time-entries, /v1/anomalies) — D4-B megasprint (404→propagate; ERP backend pending parallel D4-A).
  listLeaves(params?: { employeeId?: string; status?: string; from?: string; to?: string; limit?: number; offset?: number; after?: string }): Promise<PaginatedResponse<Record<string, unknown>>>;
  createLeaveRequest(data: { employeeId: string; type: string; startDate: string; endDate: string; reason?: string }): Promise<Record<string, unknown>>;
  approveLeave(leaveId: string, data?: { reason?: string }): Promise<Record<string, unknown>>;
  rejectLeave(leaveId: string, data: { reason: string }): Promise<Record<string, unknown>>;
  cancelLeave(leaveId: string): Promise<Record<string, unknown>>;
  attendanceClockIn(data: { employeeId: string; mood?: string; location?: string }): Promise<Record<string, unknown>>;
  attendanceClockOut(entryId: string): Promise<Record<string, unknown>>;
  getOvertimeReport(params: { period: string; employeeId?: string }): Promise<Record<string, unknown>>;
  listAnomalies(params?: { type?: string; severity?: string; from?: string; to?: string; limit?: number; offset?: number }): Promise<PaginatedResponse<Record<string, unknown>>>;

  // Webhook trust-area extensions (/v1/webhooks/:id/test) — D4-B megasprint.
  testWebhook(id: string, data?: { eventType?: string }): Promise<Record<string, unknown>>;

  // Payroll endpoints (/v1/payroll/prep/*) — D4-B megasprint.
  exportPayroll(params: { format: "a3" | "contasol" | "sage" | "holded" | "siltra"; month: string }): Promise<Record<string, unknown>>;
  getPayrollChecklist(params: { month: string }): Promise<Record<string, unknown>>;

  // Onboarding endpoints (/v1/onboarding/*) — D4-B megasprint.
  getOnboardingStatus(): Promise<Record<string, unknown>>;
  setOnboardingPersona(data: { persona: "autonomo" | "empresa" | "agencia" | "gestoria" }): Promise<Record<string, unknown>>;

  // Permissions endpoints (/v1/permissions/*) — D4-B megasprint.
  getPermissionsMatrix(): Promise<Record<string, unknown>>;
  getMyPermissions(): Promise<Record<string, unknown>>;

  // Period close endpoints (/v1/periods/*) — D4-B megasprint.
  getCurrentPeriod(params?: { periodId?: string }): Promise<Record<string, unknown>>;
  closePeriod(data: { type: "monthly" | "quarterly" }): Promise<Record<string, unknown>>;
  reopenPeriod(data: { periodId: string; reason: string }): Promise<Record<string, unknown>>;
}
