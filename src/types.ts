/**
 * Shared types for the Frihet MCP server.
 */

// -- API response envelope --

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
  nextCursor?: string;
}

export interface ApiError {
  error: string;
  message?: string;
  detail?: string;
}

// -- Pagination params --

export interface PaginationParams {
  limit?: number;
  offset?: number;
}

// -- Address --

export interface Address {
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

// -- Invoice --

export interface InvoiceItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface Invoice {
  id: string;
  clientName: string;
  items: InvoiceItem[];
  issueDate?: string;
  dueDate?: string;
  status?: string;
  notes?: string;
  taxRate?: number;
  total?: number;
  createdAt?: string;
  updatedAt?: string;
}

export type CreateInvoiceInput = Pick<Invoice, "clientName" | "items"> &
  Partial<Pick<Invoice, "issueDate" | "dueDate" | "status" | "notes" | "taxRate">>;

export type UpdateInvoiceInput = Partial<CreateInvoiceInput>;

// -- Expense --

export interface Expense {
  id: string;
  description: string;
  amount: number;
  category?: string;
  date?: string;
  vendor?: string;
  taxDeductible?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type CreateExpenseInput = Pick<Expense, "description" | "amount"> &
  Partial<Pick<Expense, "category" | "date" | "vendor" | "taxDeductible">>;

export type UpdateExpenseInput = Partial<CreateExpenseInput>;

// -- Client --

export interface Client {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  taxId?: string;
  address?: Address;
  createdAt?: string;
  updatedAt?: string;
}

export type CreateClientInput = Pick<Client, "name"> &
  Partial<Pick<Client, "email" | "phone" | "taxId" | "address">>;

export type UpdateClientInput = Partial<CreateClientInput>;

// -- Product --

export interface Product {
  id: string;
  name: string;
  unitPrice: number;
  description?: string;
  taxRate?: number;
  createdAt?: string;
  updatedAt?: string;
}

export type CreateProductInput = Pick<Product, "name" | "unitPrice"> &
  Partial<Pick<Product, "description" | "taxRate">>;

export type UpdateProductInput = Partial<CreateProductInput>;

// -- Quote --

export interface QuoteItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface Quote {
  id: string;
  clientName: string;
  items: QuoteItem[];
  validUntil?: string;
  notes?: string;
  status?: string;
  total?: number;
  createdAt?: string;
  updatedAt?: string;
}

export type CreateQuoteInput = Pick<Quote, "clientName" | "items"> &
  Partial<Pick<Quote, "validUntil" | "notes" | "status">>;

export type UpdateQuoteInput = Partial<CreateQuoteInput>;

// -- Webhook --

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  active?: boolean;
  secret?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type CreateWebhookInput = Pick<Webhook, "url" | "events"> &
  Partial<Pick<Webhook, "active" | "secret">>;

export type UpdateWebhookInput = Partial<CreateWebhookInput>;
