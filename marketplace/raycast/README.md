# Frihet ERP Extension for Raycast

Native [Raycast](https://www.raycast.com/) extension for **Frihet ERP**. Manage customer invoices, record deductible expenses, and check real-time European tax and financial health summaries directly from your macOS command bar.

> **Status:** Fully implemented Raycast Extension source package (`CONTRACT_TESTED`), ready for local developer mode (`ray develop`) or submission to the official Raycast Store (`ray publish`).

---

## Commands Implemented

1. **Search Invoices (`search-invoices`):**
   - Instant search across client names, invoice numbers, and payment status.
   - Status badge indicators (Draft, Sent, Paid, Overdue).
   - Action panel to copy public payment link, copy invoice ID, or open directly in Frihet ERP web dashboard.

2. **Monthly Financial Summary (`monthly-summary`):**
   - Quick HUD showing current month billed revenue, deductible expenses, and net operating margin (`/monthly?month=YYYY-MM`).
   - Estimated VAT/IVA liability (Modelo 303).
   - One-click copy of the formatted summary report.

3. **Log Business Expense (`create-draft-expense`):**
   - Quick capture form to log supplier receipts, amounts, categories, and Spanish VAT rates (21%, 10%, 4%, 0%).
   - **Draft Safety:** Created records enter strictly reviewable draft status with unique `Idempotency-Key` headers; never submits to tax authorities directly.

---

## Directory Structure

```
marketplace/raycast/
├── package.json                   # Extension manifest and Raycast schema
├── tsconfig.json                  # TypeScript compiler options
├── icon.png                       # Official Frihet 512x512 rounded icon
├── README.md                      # Documentation & setup guide
└── src/
    ├── types.ts                   # Interfaces for Invoices, Summary, and Preferences
    ├── api.ts                     # Governed API client with Idempotency & Redaction
    ├── search-invoices.tsx        # Search Invoices Raycast List command
    ├── monthly-summary.tsx        # Financial Summary Raycast Detail HUD command
    └── create-draft-expense.tsx   # Log Business Expense Raycast Form command
```

---

## Setup & Extension Development

```bash
# Navigate to raycast extension package
cd marketplace/raycast

# Install Raycast API dependencies
npm install

# Run local development mode in Raycast
npm run dev

# Build production bundle
npm run build
```

---

## Configuration & Credentials

Configured via Raycast Preferences > Extensions > Frihet ERP:
- `apiKey`: Frihet API Key (`fri_live_...`), obtained at [https://app.frihet.io/settings/api-keys](https://app.frihet.io/settings/api-keys).
- `baseUrl`: API base URL (defaults to production `https://api.frihet.io/v1`).
