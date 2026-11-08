# Frihet ERP for Cursor

Enable AI-assisted financial operations, invoice drafting, and expense management directly inside [Cursor](https://www.cursor.com/) using the Model Context Protocol (MCP).

## Quick Setup

### 1. Configure MCP Server in Cursor
Open **Cursor Settings** > **Features** > **MCP Servers** > **Add New MCP Server**, or copy the included configuration to `.cursor/mcp.json` in your workspace root:

```json
{
  "mcpServers": {
    "frihet": {
      "command": "npx",
      "args": ["-y", "@frihet/mcp-server@latest"],
      "env": {
        "FRIHET_API_KEY": "YOUR_FRIHET_API_KEY"
      }
    }
  }
}
```

*Note: For remote streaming without local Node dependencies, configure the SSE endpoint:*
```json
{
  "mcpServers": {
    "frihet-remote": {
      "url": "https://mcp.frihet.io/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_FRIHET_API_KEY"
      }
    }
  }
}
```

### 2. Add Cursor Rules
Copy `.cursor/rules/frihet.mdc` into your project's `.cursor/rules/` directory to ground Cursor Composer and Cursor Agent in Frihet's fiscal invariants (draft-only safeguard, VAT regimes, NIF masking).

## Example Prompts in Cursor Composer & Agent

- **Monthly Health Check:**
  > "Using Frihet MCP, summarize our revenue, expenses, and pending VAT for this month."
- **Customer Lookup & Draft Invoicing:**
  > "Find client 'Acme Corp' in Frihet ERP and draft an invoice for 10 hours of software consulting at €95/hr with 21% IVA."
- **Expense Categorization:**
  > "List recent unreviewed expenses and verify if our hosting invoices are properly categorized."

## Safety Guarantees
- **Strict Draft Mode:** Any tool that creates an invoice defaults to `draft`.
- **Zero Irreversible Fiscal Submission:** Formal submission to tax authorities (VeriFactu, TicketBAI, AEAT) requires human confirmation in the Frihet ERP web application.
