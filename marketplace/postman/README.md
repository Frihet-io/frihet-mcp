# Frihet ERP Official Postman Collection

Official [Postman](https://www.postman.com/) collection and environment for Frihet ERP REST API v1 (`https://api.frihet.io/v1`) testing, automation, and CI/CD validation.

## Files
- `frihet-erp.postman_collection.json`: Collection v2.1.0 with 52 requests across 10 folders, `X-API-Key` auth, `Idempotency-Key` headers on mutations, and automated assertions.
- `frihet-erp.postman_environment.json`: Pre-configured environment variables (`baseUrl`, `apiKey`, and sample resource ID placeholders).

## Coverage (10 Folders, 52 Requests)
1. **Intelligence, Summaries & Global Search** — `/context`, `/summary`, `/monthly`, `/quarterly`, `/search/global`
2. **Invoices** — list, get, create draft (`status: "draft"`, `provisionalDraft: true`), credit note draft, PDF download, invoice series
3. **Fiscal, VeriFactu & E-Invoicing (ES/EU)** — VeriFactu AEAT status, e-invoice XML export (Facturae / EN 16931), XML download, FACe B2G status & sandbox submit, TicketBAI sandbox status & preview submit
4. **Banking & Reconciliation** — accounts, transactions, manual transaction creation, categorize, invoice/expense matching, reconciliation suggestions
5. **Quotes** — list, create draft quote, PDF download
6. **Expenses** — list, get, create expense
7. **Clients, Products, Vendors & Deposits** — list & create core CRM/catalog/deposit records
8. **POS (Point of Sale)** — terminals, products, sales, cash sessions
9. **Stay (Vacation Rentals / PMS) & Kitchen (KDS)** — properties, reservations, channel sync, kitchen stations, tickets, menu items
10. **Webhooks, Team & Gestoría** — webhook CRUD, team members, consolidated AR aging

## Running with Newman CLI

```bash
# Install Newman
npm install -g newman

# Execute collection tests (obtain your key at https://app.frihet.io/settings/api)
newman run marketplace/postman/frihet-erp.postman_collection.json \
  -e marketplace/postman/frihet-erp.postman_environment.json \
  --env-var "apiKey=fri_your_key_here"
```

## Included Assertions & Invariants
- Canonical `X-API-Key` header authentication (matching `openapi.json`).
- UUIDv4 `Idempotency-Key: {{$guid}}` header on every mutating request.
- Verification of HTTP 200/201 response status codes and JSON envelopes.
- Enforcement of `status: 'draft'` on invoice and quote creation calls.
