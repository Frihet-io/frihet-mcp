/**
 * Flowise Custom Tool for Frihet ERP
 *
 * Description: Allows AI agents in Flowise to query Frihet ERP financial records,
 * view tax estimates, and create draft invoices with human-in-the-loop safeguards.
 *
 * Requirements: Set 'FRIHET_API_KEY' in Flowise Environment Variables or tool inputs.
 */

const fetch = require('node-fetch');

const SENSITIVE_KEYS = new Set(['taxId', 'iban', 'token', 'secret', 'apiKey', 'password', 'verifactuHash']);

function redactSensitiveData(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactSensitiveData);

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactSensitiveData(v);
    }
  }
  return out;
}

function generateIdempotencyKey() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `idemp_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

module.exports = async function (input) {
  const apiKey = process.env.FRIHET_API_KEY || input.apiKey;
  const baseUrl = (process.env.FRIHET_API_BASE_URL || 'https://api.frihet.io/v1').replace(/\/+$/, '');

  if (!apiKey) {
    return 'Error: FRIHET_API_KEY is required to connect to Frihet ERP.';
  }

  const action = input.action || 'get_business_context';

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'x-frihet-api-key': apiKey,
    'User-Agent': 'Frihet-Flowise-Tool/1.0.0',
  };

  try {
    switch (action) {
      case 'get_business_context': {
        const res = await fetch(`${baseUrl}/context`, { headers });
        const data = await res.json();
        return redactSensitiveData(data);
      }

      case 'get_monthly_summary': {
        const year = input.year || new Date().getFullYear();
        const month = input.month || new Date().getMonth() + 1;
        const monthStr = `${year}-${String(month).padStart(2, '0')}`;
        const res = await fetch(`${baseUrl}/monthly?month=${encodeURIComponent(monthStr)}`, { headers });
        const data = await res.json();
        return redactSensitiveData(data);
      }

      case 'get_quarterly_taxes': {
        const year = input.year || new Date().getFullYear();
        const quarter = input.quarter || Math.ceil((new Date().getMonth() + 1) / 3);
        const quarterStr = `${year}-Q${quarter}`;
        const res = await fetch(`${baseUrl}/quarterly?quarter=${encodeURIComponent(quarterStr)}`, { headers });
        const data = await res.json();
        return redactSensitiveData(data);
      }

      case 'list_invoices': {
        const limit = input.limit || 20;
        const status = input.status ? `&status=${encodeURIComponent(input.status)}` : '';
        const res = await fetch(`${baseUrl}/invoices?limit=${limit}${status}`, { headers });
        const data = await res.json();
        return redactSensitiveData(data);
      }

      case 'create_draft_invoice': {
        if (!input.clientId || !input.description || !input.unitPrice) {
          return 'Error: clientId, description, and unitPrice are required to draft an invoice.';
        }
        const body = {
          clientId: input.clientId,
          items: [
            {
              description: input.description,
              quantity: Number(input.quantity) || 1,
              unitPrice: Number(input.unitPrice),
              vatRate: Number(input.vatRate) || 21,
            },
          ],
          status: 'draft', // Enforce draft-only invariant
        };
        const res = await fetch(`${baseUrl}/invoices`, {
          method: 'POST',
          headers: {
            ...headers,
            'Idempotency-Key': generateIdempotencyKey(),
          },
          body: JSON.stringify(body),
        });
        const created = await res.json();
        return {
          message: 'Draft invoice created successfully. Human review required before issuance.',
          invoice: redactSensitiveData(created),
        };
      }

      case 'create_expense': {
        if (!input.vendor || !input.amount) {
          return 'Error: vendor and amount are required to log an expense.';
        }
        const body = {
          vendor: input.vendor,
          amount: Number(input.amount),
          vatRate: Number(input.vatRate) || 21,
          category: input.category || 'General',
          status: 'draft',
        };
        const res = await fetch(`${baseUrl}/expenses`, {
          method: 'POST',
          headers: {
            ...headers,
            'Idempotency-Key': generateIdempotencyKey(),
          },
          body: JSON.stringify(body),
        });
        const created = await res.json();
        return redactSensitiveData(created);
      }

      case 'list_clients': {
        const search = input.search ? `?search=${encodeURIComponent(input.search)}` : '';
        const res = await fetch(`${baseUrl}/clients${search}`, { headers });
        const data = await res.json();
        return redactSensitiveData(data);
      }

      default:
        return `Error: Unknown action '${action}'. Supported: get_business_context, get_monthly_summary, get_quarterly_taxes, list_invoices, create_draft_invoice, create_expense, list_clients.`;
    }
  } catch (error) {
    return `Frihet API call failed: ${error.message}`;
  }
};
