# Cursor Marketplace — Submission Package

> **DO NOT SUBMIT — awaiting Viktor final OK.**
> Review this document fully, verify checklist items, then submit via the paths listed below.

---

## Target Store

**Primary submission URL:** https://cursor.com/marketplace/publish
**Marketplace listing (post-approval):** https://cursor.com/marketplace
**Cursor plugin spec (GitHub):** https://github.com/cursor/plugins
**Plugin template:** https://github.com/cursor/plugin-template
**Blog / announcement:** https://cursor.com/blog/marketplace
**Docs:** https://cursor.com/docs/plugins

**Contact for submission:** Submit via the publish form, or email `kniparko@anysphere.com` with repo link and description.

---

## Context: Cursor Plugin Architecture

Cursor plugins bundle primitives that agents use:
- **MCP servers** — connect to external tools and APIs
- **Skills** — domain-specific prompts and instructions
- **Rules** — system-level instructions
- **Subagents** — specialized parallel agents
- **Hooks** — custom scripts for observing agent behavior

A Frihet submission is primarily an **MCP server plugin** with an optional **Skill** bundled.

---

## Form Fields (cursor.com/marketplace/publish)

| Field | Max | Value |
|-------|-----|-------|
| Plugin name | 60 chars | `Frihet ERP` |
| Tagline / short description | 100 chars | `AI-native ERP — 111 tools for invoicing, CRM, tax & banking via natural language.` |
| Long description | 2,000 chars | See below |
| Category | — | `Finance & Accounting` (primary) / `Business Tools` (secondary) |
| GitHub repository | — | `https://github.com/Frihet-io/frihet-mcp` |
| Homepage | — | `https://frihet.io` |
| Documentation URL | — | `https://docs.frihet.io/desarrolladores/mcp-server` |
| npm package | — | `@frihet/mcp-server` |
| Remote MCP URL | — | `https://mcp.frihet.io/mcp` |
| License | — | `MIT` |
| Contact email | — | `hola@frihet.io` |

**Long description (copy-paste ready, 721 chars):**

```
Frihet MCP Server connects Cursor directly to your Frihet ERP account.

Talk to your business in natural language from inside Cursor. Create invoices, log expenses, manage clients, check cash flow, prepare quarterly taxes — all without leaving the editor.

111 tools across invoicing, CRM, products, quotes, expenses, banking, fiscal compliance (Modelo 303/130/390/180/347, VeriFactu, TicketBAI), e-invoicing (PEPPOL, XRechnung, FatturaPA, Factur-X, Facturae), vacation rental management (Stay), point-of-sale, time tracking, recurring invoices, and team management.

Zero install — connect via the remote endpoint at mcp.frihet.io with OAuth or API key. Also available as npx @frihet/mcp-server for local stdio transport.

Works with the free Frihet plan. Get an API key at app.frihet.io.
```

---

## Cursor MCP Configuration (for .cursor/mcp.json)

**Option A — Remote (zero install, recommended):**

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

**Option B — Local stdio:**

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

---

## Plugin Manifest (plugin.json — required for Cursor marketplace bundles)

```json
{
  "name": "frihet-erp",
  "version": "1.10.0-beta.2",
  "displayName": "Frihet ERP",
  "description": "AI-native ERP — 111 tools for invoicing, CRM, tax & banking via natural language.",
  "icon": "https://frihet.io/favicon.svg",
  "homepage": "https://frihet.io",
  "repository": "https://github.com/Frihet-io/frihet-mcp",
  "license": "MIT",
  "categories": ["Finance & Accounting", "Business Tools"],
  "mcp": {
    "servers": [
      {
        "name": "frihet",
        "transport": "streamable-http",
        "url": "https://mcp.frihet.io/mcp",
        "auth": {
          "type": "bearer",
          "env": "FRIHET_API_KEY"
        }
      }
    ]
  },
  "skills": [
    {
      "name": "frihet",
      "path": "./skill"
    }
  ]
}
```

> Note: The `skill/` directory already exists in the repo at `~/Documents/frihet-mcp/skill/`. Bundle it with the plugin manifest.

---

## Branding & Assets

| Asset | Path | Notes |
|-------|------|-------|
| Plugin icon (SVG) | `~/Documents/Frihet-Saas-Website/public/favicon.svg` | Monochrome preferred |
| Plugin icon (PNG 128×128) | `~/Documents/Frihet-Saas-Website/public/favicon-32x32.png` | Upscale to 128×128 for submission |
| Banner image | `~/Documents/Frihet-Saas-Website/public/banners/frihet-banner-dev-github.png` | 1280×640 dev-focused |
| Dev banner (Twitter/X size) | `~/Documents/Frihet-Saas-Website/public/banners/frihet-banner-dev-twitter.png` | 1500×500 |
| Bluesky banner | `~/Documents/Frihet-Saas-Website/public/banners/frihet-banner-dev-bluesky.png` | — |

**Screenshots to prepare (Viktor action required):**
1. Cursor agent: `"Create an invoice for Acme SL, 10h consulting at 95/h"` → invoice created response
2. Cursor agent: `"Show me all overdue invoices"` → structured list
3. Cursor agent: `"What's my quarterly tax liability for Q1 2026?"` → Modelo 303 breakdown

---

## Alternative: cursor.directory Listing

In addition to the official Cursor Marketplace, also submit to:
- **cursor.directory/mcp**: Community-curated MCP server directory for Cursor users
  - URL: https://cursor.directory/mcp
  - Process: Submit via the site's "Add server" form
- **MCPCursor**: https://mcpcursor.com — submit via website

These are independent community directories and can be submitted **before** the official marketplace.

---

## Verification Checklist

Before submitting:

- [ ] `https://mcp.frihet.io/mcp` is reachable (returns MCP protocol response)
- [ ] `plugin.json` created in repo root or `marketplace/cursor/plugin.json` (copy template above)
- [ ] Skill directory (`skill/`) is present and functional: `ls ~/Documents/frihet-mcp/skill/`
- [ ] npm package `@frihet/mcp-server` is latest published version
- [ ] Icon at `https://frihet.io/favicon.svg` returns valid SVG
- [ ] Screenshots prepared (min 2, max 5)
- [ ] No beta version in plugin.json displayName unless explicitly noted
- [ ] Email `hola@frihet.io` is monitored for Cursor review communications
- [ ] README includes Cursor-specific install badge and `.cursor/mcp.json` config snippet (already in main README)

---

## Submission Order Recommendation

Submit Cursor **first** — fastest review cycle, community-driven, lower bar than Anthropic. Use as a test run for messaging before Anthropic review.

See `../README.md` for full submission sequencing.
