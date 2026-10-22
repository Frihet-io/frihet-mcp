# Frihet ERP connector manifest

`manifest.json` is the public connector manifest for the Frihet ERP MCP server.
Its public identity is `io.frihet/erp`; the remote MCP endpoint is
`https://mcp.frihet.io/mcp`, and the local package is `@frihet/mcp-server`.

The manifest is descriptive metadata, not proof of provider approval or current
deployment. Operational packaging, submission credentials, test accounts, and
provider configuration are intentionally not documented in this repository.

The dedicated Claude Directory submission uses `https://claude-mcp.frihet.io/mcp`
and a separately bounded catalogue. Its current submission status is documented
in [`../SUBMISSION.md`](../SUBMISSION.md); do not overwrite this general MCP
manifest with Claude-specific endpoints or tool counts.
