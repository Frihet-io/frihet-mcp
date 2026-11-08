export interface Preferences {
  apiKey: string;
  baseUrl?: string;
}

export interface InvoiceItem {
  id?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  vatRate?: number;
}

export interface Invoice {
  id: string;
  invoiceNumber?: string;
  clientName?: string;
  clientId?: string;
  total: number;
  currency?: string;
  status: 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled';
  issueDate?: string;
  dueDate?: string;
  paymentUrl?: string;
  items?: InvoiceItem[];
}

export interface MonthlySummary {
  month: string;
  revenue: number;
  expenses: number;
  netMargin: number;
  cashBalance?: number;
  estimatedVat?: number;
}

export interface DraftExpensePayload {
  vendor: string;
  amount: number;
  category: string;
  vatRate: number;
  date?: string;
  notes?: string;
  status: 'draft';
}
