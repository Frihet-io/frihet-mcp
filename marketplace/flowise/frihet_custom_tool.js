/**
 * Flowise Custom Tool for Frihet ERP
 *
 * Description: Allows AI agents in Flowise to query Frihet ERP financial records,
 * view tax estimates, and create draft invoices with human-in-the-loop safeguards.
 *
 * Requirements: Set 'FRIHET_API_KEY' in Flowise Environment Variables or tool inputs.
 */

const fetch = require('node-fetch');

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
        return await res.json();
      }

      case 'get_monthly_summary': {
        const year = input.year || new Date().getFullYear();
        const month = input.month || new Date().getMonth() + 1;
        const res = await fetch(`${baseUrl}/summaries/monthly?year=${year}&month=${month}`, { headers });
        return await res.json();
      }

      case 'get_quarterly_taxes': {
        const year = input.year || new Date().getFullYear();
        const quarter = input.quarter || Math.ceil((new Date().getMonth() + 1) / 3);
        const res = await fetch(`${baseUrl}/taxes/quarterly?year=${year}&quarter=${quarter}`, { headers });
        return await res.json();
      }

      case 'list_invoices': {
        const limit = input.limit || 20;
        const status = input.status ? `&status=${encodeURIComponent(input.status)}` : '';
        const res = await fetch(`${baseUrl}/invoices?limit=${limit}${status}`, { headers });
        return await res.json();
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
          headers,
          body: JSON.stringify(body),
        });
        const created = await res.json();
        return {
          message: 'Draft invoice created successfully. Human review required before issuance.',
          invoice: created,
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
        };
        const res = await fetch(`${baseUrl}/expenses`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        return await res.json();
      }

      default:
        return `Unknown action: ${action}. Available: get_business_context, get_monthly_summary, get_quarterly_taxes, list_invoices, create_draft_invoice, create_expense.`;
    }
  } catch (err) {
    return `Frihet API call failed: ${err.message}`;
  }
};
