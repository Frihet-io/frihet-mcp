# Official Model Context Protocol (MCP) Registry Submission

This folder documents Frihet ERP's integration with the official [MCP Registry](https://github.com/modelcontextprotocol/registry) managed by the Model Context Protocol Working Group (Anthropic, Stacklok, PulseMCP).

## Metadata Contract (`server.json`)

Frihet ERP provides a strictly validated metadata manifest in the repository root (`server.json`) conforming to schema `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.frihet/erp",
  "title": "Frihet ERP",
  "description": "Frihet ERP over MCP: invoices, quotes, expenses, clients, CRM, banking and Spanish tax summaries",
  "repository": {
    "url": "https://github.com/Frihet-io/frihet-mcp",
    "source": "github"
  },
  "websiteUrl": "https://www.frihet.io/en/mcp",
  "icons": [
    {
      "src": "https://www.frihet.io/logo.png",
      "mimeType": "image/png",
      "sizes": [
        "512x512"
      ],
      "theme": "light"
    },
    {
      "src": "https://www.frihet.io/brand/frihet-mark-white.svg",
      "mimeType": "image/svg+xml",
      "sizes": [
        "any"
      ],
      "theme": "dark"
    }
  ],
  "version": "2.0.0",
  "packages": [
    {
      "registryType": "npm",
      "identifier": "@frihet/mcp-server",
      "version": "2.0.0",
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
