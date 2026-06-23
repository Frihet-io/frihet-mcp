# Frihet MCP Server — Install Guide for AI Coding Assistants

> Machine-readable install guide. Tested with Cline, Cursor, Windsurf, Claude Code, Codex CLI, and Copilot.

## Option A — Remote endpoint (zero install, recommended)

No local dependencies. Runs on Cloudflare Workers. Supports OAuth 2.0 + PKCE or API key.

### With API key

```json
{
  "mcpServers": {
    "frihet": {
      "type": "streamable-http",
      "url": "https://mcp.frihet.io/mcp",
      "headers": {
        "Authorization": "Bearer fri_your_key_here"
      }
    }
  }
}
```

### With OAuth 2.0 + PKCE (browser login, no API key needed)

Clients that support OAuth (Claude Desktop, Smithery, Cline with OAuth support) connect directly:

- MCP server URL: `https://mcp.frihet.io/mcp`
- Auth type: OAuth 2.0 + PKCE
- Authorization URL: `https://mcp.frihet.io/oauth/authorize`
- Token URL: `https://mcp.frihet.io/oauth/token`
- Scopes: `read write`

The server advertises its OAuth metadata at `https://mcp.frihet.io/.well-known/oauth-authorization-server`.

---

## Option B — npm (local stdio)

Requires Node.js >= 18. No global install needed via `npx`.

```bash
npx -y @frihet/mcp-server
```

Set the API key via environment variable:

```bash
export FRIHET_API_KEY=fri_your_key_here
```

### Config file (all tools use the same JSON structure)

```json
{
  "mcpServers": {
    "frihet": {
      "command": "npx",
      "args": ["-y", "@frihet/mcp-server"],
      "env": {
        "FRIHET_API_KEY": "fri_your_key_here"
      }
    }
  }
}
```

| Tool | Config file path |
|------|-----------------|
| Claude Code | `~/.claude/mcp.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `.cursor/mcp.json` or `~/.cursor/mcp.json` |
| Windsurf | `~/.windsurf/mcp.json` |
| Cline | VS Code settings → Cline MCP Servers, or `.cline/mcp.json` |
| Codex CLI | `~/.codex/config.toml` (MCP section) |
| Copilot | `.vscode/mcp.json` (VS Code MCP support) |

---

## Get your API key

1. Sign up or log in at [app.frihet.io](https://app.frihet.io)
2. Go to **Settings > API**
3. Click **Create API key**
4. Copy the key (starts with `fri_`) — shown once

---

## Verify the connection

After installing, ask your AI assistant:

```
"List my most recent invoices"
```

Expected: structured list with invoice IDs, clients, amounts, and status.

---

## What you get

157 tools across 20+ domains: invoices, expenses, clients, CRM, quotes, deposits, banking, fiscal (Modelo 303/130/390/180/347/415/425/418), e-invoicing (XRechnung, Factur-X, FatturaPA, PEPPOL, Facturae, FACe, TicketBAI, KSeF), VeriFactu, IGIC/AIEM, corporate tax, GL audit, vacation rentals, POS, time tracking, HR, payroll, onboarding, period close, gestoria.

11 resources (read-only context) and 10 pre-built prompts (monthly-close, quarterly-tax-prep, year-end-close, cash-flow-forecast, invoice-aging-review, and more).

---

## Links

- Homepage: https://frihet.io
- Docs: https://docs.frihet.io/desarrolladores/mcp-server
- npm: https://www.npmjs.com/package/@frihet/mcp-server
- Remote endpoint: https://mcp.frihet.io
- GitHub: https://github.com/Frihet-io/frihet-mcp
- MCP Registry: https://registry.modelcontextprotocol.io/?q=io.frihet
