# Frihet ERP Extension for Raycast

Official [Raycast](https://www.raycast.com/) extension for Frihet ERP.

## Commands

1. **Search Invoices (`search-invoices`):**
   - Instant search across client names, invoice numbers, and payment status.
   - Action to copy public payment link or open invoice directly in Frihet ERP.

2. **Monthly Financial Summary (`monthly-summary`):**
   - Instant overview of current month billed revenue, deductible expenses, and net operating margin.
   - Estimated VAT/IVA liability (Modelo 303).

3. **Log Business Expense (`create-draft-expense`):**
   - Quick capture form to log supplier receipts, amounts, and tax categories.

## Setup & Development

```bash
# Clone repository and navigate to extension
cd marketplace/raycast

# Install dependencies
npm install

# Start local Raycast developer mode
npm run dev
```

## Configuration
Configure your `apiKey` in Raycast Preferences > Extensions > Frihet ERP.
Obtain an API key at [https://app.frihet.io/settings/api-keys](https://app.frihet.io/settings/api-keys).
