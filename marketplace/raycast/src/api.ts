import { getPreferenceValues } from '@raycast/api';
import { Preferences, Invoice, MonthlySummary, DraftExpensePayload } from './types';

const SENSITIVE_KEYS = new Set(['taxId', 'iban', 'token', 'secret', 'apiKey', 'password', 'verifactuHash']);

/**
 * Recursively redacts sensitive identifiers from API responses.
 */
function redactSensitiveData<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(redactSensitiveData) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactSensitiveData(value);
    }
  }
  return result as T;
}

function getApiConfig(): { apiKey: string; baseUrl: string } {
  const prefs = getPreferenceValues<Preferences>();
  const apiKey = prefs.apiKey?.trim();
  const baseUrl = (prefs.baseUrl || 'https://api.frihet.io/v1').replace(/\/+$/, '');
  if (!apiKey) {
    throw new Error('Frihet API Key is required. Please set it in Raycast Preferences.');
  }
  return { apiKey, baseUrl };
}

function generateIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `ray_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const { apiKey, baseUrl } = getApiConfig();
  const method = options.method?.toUpperCase() || 'GET';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'x-frihet-api-key': apiKey,
    'User-Agent': 'Frihet-Raycast-Extension/1.0.0',
  };

  if (['POST', 'PATCH', 'DELETE'].includes(method)) {
    headers['Idempotency-Key'] = generateIdempotencyKey();
  }

  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Frihet API (${response.status}): ${errorText || response.statusText}`);
  }

  const rawJson = (await response.json()) as T;
  return redactSensitiveData(rawJson);
}

export async function fetchInvoices(status?: string, limit = 50): Promise<Invoice[]> {
  const query = new URLSearchParams();
  query.set('limit', String(Math.min(limit, 100)));
  if (status && status !== 'all') {
    query.set('status', status);
  }
  const data = await request<{ data?: Invoice[]; items?: Invoice[] } | Invoice[]>(`/invoices?${query.toString()}`);
  if (Array.isArray(data)) return data;
  return data.data || data.items || [];
}

export async function fetchMonthlySummary(year?: number, month?: number): Promise<MonthlySummary> {
  const now = new Date();
  const y = year || now.getFullYear();
  const m = month || now.getMonth() + 1;
  const monthStr = `${y}-${String(m).padStart(2, '0')}`;

  const data = await request<Record<string, unknown>>(`/monthly?month=${encodeURIComponent(monthStr)}`);

  return {
    month: monthStr,
    revenue: Number(data.revenue || data.totalRevenue || 0),
    expenses: Number(data.expenses || data.totalExpenses || 0),
    netMargin: Number(data.netMargin || (Number(data.revenue || 0) - Number(data.expenses || 0))),
    cashBalance: data.cashBalance !== undefined ? Number(data.cashBalance) : undefined,
    estimatedVat: data.estimatedVat !== undefined ? Number(data.estimatedVat) : undefined,
  };
}

export async function createDraftExpense(input: Omit<DraftExpensePayload, 'status'>): Promise<Record<string, unknown>> {
  const payload: DraftExpensePayload = {
    ...input,
    status: 'draft',
  };

  return request<Record<string, unknown>>('/expenses', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
