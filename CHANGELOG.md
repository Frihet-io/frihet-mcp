# Changelog

All notable changes to `@frihet/mcp-server` are documented here.

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
