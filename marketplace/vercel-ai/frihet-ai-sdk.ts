import { z } from 'zod';

export interface FrihetClientConfig {
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Creates Vercel AI SDK compatible tool definitions for Frihet ERP.
 * Conforms to AI SDK Core tool format: { description, parameters, execute }
 */
export function createFrihetTools(config: FrihetClientConfig = {}) {
  const envApiKey = typeof process !== 'undefined' && process.env ? process.env.FRIHET_API_KEY : undefined;
  const envBaseUrl = typeof process !== 'undefined' && process.env ? process.env.FRIHET_API_BASE_URL : undefined;
  const apiKey = config.apiKey || envApiKey;
  const baseUrl = (config.baseUrl || envBaseUrl || 'https://api.frihet.io/v1').replace(/\/+$/, '');

  async function request(endpoint: string, options: RequestInit = {}) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Frihet-Vercel-AI-SDK/1.0.0',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
      headers['x-frihet-api-key'] = apiKey;
    }

    const response = await fetch(`${baseUrl}${endpoint}`, {
      ...options,
      headers: { ...headers, ...options.headers },
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Frihet API error (${response.status}): ${errText}`);
    }

    return response.json();
  }

  return {
    frihet_get_business_context: {
      description: 'Get high-level overview of the connected business: default currency, fiscal country, legal structure, and operating metrics.',
      parameters: z.object({}),
      execute: async () => {
        return request('/context');
      },
    },

    frihet_get_monthly_summary: {
      description: 'Retrieve financial performance summary (revenue, deductible expenses, net margin, cash balance) for a specific month.',
      parameters: z.object({
        year: z.number().int().describe('Calendar year (e.g. 2026)'),
        month: z.number().int().min(1).max(12).describe('Calendar month (1-12)'),
      }),
      execute: async ({ year, month }: { year: number; month: number }) => {
        return request(`/summaries/monthly?year=${year}&month=${month}`);
      },
    },

    frihet_get_quarterly_taxes: {
      description: 'Retrieve estimated tax obligations (VAT/IVA, withholding/IRPF) and upcoming fiscal submission deadlines for a given quarter.',
      parameters: z.object({
        year: z.number().int().describe('Fiscal year (e.g. 2026)'),
        quarter: z.number().int().min(1).max(4).describe('Quarter (1-4)'),
      }),
      execute: async ({ year, quarter }: { year: number; quarter: number }) => {
        return request(`/summaries/quarterly-taxes?year=${year}&quarter=${quarter}`);
      },
    },

    frihet_list_invoices: {
      description: 'List issued customer invoices with pagination and optional status filter (draft, sent, paid, overdue).',
      parameters: z.object({
        status: z.enum(['draft', 'sent', 'paid', 'overdue', 'cancelled']).optional().describe('Filter by invoice status'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max records to return'),
        offset: z.number().int().min(0).default(0).describe('Pagination offset'),
      }),
      execute: async ({ status, limit, offset }: { status?: string; limit?: number; offset?: number }) => {
        const params = new URLSearchParams();
        if (status) params.set('status', status);
        if (limit) params.set('limit', limit.toString());
        if (offset) params.set('offset', offset.toString());
        return request(`/invoices?${params.toString()}`);
      },
    },

    frihet_get_invoice: {
      description: 'Retrieve detailed information and line items for a specific invoice by ID.',
      parameters: z.object({
        invoiceId: z.string().describe('Unique invoice identifier (e.g. inv_12345)'),
      }),
      execute: async ({ invoiceId }: { invoiceId: string }) => {
        return request(`/invoices/${encodeURIComponent(invoiceId)}`);
      },
    },

    frihet_create_draft_invoice: {
      description: 'Create a new DRAFT customer invoice. Strictly creates a draft; does NOT submit to tax authorities or send to client.',
      parameters: z.object({
        clientId: z.string().describe('Client ID to bill'),
        items: z.array(z.object({
          description: z.string().describe('Line item description'),
          quantity: z.number().positive().describe('Quantity of units'),
          unitPrice: z.number().nonnegative().describe('Unit price in invoice currency'),
          taxRate: z.number().nonnegative().default(21).describe('Tax/VAT rate percentage (e.g. 21 for 21%)'),
        })).min(1).describe('List of invoice line items'),
        notes: z.string().optional().describe('Optional payment instructions or internal notes'),
      }),
      execute: async ({ clientId, items, notes }: { clientId: string; items: Array<{ description: string; quantity: number; unitPrice: number; taxRate: number }>; notes?: string }) => {
        return request('/invoices', {
          method: 'POST',
          body: JSON.stringify({
            clientId,
            items,
            notes,
            status: 'draft', // Enforcement of Draft-Only invariant
          }),
        });
      },
    },

    frihet_list_expenses: {
      description: 'List recorded business expenses with category and date range filters.',
      parameters: z.object({
        category: z.string().optional().describe('Expense category (e.g. software, travel, utilities)'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max records to return'),
      }),
      execute: async ({ category, limit }: { category?: string; limit?: number }) => {
        const params = new URLSearchParams();
        if (category) params.set('category', category);
        if (limit) params.set('limit', limit.toString());
        return request(`/expenses?${params.toString()}`);
      },
    },

    frihet_create_draft_expense: {
      description: 'Record a new draft business expense for receipt auditing and bookkeeper verification.',
      parameters: z.object({
        vendorName: z.string().describe('Name of the vendor or merchant'),
        amount: z.number().positive().describe('Total expense amount'),
        category: z.string().describe('Expense category'),
        date: z.string().describe('Date of expense (YYYY-MM-DD)'),
        notes: z.string().optional().describe('Business purpose or notes'),
      }),
      execute: async ({ vendorName, amount, category, date, notes }: { vendorName: string; amount: number; category: string; date: string; notes?: string }) => {
        return request('/expenses', {
          method: 'POST',
          body: JSON.stringify({
            vendorName,
            amount,
            category,
            date,
            notes,
            status: 'draft',
          }),
        });
      },
    },

    frihet_list_clients: {
      description: 'List registered clients, customer contacts, and outstanding billing balances.',
      parameters: z.object({
        search: z.string().optional().describe('Search query by client name or email'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max records to return'),
      }),
      execute: async ({ search, limit }: { search?: string; limit?: number }) => {
        const params = new URLSearchParams();
        if (search) params.set('search', search);
        if (limit) params.set('limit', limit.toString());
        return request(`/clients?${params.toString()}`);
      },
    },

    frihet_create_client: {
      description: 'Register a new client profile with billing contact and payment terms.',
      parameters: z.object({
        name: z.string().describe('Client legal name or business trade name'),
        email: z.string().email().describe('Primary billing contact email'),
        country: z.string().length(2).default('ES').describe('Two-letter ISO country code'),
        taxId: z.string().optional().describe('Tax identification number (CIF/NIF/VAT)'),
      }),
      execute: async ({ name, email, country, taxId }: { name: string; email: string; country: string; taxId?: string }) => {
        return request('/clients', {
          method: 'POST',
          body: JSON.stringify({ name, email, country, taxId }),
        });
      },
    },
  };
}
