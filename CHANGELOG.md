# Changelog

All notable changes to `@frihet/mcp-server` are documented here.

## [1.9.0-beta.1] — 2026-05-10

### Added

- **Wave 6 — Banking (5 tools)**: `list_bank_accounts`, `get_bank_account`, `list_transactions`, `categorize_transaction`, `match_transaction_to_invoice` (Trust Area: requires `confirm=true`). REST surface: `/v1/banking/*`.
- **Wave 6 — Fiscal (8 tools)**: `get_modelo_303_summary` (IVA quarterly), `get_modelo_130_summary` (IRPF estimated), `get_modelo_390_summary` (IVA annual), `get_modelo_180_summary` (IRPF rentals annual), `get_modelo_347_summary` (operations >€3,005 recap), `verifactu_status`, `verifactu_resubmit` (Trust Area + audit trail: requires `confirm=true`), `ticketbai_status` (Basque Country, province field). REST surface: `/v1/fiscal/*`.
- **Wave 6 — Time Tracking (4 tools)**: `list_time_entries`, `create_time_entry`, `update_time_entry`, `delete_time_entry` (soft-delete, Trust Area: requires `confirm=true`). REST surface: `/v1/time/entries`.
- **Wave 6 — Recurring Invoices (2 tools)**: `list_recurring_invoices`, `run_recurring_now` (manual trigger, `draftOnly` flag). REST surface: `/v1/recurring/invoices`.
- 7 new output schemas added to `shared.ts`: `BankAccount`, `BankTransaction`, `FiscalModeloSummary`, `VeriFactuStatus`, `TicketBaiStatus`, `TimeEntry`, `RecurringInvoice`.
- 19 new interface methods in `IFrihetClient` and HTTP implementations in `FrihetClient`.
- 4 new test files: `banking-tools.test.ts`, `fiscal-tools.test.ts`, `time-tools.test.ts`, `recurring-tools.test.ts` (~35 new tests).

### Changed

- Total tool count: 75 → **94 tools**.
- Updated package description, README badge, and `register-all.ts` to wire all 4 new families.

### Notes

- ERP backend endpoints `/v1/banking/*`, `/v1/fiscal/*`, `/v1/time/*`, `/v1/recurring/*` are planned. Tools are wired now and will surface 404 errors until the backend ships.
- Trust Area tools (`match_transaction_to_invoice`, `verifactu_resubmit`, `delete_time_entry`) require explicit `confirm=true` and fail-open with clear error messages.

---

## [1.8.0-beta.1] — 2026-05-10

### Added
- **Wave 4 — Stay v1 (5 tools)**: `list_reservations`, `get_reservation`, `create_reservation`, `list_properties`, `sync_channel`. Full vacation rental management surface exposed to AI assistants.
- **Wave 5 — POS v1 (4 tools)**: `list_terminals`, `get_sale`, `list_sales`, `refund_sale`. Point-of-sale tools with Trust Area confirmation gate on `refund_sale` (requires `confirm=true`).
- Output schemas for Stay and POS added to `shared.ts`: `reservationItemOutput`, `propertyItemOutput`, `posTerminalItemOutput`, `posSaleItemOutput`.
- New client interface methods and HTTP client implementations for `/v1/stay/*` and `/v1/pos/*` endpoints.

### Changed
- Total tool count: 66 → **75 tools**.
- Updated package description and README badge to reflect 75-tool count.
- `register-all.ts` updated to wire Stay + POS tool families.

### Notes
- ERP backend endpoints `/v1/stay/*` and `/v1/pos/*` land in Frihet-ERP S2 sprint. Tools are wired and will surface 404 errors until the backend ships.

---

## [1.5.3] — 2026-03-28

### Added
- **Tool #53 — `create_credit_note`**: Create credit notes linked to existing invoices with full line-item control.
- **Tool #54 — `get_invoice_einvoice`**: Retrieve the EN16931-compliant e-invoice (XML/UBL) for any issued invoice.
- **Tool #55 — `apply_late_fee`**: Apply a late payment fee to an overdue invoice, with configurable rate and description.

### Changed
- Total tool count: 52 → **55 tools**.
- Updated package description to reflect 55-tool count.

---

## [1.5.2] — 2026-03-24

### Added
- 52 tools covering invoicing, expenses, clients, products, quotes, CRM, webhooks, VeriFactu, accounting, and AI-powered reports.
- Smart alerts, purchase orders, and AI cash-flow forecast tools.

---

## [1.5.0] — 2026-03-21

### Added
- Initial public release with 52 tools.
- Full MCP protocol compliance.
- Works with Claude Desktop, Cursor, Windsurf, Cline, and any MCP-compatible client.
