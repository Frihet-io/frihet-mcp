# Official Model Context Protocol (MCP) Registry Submission

This folder documents Frihet ERP's integration with the official [MCP Registry](https://github.com/modelcontextprotocol/registry) managed by the Model Context Protocol Working Group (Anthropic, Stacklok, PulseMCP).

## Metadata Contract (`server.json`)

Frihet ERP provides a strictly validated metadata manifest in the repository root (`server.json`) conforming to schema `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.frihet/erp",
  "title": "Frihet ERP",
  "description": "AI-native ERP MCP: ES/EU fiscal compliance (VeriFactu/TicketBAI/Facturae), invoicing, tax, banking",
  "repository": {
    "url": "https://github.com/Frihet-io/frihet-mcp",
    "source": "github"
  },
  "version": "1.18.0",
  "packages": [
    {
      "registryType": "npm",
      "identifier": "@frihet/mcp-server",
      "version": "1.18.0",
      "transport": {
        "type": "stdio"
      }
    }
  ],
  "remotes": [
    {
      "type": "streamable-http",
      "url": "https://mcp.frihet.io/mcp"
    }
  ]
}
```

## Validation Status

Validated with official `mcp-publisher`:
```bash
mcp-publisher validate
# Output:
# Validating against https://registry.modelcontextprotocol.io...
# ✅ server.json is valid
```

## Publication Instructions

To publish new releases to the public MCP Registry:
```bash
# 1. Login via GitHub or Domain ownership (DNS/HTTP)
mcp-publisher login github

# 2. Publish manifest
mcp-publisher publish server.json
```
