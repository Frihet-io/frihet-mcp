# Frihet ERP — Claude Connector Bundle (DXT / .mcpb)

> DO NOT SUBMIT — awaiting Viktor final OK.

This directory contains the connector manifest for the Anthropic Claude Connectors Directory submission.

## What is here

- `manifest.json` — MCP Bundle manifest (DXT spec, `server.schema.json` 2025-12-11). Describes both the remote streamable-HTTP endpoint (OAuth 2.0 + PKCE) and the local stdio entrypoint (npm).

## How to pack into a .mcpb and submit

A `.mcpb` is a ZIP archive renamed to `.mcpb`. The archive must contain at minimum `manifest.json` at the root. For the remote-only variant no server binary is needed.

```bash
# From this directory:
cd ~/Documents/frihet-mcp/marketplace/anthropic/connector

# Pack: zip then rename extension
zip -r frihet-erp-1.14.5.mcpb manifest.json

# Verify well-formed JSON before packing
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest.json OK')"
```

## Submission steps (gated — Viktor must approve)

1. Verify `https://mcp.frihet.io/mcp` is reachable with a valid MCP JSON-RPC response.
2. Verify OAuth redirect URI `https://claude.ai/api/mcp/auth_callback` AND `https://claude.com/api/mcp/auth_callback` are in the Frihet OAuth allowlist.
3. Create a test account at `https://app.frihet.io` with sample clients/invoices/expenses.
4. Pack the bundle: `zip -r frihet-erp-1.14.5.mcpb manifest.json`
5. Go to `https://claude.ai/settings/connectors` → "Submit your connector"
6. Fill in the form using `SUBMISSION.md` (parent directory) as the copy-paste reference.
7. Upload `frihet-erp-1.14.5.mcpb` where the form requests a bundle.
8. Expect ~2 week review cycle (per Anthropic FAQ).

## Alternatively: submit as a remote MCP connector without bundle

Anthropic's claude.ai connectors directory also accepts remote MCP servers directly (URL-only submission, no .mcpb required). In that case:

- MCP server URL: `https://mcp.frihet.io/mcp`
- Auth: OAuth 2.0 + PKCE
- No bundle needed — submit URL + OAuth config via the form at `https://claude.ai/settings/connectors`

The manifest.json here serves as a self-contained spec and future registry artifact regardless of submission path.

## Notes on the DXT / MCPB format

- The `.mcpb` format is a ZIP archive with `manifest.json` at root (plus optional server binary + deps for local servers).
- For a remote server like Frihet (hosted at mcp.frihet.io), the manifest is self-sufficient — no binary needed.
- For a local stdio entrypoint, reference the npm package `@frihet/mcp-server` via the `packages` array (already in manifest.json).
- MCP Registry (`registry.modelcontextprotocol.io`) also accepts `.mcpb` packages under `registryType: "mcpb"` in `server.json`. Requires a SHA-256 hash of the artifact.
- Docs: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2025-11-20-adopting-mcpb.md
