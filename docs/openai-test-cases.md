# OpenAI App Submission — Test Cases

> Run ALL test cases on both **ChatGPT web** and **ChatGPT mobile** before submission.
> Endpoint: `https://openai-mcp.frihet.io/mcp` (OpenAI-safe profile)

## Prerequisites

- Deploy `openai-mcp.frihet.io` with `FRIHET_OPENAI_MODE=true`
- Verify OpenAI mode exposes 53 reviewed business tools + 3 read-only discovery meta-tools and 0 prompts
- Demo API key with sample data: invoices, expenses, clients, vendors, products, quotes
- Demo account must NOT require MFA or additional signup

---

## Test Case 1: Business Context (read-only, no PII)

**Tool:** `get_business_context`
**Input:** (none)
**Expected:**
- Returns business profile (company name, plan type, recent activity)
- Does NOT contain `taxId` or `secret` in the response
- No errors on web or mobile

**Verification:** Check response JSON has no `taxId` key at any nesting level.

---

## Test Case 2: List Clients (output redaction)

**Tool:** `list_clients`
**Input:** `{ "limit": 5 }`
**Expected:**
- Returns paginated list with `name`, `email`, `phone`, `address`
- `taxId` field is ABSENT from all client records
- Pagination metadata present (total, limit, offset)

**Verification:** `JSON.stringify(response).includes("taxId")` must be `false`.

---

## Test Case 3: Create Client (input stripped)

**Tool:** `create_client`
**Input:** `{ "name": "OpenAI Test Corp", "email": "test@openai-review.com" }`
**Expected:**
- Client created successfully
- `taxId` is NOT accepted as an input parameter (tool schema should not show it)
- Response contains `id`, `name`, `email` but NOT `taxId`

**Verification:** Try passing `taxId` — should be rejected or ignored.

---

## Test Case 4: Create Invoice

**Tool:** `create_invoice`
**Input:**
```json
{
  "clientName": "OpenAI Test Corp",
  "items": [{ "description": "Consulting", "quantity": 2, "unitPrice": 500 }],
  "taxRate": 21
}
```
**Expected:**
- Invoice created in `draft` status
- Returns `id`, `clientName`, `items`, `total`
- `total` calculated correctly (2 × 500 × 1.21 = 1210)
- `_suggestions` array present with next steps

---

## Test Case 5: List Invoices with Filters

**Tool:** `list_invoices`
**Input:** `{ "status": "draft", "limit": 10 }`
**Expected:**
- Returns only draft invoices
- Pagination works correctly
- No sensitive fields leaked

---

## Test Case 6: Send Invoice (openWorldHint: true)

**Tool:** `send_invoice`
**Input:** `{ "id": "<invoice_id_from_test_4>" }`
**Expected:**
- Invoice sent to the client's stored email
- `to` field is NOT available as input (stripped in OpenAI mode)
- Returns `{ success: true, id: "...", message: "..." }`

**Verification:** Tool description includes `[openWorldHint: true]` justification.

---

## Test Case 7: Monthly Summary (financial data)

**Tool:** `get_monthly_summary`
**Input:** `{ "month": "2026-03" }`
**Expected:**
- Returns revenue, expenses, profit, invoice stats
- No `taxId` in the response
- Financial totals are numeric values

---

## Test Case 8: Create and List Expenses

**Tool:** `create_expense`
**Input:** `{ "description": "Office supplies", "amount": 45.99, "category": "office" }`
**Expected:**
- Expense created with correct fields
- Tax deductible flag works

**Tool:** `list_expenses`
**Input:** `{ "limit": 5 }`
**Expected:**
- Returns paginated expenses
- No PII in expense records

---

## Test Case 9: Products CRUD (no PII)

**Tool:** `create_product`
**Input:** `{ "name": "Consulting Hour", "unitPrice": 150, "taxRate": 21 }`
**Expected:**
- Product created
- No sensitive fields (products have zero PII)

---

## Test Case 10: Webhook Management (openWorldHint: true, secret stripped)

**Tool:** `create_webhook`
**Input:**
```json
{
  "url": "https://httpbin.org/post",
  "events": ["invoice.created", "invoice.paid"]
}
```
**Expected:**
- Webhook created
- `secret` NOT accepted as input (stripped)
- `secret` NOT present in response (redacted)
- Tool description includes `[openWorldHint: true]` justification

**Tool:** `list_webhooks`
**Input:** `{ "limit": 10 }`
**Expected:**
- `secret` field ABSENT from all webhook records

---

## Test Case 11: Quotes Full Cycle

**Tool:** `create_quote` → `get_quote` → `send_quote`
**Input:** `{ "clientName": "Test Client", "items": [{ "description": "Design", "quantity": 1, "unitPrice": 3000 }] }`
**Expected:**
- Quote created in draft
- `send_quote` works WITHOUT `to` field (uses stored email)
- openWorldHint justification visible

---

## Test Case 12: Vendor Operations (taxId stripped)

**Tool:** `create_vendor`
**Input:** `{ "name": "Supplier X", "email": "supplier@test.com" }`
**Expected:**
- `taxId` NOT in input schema
- Vendor created
- Response has NO `taxId`

---

## Test Case 13: CRM Subcollections

**Tool:** `create_client_contact`
**Input:** `{ "clientId": "<id>", "name": "Maria Test", "email": "maria@test.com", "role": "CTO" }`
**Expected:**
- Contact created under client
- Returns `name`, `email`, `phone`, `role`

**Tool:** `log_client_activity`
**Input:** `{ "clientId": "<id>", "type": "call", "title": "Initial call" }`
**Expected:**
- Activity logged

**Tool:** `create_client_note`
**Input:** `{ "clientId": "<id>", "content": "Good prospect, follow up next week" }`
**Expected:**
- Note created

---

## Test Case 14: Hidden Surface Verification

**Expected ABSENT tools/prompts (must NOT appear in OpenAI mode):**
- `get_quarterly_taxes` — excluded (tax filing data)
- `get_invoice_einvoice` — excluded (e-invoice XML with NIFs)
- `send_einvoice`, `validate_einvoice_xml`, `einvoice_export`
- `frihet_tax_id_vies_lookup`
- `create_reservation`
- `payroll_export`
- `invite_team_member`
- All MCP prompts

**Expected PRESENT discovery tools:** `list_tool_groups`, `search_tools`, `describe_tool`.

**Verification:** Use `list_tools` / `list_prompts` or check the MCP session. OpenAI mode must expose 56 total tools: 53 reviewed business tools + the 3 read-only discovery meta-tools above, and 0 prompts.

---

## Test Case 15: Search and Pagination

**Tool:** `search_invoices`
**Input:** `{ "query": "Test", "limit": 5 }`
**Expected:**
- Returns matching invoices
- Pagination controls work
- No sensitive data leaked

---

## Summary Checklist

| # | Test | Validates |
|---|------|-----------|
| 1 | Business context | Output redaction, no PII |
| 2 | List clients | Output redaction (taxId stripped) |
| 3 | Create client | Input stripping (taxId removed) |
| 4 | Create invoice | Core CRUD, calculations |
| 5 | List invoices | Filtering, pagination |
| 6 | Send invoice | openWorldHint, `to` stripped |
| 7 | Monthly summary | Financial aggregates |
| 8 | Expenses | No PII in expenses |
| 9 | Products | Zero PII resource |
| 10 | Webhooks | openWorldHint, `secret` stripped I/O |
| 11 | Quotes | Full cycle, openWorldHint |
| 12 | Vendors | taxId stripped I/O |
| 13 | CRM | Contact/activity/note CRUD |
| 14 | Excluded tools | Quarterly taxes + e-invoice absent |
| 15 | Search | Pagination + text search |

**Total: 56 tools available (53 reviewed business tools + 3 read-only discovery meta-tools), 0 prompts, full-server tools hidden by allowlist, 0 government IDs in I/O, 0 credentials leaked.**
