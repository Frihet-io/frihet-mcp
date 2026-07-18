# Frihet API Patterns & Error Reference

Technical reference for working with the Frihet MCP server tools. Covers rate limits, pagination, error handling, and response conventions.

## MCP Tool Inventory

### Invoices (6 tools)

| Tool | Parameters | Notes |
|------|-----------|-------|
| `list_invoices` | `offset`, `limit`, `status`, `clientId`, `dateFrom`, `dateTo` | Default limit 20. Paginated. |
| `get_invoice` | `id` (required) | Returns full invoice with line items |
| `create_invoice` | `clientId`, `items[]`, `notes`, `dueDate`, `series` | Items: `{productId?, description, quantity, price, taxRate}` |
| `update_invoice` | `id` (required), partial fields | Cannot update if status is `paid` or `cancelled` |
| `delete_invoice` | `id` (required) | Only `draft` invoices can be deleted. Others must be cancelled. |
| `search_invoices` | `query`, `offset`, `limit` | Searches across number, client name, notes |

### Expenses (5 tools)

| Tool | Parameters | Notes |
|------|-----------|-------|
| `list_expenses` | `offset`, `limit`, `category`, `dateFrom`, `dateTo` | Default limit 20 |
| `get_expense` | `id` (required) | |
| `create_expense` | `description`, `amount`, `date`, `category`, `taxAmount`, `supplier` | Category: one of 8 values |
| `update_expense` | `id` (required), partial fields | |
| `delete_expense` | `id` (required) | |

### Clients (5 tools)

| Tool | Parameters | Notes |
|------|-----------|-------|
| `list_clients` | `offset`, `limit`, `search` | |
| `get_client` | `id` (required) | Returns full client with address, fiscal zone |
| `create_client` | `name`, `taxId`, `email`, `phone`, `address`, `fiscalZone` | fiscalZone: peninsula/canarias/ceuta_melilla/eu/world |
| `update_client` | `id` (required), partial fields | |
| `delete_client` | `id` (required) | Cannot delete if has invoices. Archive instead. |

### Products (5 tools)

| Tool | Parameters | Notes |
|------|-----------|-------|
| `list_products` | `offset`, `limit`, `search` | |
| `get_product` | `id` (required) | |
| `create_product` | `name`, `price`, `taxRate`, `description`, `unit` | unit: "unit", "hour", "kg", etc. |
| `update_product` | `id` (required), partial fields | |
| `delete_product` | `id` (required) | Cannot delete if used in invoices |

### Quotes (5 tools)

| Tool | Parameters | Notes |
|------|-----------|-------|
| `list_quotes` | `offset`, `limit`, `status`, `clientId` | |
| `get_quote` | `id` (required) | |
| `create_quote` | `clientId`, `items[]`, `notes`, `validUntil` | Same items format as invoices |
| `update_quote` | `id` (required), partial fields | |
| `delete_quote` | `id` (required) | Only draft quotes |

### Webhooks (5 tools)

| Tool | Parameters | Notes |
|------|-----------|-------|
| `list_webhooks` | `offset`, `limit` | |
| `get_webhook` | `id` (required) | |
| `create_webhook` | `url`, `events[]` | Events: invoice.created, invoice.paid, expense.created, etc. |
| `update_webhook` | `id` (required), partial fields | |
| `delete_webhook` | `id` (required) | |

## Pagination

All list endpoints return paginated results:

```json
{
  "data": [...],
  "pagination": {
    "offset": 0,
    "limit": 20,
    "total": 142
  }
}
```

**Best practices:**
- Default `limit` is 20. Max is 100.
- For "list all" requests, paginate with a loop: increment `offset` by `limit` until `offset >= total`.
- For "last N" requests, use `limit: N` with `offset: 0` (results are sorted newest first by default).
- When calculating totals across all records (e.g., monthly close), fetch ALL pages.

## Rate Limits

- **Standard:** 60 requests per minute per API key
- **Burst:** Up to 10 requests in 1 second
- **Rate limit response:** HTTP 429 with `Retry-After` header (seconds)
- **Strategy:** If 429, wait `Retry-After` seconds, then retry. Max 3 retries.

**Practical guidance:**
- Normal skill operations (5-10 tool calls) will never hit rate limits.
- Batch operations (importing many expenses, listing all invoices for a year) may hit limits.
- For batch imports: process in chunks of 10, with a brief pause between chunks.

## Error Codes

### HTTP Status Codes

| Code | Meaning | Skill Action |
|------|---------|-------------|
| 200 | Success | Process response |
| 201 | Created | Confirm creation to user |
| 400 | Bad Request | Check required fields, validate data format |
| 401 | Unauthorized | API key invalid/expired. Direct to app.frihet.io > Settings > API |
| 403 | Forbidden | Insufficient permissions. Check plan limits. |
| 404 | Not Found | Resource doesn't exist. Suggest search instead. |
| 409 | Conflict | Duplicate or state conflict (e.g., deleting non-draft invoice) |
| 422 | Unprocessable | Validation error. Check field-level errors in response body. |
| 429 | Rate Limited | Auto-retry with backoff per Retry-After header |
| 500 | Server Error | Transient. Retry once. If persists, report to support@frihet.io |

### Common Validation Errors (422)

| Field | Error | Fix |
|-------|-------|-----|
| `taxId` | "Invalid NIF/CIF format" | Validate: NIF = 8 digits + letter, CIF = letter + 7 digits + letter |
| `email` | "Invalid email format" | Check for typos |
| `items` | "At least one item required" | Add items array with at least one line item |
| `amount` | "Must be positive" | Ensure amount > 0 |
| `date` | "Invalid date format" | Use ISO 8601: YYYY-MM-DD |
| `category` | "Invalid category" | Must be: general, office, travel, food, professional, marketing, technology, vehicle |

### MCP-Specific Errors

| Error | Cause | Fix |
|-------|-------|-----|
| "MCP server not found" | `@frihet/mcp-server` not configured | Add to mcp.json, run `/frihet setup` |
| "Tool not found: frihet_*" | MCP server not started or crashed | Restart Claude Code or check MCP logs |
| "Connection refused" | MCP server process died | `npx @frihet/mcp-server` to test manually |
| "FRIHET_API_KEY not set" | Missing env var in MCP config | Add to mcp.json env block |
| "Timeout" | API response took too long | Retry. If persistent, check Frihet status page. |

## Response Formatting Conventions

### Amounts

- Always EUR. No other currencies.
- Format: `1,234.56 EUR` — dot for decimals, comma for thousands.
- Right-align in tables.
- Show 2 decimal places always, even for round numbers: `100.00 EUR` not `100 EUR`.

### Dates

- Display to user: `DD/MM/YYYY` (Spanish convention) or localized to user's language.
- Send to API: `YYYY-MM-DD` (ISO 8601).
- Relative dates OK in conversation: "hace 3 días", "next Monday".

### IDs

- Frihet IDs are UUIDs. Show them only when needed (for update/delete operations).
- Prefer invoice/quote numbers (e.g., `#FRI-2026-0042`) for display.

### Status Labels

| API Status | Spanish Display | English Display |
|-----------|----------------|-----------------|
| `draft` | BORRADOR | DRAFT |
| `sent` | ENVIADA | SENT |
| `paid` | PAGADA | PAID |
| `overdue` | VENCIDA | OVERDUE |
| `cancelled` | ANULADA | CANCELLED |
| `accepted` | ACEPTADO | ACCEPTED |
| `rejected` | RECHAZADO | REJECTED |
| `expired` | EXPIRADO | EXPIRED |

### Webhook Events

| Event | When |
|-------|------|
| `invoice.created` | New invoice created |
| `invoice.sent` | Invoice marked as sent |
| `invoice.paid` | Invoice marked as paid |
| `invoice.overdue` | Invoice past due date |
| `invoice.cancelled` | Invoice cancelled |
| `expense.created` | New expense logged |
| `client.created` | New client added |
| `quote.created` | New quote created |
| `quote.accepted` | Quote marked as accepted |

## API Base URLs

- **Production API:** `https://api.frihet.io/v1/`
- **MCP Remote:** `https://mcp.frihet.io` (SSE transport, OAuth 2.0 + PKCE)
- **App:** `https://app.frihet.io`
- **Docs:** `https://docs.frihet.io/desarrolladores`

Note: When using the MCP server locally (`npx @frihet/mcp-server`), it handles all API communication. You never call the API directly — the MCP tools are your interface.
