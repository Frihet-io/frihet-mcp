# OpenAI Tool Justifications — Copy-Paste Reference

53 reviewed business tools, 3 justifications each. The live ChatGPT surface also includes 3 read-only discovery meta-tools (`list_tool_groups`, `search_tools`, `describe_tool`) whose catalog is pinned to these 53 tools.

---

## READ-ONLY TOOLS (21 tools)

All these share the same justifications:

| Field | Justification |
|-------|---------------|
| **Read Only: Yes** | This tool only retrieves data from the Frihet API. It does not create, update, or delete any records. |
| **Open World: No** | This tool only communicates with the Frihet API (api.frihet.io). It does not make requests to external services or the public internet. |
| **Destructive: No** | This tool is read-only and cannot modify or delete any data. |

**Tools:** `get_business_context`, `get_monthly_summary`, `list_invoices`, `get_invoice`, `search_invoices`, `get_invoice_pdf`, `list_expenses`, `get_expense`, `list_clients`, `get_client`, `list_client_contacts`, `list_client_activities`, `list_client_notes`, `list_products`, `get_product`, `list_quotes`, `get_quote`, `list_vendors`, `get_vendor`, `list_webhooks`, `get_webhook`

---

## CREATE TOOLS (12 tools — standard, no external effects)

| Field | Justification |
|-------|---------------|
| **Read Only: No** | This tool creates a new record in the user's Frihet account. |
| **Open World: No** | This tool only writes to the Frihet database via api.frihet.io. It does not contact external services. |
| **Destructive: No** | This tool creates new records but does not delete or irreversibly modify existing data. Created records can be edited or deleted later. |

**Tools:** `create_invoice`, `duplicate_invoice`, `create_credit_note`, `apply_late_fee`, `create_expense`, `create_client`, `create_client_contact`, `log_client_activity`, `create_client_note`, `create_product`, `create_quote`, `create_vendor`

---

## UPDATE TOOLS (7 tools — standard, no external effects)

| Field | Justification |
|-------|---------------|
| **Read Only: No** | This tool updates an existing record using PATCH semantics. Only the provided fields are changed. |
| **Open World: No** | This tool only communicates with the Frihet API (api.frihet.io). No external requests are made. |
| **Destructive: No** | This tool modifies fields on existing records but does not delete data. Changes are reversible by updating again. |

**Tools:** `update_invoice`, `mark_invoice_paid`, `update_expense`, `update_client`, `update_product`, `update_quote`, `update_vendor`

---

## DELETE TOOLS (9 tools)

| Field | Justification |
|-------|---------------|
| **Read Only: No** | This tool permanently deletes a record from the user's Frihet account. |
| **Open World: No** | This tool only communicates with the Frihet API (api.frihet.io). No external requests are made. |
| **Destructive: Yes** | This tool permanently deletes the record from the database. This action cannot be undone. |

**Tools:** `delete_invoice`, `delete_expense`, `delete_client`, `delete_client_contact`, `delete_client_note`, `delete_product`, `delete_quote`, `delete_vendor`, `delete_webhook`

---

## OPEN WORLD TOOLS (4 tools — trigger external communication)

### send_invoice

| Field | Justification |
|-------|---------------|
| **Read Only: No** | This tool triggers sending an invoice to the client via email and updates the invoice status to sent. |
| **Open World: Yes** | This tool causes Frihet's transactional email service to deliver the invoice PDF to the client's stored email address. An email is sent to an external recipient. |
| **Destructive: No** | The invoice data is preserved. While the email delivery cannot be recalled, the invoice can be updated or credit-noted afterward. |

### send_quote

| Field | Justification |
|-------|---------------|
| **Read Only: No** | This tool triggers sending a quote to the client via email and updates the quote status to sent. |
| **Open World: Yes** | This tool causes Frihet's transactional email service to deliver the quote to the client's stored email address. An email is sent to an external recipient. |
| **Destructive: No** | The quote data is preserved. While the email delivery cannot be recalled, the quote can be updated afterward. |

### create_webhook

| Field | Justification |
|-------|---------------|
| **Read Only: No** | This tool creates a new webhook configuration that subscribes to business events. |
| **Open World: Yes** | This tool configures Frihet to send HTTP POST requests to a user-specified external URL when subscribed business events occur (e.g. invoice.created, invoice.paid). Event data is sent to the external endpoint. |
| **Destructive: No** | This tool creates a new configuration. It does not delete existing data. The webhook can be deactivated or deleted later. |

### update_webhook

| Field | Justification |
|-------|---------------|
| **Read Only: No** | This tool modifies an existing webhook configuration (URL, events, active status). |
| **Open World: Yes** | This tool can change the external URL that receives webhook notifications from Frihet, redirecting event data to a different external endpoint. |
| **Destructive: No** | This tool modifies configuration but does not delete it. Changes are reversible by updating again. |

---

## EXCLUDED / HIDDEN TOOLS

OpenAI mode uses an explicit allowlist of the 53 business tools above. Everything else in the full MCP server is hidden from the ChatGPT app submission surface, including payroll, HR, lodging/POS, banking, e-invoicing, regulated filing/export workflows, time tracking, recurring invoices, gestoría bulk-send, permissions, onboarding, period-close tools, and all MCP prompts.

Explicit defense-in-depth exclusions:

- `get_quarterly_taxes` — returns tax filing data with government identifiers
- `get_invoice_einvoice` — returns e-invoice XML with regulated identifiers
