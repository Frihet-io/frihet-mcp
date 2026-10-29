---
name: invoices-and-quotes
description: >-
  Search, inspect, and prepare numbered invoice drafts and quote drafts, or
  delete/cancel quotes in a connected Frihet workspace. Use when the user asks
  to list, search, or read invoices or quotes, check draft or overdue invoices,
  prepare or create an invoice or quote draft, or delete/cancel a quote
  (facturas, presupuestos, borradores de factura, buscar facturas).
license: MIT
---

# Invoices & Quotes (`invoices-and-quotes`)

Respond in the user's language (English or Spanish). Keep proposals in chat strictly separate from saved Frihet records, and keep internal draft records strictly separate from issued or fiscally submitted documents.

## Supported tools in this workflow

- **Invoices (read-only):** `list_invoices`, `get_invoice`, `search_invoices`
- **Invoices (write, requires `confirm: true`):** `create_invoice`
- **Quotes (read-only):** `list_quotes`, `get_quote`
- **Quotes (write, requires `confirm: true`):** `create_quote`, `delete_quote`
- **Supporting read-only lookups:** `get_business_context`, `get_daily_operational_brief`, `get_business_period_summary`, `search_clients`, `list_clients`, `get_client`, `list_products`, `get_product`

## 1. Reading and searching invoices and quotes

1. **Choose the right read tool:**
   - Use `list_invoices` (`status`, `clientId`, `from`, `to`, `seriesId`, `limit`, `offset`, `after`) for filtered invoice lists.
   - Use `search_invoices` (`query`, `status`, `from`, `to`, `limit`, `offset`, `after`) when searching by text query (such as client name or invoice number).
   - Use `get_invoice` (`id`) to inspect full stored line items (`items`), `notes`, `discountRate`, `taxRate`, and `total` for a single invoice, because `list_invoices` and `search_invoices` return summary rows without line items or notes.
   - Use `list_quotes` and `get_quote` (`id`) analogously for quotes.
2. **Pagination truth (never present one page as all records):**
   - Always inspect `total`, `limit`, `offset`, and `nextCursor`.
   - **Exploratory browsing (default):** If `nextCursor` is present or `total > data.length` on a general listing/search query, report the first page immediately without looping through extra pages, and explicitly label the output as a partial page (e.g., `Showing 20 of 47 invoices`). Never sum a partial page and claim it is the full period total.
   - **Exhaustive, full-sort, or aggregate requests (exception):** When the user explicitly asks for all matching records, a full sort across the entire set, or an exact sum across all pages, paginate using `after` (`nextCursor`) or `offset` until all pages are retrieved (or until a clear safety limit is reached, disclosing the exact number of records fetched out of `total`) before computing the sort or total. For monthly period totals and month-over-month comparisons, prefer `get_business_period_summary`.
3. **Stored totals and internal status boundary:**
   - Report `total` only when present on the returned record; if `total` is absent, state that the calculated total is not stored on the summary row and call `get_invoice` / `get_quote` if detail is needed.
   - Internal `status` and `issueDate` reflect workspace records only. They do **not** prove external email delivery, Peppol delivery receipts, EN 16931 validation, or e-invoicing (VeriFactu/AEAT/TicketBAI) submission or acceptance. If the user asks exclusively for regulated e-invoice delivery receipts or transmission status, explain that those external receipts are outside this connector without calling Frihet tools.

## 2. Preparing and creating invoice and quote drafts

1. **Draft-only creation boundary:**
   - `create_invoice` and `create_quote` always create a numbered **draft** (`status: "draft"`).
   - **Never claim** that `create_invoice` or `create_quote` issued, finalized, emailed, collected payment for, or filed an invoice or quote.
   - This connector does not include `update_invoice`, `delete_invoice`, `send_invoice`, `mark_invoice_paid`, or `update_quote`. If the user wants to edit an existing invoice draft, issue/email an invoice, or convert a quote, explain that those steps are completed in the Frihet web application.
2. **Required inputs & zero-invention rule:**
   - `create_invoice` requires `clientName`, `items` (non-empty array of `{ description, quantity, unitPrice }`), and `confirm: true` (optional: `issueDate`, `dueDate`, `taxRate`, `discountRate`, `notes`).
   - `create_quote` requires `clientName`, `items` (non-empty array of `{ description, quantity, unitPrice }`), and `confirm: true` (optional: `issueDate`, `dueDate`, `validUntil`, `taxRate`, `notes`).
   - **Never invent amounts, quantities, dates, discounts, document numbers, or tax treatment (`taxRate`).** Do not infer IVA, IGIC, reverse-charge, or tax exemption from a client's name or geography, and **never predict, extrapolate, or promise the next `invoiceNumber`, `quoteNumber`, or record `id` before the server returns it** (for example, never infer `INV-2026-0203` from `INV-2026-0201` and `INV-2026-0202`). Report only document numbers and IDs actually returned by Frihet tools.
   - When the user says *"prepare a draft"* or omits `clientName`, item `description` / `quantity` / `unitPrice`, or the applicable `taxRate`, do **not** chain exploratory calls to `list_invoices`, `search_invoices`, `get_invoice`, or `list_clients` to guess pricing from past invoices. Make at most one `list_products` lookup if a catalogue item was named (or zero tool calls), present the missing-fields checklist in chat, and ask the user to provide the exact `quantity`, `unitPrice`, `taxRate`, and confirmation before calling `create_invoice` or `create_quote`.
3. **Authorization & external-effects disclosure:**
   - Before calling `create_invoice` or `create_quote` without prior authorization, clearly disclose the lasting and external effects:
     - **For `create_invoice`:** reserves a document number and advances the workspace numbering counter, consumes monthly invoice usage, may create and link a client if `clientName` has no exact match, and may send minimized invoice-creation analytics to PostHog's EU-hosted service, deliver `invoice.created` / `client.created` events to active owner-configured webhooks, notify eligible workspace admins or accountants (in-app and via Novu), and award first-use referral credits.
     - **For `create_quote`:** reserves a quote number and advances the quote numbering counter, may create and link a client if `clientName` has no exact match, and may deliver `quote.created` / `client.created` events to active owner-configured webhooks.
   - **Minimum necessary calls (no redundant confirmation or unnecessary reads):** Make the minimum calls needed to complete the user's task; do not treat "zero extra calls" as an absolute prohibition when completing the task requires a lookup. When the user's prompt already contains all required fields (`clientName`, complete `items` with `description`, `quantity`, and `unitPrice`, and any requested `taxRate` / date parameters) AND explicitly authorizes creating the draft, call `create_invoice` or `create_quote` with `confirm: true` immediately on the first turn—do not ask a second confirmation question, and do not perform redundant pre- or post-write calls (`list_clients`, `list_products`, `get_invoice`) when `create_invoice` / `create_quote` already links/creates the client by `clientName` and returns the details needed to answer the user. Perform pre- or post-write read calls only when needed to (a) disambiguate an incomplete input or look up a named catalogue item's price, (b) retrieve a stored field omitted from the write response that the user asked to see, (c) verify an uncertain or timed-out write outcome, or (d) satisfy an explicit user request to re-read/verify the saved record.
4. **Post-creation reporting:**
   - Report the returned `id`, reserved `invoiceNumber` or `quoteNumber`, `status` (`draft`), linked `clientId` and `clientName`, line items, dates, and `externalEffects`. Explicitly remind the user that the document is saved as a **draft** and has not been issued or emailed.

## 3. Deleting or cancelling a quote (`delete_quote`)

1. Inspect the quote first with `get_quote` (`id`) if its current status or number is not yet known in the conversation.
2. Explain the exact behavior of `delete_quote` before executing an unauthorized request:
   - Permanently deletes **only a clean draft quote** (with no delivery, response, attachment, or conversion evidence).
   - Refuses deletion of a protected draft.
   - **Cancels** (does not permanently delete) a non-draft quote and may deliver a `quote.updated` event to active owner-configured webhooks.
3. Once authorized (`confirm: true`), call `delete_quote` and report the exact `result` returned by the server (whether deleted, cancelled, or refused).

## 4. Unknown write outcomes & timeout recovery

If `create_invoice`, `create_quote`, or `delete_quote` fails with a timeout, lost connection, or unknown status:
- **Do not repeat the write call automatically** (retrying `create_invoice` or `create_quote` blindly can advance the numbering counter again and create duplicate drafts).
- Query `search_invoices` (or `list_invoices` / `list_quotes`) once, and if needed call `get_invoice` / `get_quote` on the returned candidate ID(s), then **stop calling additional read tools**.
- Only attribute a found draft to the timed-out request if its details uniquely correlate. If **multiple** matching drafts exist with identical fields (for example, two pre-existing or identical drafts for the same client and amount), do not keep querying `list_invoices`, `list_clients`, or `get_business_context` trying to break the tie—immediately maintain uncertainty, list all candidate drafts (`invoiceNumber` and `id`) returned by the server, state clearly that you cannot confirm whether the timed-out write created one of them or whether they pre-existed, and ask the user which draft to keep or how to proceed without retrying `create_invoice` / `create_quote`, **without offering to delete or edit invoice drafts in chat** (remind the user that deleting or editing an invoice draft must be done in the Frihet web application), and **without guessing or promising what future `invoiceNumber` / `quoteNumber` a new draft would receive** (simply note that creating another draft would reserve a new server-assigned number and advance the counter).
