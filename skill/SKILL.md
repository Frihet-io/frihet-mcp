---
name: frihet-mcp
description: >-
  Business-aware ERP management skill for Frihet MCP server. Manages invoices,
  expenses, clients, products, quotes, and webhooks with embedded Spanish tax
  knowledge (IVA/IGIC/IRPF), automatic expense categorization, and multi-step
  workflows like monthly close and quarterly tax prep. Use when the user says
  "create invoice", "log expense", "list clients", "tax report", "monthly close",
  "cierre mensual", "factura", "gasto", "presupuesto", "frihet", "303", "IVA
  trimestral", "overdue invoices", "morosos", or any business management task
  with a Frihet MCP server connected. Supports both English and Spanish. Do NOT
  use for general accounting questions without Frihet MCP server configured.
license: MIT
metadata:
  author: BRTHLS
  version: 1.13.0
  mcp-server: frihet-mcp
  category: business-management
  tags: [erp, invoicing, expenses, tax-compliance, ai-business, spain, mcp]
  documentation: https://docs.frihet.io/desarrolladores/mcp-server
  support: support@frihet.io
---

# Frihet MCP Skill

Business assistant inside Claude Code. Manage invoices, expenses, clients, products, and quotes in plain language — with built-in Spanish tax intelligence.

**Requires:** Frihet account with API access + `@frihet/mcp-server` configured as MCP server.

## Setup

### 1. Configure the MCP server

Add to your Claude Code MCP config (`~/.claude/mcp.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "frihet": {
      "command": "npx",
      "args": ["@frihet/mcp-server"],
      "env": {
        "FRIHET_API_KEY": "fri_your_api_key_here"
      }
    }
  }
}
```

Get your API key at **app.frihet.io > Settings > API**.

### 2. Verify

Run `/frihet status` — if you see your account info, you're ready.

## Commands

| Command | What it does | Example |
|---------|-------------|---------|
| `/frihet status` | Account overview: recent invoices, pending payments, month's expenses | `/frihet status` |
| `/frihet invoice` | Create, list, search invoices | `/frihet invoice "Acme 3500 EUR consulting enero"` |
| `/frihet expense` | Log and query expenses | `/frihet expense "47.50 gasolina 15 feb"` |
| `/frihet clients` | Manage client database | `/frihet clients "Acme"` |
| `/frihet quote` | Create and manage quotes | `/frihet quote create` |
| `/frihet report` | Financial summaries and P&L | `/frihet report quarterly` |
| `/frihet webhooks` | Configure automation triggers | `/frihet webhooks` |
| `/frihet setup` | Guided connection setup | `/frihet setup` |

## MCP Tools (94 total)

| Resource | Tools | Operations |
|----------|-------|------------|
| Intelligence | 4 | get_business_context, get_monthly_summary, get_quarterly_taxes, duplicate_invoice |
| Invoices | 6 | list, get, create, update, delete, search |
| Expenses | 5 | list, get, create, update, delete |
| Clients | 5 | list, get, create, update, delete |
| Products | 5 | list, get, create, update, delete |
| Quotes | 5 | list, get, create, update, delete |
| Webhooks | 5 | list, get, create, update, delete |
| Banking | 5 | list_bank_accounts, get_bank_account, list_transactions, categorize_transaction, match_transaction_to_invoice |
| Fiscal | 8 | modelo_303/130/390/180/347, verifactu_status, verifactu_resubmit, ticketbai_status |
| Stay | 5 | list_reservations, get_reservation, create_reservation, list_properties, sync_channel |
| POS | 4 | list_terminals, get_sale, list_sales, refund_sale |
| Time Tracking | 4 | list_time_entries, create_time_entry, update_time_entry, delete_time_entry |
| Recurring Invoices | 2 | list_recurring_invoices, run_recurring_now |

## Core Decision Logic

### Tax Rate Selection

Determine the correct tax based on the client's fiscal zone:

| Fiscal Zone | Tax | General Rate | Reduced | Super-reduced |
|-------------|-----|-------------|---------|---------------|
| `peninsula` | IVA | 21% | 10% | 4% |
| `canarias` | IGIC | 7% | 3% | 0% |
| `ceuta_melilla` | IPSI | 10% | — | — |
| `eu` | Reverse charge | 0% | — | — |
| `world` | Exempt | 0% | — | — |

**Decision flow for invoices:**
1. Check the client's address/fiscal zone
2. If `peninsula` → apply IVA at the rate matching the product/service type
3. If `canarias` → apply IGIC instead of IVA
4. If `eu` → 0% with "Inversión del sujeto pasivo" / "Reverse charge" note
5. If `world` → 0% exempt, no tax line

**IRPF retention (professional services only):**
- Standard: 15%
- New autónomo (first 3 years): 7%
- Only applies when invoicing as a professional to a business (B2B peninsula)

For full tax details including quarterly models, deadlines, and expense deductibility rules, see `references/tax-guide.md`.

### Expense Categorization

Auto-categorize expenses by matching keywords in the description:

| Category | Keywords (ES/EN) |
|----------|-----------------|
| `office` | oficina, papelería, material, supplies, stationery |
| `technology` | software, SaaS, hosting, dominio, hardware, cloud |
| `travel` | viaje, vuelo, tren, hotel, parking, flight, train |
| `food` | comida, restaurante, café, meal, lunch, dinner |
| `vehicle` | gasolina, combustible, fuel, peaje, toll, mantenimiento |
| `professional` | asesoría, gestoría, abogado, notario, consulting |
| `marketing` | publicidad, ads, diseño, campaign, SEO, social |
| `general` | anything that doesn't match above |

### Invoice Status Flow

```
draft → sent → paid
              → overdue → paid
                        → cancelled
```

Rectificativa (credit note) types: R1 (error), R2 (insolvency), R3 (discount), R4 (other), R5 (simplified).

### Quote Status Flow

```
draft → sent → accepted → (convert to invoice)
             → rejected
             → expired
```

## Key Workflows

Brief workflow outlines — for detailed step-by-step recipes, see `references/workflows.md`.

**Monthly close** ("cierre mensual"): List month's invoices + expenses → calculate income, expenses, IVA collected vs paid, net result → flag unpaid invoices.

**Tax prep 303** ("IVA trimestral", "303"): Sum quarter's IVA repercutido (invoices) - IVA soportado (deductible expenses) → present pre-filled 303 data.

**Client onboarding**: Create client → optionally create product → create invoice → confirm.

**Expense batch** ("gastos del mes"): Parse multiple expenses → create each with auto-categorized category → summary table with deductible split.

**Overdue follow-up** ("morosos"): List overdue invoices → sort by amount → suggest follow-up actions.

**Quote to invoice**: Get accepted quote → create invoice copying client/items/notes → mark quote as accepted.

## Error Handling

| Error | What to tell the user | Action |
|-------|----------------------|--------|
| 401 Unauthorized | "API key inválida o expirada. Revisa tu configuración en app.frihet.io > Settings > API." | Guide to `/frihet setup` |
| 404 Not Found | "No encontré ese recurso. Comprueba el ID o busca por nombre." | Suggest search tool |
| 429 Rate Limited | "Demasiadas peticiones. Esperando {retryAfter}s..." | Auto-retry with backoff |
| Network Error | "No puedo conectar con Frihet. Verifica tu conexión." | Check MCP server status |
| No MCP Server | "El servidor MCP de Frihet no está configurado. Ejecuta `/frihet setup`." | Guide setup |

For full error code reference and pagination patterns, see `references/api-patterns.md`.

## Language Rules

- Respond in the same language the user writes in
- Default to Spanish (ES) for financial terms and tax references
- Keep Spanish terms for tax models (Modelo 303, IRPF, IVA) even in English — they have no direct translation
- Currency is always EUR. Format: `1,234.56 EUR` (dot for decimals, comma for thousands)

## Security

- **Never** log, display, or store the API key in conversation output
- **Never** include the API key in code snippets shown to the user
- API key is managed exclusively via environment variables in MCP config
- All data stays between Claude Code, the MCP server, and Frihet's API
- The MCP server is stateless — stores nothing
- If a user asks to see their API key, direct them to app.frihet.io

## References

- `references/tax-guide.md` — Full Spanish tax knowledge: IVA/IGIC/IRPF rates, fiscal zones, quarterly calendar, expense deductibility, VeriFactu, Crea y Crece
- `references/workflows.md` — Detailed workflow recipes with step-by-step MCP tool calls and response formatting templates
- `references/api-patterns.md` — API rate limits, pagination, error codes, response formatting conventions

## Links

- **App:** https://app.frihet.io
- **Docs:** https://docs.frihet.io/desarrolladores
- **API Reference:** https://docs.frihet.io/desarrolladores/api-rest
- **MCP Server (npm):** https://www.npmjs.com/package/@frihet/mcp-server
- **Source Code:** https://github.com/Frihet-io/frihet-mcp
- **Remote MCP:** https://mcp.frihet.io
- **Support:** soporte@frihet.io
