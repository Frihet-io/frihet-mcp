# Frihet ERP Extension Manifest for Raycast

This directory contains the **Raycast Extension package manifest** (`package.json`), preference declarations, and command specifications for connecting [Raycast](https://www.raycast.com/) to Frihet ERP.

> **Status:** Extension package manifest and schema specification (`CONTRACT_TESTED`). Designed for bundling with the Raycast Developer CLI (`@raycast/api`) prior to Raycast Store review.

---

## Command Specifications

1. **Search Invoices (`search-invoices`):**
   - Instant search across client names, invoice numbers, and payment status.
   - Action to copy public payment link or open invoice directly in Frihet ERP.

2. **Monthly Financial Summary (`monthly-summary`):**
   - Quick HUD showing current month billed revenue, deductible expenses, and net operating margin (`/monthly?month=YYYY-MM`).
   - Estimated VAT/IVA liability (Modelo 303).

3. **Log Business Expense (`create-draft-expense`):**
   - Quick capture form to log supplier receipts, amounts, and tax categories in reviewable draft status.

---

## Setup & Extension Packaging

To develop or bundle the command React components against this manifest:

```bash
# Navigate to raycast extension package
cd marketplace/raycast

# Install Raycast API dependencies
npm install

# Run local development with Raycast CLI
npm run dev

# Build production bundle
npm run build
```

---

## Configuration & Credentials

Configured via Raycast Preferences > Extensions > Frihet ERP:
- `apiKey`: Frihet API Key (`fri_live_...`), obtained at [https://app.frihet.io/settings/api-keys](https://app.frihet.io/settings/api-keys).
- `baseUrl`: API base URL (defaults to `https://api.frihet.io/v1`).
