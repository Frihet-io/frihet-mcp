# Release Notes — @frihet/mcp-server v1.13.0

> **Draft — do not publish until Viktor approves.**
> Publishing a GitHub Release on `v1.13.0` re-triggers crawls from PulseMCP, mcp.so, and Glama.
> Command: `gh release create v1.13.0 --title "v1.13.0 — 151 tools, full ES/EU fiscal compliance" --notes-file docs/RELEASE_NOTES_1.13.0.md`

---

## What ships in v1.13.0

`@frihet/mcp-server` v1.13.0 is the stable promotion of the `1.13.0-beta.1` build.
It is the largest single-version surface expansion in the project's history — 57 tools added over `1.9.0-beta.1`.

### Surface at v1.13.0

| Capability | Count |
|------------|-------|
| MCP Tools | **151** |
| MCP Resources | **11** |
| MCP Prompts | **10** |
| npm package | `@frihet/mcp-server@1.13.0` |
| Remote endpoint | `https://mcp.frihet.io/mcp` |

### Tool families

| Domain | Tools | Notes |
|--------|-------|-------|
| Invoices | 12 | CRUD + send + pay + PDF + credit note + late fee |
| Expenses | 5 | CRUD |
| Clients | 5 | CRUD |
| CRM | 8 | Contacts + Activities + Notes |
| Products | 5 | CRUD |
| Quotes | 6 | CRUD + send |
| Webhooks | 6 | CRUD + test_webhook |
| Deposits | 7 | CRUD + apply + refund |
| Vendors | 5 | CRUD |
| Intelligence | 4 | business context, monthly summary, quarterly taxes, duplicate invoice |
| E-Invoicing | 10 | XRechnung, Factur-X, FatturaPA, PEPPOL, Facturae, FACe B2G, TicketBAI, KSeF stub, DATEV export, einvoice_export |
| Banking | 5 | accounts, transactions, categorize, match |
| Fiscal (Spanish Tax Models) | 8 | Modelo 303/130/390/180/347, VeriFactu, TicketBAI status |
| Vacation Rentals / Stay | 5 | reservations, properties, OTA sync |
| POS | 4 | terminals, sales, refund |
| Time Tracking | 6 | CRUD + summary |
| Recurring Invoices | 8 | CRUD + pause/resume/run_now |
| Team Management | 4 | members + roles + invites |
| HR | 9 | leave management + attendance + overtime + anomalies |
| Payroll | 2 | export + checklist |
| Onboarding | 2 | status + persona |
| Permissions | 2 | matrix + me |
| Period Close | 3 | status + close + reopen (Trust Area) |
| Gestoria / Accountants | 5 | messaging + templates + bulk send + AR aging |
| Audit GL | 3 | approve + reject + audit log (Trust Area) |
| White-label Portal Domain | 3 | add + verify + remove |
| Self-Onboard & VIES | 2 | onboard link + EU VAT lookup |
| IGIC / Canary Islands | 4 | M415, M425, M418, AIEM |
| Corporate Tax (IS) | 2 | M200, M202 |
| Bank Rules | 2 | list + create |

### Resources (11)

**Static:** API Schema, Tax Rates, Tax Calendar, Expense Categories, Invoice Statuses, Currencies (40), Countries (61)

**Dynamic:** Business Profile, Monthly Snapshot, Overdue Invoices, Plan Limits

### Prompts (10)

`monthly-close`, `onboard-client`, `quarterly-tax-prep`, `overdue-followup`, `new-client-invoice`, `expense-report`, `year-end-close`, `cash-flow-forecast`, `invoice-aging-review`, `expense-batch`

### Why this matters for discoverability

Publishing this release on GitHub re-triggers crawls from:
- **PulseMCP** — indexes from GitHub releases
- **mcp.so** — indexes from npm + GitHub
- **Glama** — indexes from `glama.json` + GitHub

All three currently list stale counts (31 / 52 tools from early versions). A new GH Release pointing at the updated README + `glama.json` clears the undercount.

---

## Installation

```bash
# npm (stdio)
npx @frihet/mcp-server

# Remote (zero install)
# Connect to https://mcp.frihet.io/mcp via OAuth 2.0 or API key
```

Full install guide: https://docs.frihet.io/desarrolladores/mcp-server

---

## Upgrade from 1.9.x / 1.11.x

No breaking changes. Drop-in replacement. All tool names, input schemas, and output shapes are stable.

New tools (HR, Payroll, Onboarding, Permissions, Period Close, Gestoria, GL Audit, etc.) require the corresponding Frihet-ERP backend endpoints — surface 404 until your workspace's backend version includes them.
