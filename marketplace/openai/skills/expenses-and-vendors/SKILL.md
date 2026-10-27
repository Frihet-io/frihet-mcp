---
name: expenses-and-vendors
description: >-
  List, inspect, record, and update business expenses and vendor records in a
  connected Frihet workspace. Use when the user asks to review expenses by date
  or category, check an expense detail, record a new expense, update an expense's
  description/category/date/deductibility, or list, view, create, or update
  vendors/suppliers (gastos, proveedores, registrar gasto, facturas recibidas).
license: MIT
---

# Expenses & Vendors (`expenses-and-vendors`)

Respond in the user's language (English or Spanish). Keep expense proposals and accounting questions distinct from authorized changes in Frihet.

## Supported tools in this workflow

- **Expenses (read-only):** `list_expenses`, `get_expense`
- **Expenses (write, requires `confirm: true`):** `create_expense`, `update_expense`
- **Vendors (read-only):** `list_vendors`, `get_vendor`
- **Vendors (write, requires `confirm: true`):** `create_vendor`, `update_vendor`

## 1. Reviewing expenses and vendors

1. **Expense queries:**
   - Call `list_expenses` with optional filters (`from`, `to`, `category`, `vendorId`, `limit`, `offset`, `after`).
   - Call `get_expense` (`id`) when the user needs full detail on a specific expense (including stored `paidDate`, `taxDeductible`, `vendor`, and `vendorId`).
2. **Vendor queries:**
   - Call `list_vendors` (`limit`, `offset`, `after`) and `get_vendor` (`id`) to inspect supplier records (`id`, `name`, `email`, `phone`).
   - Dedicated government-identifier fields (NIF/CIF/VAT) and precise street addresses are intentionally omitted from the reviewed vendor DTOs.
3. **Pagination truth:**
   - Always check `total`, `limit`, `offset`, and `nextCursor` on `list_expenses` and `list_vendors`.
   - Never present a single page as the complete set of expenses or vendors when `nextCursor` is present or `total > data.length`. Either paginate through the remaining pages or state clearly that the response is a partial page (e.g., `Showing 20 of 65 expenses`).

## 2. Recording a new expense (`create_expense`)

1. **Required inputs & zero-invention rule:**
   - `create_expense` requires four explicit business fields plus confirmation:
     - `description` (non-empty string)
     - `amount` (positive number, in the schema's monetary unit)
     - `date` (`YYYY-MM-DD` — determines the expense's accounting and future tax-report period)
     - `taxDeductible` (`boolean` — records an explicit internal tax-deductible classification without filing any return)
     - `confirm: true`
   - Optional fields: `category`, `vendor` (supplier name).
   - **Never invent `amount`, `date`, or `taxDeductible`.** Do not assume an expense is tax-deductible (`taxDeductible: true`) or non-deductible (`false`) by default, and do not guess the expense date if the user did not state it. If any of `description`, `amount`, `date`, or `taxDeductible` is missing, do not call `list_vendors`, `list_expenses`, or `get_business_context` first—ask the user directly for the missing `date`, `taxDeductible` classification, and confirmation before calling `create_expense`.
2. **Authorization & lasting/external effects disclosure:**
   - Before executing an unauthorized `create_expense`, disclose:
     - The `date` selects the accounting and future tax-report period (no tax return is filed, and the connector does not mark the expense paid).
     - When `vendor` is provided and no exact vendor match exists, Frihet may create and link the vendor in a **separate backend step** that can remain even if the subsequent expense write fails.
     - `create_expense` can deliver `expense.created` events to active owner-configured webhooks, notify eligible workspace admins or accountants in-app and via Novu, and award first-use referral activation credits.
   - **No redundant confirmation:** When the user's prompt already supplies `description`, `amount`, `date`, and an explicit `taxDeductible` choice along with authorization to record the expense, call `create_expense` with `confirm: true` directly without asking a second confirmation question.
3. **Post-creation reporting:**
   - Report the new `id`, `description`, `amount`, `date`, `taxDeductible`, `category` / `vendor` / `vendorId` (when stored), and `externalEffects`. Do not claim the expense was paid, reimbursed, or filed with a tax authority.

## 3. Updating an expense (`update_expense`)

1. **Allowed vs. immutable fields:**
   - `update_expense` requires `id` and `confirm: true`, and can update **only** `description`, `category`, `date`, or `taxDeductible`.
   - Changing `date` moves the expense's accounting and future tax-report period; changing `taxDeductible` updates internal accounting classification without filing anything; external `expense.updated` webhooks may be delivered.
   - **`amount` and supplier identity (`vendor` / `vendorId`) cannot be changed** via `update_expense`, and there is **no `delete_expense` tool** in this connector. If the user asks to change an expense amount, change its linked supplier, or delete an expense, explain that limitation clearly and direct them to the Frihet web application.

## 4. Creating and updating vendors (`create_vendor`, `update_vendor`)

1. Before calling `create_vendor` (`name`, `confirm: true`, optional `email`, `phone`), check `list_vendors` to avoid creating a duplicate supplier.
2. For `update_vendor` (`id`, `confirm: true`, optional `name`, `email`, `phone`), note that PATCH semantics overwrite the supplied fields on the selected vendor with no undo operation in this connector.
3. There is **no `delete_vendor` tool** in this connector. Do not blank out vendor fields to simulate deletion.

## 5. Unknown write outcomes & timeout recovery

If `create_expense`, `update_expense`, `create_vendor`, or `update_vendor` fails with a timeout or ambiguous transport error:
- **Never retry the write automatically** (especially `create_expense`, which could record a duplicate expense or leave a separately created vendor).
- Call `list_expenses` (filtering by `from` / `to` around `date`) and `get_expense`, or `list_vendors` and `get_vendor`, to verify whether the write succeeded before taking further action.
- Report any matching record with its `id` and state clearly whether its correlation to the failed request is confirmed or uncertain.
