# Frihet ERP — Cursor plugin

Talk to your business from inside Cursor. Create invoices, log expenses, manage
clients, check cash flow and prepare quarterly taxes in natural language — backed
by the [Frihet](https://frihet.io) AI-native ERP.

## Included

- `mcp.json` — the Frihet MCP server (157 tools: invoicing, expenses, CRM, products,
  quotes, deposits, banking, fiscal compliance, e-invoicing, POS, stay/PMS, HR/payroll).
- `rules/frihet-fiscal.mdc` — Spanish & EU fiscal context so the agent picks the right
  VAT/IGIC rate, IRPF retención and tax model.
- `assets/logo.svg` — marketplace logo.

## Setup

1. Get an API key: log into [app.frihet.io](https://app.frihet.io) → **Settings → API → Create API key** (starts with `fri_`).
2. Set `FRIHET_API_KEY` in your environment. The bundled `mcp.json` reads it via `${FRIHET_API_KEY}`.

That's it — `npx @frihet/mcp-server` runs locally over stdio.

### Remote (zero install)

Prefer no local process? Point at the hosted endpoint instead of the npx command:

```json
{
  "mcpServers": {
    "frihet": {
      "type": "streamable-http",
      "url": "https://mcp.frihet.io/mcp",
      "headers": { "Authorization": "Bearer fri_your_key_here" }
    }
  }
}
```

Clients that support OAuth 2.1 + PKCE (browser login, no key) can connect to
`https://mcp.frihet.io/mcp` directly.

## Links

- Product: <https://frihet.io>
- Docs: <https://docs.frihet.io/desarrolladores/mcp-server>
- npm: [`@frihet/mcp-server`](https://www.npmjs.com/package/@frihet/mcp-server)
- Source: <https://github.com/Frihet-io/frihet-mcp>

MIT licensed.
