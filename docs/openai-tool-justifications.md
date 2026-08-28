# OpenAI tool justifications

The reviewed ChatGPT surface contains 33 business tools and 3 read-only
discovery tools. Every business write requires literal `confirm=true`. Each tool
has explicit read-only, destructive, and open-world annotations; the runtime
descriptor also declares idempotence explicitly.

## Read-only business tools (17)

`get_business_context`, `list_invoices`, `get_invoice`,
`search_invoices`, `list_expenses`, `get_expense`, `list_clients`, `get_client`,
`list_client_contacts`, `list_client_activities`, `list_client_notes`,
`list_products`, `get_product`, `list_quotes`, `get_quote`, `list_vendors`, and
`get_vendor`.

These tools read only the authenticated Frihet workspace. They cannot change or
remove records and have no user-directed external effect. Reviewed client and
vendor DTOs omit dedicated government identifiers and precise addresses.

## Webhook-capable confirmed writes (10)

`create_invoice`, `create_expense`, `update_expense`, `create_quote`,
`delete_quote`, `create_client`, `update_client`, `log_client_activity`,
`create_product`, and `update_product`.

These tools change Frihet state and can deliver a full resulting business event
to active endpoints previously configured by the workspace owner. Webhook
deliveries are outside the reviewed MCP response schema and can contain the
complete underlying record, including fields not exposed to ChatGPT. Because an
external delivery cannot be recalled, they are non-read-only, destructive,
open-world, and non-idempotent for review purposes.

Important per-tool consequences:

- `create_invoice` and `create_quote` create drafts, reserve a document number,
  advance the numbering counter, and may create/link a client.
- `create_invoice` also consumes monthly invoice usage, may send minimized
  activation/usage analytics to PostHog's EU-hosted analytics service, may notify
  eligible admins/accountants in-app and through Novu, and may award a first-use
  referral credit to another Frihet account.
- `create_expense` requires an explicit expense date and deductible choice, may create/link a vendor, may notify eligible
  admins/accountants, and may award a first-use referral credit. Its date
  determines its accounting/future tax-report period and its classification
  affects internal accounting, but it cannot mark the expense paid, choose a
  separate cash-basis payment period, or file a return.
- `update_expense` can change description, category, date, or deductible
  classification. It cannot change amount or linked supplier identity and does
  not file or amend anything.
- `log_client_activity` emits `client.updated` only for call, meeting, or email
  entries because those update the parent client's latest-activity fields; a task
  entry does not update the parent client.
- `delete_quote` permanently removes only a clean draft with no delivery,
  response, attachment, or conversion evidence. It refuses a protected draft.
  For a non-draft it preserves the record, changes status to `cancelled`, and
  may emit `quote.updated`.

## Closed-world, non-destructive confirmed writes (3)

`create_client_contact`, `create_client_note`, and `create_vendor` add records
inside the authenticated Frihet workspace without deleting or overwriting an
existing record and without a user-directed external effect.

## Closed-world destructive update (1)

`update_vendor` overwrites the supplied vendor fields using PATCH semantics.
There is no connector undo operation, but it has no user-directed external
effect.

## Permanent closed-world deletes (2)

`delete_client_contact` and `delete_client_note` permanently remove one selected
record. They are destructive,
cannot be undone by this connector, and have no user-directed external effect.

## Discovery tools (3)

`list_tool_groups`, `search_tools`, and `describe_tool` read only the in-process
reviewed catalogue. They perform no network call, mutate no data, and cannot
reveal tools outside the allowlist. Discovery advertises only `invoicing`,
`expenses`, `crm`, `intelligence`, and `catalog`.

## Explicitly excluded capabilities

The OpenAI profile excludes the following even though they remain available on
the full MCP server:

- `duplicate_invoice`, `create_credit_note`, `apply_late_fee`, `update_invoice`,
  `mark_invoice_paid`, `delete_invoice`, `send_invoice`, and every other invoice
  lifecycle, credit, issuing, sending, payment, cancellation, or filing action;
- `send_quote` and `update_quote`;
- `get_monthly_summary` because its legacy aggregate can count draft and
  cancelled invoices as revenue, while `get_business_context` provides the
  reviewed current-month context;
- `delete_product` because the backend can hard-delete a product referenced by
  historical documents, while the Frihet UI protects that relationship;
- `delete_vendor` because removing a supplier can leave historical expenses
  without the fiscal identity required by later reports or exports;
- `delete_client` because it does not atomically erase all child personal data;
- `delete_expense` because it does not atomically erase linked attachment data;
- `get_invoice_einvoice` and `get_invoice_pdf` because raw documents can carry
  restricted values and opaque bytes cannot be field-redacted;
- webhook listing/configuration/testing because URLs, secrets, and arbitrary
  metadata broaden the external-routing surface (existing owner-configured
  endpoints can still receive events from the ten disclosed writes);
- banking, payroll/HR, accommodation/POS, time tracking, recurring invoices,
  regulated e-invoicing/fiscal workflows, permissions, onboarding, period-close,
  and all MCP prompts/resources.
