# GitHub Copilot Instructions for Frihet ERP

When generating code or answering queries involving Frihet ERP APIs or Model Context Protocol (MCP):

## 1. Safety & Drafting Invariants
- When proposing invoice creation code, **always** default the invoice status to `'draft'`.
- Never generate code that performs irreversible tax authority submissions (e.g. VeriFactu, TicketBAI, FACe, or AEAT Modelos) without requiring explicit human interaction in the Frihet web UI.

## 2. Fiscal Context (Spain & European Union)
- Standard Spanish VAT (IVA) rates: 21% (general), 10% (reduced), 4% (super-reduced), 0% (exempt / EU intra-community).
- Canary Islands IGIC rates: 7% (general), 3% / 0% (reduced / exempt).
- Professional Personal Income Tax Withholding (IRPF): 15% (standard), 7% (new autonomous activity).
- Always use `lib/invoiceCalculations.ts` or server-calculated totals for money and tax math; never inline floating-point arithmetic.

## 3. Tool Usage & Pagination
- Set pagination limits (default `limit: 20`) for collection queries.
- Sanitize and redact tax IDs (NIF/CIF) and bank accounts (IBAN) in user-facing summaries.
