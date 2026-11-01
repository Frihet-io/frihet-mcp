# OpenClaw Skill Package — Frihet ERP

Official skill descriptor for publishing Frihet ERP tools to the **OpenClaw** autonomous agent network and **ClawHub** registry (`@frihet-io` v1.1.0).

---

## 1. Overview

This package allows OpenClaw autonomous agents to interact with Frihet ERP through a governed, secure MCP streamable HTTP endpoint:
- **Registry ID:** `@frihet-io/frihet-erp`
- **Version:** `1.1.0`
- **Endpoint:** `https://mcp.frihet.io/mcp`
- **Authentication:** Bearer API key or OAuth 2.1 token

---

## 2. Governed Tool Surface

The skill package exposes 18 core tools:
1. `get_business_context`: High-level business overview and operating currency.
2. `get_monthly_summary`: Revenue, expenses, net margin, and VAT summary.
3. `get_quarterly_taxes`: Estimated tax obligations and quarterly fiscal calendar.
4. `list_invoices`: Search and list customer invoices.
5. `get_invoice`: Retrieve full line-item details of an invoice.
6. `search_invoices`: Free-text query across customer invoices.
7. `create_invoice`: **Draft-only** creation for human review.
8. `list_expenses`: Paginated listing of recorded expenses.
9. `get_expense`: Detailed expense view and tax deductibility.
10. `create_expense`: Draft expense registration.
11. `list_clients`: Active customer list.
12. `get_client`: Client details and payment terms.
13. `create_client`: Customer record registration.
14. `list_products`: Catalog items, standard pricing, and tax rates.
15. `get_product`: Specific item SKU lookup.
16. `list_quotes`: Commercial proposals and quotes.
17. `get_quote`: Specific quote details.
18. `create_quote`: Draft commercial quote generation.

---

## 3. Safety Invariants

- **Draft-Only Boundary:** Agents cannot legally issue invoices or file tax returns. All documents are created in `draft` status.
- **Automatic Redaction:** Sensitive taxpayer identifiers (NIF/CIF), bank details (IBAN), and auth tokens are masked.
- **Idempotency Protection:** Every mutation accepts a unique UUID `Idempotency-Key` to prevent duplicate writes.
