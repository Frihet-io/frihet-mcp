# Frihet ERP for Google Antigravity

Connect Google Antigravity (App, CLI, and IDE) to your [Frihet ERP](https://frihet.io) workspace. Manage invoices, quotes, expenses, clients, receivables, banking, and Spanish/EU fiscal compliance (VeriFactu, TicketBAI, Facturae) directly from your agent sessions.

## Included Components

- **Remote MCP Server (`frihet_erp`)** — Connects to `https://mcp.frihet.io/mcp` over Streamable HTTP with built-in OAuth 2.0 + PKCE browser sign-in (158 canonical operations across invoicing, quotes, expenses, CRM, products, banking, fiscal models, POS, hospitality PMS, and HR/time tracking).
- **8 Guided Skills**:
  - `/frihet-mcp` — General workspace operations, schema discovery, and multi-currency orchestration.
  - `/clientes` — Client CRM, contacts, notes, deduplication, and commercial follow-up.
  - `/cobros` — Pending and overdue receivables analysis by currency, partial-payment verification, and payment reminder drafting.
  - `/documentos` — Draft invoice and quote preparation with NIF/VAT, currency, and tax regime checks, plus timeout-safe recovery.
  - `/gastos` — Expense and vendor review, category/currency grouping, and duplicate detection.
  - `/operaciones` — Team, time tracking, leave requests, POS, kitchen, and hospitality operations.
  - `/revision-mensual` — Monthly billed, collected, outstanding, and expense reconciliation by currency.
  - `/tesoreria` — Bank account balances, transaction matching, and cash reconciliation.
- **Always-On Fiscal & Safety Rules (`rules/AGENTS.md`)** — Enforces the draft-only document creation invariant (`status: "draft"`), Spanish & EU indirect tax rules (IVA, IGIC, IPSI, IRPF withholding, VIES intra-community validation), and explicit human confirmation before irreversible actions.

## Getting Started

1. **Install the plugin** from **Customizations > Marketplace** in the Antigravity App (or via `/plugin` in the Antigravity CLI).
2. **Sign in with OAuth 2.0**: When the `frihet_erp` MCP server connects for the first time, Antigravity opens your browser to authenticate with your Frihet account (`https://app.frihet.io`). No manual API key copy-pasting is required.
3. **Run a starter prompt** from the plugin detail page or invoke `/cobros`, `/documentos`, or `/revision-mensual` in chat.

### Alternative: Local `stdio` with API Key

If you prefer running the local npm package (`@frihet/mcp-server`) with an API key from **Settings → API** in [app.frihet.io](https://app.frihet.io), you can configure `.agents/mcp_config.json`:

```json
{
  "mcpServers": {
    "frihet-local": {
      "command": "npx",
      "args": ["-y", "@frihet/mcp-server@latest"],
      "env": {
        "FRIHET_API_KEY": "fri_your_key_here"
      }
    }
  }
}
```

## Safety & Privacy Guarantees

- **Draft-Only Mutations:** Agent-created invoices, quotes, and credit notes default strictly to `draft` status. Irreversible fiscal submissions (AEAT VeriFactu, TicketBAI, FACe) and real-money movements require explicit human confirmation.
- **Idempotency Protection:** Mutating operations support UUIDv4 `Idempotency-Key` headers to prevent duplicate financial records on network retries.
- **Multi-Currency Accuracy:** Amounts are grouped and reconciled strictly per currency without silent conversion assumptions.

## Links

- **Website:** [https://frihet.io](https://frihet.io)
- **Documentation:** [https://docs.frihet.io/desarrolladores/mcp-server](https://docs.frihet.io/desarrolladores/mcp-server)
- **npm Package:** [`@frihet/mcp-server`](https://www.npmjs.com/package/@frihet/mcp-server)
- **Source Repository:** [https://github.com/Frihet-io/frihet-mcp](https://github.com/Frihet-io/frihet-mcp)
- **Support:** [hello@frihet.io](mailto:hello@frihet.io)
