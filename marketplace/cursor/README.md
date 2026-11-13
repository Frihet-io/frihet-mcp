# Frihet ERP for Cursor

The [Frihet Cursor plugin](../../plugins/frihet-erp/README.md) bundles the pinned
MCP server, eight business workflows and fiscal operating safeguards. Configure
its variables under **Plugins → Configure**. The plugin includes an explicit
synthetic demo mode; a live API key is unnecessary for that review.

## Manual MCP configuration

For a standalone connection instead of a plugin installation, copy
[`.cursor/mcp.json`](.cursor/mcp.json) to your project or user Cursor configuration.
It uses the same pinned `@frihet/mcp-server@2.0.2` version and Cursor's standalone
`${env:FRIHET_API_KEY}` environment-variable syntax. Keep the key outside the
repository and conversation. This path configures MCP only; it does not install
the plugin's skills or rules.

A manual demo connection needs no key:

```json
{
  "mcpServers": {
    "frihet-demo": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@frihet/mcp-server@2.0.2"],
      "env": {
        "FRIHET_DEMO": "1",
        "FRIHET_TOOL_MODE": "full",
        "FRIHET_API_KEY": ""
      }
    }
  }
}
```

The pinned version must be available on npm before installation. The local full
source profile contains 158 canonical operations and five aliases (163 tool
names). Demo uses fixed synthetic fixtures; exposed writes are simulations and
are not saved. For a read-only review, ask the agent to call reads only and apply
a host tool allowlist if supported.

## Example requests

- Summarize the selected workspace and month, with source coverage and separate currencies.
- Review pending invoices, inspect partial payments and credits, and report unknown balances.
- Review recent expenses for missing information without changing records or guessing tax treatment.

Check the connected schemas and permissions before any action. Invoice drafts,
email delivery, payment bookkeeping and fiscal acceptance are distinct outcomes.
A manual MCP test, a plugin installation, a directory listing and marketplace
approval each require their own evidence.
