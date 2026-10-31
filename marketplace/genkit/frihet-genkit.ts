import { z } from 'zod';

export interface FrihetGenkitConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface GenkitToolRegistrar {
  // Compatible with Genkit v0.9+ and v1.0+ defineTool signature
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defineTool(config: { name: string; description: string; inputSchema: any; outputSchema?: any }, fn: (input: any) => Promise<any>): any;
}

/**
 * Creates Google Genkit tools for Frihet ERP.
 * Works seamlessly with Google Genkit (Gemini 1.5/2.0 Pro and Flash models).
 */
export function createFrihetGenkitTools(registrar?: GenkitToolRegistrar, config: FrihetGenkitConfig = {}) {
  const envApiKey = typeof process !== 'undefined' && process.env ? process.env.FRIHET_API_KEY : undefined;
  const envBaseUrl = typeof process !== 'undefined' && process.env ? process.env.FRIHET_API_BASE_URL : undefined;
  const apiKey = config.apiKey || envApiKey;
  const baseUrl = (config.baseUrl || envBaseUrl || 'https://api.frihet.io/v1').replace(/\/+$/, '');

  async function request(endpoint: string, options: RequestInit = {}) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Frihet-Genkit-Toolkit/1.0.0',
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

  const toolDefinitions = [
    {
      name: 'frihet_get_business_context',
      description: 'Get high-level overview of the connected business: default currency, fiscal country, legal structure, and operating limits.',
      inputSchema: z.object({}),
      fn: async () => request('/context'),
    },
    {
      name: 'frihet_get_monthly_summary',
      description: 'Retrieve financial performance summary (revenue, deductible expenses, net margin, cash balance) for a specific month.',
      inputSchema: z.object({
        year: z.number().int().describe('Calendar year (e.g. 2026)'),
        month: z.number().int().min(1).max(12).describe('Calendar month (1-12)'),
      }),
      fn: async (input: { year: number; month: number }) => {
        return request(`/summaries/monthly?year=${input.year}&month=${input.month}`);
      },
    },
    {
      name: 'frihet_get_quarterly_taxes',
      description: 'Retrieve estimated tax breakdown (Modelo 303 VAT/IVA, Modelo 130 IRPF installment, or corporate tax) for a specific fiscal quarter.',
      inputSchema: z.object({
        year: z.number().int().describe('Fiscal year (e.g. 2026)'),
        quarter: z.number().int().min(1).max(4).describe('Quarter (1-4)'),
      }),
      fn: async (input: { year: number; quarter: number }) => {
        return request(`/taxes/quarterly?year=${input.year}&quarter=${input.quarter}`);
      },
    },
    {
      name: 'frihet_list_invoices',
      description: 'Query invoices with filters for payment status, customer ID, and pagination limits.',
      inputSchema: z.object({
        status: z.enum(['draft', 'issued', 'sent', 'paid', 'overdue', 'cancelled']).optional().describe('Filter by invoice status'),
        clientId: z.string().optional().describe('Filter by client identifier'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max results to return'),
      }),
      fn: async (input: { status?: string; clientId?: string; limit: number }) => {
        const query = new URLSearchParams();
        if (input.status) query.set('status', input.status);
        if (input.clientId) query.set('clientId', input.clientId);
        query.set('limit', String(input.limit));
        return request(`/invoices?${query.toString()}`);
      },
    },
    {
      name: 'frihet_get_invoice',
      description: 'Retrieve detailed information for a single invoice by its ID.',
      inputSchema: z.object({
        invoiceId: z.string().describe('Unique invoice identifier'),
      }),
      fn: async (input: { invoiceId: string }) => {
        return request(`/invoices/${encodeURIComponent(input.invoiceId)}`);
      },
    },
    {
      name: 'frihet_create_draft_invoice',
      description: 'Create an invoice in strictly reviewable DRAFT status. Human confirmation is required before issuance or fiscal submission.',
      inputSchema: z.object({
        clientId: z.string().describe('Target client identifier'),
        items: z.array(z.object({
          description: z.string().describe('Line item description'),
          quantity: z.number().min(0.01).describe('Quantity units'),
          unitPrice: z.number().describe('Net unit price in EUR'),
          vatRate: z.number().default(21).describe('Applicable VAT rate percentage (e.g. 21, 10, 4, 0)'),
        })).min(1).describe('Invoice line items'),
        notes: z.string().optional().describe('Optional payment instructions or internal notes'),
      }),
      fn: async (input: { clientId: string; items: unknown[]; notes?: string }) => {
        return request('/invoices', {
          method: 'POST',
          body: JSON.stringify({
            ...input,
            status: 'draft', // Draft-only invariant
          }),
        });
      },
    },
    {
      name: 'frihet_list_expenses',
      description: 'List recorded business expenses with category and tax deductibility information.',
      inputSchema: z.object({
        category: z.string().optional().describe('Expense category filter'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max results to return'),
      }),
      fn: async (input: { category?: string; limit: number }) => {
        const query = new URLSearchParams();
        if (input.category) query.set('category', input.category);
        query.set('limit', String(input.limit));
        return request(`/expenses?${query.toString()}`);
      },
    },
    {
      name: 'frihet_create_expense',
      description: 'Record a new business expense/receipt for tax deduction.',
      inputSchema: z.object({
        vendor: z.string().describe('Vendor or merchant name'),
        amount: z.number().positive().describe('Total expense amount including tax'),
        vatRate: z.number().default(21).describe('VAT rate percentage (e.g. 21, 10, 4)'),
        category: z.string().describe('Expense category (e.g. "Software", "Travel", "Office")'),
        date: z.string().optional().describe('Expense date in YYYY-MM-DD format (defaults to today)'),
      }),
      fn: async (input: { vendor: string; amount: number; vatRate: number; category: string; date?: string }) => {
        return request('/expenses', {
          method: 'POST',
          body: JSON.stringify(input),
        });
      },
    },
    {
      name: 'frihet_list_clients',
      description: 'Query clients directory with search query and pagination.',
      inputSchema: z.object({
        search: z.string().optional().describe('Search term for client name, tax ID (NIF/CIF), or email'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max results to return'),
      }),
      fn: async (input: { search?: string; limit: number }) => {
        const query = new URLSearchParams();
        if (input.search) query.set('search', input.search);
        query.set('limit', String(input.limit));
        return request(`/clients?${query.toString()}`);
      },
    },
    {
      name: 'frihet_create_client',
      description: 'Register a new customer or business client in Frihet ERP.',
      inputSchema: z.object({
        name: z.string().describe('Full company or individual legal name'),
        taxId: z.string().describe('Tax identification number (NIF/CIF/VAT number)'),
        email: z.string().email().describe('Primary billing email address'),
        country: z.string().length(2).default('ES').describe('Two-letter ISO country code (e.g. ES, DE, FR)'),
      }),
      fn: async (input: { name: string; taxId: string; email: string; country: string }) => {
        return request('/clients', {
          method: 'POST',
          body: JSON.stringify(input),
        });
      },
    },
  ];

  if (registrar && typeof registrar.defineTool === 'function') {
    return toolDefinitions.map((t) =>
      registrar.defineTool(
        {
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        },
        t.fn
      )
    );
  }

  return toolDefinitions;
}
