---
name: frihet-workspace
description: >-
  Onboard, orient, and review a connected Frihet workspace and its product and
  service catalogue in ChatGPT. Use after installing the plugin (onboarding and
  setup), or when the user asks what Frihet can do, requests a workspace or
  monthly business overview, checks plan usage or workspace defaults, or lists,
  inspects, creates, or updates catalogue products and services (resumen del
  negocio, contexto de la empresa, catálogo de productos y servicios).
license: MIT
---

# Frihet Workspace & Catalogue (`frihet-workspace`)

Respond in the user's language (English or Spanish). Use the connected Frihet MCP server as the single source of truth for workspace records.

## Supported tools in this workflow

- **Workspace orientation (read-only):** `get_business_context`
- **Product & service catalogue (read-only):** `list_products`, `get_product`
- **Product & service catalogue (write, requires `confirm: true`):** `create_product`, `update_product`
- **Cross-workspace read helpers (when a broader overview is requested):** `list_invoices`, `list_quotes`, `list_expenses`, `list_clients`, `list_vendors`

## 1. Capability orientation vs. workspace data inspection

Always distinguish a **generic capability question** from an **authenticated workspace query**:

### A. Generic capability & welcome questions (*"What can Frihet do?"*, *"How do I use this plugin?"*, *"¿Qué puede hacer Frihet?"*)
- **Do NOT call `get_business_context` or any other MCP tool.** A generic question about plugin capabilities, setup, or limits must never read private workspace records.
- Answer directly by summarizing the four guided workflows and offering ready-to-use prompts:
  1. **Workspace & Catalogue (`frihet-workspace`):** *"Give me an overview of my business this month."* / *"Show me my active products and services."*
  2. **Invoices & Quotes (`invoices-and-quotes`):** *"Show me my draft invoices."* / *"Prepare an invoice draft for Acme SL."*
  3. **Expenses & Vendors (`expenses-and-vendors`):** *"List my expenses from this month."* / *"Record an office supplies expense."*
  4. **Clients & CRM (`clients-crm`):** *"List my clients and show recent CRM activity."* / *"Show notes for client Acme SL."*
- State the operational boundary briefly: read tools run only when you ask to inspect workspace records; write tools require explicit authorization (`confirm: true`) and only create or update internal records and drafts.

### B. Workspace overview requests (*"Give me an overview of my business this month"*, *"Give me my current Frihet business context overview"*, *"Check my workspace plan usage and defaults"*)
- When the user explicitly asks to inspect their connected business, monthly summary, plan usage, or workspace defaults (or asks during `onboardingSkill` setup to verify their connected workspace):
  1. Call `get_business_context` (takes no arguments) to retrieve `business`, `defaults`, `plan`, `currentMonth`, `recentActivity`, and `topClients`.
  2. Present a concise, factual summary of the connected workspace:
     - **Workspace & defaults:** business name and configured defaults (`defaults`) when present.
     - **Current month & plan usage:** current-month totals (`currentMonth`) and plan usage (`plan`).
     - **Recent activity & top clients:** highlight recent items from `recentActivity` and `topClients` without inventing fields omitted by the reviewed DTO.
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
