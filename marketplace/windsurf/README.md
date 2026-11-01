# Frihet ERP for Windsurf (Codeium)

Connect Windsurf's Cascade AI agent to Frihet ERP using the Model Context Protocol (MCP) for AI-native invoicing, expense management, CRM, and fiscal operations.

## Configuration

### 1. Global MCP Configuration
Add the Frihet MCP server to your Windsurf configuration at `~/.codeium/windsurf/mcp_config.json`:

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

Or for remote streaming over SSE:

```json
{
  "mcpServers": {
    "frihet-remote": {
      "serverUrl": "https://mcp.frihet.io/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_FRIHET_API_KEY"
      }
    }
  }
}
```

### 2. Cascade Agent Rules
Copy [`.windsurfrules`](./.windsurfrules) into your project root as `.windsurfrules` to ground Cascade in Frihet's fiscal invariants (draft-only enforcement, Spanish VAT/IGIC regimes, PII masking).

## Example Prompts in Cascade

- **Monthly Health Check:**
  > "Using Frihet, summarize our quarterly taxes and monthly revenue for Q4."
- **Draft an Invoice:**
  > "Look up client 'Acme Innovations' and create a draft invoice for 20 hours of backend architecture consulting at €110/hr with 21% IVA."
- **Expense Categorization:**
  > "List unreviewed expenses from this month and verify if office supplies have proper deductibility assigned."

## Safety Guarantees
- **Draft-only mutations:** Tool calls default to `status: "draft"` preventing unintentional issuance.
- **Idempotency protection:** Mutations use UUIDv4 idempotency keys preventing duplicated records.
- **Zero data training:** Financial records are never used for AI model training.
