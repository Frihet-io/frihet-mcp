# Changelog

All notable changes to `@frihet/mcp-server` are documented here.

## [1.12.0-beta.1] — 2026-05-16

### Added

- **D4-B megasprint — HR / Payroll / Onboarding / Permissions / Period close (19 new tools across 5 new files + 1 webhook test)**: wraps D1+D2 Frihet-ERP features previously absent from MCP surface (D3-T6 audit finding).
  - **HR (9 tools, `src/tools/hr.ts`)**: `leave_request_create`, `leave_approve`, `leave_reject`, `leave_cancel`, `leave_list`, `attendance_clock_in`, `attendance_clock_out`, `overtime_report`, `anomaly_list`. Wraps REST `/v1/leaves`, `/v1/time-entries`, `/v1/anomalies`.
  - **Webhook trust (1 tool, extended `src/tools/webhooks.ts`)**: `test_webhook` — fire synthetic event to verify endpoint reachability + signature validation. REST `POST /v1/webhooks/:id/test`.
  - **Payroll (2 tools, `src/tools/payroll.ts`)**: `payroll_export` (A3/Contasol/Sage/Holded/SILTRA gestoria formats), `payroll_checklist` (employee readiness per payroll month). REST `/v1/payroll/prep/export`, `/v1/payroll/prep/employees`. Frihet stages data → gestoria processes payroll.
  - **Onboarding (2 tools, `src/tools/onboarding.ts`)**: `onboarding_status`, `onboarding_persona_set` (autonomo/empresa/agencia/gestoria). REST `/v1/onboarding/status`, `/v1/onboarding/persona`.
  - **Permissions (2 tools, `src/tools/permissions.ts`)**: `permissions_matrix`, `permissions_me`. REST `/v1/permissions/matrix`, `/v1/permissions/me`.
  - **Period close (3 tools, `src/tools/accountingClose.ts`)**: `period_close_status`, `period_close` (TRUST AREA: `confirm=true` gate), `period_reopen` (TRUST AREA: `confirm=true` + reason required). REST `/v1/periods/current`, `/v1/periods/close`, `/v1/periods/:id/reopen`.
- 12 new output schemas in `shared.ts`: `leaveRequestItemOutput`, `attendanceEntryItemOutput`, `overtimeReportOutput`, `anomalyItemOutput`, `webhookTestResultOutput`, `payrollExportOutput`, `payrollChecklistOutput`, `onboardingStatusOutput`, `onboardingPersonaResultOutput`, `permissionsMatrixOutput`, `permissionsMeOutput`, `periodStatusOutput`.
- 19 new `IFrihetClient` methods + HTTP implementations in `FrihetClient`.
- `d4b-hr-payroll-onboarding-tools.test.ts` — 41 new tests covering registration counts, happy paths, trust-area `confirm=false` gates, and 404 error propagation.

### Changed

- Total tool count: **133 → 152 tools**.
- Bumped `package.json` version to `1.12.0-beta.1`.
- `register-all.ts` updated to register 5 new tool modules; comment reflects 152 tools.
- Test script includes new `d4b-hr-payroll-onboarding-tools.test.js`.

### Notes

- ERP backend endpoints land in parallel D4-A wave; until then the tools surface 404 errors as `isError=true` (consistent with existing banking/fiscal stub-or-propagate pattern). TODO comments mark `logLeaveDecision` callable wiring, A3 column confirmation, and SILTRA file extension.
- `period_close` and `period_reopen` follow the Trust Area `confirm=true` gate pattern (same as `match_transaction_to_invoice`).
- Npm publish deferred to D15 batch.

## [1.11.0-beta.1] — 2026-05-13

### Added

- **Day 4 Wave — E-Invoicing REST tools (6 tools)**: per-invoice endpoints wrapping Frihet-ERP PR #414, FACe PR #411, and TicketBAI PR #356.
  - `einvoice_export` — export an invoice as XML in a specific format (Facturae/XRechnung-CII/XRechnung-UBL/Factur-X/FatturaPA/PEPPOL-BIS-3/UBL/CII). `signed=true` returns XAdES-enveloped Facturae for FACe/AEAT. REST: `POST /v1/invoices/:id/einvoice/export`.
  - `face_submit` — submit a Facturae invoice to the Spanish FACe B2G portal (mock/sandbox/production modes, requires DIR3 codes on recipient). REST: `POST /v1/invoices/:id/face/submit`.
  - `face_status` — poll the FACe submission status by invoice ID (status codes: 1200=Registrada, 1300=Contabilizándose, 1400=Contabilizada, 2400=Anulada, 3100=Rechazada). REST: `GET /v1/invoices/:id/face/status`.
  - `ticketbai_submit` — submit to the Basque Country TicketBAI system (territory auto-routed: Bizkaia→BATUZ/LROE, Gipuzkoa, Álava; sandbox flag; returns TBAI identifier + QR URL). REST: `POST /v1/invoices/:id/ticketbai/submit`.
  - `ticketbai_status` — poll hacienda foral acknowledgement status for a TicketBAI submission. REST: `GET /v1/invoices/:id/ticketbai/status`.
  - `ksef_submit` — **stub only** — forward-compatible stub for Poland KSeF national e-invoicing. Returns `_notImplemented=true` with activation guidance until Frihet-ERP PR #417 merges to main. REST planned: `POST /v1/invoices/:id/ksef/submit`.
- 6 new output schemas in `einvoice.ts`: `einvoiceExportOutput`, `faceSubmitOutput`, `faceStatusOutput`, `ticketbaiSubmitOutput`, `ticketbaiStatusOutput`, `kSeFSubmitOutput`.
- 5 new Day 4 interface methods in `IFrihetClient` + HTTP implementations in `FrihetClient` (`exportEInvoice`, `faceSubmit`, `faceStatus`, `ticketbaiSubmit`, `ticketbaiStatus`).
- `einvoice-day4-tools.test.ts` — 35 new tests covering registration, 404-fallback stubs, live client success paths, 403 error handling, and KSeF always-stub behavior.

### Changed

- Total tool count: **127 → 133 tools**.
- Bumped `package.json` version to `1.11.0-beta.1`.
- Updated `package.json` description to include FACe, TicketBAI, and KSeF coverage.
- `register-all.ts` comment updated to reflect 133 tools.
- `einvoice-tools.test.ts` updated to expect 10 einvoice tools (4 original + 6 Day 4).
- Test script includes new `einvoice-day4-tools.test.js`.

### Notes

- All 5 live tools (`einvoice_export`, `face_{submit,status}`, `ticketbai_{submit,status}`) include 404-fallback stubs so the server remains usable while CF endpoints are deploying.
- `ksef_submit` is intentionally always-stub to future-proof the API surface — activation requires only removing the stub block when PR #417 merges.
- 404-fallback pattern mirrors existing Day 3 einvoice tools for consistency.

---

## [1.10.0-beta.3] — 2026-05-11

### Added

- **Wave Fase 1 — Gestoria (5 tools)**: surface accountant workflows to AI assistants.
  - `gestoria_message_send` — send a message in a contextual thread between gestor and client (parent: documentRequest, filingItem, or obligation).
  - `gestoria_messages_list` — paginate a thread newest-first using `before` cursor; returns `hasMore` flag.
  - `gestoria_template_create` — create a reusable document request template (title, description, due-date offset, attachment requirement, variables).
  - `gestoria_template_bulk_send` — bulk send a template to up to 500 client workspaces; honours `allowGestoriaCommunications=false` opt-out (RGPD). Maps to Frihet-ERP callable `gestoriaBulkSendRequests` (PR #383).
  - `gestoria_aging_consolidated` — cross-client AR aging report with totals by bucket (current / 30-60 / 60-90 / 90+), per-workspace breakdown, and top overdue invoices. Defaults to authenticated gestor.
- 6 new output schemas in `shared.ts`: `gestoriaMessageItemOutput`, `gestoriaMessageSendResultOutput`, `gestoriaTemplateItemOutput`, `gestoriaTemplateCreateResultOutput`, `gestoriaBulkSendResultOutput`, `gestoriaAgingConsolidatedOutput`.
- 5 new interface methods in `IFrihetClient` + HTTP implementations in `FrihetClient`.

### Changed

- Total tool count: 106 → **111 tools**.
- Bumped `package.json` version to `1.10.0-beta.3`; aligned `server.json` description and version.
- Updated README badge, hero copy, and tools section with new Gestoria family.

### Notes

- ERP backend REST routes `/v1/gestoria/*` are planned and will proxy the corresponding Firebase callables (eu-west1) + Firestore reads. Tools are wired now and will surface 404 errors until the REST shell ships in Frihet-ERP Wave Fase 1 closure (PRs #383 merged, #384 + #385 pending).
- App Check is required (mcp.frihet.io worker is App Check enforced).
- No new tests in this beta — REST surface arrives with Wave Fase 1; unit-level coverage will land alongside the test suite that mocks the new endpoints (parity with team / recurring families).

---

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
