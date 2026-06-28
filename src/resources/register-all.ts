/**
 * MCP Resources for the Frihet ERP server (11 total: 7 static + 4 dynamic).
 *
 * Resources are read-only reference data that LLMs can access without making
 * API calls. They encode domain knowledge (tax rates, deadlines, categories,
 * currencies, countries) that would otherwise require the user to explain
 * every time.
 *
 * All resources use the `frihet://` URI scheme.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IFrihetClient } from "../client-interface.js";

export const MCP_STATIC_RESOURCE_COUNT = 7;
export const MCP_DYNAMIC_RESOURCE_COUNT = 4;
export const MCP_RESOURCE_COUNT = MCP_STATIC_RESOURCE_COUNT + MCP_DYNAMIC_RESOURCE_COUNT;

/* ------------------------------------------------------------------ */
/*  Static data                                                        */
/* ------------------------------------------------------------------ */

const API_SCHEMA_SUMMARY = `Frihet ERP REST API — OpenAPI 3.1
Base URL: https://api.frihet.io/v1
Docs: https://docs.frihet.io/desarrolladores/api-reference

Authentication:
  Header: X-API-Key
  Format: fri_<key>

Rate limits:
  100 requests/minute per API key
  Burst: 10 requests/second
  Response header: Retry-After (seconds) on 429

Endpoints:
  GET    /invoices          — List invoices (paginated)
  GET    /invoices/:id      — Get invoice by ID
  POST   /invoices          — Create invoice
  PATCH  /invoices/:id      — Update invoice
  DELETE /invoices/:id      — Delete invoice

  GET    /expenses          — List expenses (paginated)
  GET    /expenses/:id      — Get expense by ID
  POST   /expenses          — Create expense
  PATCH  /expenses/:id      — Update expense
  DELETE /expenses/:id      — Delete expense

  GET    /clients           — List clients (paginated)
  GET    /clients/:id       — Get client by ID
  POST   /clients          — Create client
  PATCH  /clients/:id       — Update client
  DELETE /clients/:id       — Delete client

  GET    /products          — List products (paginated)
  GET    /products/:id      — Get product by ID
  POST   /products          — Create product
  PATCH  /products/:id      — Update product
  DELETE /products/:id      — Delete product

  GET    /quotes            — List quotes (paginated)
  GET    /quotes/:id        — Get quote by ID
  POST   /quotes            — Create quote
  PATCH  /quotes/:id        — Update quote
  DELETE /quotes/:id        — Delete quote

  GET    /webhooks          — List webhooks (paginated)
  GET    /webhooks/:id      — Get webhook by ID
  POST   /webhooks          — Create webhook
  PATCH  /webhooks/:id      — Update webhook
  DELETE /webhooks/:id      — Delete webhook

Pagination:
  Query params: limit (1-100, default 50), offset (default 0)
  Response: { data: [...], total: number, limit: number, offset: number }

Error responses:
  400 — Bad request (validation error)
  401 — Invalid or missing API key
  403 — Insufficient permissions
  404 — Resource not found
  429 — Rate limit exceeded
  500 — Internal server error

Content-Type: application/json
All monetary values in EUR (cents not used — decimal euros).
Dates in ISO 8601 format (YYYY-MM-DD or full datetime).`;

const TAX_RATES = `Spanish Tax Rates by Fiscal Zone
================================

PENINSULA & BALEARIC ISLANDS — IVA (Impuesto sobre el Valor Añadido)
  General:    21%  — Most goods and services
  Reduced:    10%  — Food, transport, hospitality, renovation
  Super-reduced: 4%  — Bread, milk, eggs, fruit, vegetables, books, medicines, wheelchairs
  Exempt:      0%  — Education, healthcare, financial services, insurance, postal

CANARY ISLANDS — IGIC (Impuesto General Indirecto Canario)
  General:     7%  — Most goods and services
  Reduced:     3%  — Food, water, transport, hospitality
  Zero:        0%  — Basic food (bread, milk, eggs, fruit, vegetables), books, medicines
  Increased:   9.5% — Vehicles, jewelry, electronics >€1,000
  Special:    15%  — Tobacco
  Exempt:      0%  — Education, healthcare, financial services

CEUTA & MELILLA — IPSI (Impuesto sobre la Producción, los Servicios y la Importación)
  General:    10%  — Most goods and services
  Reduced:     2%  — Basic food, water
  Intermediate: 5%  — Other food, hospitality
  Increased:   8%  — Vehicles, electronics
  Special:    10%  — Tobacco, alcohol

EU INTRA-COMMUNITY — Reverse Charge
  B2B:         0%  — Buyer self-assesses VAT in their country (reverse charge / inversión del sujeto pasivo)
  B2C:       Destination country rate — Via OSS (One-Stop Shop) if >€10,000/year

INTERNATIONAL (outside EU)
  Exports:     0%  — Exempt with right to deduction (exención plena)
  Imports:   Destination country duties + VAT at border

WITHHOLDING TAX — IRPF (professionals / autónomos)
  Standard:   15%  — Retention on professional invoices
  New freelancer: 7%  — First 3 full calendar years of activity
  Applies to: Professional services invoiced to other businesses (B2B)

SPECIAL REGIMES
  Equivalence surcharge (recargo de equivalencia): +5.2% / +1.4% / +0.5% on IVA rates
    Applies to: Retail businesses (comercio minorista) buying from wholesalers
  Simplified regime: Fixed quarterly quotas based on activity modules
  Agriculture: 12% / 10.5% flat-rate compensation`;

const TAX_CALENDAR = `Spanish Quarterly Tax Calendar
===============================

All deadlines apply to the corresponding fiscal quarter unless noted.

Q1 (January–March) — File by April 20
  Modelo 303  — IVA quarterly return (autoliquidación trimestral IVA)
  Modelo 130  — IRPF quarterly advance payment (pago fraccionado IRPF)
  Modelo 349  — Intra-community operations summary (if applicable)
  Modelo 115  — Withholding on rental payments (if applicable)

Q2 (April–June) — File by July 20
  Modelo 303  — IVA quarterly return
  Modelo 130  — IRPF quarterly advance payment
  Modelo 349  — Intra-community operations (if applicable)
  Modelo 115  — Rental withholdings (if applicable)

Q3 (July–September) — File by October 20
  Modelo 303  — IVA quarterly return
  Modelo 130  — IRPF quarterly advance payment
  Modelo 349  — Intra-community operations (if applicable)
  Modelo 115  — Rental withholdings (if applicable)

Q4 (October–December) — File by January 30 (next year)
  Modelo 303  — IVA quarterly return
  Modelo 130  — IRPF quarterly advance payment
  Modelo 349  — Intra-community operations (if applicable)
  Modelo 115  — Rental withholdings (if applicable)

ANNUAL RETURNS — File by January 30
  Modelo 390  — Annual IVA summary (resumen anual IVA)
  Modelo 180  — Annual rental withholdings summary
  Modelo 190  — Annual professional withholdings summary (IRPF retenciones)

ANNUAL INCOME TAX — File April 1 – June 30
  Modelo 100  — Personal income tax return (Renta / IRPF)

CANARY ISLANDS (IGIC instead of IVA)
  Modelo 420  — IGIC quarterly return (same deadlines as Modelo 303)
  Modelo 425  — Annual IGIC summary (same deadline as Modelo 390)
  Filed with ATC (Administración Tributaria Canaria), NOT AEAT

VERIFACTU (mandatory e-invoicing, phased rollout)
  2026: Voluntary adoption
  2027: Mandatory for large companies
  2028: Mandatory for all businesses

KEY DATES SUMMARY
  Apr 20 — Q1 filings
  Jul 20 — Q2 filings
  Oct 20 — Q3 filings
  Jan 30 — Q4 filings + annual summaries (390, 180, 190)
  Apr 1–Jun 30 — Annual income tax (Modelo 100)`;

const EXPENSE_CATEGORIES = `Frihet Expense Categories & Deductibility Rules
=================================================

1. OFFICE (oficina)
   Examples: Rent, utilities, internet, phone, office supplies, cleaning
   Deductibility: 100% if exclusively for business use
   Mixed use: Proportional deduction (e.g., home office = % of m²)
   IVA deductible: Yes (with invoice)

2. TRAVEL (viajes)
   Examples: Flights, trains, taxis, hotel, car rental, fuel, tolls, parking
   Deductibility: 100% if business-related
   Meals during travel: Max €26.67/day (Spain), €48.08/day (abroad)
   IVA deductible: Yes (except parking meters, some tolls)

3. SOFTWARE (software)
   Examples: SaaS subscriptions, licenses, hosting, domains, cloud services
   Deductibility: 100% as operating expense
   IVA deductible: Yes (EU reverse charge for non-Spanish providers)
   Note: If >€300/unit, may need to amortize over 3 years

4. MARKETING (marketing)
   Examples: Advertising, social media ads, design, print materials, events, sponsorship
   Deductibility: 100% as operating expense
   IVA deductible: Yes
   Note: Gifts to clients deductible up to 1% of net revenue

5. PROFESSIONAL (servicios profesionales)
   Examples: Legal fees, accounting, consulting, freelancers, subcontractors
   Deductibility: 100%
   IRPF withholding: Provider should apply 15% (or 7% if new freelancer)
   IVA deductible: Yes

6. EQUIPMENT (equipamiento)
   Examples: Computers, monitors, furniture, phones, machinery
   Deductibility: Amortization (not instant deduction if >€300)
   Amortization: Computers 25%/yr (4yr), furniture 10%/yr (10yr), vehicles 16%/yr
   IVA deductible: Yes (vehicles: 50% unless exclusively business)
   Freelancer benefit: Items <€300 can be fully expensed in the year

7. INSURANCE (seguros)
   Examples: Professional liability, health (autónomo), property, cyber, D&O
   Deductibility: 100% if business-related
   Health insurance: Deductible up to €500/person/year for autónomos + family
   IVA: Insurance is IVA-exempt (no input IVA to deduct)

8. OTHER (otros)
   Examples: Bank fees, taxes (non-income), fines, donations, miscellaneous
   Deductibility: Varies
   NOT deductible: Fines, penalties, personal expenses, income tax itself
   Bank fees: 100% deductible
   Donations: Deduction in IRPF (not expense), 80% of first €250 + 40% rest`;

const INVOICE_STATUSES = `Frihet Invoice Status Flow
===========================

Statuses and transitions:

  DRAFT ──────► SENT ──────► PAID
    │             │
    │             └──────► OVERDUE ────► PAID
    │                         │
    │                         └────────► CANCELLED
    │
    └─────────────────────────────────► CANCELLED

Status definitions:

  draft     — Invoice created but not yet sent to client.
              Can be freely edited. No fiscal implications yet.
              This is the default status for new invoices.

  sent      — Invoice delivered to the client (email, PDF, etc.).
              Payment is expected. The invoice number and date become
              fiscally relevant — avoid modifications after this point.

  paid      — Payment received in full. Terminal state.
              Records the payment date. Invoice is complete.

  overdue   — Payment deadline (dueDate) has passed without payment.
              Triggers follow-up workflows. Can transition to paid
              (late payment) or cancelled (write-off / bad debt).

  cancelled — Invoice voided. Requires a corrective invoice or
              credit note for fiscal compliance if previously sent.
              Terminal state. Cannot transition to other statuses.

Automation rules (when configured):
  - Auto-transition sent → overdue when dueDate passes (daily check)
  - Webhook events: invoice.created, invoice.sent, invoice.paid,
    invoice.overdue, invoice.cancelled
  - Overdue reminders can be configured per-client

Best practices:
  - Always set a dueDate when creating invoices (default: 30 days)
  - Use draft status while iterating with the client
  - Once sent, create a new corrective invoice rather than editing
  - For partial payments, keep status as sent until full payment
  - cancelled requires a reason (notes field) for audit trail`;

const CURRENCIES = JSON.stringify({
  EUR: { name: "Euro", symbol: "\u20ac", decimals: 2, format: "1.234,56 \u20ac", countries: ["ES","DE","FR","IT","NL","PT","BE","AT","IE","FI","GR","LU","SK","SI","EE","LV","LT","CY","MT"] },
  USD: { name: "US Dollar", symbol: "$", decimals: 2, format: "$1,234.56", countries: ["US"] },
  GBP: { name: "British Pound", symbol: "\u00a3", decimals: 2, format: "\u00a31,234.56", countries: ["GB"] },
  CHF: { name: "Swiss Franc", symbol: "CHF", decimals: 2, format: "CHF 1'234.56", countries: ["CH"] },
  JPY: { name: "Japanese Yen", symbol: "\u00a5", decimals: 0, format: "\u00a51,234", countries: ["JP"] },
  CAD: { name: "Canadian Dollar", symbol: "CA$", decimals: 2, format: "$1,234.56", countries: ["CA"] },
  AUD: { name: "Australian Dollar", symbol: "A$", decimals: 2, format: "$1,234.56", countries: ["AU"] },
  MXN: { name: "Mexican Peso", symbol: "$", decimals: 2, format: "$1,234.56", countries: ["MX"] },
  BRL: { name: "Brazilian Real", symbol: "R$", decimals: 2, format: "R$ 1.234,56", countries: ["BR"] },
  SEK: { name: "Swedish Krona", symbol: "kr", decimals: 2, format: "1 234,56 kr", countries: ["SE"] },
  NOK: { name: "Norwegian Krone", symbol: "kr", decimals: 2, format: "1 234,56 kr", countries: ["NO"] },
  DKK: { name: "Danish Krone", symbol: "kr", decimals: 2, format: "1.234,56 kr", countries: ["DK"] },
  PLN: { name: "Polish Zloty", symbol: "z\u0142", decimals: 2, format: "1 234,56 z\u0142", countries: ["PL"] },
  CZK: { name: "Czech Koruna", symbol: "K\u010d", decimals: 2, format: "1 234,56 K\u010d", countries: ["CZ"] },
  HUF: { name: "Hungarian Forint", symbol: "Ft", decimals: 0, format: "1 234 Ft", countries: ["HU"] },
  RON: { name: "Romanian Leu", symbol: "lei", decimals: 2, format: "1.234,56 lei", countries: ["RO"] },
  BGN: { name: "Bulgarian Lev", symbol: "\u043b\u0432", decimals: 2, format: "1 234,56 \u043b\u0432", countries: ["BG"] },
  HRK: { name: "Croatian Kuna", symbol: "kn", decimals: 2, format: "1.234,56 kn", countries: ["HR"] },
  ISK: { name: "Icelandic Kr\u00f3na", symbol: "kr", decimals: 0, format: "1.234 kr", countries: ["IS"] },
  TRY: { name: "Turkish Lira", symbol: "\u20ba", decimals: 2, format: "\u20ba1.234,56", countries: ["TR"] },
  ILS: { name: "Israeli Shekel", symbol: "\u20aa", decimals: 2, format: "\u20aa1,234.56", countries: ["IL"] },
  ZAR: { name: "South African Rand", symbol: "R", decimals: 2, format: "R 1 234,56", countries: ["ZA"] },
  INR: { name: "Indian Rupee", symbol: "\u20b9", decimals: 2, format: "\u20b91,23,456.78", countries: ["IN"] },
  CNY: { name: "Chinese Yuan", symbol: "\u00a5", decimals: 2, format: "\u00a51,234.56", countries: ["CN"] },
  KRW: { name: "South Korean Won", symbol: "\u20a9", decimals: 0, format: "\u20a91,234", countries: ["KR"] },
  SGD: { name: "Singapore Dollar", symbol: "S$", decimals: 2, format: "S$1,234.56", countries: ["SG"] },
  HKD: { name: "Hong Kong Dollar", symbol: "HK$", decimals: 2, format: "HK$1,234.56", countries: ["HK"] },
  NZD: { name: "New Zealand Dollar", symbol: "NZ$", decimals: 2, format: "$1,234.56", countries: ["NZ"] },
  THB: { name: "Thai Baht", symbol: "\u0e3f", decimals: 2, format: "\u0e3f1,234.56", countries: ["TH"] },
  TWD: { name: "Taiwan Dollar", symbol: "NT$", decimals: 0, format: "NT$1,234", countries: ["TW"] },
  ARS: { name: "Argentine Peso", symbol: "$", decimals: 2, format: "$ 1.234,56", countries: ["AR"] },
  CLP: { name: "Chilean Peso", symbol: "$", decimals: 0, format: "$1.234", countries: ["CL"] },
  COP: { name: "Colombian Peso", symbol: "$", decimals: 0, format: "$ 1.234", countries: ["CO"] },
  PEN: { name: "Peruvian Sol", symbol: "S/", decimals: 2, format: "S/ 1,234.56", countries: ["PE"] },
  UYU: { name: "Uruguayan Peso", symbol: "$U", decimals: 2, format: "$U 1.234,56", countries: ["UY"] },
  AED: { name: "UAE Dirham", symbol: "\u062f.\u0625", decimals: 2, format: "1,234.56 \u062f.\u0625", countries: ["AE"] },
  SAR: { name: "Saudi Riyal", symbol: "\ufdfc", decimals: 2, format: "1,234.56 \ufdfc", countries: ["SA"] },
  PHP: { name: "Philippine Peso", symbol: "\u20b1", decimals: 2, format: "\u20b11,234.56", countries: ["PH"] },
  MYR: { name: "Malaysian Ringgit", symbol: "RM", decimals: 2, format: "RM1,234.56", countries: ["MY"] },
  IDR: { name: "Indonesian Rupiah", symbol: "Rp", decimals: 0, format: "Rp1.234", countries: ["ID"] },
}, null, 2);

const COUNTRIES = JSON.stringify([
  { name: "Spain (Peninsula)", code: "ES", fiscalZone: "peninsula", defaultTaxRate: 21, taxName: "IVA", currency: "EUR", invoicePrefix: "F" },
  { name: "Spain (Canary Islands)", code: "ES-CN", fiscalZone: "canarias", defaultTaxRate: 7, taxName: "IGIC", currency: "EUR", invoicePrefix: "F" },
  { name: "Spain (Ceuta)", code: "ES-CE", fiscalZone: "ceuta", defaultTaxRate: 10, taxName: "IPSI", currency: "EUR", invoicePrefix: "F" },
  { name: "Spain (Melilla)", code: "ES-ML", fiscalZone: "melilla", defaultTaxRate: 10, taxName: "IPSI", currency: "EUR", invoicePrefix: "F" },
  { name: "Germany", code: "DE", fiscalZone: "eu", defaultTaxRate: 19, taxName: "USt", currency: "EUR", invoicePrefix: "INV" },
  { name: "France", code: "FR", fiscalZone: "eu", defaultTaxRate: 20, taxName: "TVA", currency: "EUR", invoicePrefix: "FA" },
  { name: "Italy", code: "IT", fiscalZone: "eu", defaultTaxRate: 22, taxName: "IVA", currency: "EUR", invoicePrefix: "FT" },
  { name: "Netherlands", code: "NL", fiscalZone: "eu", defaultTaxRate: 21, taxName: "BTW", currency: "EUR", invoicePrefix: "F" },
  { name: "Belgium", code: "BE", fiscalZone: "eu", defaultTaxRate: 21, taxName: "TVA/BTW", currency: "EUR", invoicePrefix: "F" },
  { name: "Portugal", code: "PT", fiscalZone: "eu", defaultTaxRate: 23, taxName: "IVA", currency: "EUR", invoicePrefix: "FT" },
  { name: "Austria", code: "AT", fiscalZone: "eu", defaultTaxRate: 20, taxName: "USt", currency: "EUR", invoicePrefix: "RE" },
  { name: "Ireland", code: "IE", fiscalZone: "eu", defaultTaxRate: 23, taxName: "VAT", currency: "EUR", invoicePrefix: "INV" },
  { name: "Finland", code: "FI", fiscalZone: "eu", defaultTaxRate: 24, taxName: "ALV", currency: "EUR", invoicePrefix: "INV" },
  { name: "Greece", code: "GR", fiscalZone: "eu", defaultTaxRate: 24, taxName: "FPA", currency: "EUR", invoicePrefix: "TIM" },
  { name: "Luxembourg", code: "LU", fiscalZone: "eu", defaultTaxRate: 17, taxName: "TVA", currency: "EUR", invoicePrefix: "F" },
  { name: "Slovakia", code: "SK", fiscalZone: "eu", defaultTaxRate: 20, taxName: "DPH", currency: "EUR", invoicePrefix: "F" },
  { name: "Slovenia", code: "SI", fiscalZone: "eu", defaultTaxRate: 22, taxName: "DDV", currency: "EUR", invoicePrefix: "F" },
  { name: "Estonia", code: "EE", fiscalZone: "eu", defaultTaxRate: 22, taxName: "KM", currency: "EUR", invoicePrefix: "INV" },
  { name: "Latvia", code: "LV", fiscalZone: "eu", defaultTaxRate: 21, taxName: "PVN", currency: "EUR", invoicePrefix: "INV" },
  { name: "Lithuania", code: "LT", fiscalZone: "eu", defaultTaxRate: 21, taxName: "PVM", currency: "EUR", invoicePrefix: "SF" },
  { name: "Cyprus", code: "CY", fiscalZone: "eu", defaultTaxRate: 19, taxName: "VAT", currency: "EUR", invoicePrefix: "INV" },
  { name: "Malta", code: "MT", fiscalZone: "eu", defaultTaxRate: 18, taxName: "VAT", currency: "EUR", invoicePrefix: "INV" },
  { name: "Sweden", code: "SE", fiscalZone: "eu", defaultTaxRate: 25, taxName: "MOMS", currency: "SEK", invoicePrefix: "F" },
  { name: "Denmark", code: "DK", fiscalZone: "eu", defaultTaxRate: 25, taxName: "MOMS", currency: "DKK", invoicePrefix: "F" },
  { name: "Poland", code: "PL", fiscalZone: "eu", defaultTaxRate: 23, taxName: "VAT", currency: "PLN", invoicePrefix: "FV" },
  { name: "Czech Republic", code: "CZ", fiscalZone: "eu", defaultTaxRate: 21, taxName: "DPH", currency: "CZK", invoicePrefix: "F" },
  { name: "Hungary", code: "HU", fiscalZone: "eu", defaultTaxRate: 27, taxName: "\u00c1FA", currency: "HUF", invoicePrefix: "SZ" },
  { name: "Romania", code: "RO", fiscalZone: "eu", defaultTaxRate: 19, taxName: "TVA", currency: "RON", invoicePrefix: "F" },
  { name: "Bulgaria", code: "BG", fiscalZone: "eu", defaultTaxRate: 20, taxName: "DDS", currency: "BGN", invoicePrefix: "F" },
  { name: "Croatia", code: "HR", fiscalZone: "eu", defaultTaxRate: 25, taxName: "PDV", currency: "EUR", invoicePrefix: "R" },
  { name: "United Kingdom", code: "GB", fiscalZone: "international", defaultTaxRate: 20, taxName: "VAT", currency: "GBP", invoicePrefix: "INV" },
  { name: "United States", code: "US", fiscalZone: "international", defaultTaxRate: 0, taxName: "Sales Tax", currency: "USD", invoicePrefix: "INV" },
  { name: "Canada", code: "CA", fiscalZone: "international", defaultTaxRate: 5, taxName: "GST", currency: "CAD", invoicePrefix: "INV" },
  { name: "Mexico", code: "MX", fiscalZone: "international", defaultTaxRate: 16, taxName: "IVA", currency: "MXN", invoicePrefix: "F" },
  { name: "Brazil", code: "BR", fiscalZone: "international", defaultTaxRate: 17, taxName: "ICMS", currency: "BRL", invoicePrefix: "NF" },
  { name: "Argentina", code: "AR", fiscalZone: "international", defaultTaxRate: 21, taxName: "IVA", currency: "ARS", invoicePrefix: "F" },
  { name: "Chile", code: "CL", fiscalZone: "international", defaultTaxRate: 19, taxName: "IVA", currency: "CLP", invoicePrefix: "F" },
  { name: "Colombia", code: "CO", fiscalZone: "international", defaultTaxRate: 19, taxName: "IVA", currency: "COP", invoicePrefix: "F" },
  { name: "Peru", code: "PE", fiscalZone: "international", defaultTaxRate: 18, taxName: "IGV", currency: "PEN", invoicePrefix: "F" },
  { name: "Uruguay", code: "UY", fiscalZone: "international", defaultTaxRate: 22, taxName: "IVA", currency: "UYU", invoicePrefix: "F" },
  { name: "Australia", code: "AU", fiscalZone: "international", defaultTaxRate: 10, taxName: "GST", currency: "AUD", invoicePrefix: "INV" },
  { name: "New Zealand", code: "NZ", fiscalZone: "international", defaultTaxRate: 15, taxName: "GST", currency: "NZD", invoicePrefix: "INV" },
  { name: "Japan", code: "JP", fiscalZone: "international", defaultTaxRate: 10, taxName: "JCT", currency: "JPY", invoicePrefix: "INV" },
  { name: "South Korea", code: "KR", fiscalZone: "international", defaultTaxRate: 10, taxName: "VAT", currency: "KRW", invoicePrefix: "INV" },
  { name: "Singapore", code: "SG", fiscalZone: "international", defaultTaxRate: 9, taxName: "GST", currency: "SGD", invoicePrefix: "INV" },
  { name: "Hong Kong", code: "HK", fiscalZone: "international", defaultTaxRate: 0, taxName: "N/A", currency: "HKD", invoicePrefix: "INV" },
  { name: "India", code: "IN", fiscalZone: "international", defaultTaxRate: 18, taxName: "GST", currency: "INR", invoicePrefix: "INV" },
  { name: "China", code: "CN", fiscalZone: "international", defaultTaxRate: 13, taxName: "VAT", currency: "CNY", invoicePrefix: "INV" },
  { name: "Taiwan", code: "TW", fiscalZone: "international", defaultTaxRate: 5, taxName: "VAT", currency: "TWD", invoicePrefix: "INV" },
  { name: "Thailand", code: "TH", fiscalZone: "international", defaultTaxRate: 7, taxName: "VAT", currency: "THB", invoicePrefix: "INV" },
  { name: "Philippines", code: "PH", fiscalZone: "international", defaultTaxRate: 12, taxName: "VAT", currency: "PHP", invoicePrefix: "INV" },
  { name: "Malaysia", code: "MY", fiscalZone: "international", defaultTaxRate: 8, taxName: "SST", currency: "MYR", invoicePrefix: "INV" },
  { name: "Indonesia", code: "ID", fiscalZone: "international", defaultTaxRate: 11, taxName: "PPN", currency: "IDR", invoicePrefix: "INV" },
  { name: "Israel", code: "IL", fiscalZone: "international", defaultTaxRate: 17, taxName: "VAT", currency: "ILS", invoicePrefix: "INV" },
  { name: "South Africa", code: "ZA", fiscalZone: "international", defaultTaxRate: 15, taxName: "VAT", currency: "ZAR", invoicePrefix: "INV" },
  { name: "United Arab Emirates", code: "AE", fiscalZone: "international", defaultTaxRate: 5, taxName: "VAT", currency: "AED", invoicePrefix: "INV" },
  { name: "Saudi Arabia", code: "SA", fiscalZone: "international", defaultTaxRate: 15, taxName: "VAT", currency: "SAR", invoicePrefix: "INV" },
  { name: "Switzerland", code: "CH", fiscalZone: "international", defaultTaxRate: 8.1, taxName: "MWST", currency: "CHF", invoicePrefix: "RE" },
  { name: "Norway", code: "NO", fiscalZone: "international", defaultTaxRate: 25, taxName: "MVA", currency: "NOK", invoicePrefix: "F" },
  { name: "Iceland", code: "IS", fiscalZone: "international", defaultTaxRate: 24, taxName: "VSK", currency: "ISK", invoicePrefix: "INV" },
  { name: "Turkey", code: "TR", fiscalZone: "international", defaultTaxRate: 20, taxName: "KDV", currency: "TRY", invoicePrefix: "F" },
], null, 2);

/* ------------------------------------------------------------------ */
/*  Registration                                                       */
/* ------------------------------------------------------------------ */

export function registerAllResources(server: McpServer, client?: IFrihetClient): void {
  server.registerResource(
    "api-schema",
    "frihet://api/schema",
    {
      description:
        "OpenAPI schema summary: all endpoints, authentication method, rate limits, pagination, and error codes. " +
        "/ Resumen del esquema OpenAPI: endpoints, autenticación, límites, paginación y errores.",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [
        {
          uri: "frihet://api/schema",
          mimeType: "text/plain",
          text: API_SCHEMA_SUMMARY,
        },
      ],
    }),
  );

  server.registerResource(
    "tax-rates",
    "frihet://tax/rates",
    {
      description:
        "Current tax rates by Spanish fiscal zone: Peninsula IVA (21/10/4%), Canary Islands IGIC (7/3/0%), " +
        "Ceuta IPSI, EU reverse charge, international exports, IRPF withholding, and special regimes. " +
        "/ Tipos impositivos por zona fiscal: IVA, IGIC, IPSI, intracomunitario, exportaciones, IRPF, regímenes especiales.",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [
        {
          uri: "frihet://tax/rates",
          mimeType: "text/plain",
          text: TAX_RATES,
        },
      ],
    }),
  );

  server.registerResource(
    "tax-calendar",
    "frihet://tax/calendar",
    {
      description:
        "Spanish quarterly tax calendar with filing deadlines for Modelo 303, 130, 390, 420 (IGIC), and annual returns. " +
        "Includes VeriFactu e-invoicing timeline. " +
        "/ Calendario fiscal trimestral español con plazos de presentación de modelos y VeriFactu.",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [
        {
          uri: "frihet://tax/calendar",
          mimeType: "text/plain",
          text: TAX_CALENDAR,
        },
      ],
    }),
  );

  server.registerResource(
    "expense-categories",
    "frihet://config/expense-categories",
    {
      description:
        "The 8 expense categories in Frihet with deductibility rules, IVA treatment, and amortization periods. " +
        "Essential for correctly categorizing business expenses. " +
        "/ Las 8 categorías de gastos con reglas de deducibilidad, IVA y amortización.",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [
        {
          uri: "frihet://config/expense-categories",
          mimeType: "text/plain",
          text: EXPENSE_CATEGORIES,
        },
      ],
    }),
  );

  server.registerResource(
    "invoice-statuses",
    "frihet://config/invoice-statuses",
    {
      description:
        "Invoice status flow in Frihet: draft → sent → paid/overdue → cancelled. " +
        "Includes transition rules, automation triggers, webhook events, and fiscal compliance notes. " +
        "/ Flujo de estados de factura: borrador → enviada → pagada/vencida → cancelada.",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [
        {
          uri: "frihet://config/invoice-statuses",
          mimeType: "text/plain",
          text: INVOICE_STATUSES,
        },
      ],
    }),
  );

  server.registerResource(
    "currencies",
    "frihet://config/currencies",
    {
      description:
        "40 supported currencies with ISO codes, symbols, decimal places, locale formatting examples, and associated countries. " +
        "Use to validate currency inputs and format monetary values. " +
        "/ 40 divisas soportadas con códigos ISO, símbolos, decimales, formato local y países asociados.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "frihet://config/currencies",
          mimeType: "application/json",
          text: CURRENCIES,
        },
      ],
    }),
  );

  server.registerResource(
    "countries",
    "frihet://config/countries",
    {
      description:
        "61 supported countries with ISO codes, fiscal zones (peninsula, canarias, ceuta, melilla, eu, international), " +
        "default tax rates, tax names, default currencies, and invoice prefixes. " +
        "/ 61 países soportados con zonas fiscales, tipos impositivos, divisas y prefijos de factura.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "frihet://config/countries",
          mimeType: "application/json",
          text: COUNTRIES,
        },
      ],
    }),
  );

  /* ---------------------------------------------------------------- */
  /*  Dynamic resources (require API client)                           */
  /* ---------------------------------------------------------------- */

  if (client) {
    server.registerResource(
      "business-profile",
      "frihet://business-profile",
      {
        description:
          "Live business profile and context — company info, plan limits, recent activity, top clients, " +
          "current month snapshot. Equivalent to calling get_business_context but as a resource. " +
          "/ Perfil y contexto del negocio en vivo — info de empresa, limites, actividad reciente, clientes principales.",
        mimeType: "application/json",
      },
      async () => {
        const data = await client.getBusinessContext();
        return {
          contents: [
            {
              uri: "frihet://business-profile",
              mimeType: "application/json",
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      },
    );

    server.registerResource(
      "monthly-snapshot",
      "frihet://monthly-snapshot",
      {
        description:
          "Live financial snapshot for the current month — revenue, expenses, profit, tax liability, " +
          "invoice counts by status, expense breakdown by category. Updates on every read. " +
          "/ Resumen financiero del mes actual en vivo — ingresos, gastos, beneficio, impuestos.",
        mimeType: "application/json",
      },
      async () => {
        const data = await client.getMonthlySummary();
        return {
          contents: [
            {
              uri: "frihet://monthly-snapshot",
              mimeType: "application/json",
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      },
    );

    server.registerResource(
      "overdue-invoices",
      "frihet://overdue-invoices",
      {
        description:
          "Live list of all overdue invoices — invoices past their due date that haven't been paid. " +
          "Includes client names, amounts, due dates, and days overdue. Critical for cash flow management. " +
          "/ Lista en vivo de facturas vencidas — facturas cuya fecha de vencimiento ha pasado sin cobrar.",
        mimeType: "application/json",
      },
      async () => {
        const data = await client.listInvoices({ status: "overdue", limit: 100 });
        return {
          contents: [
            {
              uri: "frihet://overdue-invoices",
              mimeType: "application/json",
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      },
    );

    server.registerResource(
      "plan-limits",
      "frihet://status/plan-limits",
      {
        description:
          "Live plan limits and current usage — plan tier, invoices/month, AI messages/day, team members, " +
          "integrations, API requests/minute, and real-time usage counters. " +
          "/ Límites del plan y uso actual en vivo — tier, facturas/mes, mensajes IA/día, miembros, integraciones, API req/min.",
        mimeType: "application/json",
      },
      async () => {
        const ctx = await client.getBusinessContext();
        const plan = (ctx as Record<string, unknown>).plan ?? "free";
        const limits = (ctx as Record<string, unknown>).limits ?? {};
        const usage = (ctx as Record<string, unknown>).usage ?? {};
        const result = { plan, limits, usage };
        return {
          contents: [
            {
              uri: "frihet://status/plan-limits",
              mimeType: "application/json",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    );
  }
}
