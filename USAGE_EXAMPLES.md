# Frihet MCP usage examples

These examples show the intended interaction shape. Use your own authorized
workspace or the package's explicit local demo mode; never paste credentials or
customer data into public examples.

## Review unpaid invoices

Prompt: “Show my unpaid invoices and summarize the outstanding total.”

Expected routing: `list_invoices` with a supported status filter, followed by a
summary calculated from the returned structured data.

## Create a draft invoice

Prompt: “Create a draft invoice for 10 consulting hours at 80 EUR/hour.”

Expected routing: `create_invoice` with explicit line-item quantity/unit price.
The tool returns the structured draft; it does not send the invoice unless the
separate external action is requested.

## Record an expense

Prompt: “Record a 25 EUR office-supplies expense dated today.”

Expected routing: `create_expense` with the supported description, amount,
category, and date fields.

## Convert an accepted quote

Prompt: “Find my accepted quote for this client and prepare a matching draft
invoice.”

Expected routing: read the quote through `list_quotes`/`get_quote`, then ask for
confirmation before creating a separate invoice when appropriate. Do not invent
identifiers or values absent from the returned record.

The generated public-capability contract is authoritative for operation names,
callability, annotations, resources, prompts, and profile-specific exposure.
