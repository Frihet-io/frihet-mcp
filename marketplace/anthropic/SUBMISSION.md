# Anthropic Claude Connectors Directory — Submission Package

> **DO NOT SUBMIT — awaiting Viktor final OK.**
> Review this document fully, verify all checklist items, then submit manually at the URL below.

---

## Target Store

**Submission form:** https://claude.ai/settings/connectors (Claude.ai → Settings → Connectors → "Submit your connector")
**Directory listing (post-approval):** https://claude.ai/settings/connectors
**Announcement page:** https://www.anthropic.com/news/integrations
**Docs:** https://claude.com/docs/connectors/building/submission
**FAQ:** https://support.claude.com/en/articles/11596036-anthropic-connectors-directory-faq
**Review timeline:** ~2 weeks

---

## Form Fields (exact names + limits)

### Section 1 — Server Basics

| Field | Max | Value |
|-------|-----|-------|
| Server name | 80 chars | `Frihet ERP` |
| Short description | 80 chars | `AI-native ERP — invoicing, CRM, tax, banking, POS for Spain & EU.` |
| Long description | 1,000 chars | See below |
| Server identifier (MCP name) | — | `io.frihet/erp` |
| Server URL (remote endpoint) | — | `https://mcp.frihet.io/mcp` |
| npm package | — | `@frihet/mcp-server` |
| Version | — | `1.14.2` (GA / stable) |
| License | — | `MIT` |
| GitHub repository | — | `https://github.com/Frihet-io/frihet-mcp` |
| Homepage / docs | — | `https://docs.frihet.io/desarrolladores/mcp-server` |

**Long description (copy-paste ready, 701 chars):**

```
Frihet MCP Server connects your AI assistant to Frihet ERP — the AI-native business platform for freelancers and SMEs in Spain and the EU.

157 tools across 20+ domains: invoices, expenses, clients, CRM, quotes, deposits, banking, fiscal (Modelo 303/130/390/180/347/415/425/418), e-invoicing (XRechnung, Factur-X, FatturaPA, PEPPOL, Facturae, FACe, TicketBAI, KSeF), VeriFactu, IGIC/AIEM, corporate tax, GL audit, vacation rentals, POS, time tracking, HR, payroll, onboarding, period close, gestoria.

11 resources and 10 pre-built prompts (monthly-close, quarterly-tax-prep, year-end-close, cash-flow-forecast, invoice-aging-review and more).

Zero install: connect via the remote endpoint at mcp.frihet.io with OAuth 2.0 + PKCE or API key. Also available as npm @frihet/mcp-server for local stdio use.
```

---

### Section 2 — Authentication

| Field | Value |
|-------|-------|
| Auth type | OAuth 2.0 + PKCE (primary) + API key Bearer (fallback) |
| OAuth authorization URL | `https://mcp.frihet.io/oauth/authorize` |
| OAuth token URL | `https://mcp.frihet.io/oauth/token` |
| OAuth scopes | `read write` |
| Required redirect URIs to allowlist | `https://claude.ai/api/mcp/auth_callback` AND `https://claude.com/api/mcp/auth_callback` |
| API key env var (stdio) | `FRIHET_API_KEY` (format: `fri_*`) |
| Account creation URL | `https://app.frihet.io` |

---

### Section 3 — Tools & Resources

**Tool count:** 157 tools, 11 resources, 10 prompts

**Domains covered:**
- Invoices (12), Expenses (5), Clients (5), CRM/Contacts (3), CRM/Activities (2), CRM/Notes (3)
- Products (5), Quotes (6), Deposits (7), Vendors (5), Webhooks (6)
- E-Invoicing (10), Intelligence (4)
- Banking (5), Fiscal — Modelo 303/130/390/180/347/415/425/418 + VeriFactu + TicketBAI (8)
- Stay / Vacation Rentals (5), POS / Point-of-Sale (4)
- Time Tracking (6), Recurring Invoices (8), Team Management (4)
- HR (9), Payroll (2), Onboarding (2), Permissions (2), Period Close (3)
- Gestoria/Accountants (5), Audit GL (3), Portal Domain (3), Self-Onboard & VIES (2)
- IGIC / Canary Islands Tax (4), Corporate Tax IS (2), Bank Rules (2)

**Tool annotations (all tools comply):**
- Read-only tools (`list_*`, `get_*`, `search_*`): `readOnlyHint: true`
- Write tools (`create_*`, `update_*`, `delete_*`): `readOnlyHint: false`, `destructiveHint` set where applicable
- All tools return `outputSchema` — typed structured JSON, not prose

---

### Section 4 — Compliance & Privacy

| Field | Value |
|-------|-------|
| Privacy policy URL | `https://www.frihet.io/en/privacy` |
| Terms of service URL | `https://www.frihet.io/en/terms` |
| Data residency | EU (europe-west1, Frankfurt) |
| GDPR compliant | Yes — see privacy policy |
| Data stored | Tool inputs/outputs are not stored server-side beyond the API request lifecycle |
| Support email | `hola@frihet.io` |

---

### Section 5 — Documentation & Support

| Field | Value |
|-------|-------|
| Documentation URL | `https://docs.frihet.io/desarrolladores/mcp-server` |
| Setup guide | `https://docs.frihet.io/desarrolladores/mcp-server#install` |
| Changelog | `https://github.com/Frihet-io/frihet-mcp/blob/main/CHANGELOG.md` |
| GitHub issues | `https://github.com/Frihet-io/frihet-mcp/issues` |
| Support email | `hola@frihet.io` |

---

### Section 6 — Branding & Assets

| Asset | Path | Notes |
|-------|------|-------|
| Logo SVG (dark bg) | `~/Documents/frihet-mcp/assets/banner.svg` | Full banner |
| Logo SVG (light bg) | `~/Documents/frihet-mcp/assets/banner-light.svg` | Full banner |
| Logo square (for icon) | `~/Documents/Frihet-Saas-Website/public/favicon.svg` | Use as app icon |
| Favicon 32×32 | `~/Documents/Frihet-Saas-Website/public/favicon-32x32.png` | — |
| Favicon 16×16 | `~/Documents/Frihet-Saas-Website/public/favicon-16x16.png` | — |
| OG / promo image | `~/Documents/Frihet-Saas-Website/public/banners/frihet-banner-dev-github.png` | Use for marketplace banner |
| Dev-focused banner | `~/Documents/Frihet-Saas-Website/public/banners/frihet-banner-dev-twitter.png` | Social-sized promo |

**Screenshots to prepare (not yet created — Viktor action required):**
1. Claude Desktop / Claude Code: natural language invoice creation
2. Claude: quarterly tax prep (`quarterly-tax-prep` prompt)
3. Claude: client CRM activity log
4. Claude: banking transactions + categorization

---

### Section 7 — Test Credentials (required by Anthropic reviewers)

Viktor must create a dedicated test account before submission:
- Account: create at `https://app.frihet.io` (free plan is sufficient)
- API key: generate under **Settings > API**, format `fri_test_*`
- Populate with: 2–3 test clients, 3–5 draft invoices, 5 sample expenses
- Include in submission form under "Test account credentials"

---

## Verification Checklist

Before submitting:

- [ ] Server is publicly reachable: `curl -s https://mcp.frihet.io/mcp` returns valid MCP response
- [ ] OAuth redirect URIs include both `https://claude.ai/api/mcp/auth_callback` AND `https://claude.com/api/mcp/auth_callback`
- [ ] All 157 tools have `readOnlyHint` set correctly (verify in `src/tools/*.ts`)
- [ ] Privacy policy page is live at `https://www.frihet.io/en/privacy`
- [ ] Documentation page is live and public at `https://docs.frihet.io/desarrolladores/mcp-server`
- [ ] Test account created and credentials ready
- [ ] Logo/icon assets prepared at required sizes (see Section 6)
- [ ] Screenshots prepared (see Section 6)
- [ ] `server.json` description is ≤ 100 chars (verified: 87 chars on branch `fix/server-json-desc-100chars`)
- [x] Version is GA / stable (not `-beta`): `v1.14.2` published to npm — ready for the production directory

---

## Submission Order Recommendation

Submit Anthropic **last** among the three marketplaces. Reason: 2-week review cycle + production-readiness requirement. Ship Cursor and OpenAI first (faster turnaround), then submit Anthropic. The server is now GA (`v1.14.2`, 157 tools) so the production-readiness bar is met.

See `../README.md` for full submission sequencing.
