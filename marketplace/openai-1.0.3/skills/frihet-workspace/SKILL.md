---
name: frihet-workspace
description: >-
  Onboard, orient, and review a connected Frihet workspace, daily operational
  priorities, month-over-month period comparisons, and the product and service
  catalogue in ChatGPT. Use after installing the plugin (onboarding and setup),
  when the user asks what deserves attention today, compares monthly business
  periods, requests a workspace overview, checks plan usage or defaults, or
  lists, inspects, creates, or updates catalogue products and services.
license: MIT
---

# Frihet Workspace, Operational Intelligence & Catalogue (`frihet-workspace`)

Respond in the user's language (English or Spanish). Use the connected Frihet MCP server as the single source of truth for workspace records.

## Supported tools in this workflow

- **Workspace orientation & operational intelligence (read-only):** `get_business_context`, `get_daily_operational_brief`, `get_business_period_summary`
- **Product & service catalogue (read-only):** `list_products`, `get_product`
- **Product & service catalogue (write, requires `confirm: true`):** `create_product`, `update_product`
- **Cross-workspace read helpers (when a broader overview is requested):** `list_invoices`, `list_quotes`, `list_expenses`, `list_clients`, `list_vendors`, `search_clients`, `search_vendors`

## 1. Capability orientation vs. workspace data inspection

Always distinguish a **generic capability question** from an **authenticated workspace query**:

### A. Generic capability & welcome questions (*"What can Frihet do?"*, *"How do I use this plugin?"*, *"¿Qué puede hacer Frihet?"*)
- **Do NOT call `get_business_context` or any other MCP tool.** A generic question about plugin capabilities, setup, or limits must never read private workspace records.
- Answer directly by summarizing the four guided workflows and offering ready-to-use prompts:
  1. **Workspace, Daily Brief & Catalogue (`frihet-workspace`):** *"What deserves my attention today in my business?"* / *"Compare this month with last month."* / *"Show me my active products and services."*
  2. **Invoices & Quotes (`invoices-and-quotes`):** *"Show me my draft invoices."* / *"Prepare an invoice draft for Acme SL."*
  3. **Expenses & Vendors (`expenses-and-vendors`):** *"Search vendor Cloud Hosting and show recent expenses."* / *"Record an office supplies expense."*
  4. **Clients & CRM (`clients-crm`):** *"I have a meeting with Acme; prepare a client briefing."* / *"Log a call with client Acme SL."*
- State the operational boundary briefly: read tools run only when you ask to inspect workspace records; write tools require explicit authorization (`confirm: true`) and only create or update internal records and drafts.

### B. Daily operational priorities (*"What deserves my attention today?"*, *"¿Qué merece mi atención hoy?"*, *"What should I review today and why?"*)
- Call `get_daily_operational_brief` (optional `asOfDate`, `pageLimit`).
- Present the prioritized findings with strict operational honesty:
  - **Separate drafts from issued activity:** Never mix `draftActivity` (non-issued working drafts) with `issuedActivity` (issued invoices).
  - **Separate invoices marked as paid from nominal unpaid receivables:** Report `paidInvoicesTotal` separately from `unpaidNominalTotal` and `overdueNominalTotal`, and note that `realOutstandingBalanceDeterminable` is `false` because partial payments and bank reconciliation are outside this connector.
  - **Preserve multi-currency buckets:** When `currency === "MIXED"`, report each currency bucket from `totalsByCurrency` separately without cross-currency conversion.
  - **Cite source records & coverage:** Cite the `recordRefs` (`id`, `label`) for each priority item and explicitly state whether the coverage is partial or complete (`coverage.isPartial`), noting if it is a partial operational sample.

### C. Period summaries & month-over-month comparisons (*"Compare October with September"*, *"Compáralo con el mes anterior"*, *"Summarize my business in 2026-10"*)
- Call `get_business_period_summary` with `period` (`YYYY-MM`) and optional `compareWithPeriod` (`YYYY-MM`).
- Present the period figures and deltas per currency (`deltasByCurrency`) without cross-currency conversion:
  - **Issue-date cohort semantics (`issuedTotal` vs. `currentlyMarkedPaidTotal` vs. `unpaidNominalTotal`):** Invoices are selected by `issueDate` within each period (`selectionBasis: "issue_date_cohort_not_payment_date"`). Always explain that `currentlyMarkedPaidTotal` (and `issuedCurrentlyPaidDelta`) represents **invoices issued in that period that are currently marked as paid**, NOT cash collected during that calendar month (an invoice issued in September and paid in October belongs to the September `issueDate` cohort). Never present `issuedCohortCurrentlyPaidMinusExpenses` as treasury cash flow or real accounting profit, and keep `draftInvoices` separate from issued revenue.
  - **Expenses & tri-state deductibility (`true` / `false` / `undetermined`):** Report `expenses.total`, `deductibleTotal` (`taxDeductible === true`), `nonDeductibleTotal` (`taxDeductible === false`), `undeterminedDeductibilityTotal` (`taxDeductible` absent or null — never assume missing deductibility is `true`), and top `byCategory` buckets.
  - **Coverage & non-filing boundary:** Report `coverage.isComplete` (and `bothPeriodsComplete` / `completeAndDeterminable` when comparing; if a delta is `null` because a document has an unavailable amount, state that honestly instead of substituting `0`). Never present operational period summaries as official tax-return filings.

### D. General workspace overview requests (*"Give me my current Frihet business context overview"*, *"Check my workspace plan usage and defaults"*)
- When the user asks to inspect their connected workspace defaults, plan usage, or general snapshot (including during `onboardingSkill` setup):
  1. Call `get_business_context` (takes no arguments) to retrieve `business`, `defaults`, `plan`, `currentMonth`, `recentActivity`, and `topClients`.
  2. Present a concise, factual summary of `business`, `defaults`, `currentMonth`, `plan`, `recentActivity`, and `topClients` without inventing fields omitted by the reviewed DTO.
  3. Do not call additional `list_*` tools unless the user asks to drill into a specific area.

## 2. Product & service catalogue workflow

### Reading catalogue items
1. Call `list_products` once using optional filters (`isActive`, `q`, `limit`, `offset`, `after`). Do not call `get_business_context` when the user only asked to list products.
2. When the user needs the full description or details of a specific item, call `get_product` with `id`.
3. **Pagination truth (exploratory single-page default vs. exhaustive requests):** Check `total`, `limit`, `offset`, and `nextCursor` on `list_products`. Never present a single page as the entire catalogue when `nextCursor` is present or `total` exceeds the returned `data.length`.
   - **Exploratory browsing (default):** For general listing requests, return the first page immediately without looping through subsequent pages, and state clearly that the list is a partial page (for example, `Showing 2 of 54 products — ask if you want the next page`).
   - **Exhaustive, full-sort, or aggregate requests (exception):** Make the minimum calls needed to complete the user's task. When the user explicitly asks for **all** items, the **complete** catalogue, a **full sort** across all products (for example, *"Show me all my active products and services and sort them by price"*), or an aggregate across the entire set, paginate using `after` (set to `nextCursor`) or `offset` until all pages are retrieved (or until a clear safety limit is reached, disclosing the exact number of records fetched out of `total`) before sorting or summarizing.

### Creating or updating a product or service
1. **Required inputs:**
   - `create_product` requires `name`, `unitPrice`, and `confirm: true` (optional: `description`, `taxRate`).
   - `update_product` requires `id` and `confirm: true`, plus at least one field to update (`name`, `unitPrice`, `description`, `taxRate`).
2. **Never invent prices or tax rates:** Do not guess `unitPrice` or `taxRate`. If the user asks to add a product without specifying `unitPrice`, or asks for tax advice without specifying `taxRate`, ask for the exact values before calling the tool.
3. **Authorization & external effects:**
   - If the user has not yet authorized the write, present the exact fields to be saved (`name`, `unitPrice`, `taxRate`, `description`) and disclose that `create_product` or `update_product` modifies the workspace catalogue and can deliver a `product.created` or `product.updated` event to active webhooks configured by the workspace owner (which cannot be recalled).
   - **Minimum necessary calls:** If the user's message already supplies complete parameters and explicit authorization to create or update the catalogue item, call `create_product` or `update_product` with `confirm: true` directly without adding a redundant confirmation question or unnecessary pre/post reads, unless a lookup (`list_products` / `get_product`) is needed to disambiguate the target `id`, verify an uncertain write outcome, or satisfy an explicit verification request.
4. **No product deletion in this connector:** `delete_product` is not available in the ChatGPT connector. If the user asks to delete a product, explain that product deletion is not exposed in this connector and can be managed in the Frihet web application.

## 3. Unknown write outcomes & timeout recovery

If `create_product` or `update_product` fails with a timeout, network interruption, or ambiguous error:
- **Never retry the write blindly.**
- Call `list_products` (with `q` set to the product name) or `get_product` first to check whether the change was already saved.
- Only attribute a found record to the timed-out request when its fields uniquely match; otherwise report that a matching product exists in the catalogue and ask whether the user wants to proceed.

## 4. Scope & privacy boundaries

- **Out-of-scope requests:** This connector does not access banking transactions (`list_transactions`, `list_bank_accounts`), payroll or HR (`Run payroll`, leave, attendance), tax return filings (Modelo 303/130/390), Peppol / EN 16931 / VeriFactu delivery receipts, raw PDF/XML retrieval, or webhook administration. When a request is outside scope, decline clearly without invoking Frihet tools.
- **Data minimization:** Never ask the user to paste API keys, passwords, payment card numbers, IBANs, health data, or government identifiers (NIF, CIF, NIE, VAT ID) into chat or free-text fields.
