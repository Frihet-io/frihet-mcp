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
}
