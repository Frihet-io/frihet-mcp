# OpenAI ChatGPT Apps Marketplace — Submission Package

> **DO NOT SUBMIT — awaiting Viktor final OK.**
> Review this document fully, verify all checklist items (especially domain verification), then submit manually via ChatGPT Developer Mode.

---

## Target Store

**Developer Mode (build & test):** https://chatgpt.com (Settings → Developer Mode → "Create App")
**Submission flow:** https://developers.openai.com/apps-sdk/deploy/submission
**MCP docs:** https://developers.openai.com/api/docs/mcp
**Auth docs:** https://developers.openai.com/apps-sdk/build/auth
**Help Center:** https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta

**Note:** As of December 17, 2025, OpenAI renamed "connectors" to "apps". Existing functionality unchanged.

---

## Form Fields

### Section 1 — App Basics

| Field | Max | Value |
|-------|-----|-------|
| App name | 60 chars | `Frihet` |
| Short description (tagline) | 120 chars | `Manage invoices, expenses, clients, products, quotes, and webhooks through ChatGPT.` |
| Long description | 2,000 chars | See below |
| Category | — | `Finance & Accounting` |
| App icon URL | — | `https://frihet.io/favicon.svg` |
| Homepage | — | `https://frihet.io/?utm_source=openai&utm_medium=mcp_directory&utm_campaign=mcp_landgrab` |
| Developer name | — | `BRTHLS / Viktor` |
| Developer email | — | `hola@frihet.io` |
| Privacy policy URL | — | `https://www.frihet.io/en/privacy` |
| Terms of service URL | — | `https://www.frihet.io/en/terms` |
| Support URL | — | `https://docs.frihet.io/desarrolladores/mcp-server` |

**Long description (copy-paste ready, 790 chars):**

```
Frihet connects ChatGPT directly to your business workspace.

Create invoices by describing what you sold. Log expenses in plain language. Look up clients, products, vendors, quotes, and monthly business summaries. Keep routine admin moving from inside ChatGPT without switching tabs.

The ChatGPT app exposes a reviewed OpenAI-safe surface for invoices, expenses, clients, CRM contacts/activities/notes, products, quotes, vendors, monthly summaries, and webhook management. It includes 53 reviewed business tools plus 3 read-only discovery tools (`list_tool_groups`, `search_tools`, `describe_tool`) that help ChatGPT select the right capability without exposing hidden product modules.

Regulated identifiers, banking identifiers, webhook signing secrets, recipient override emails, payroll/HR, lodging/POS, banking, and regulated filing/export workflows are outside the ChatGPT surface.

Connect via OAuth 2.0 in seconds. No API key required.

Frihet is built for freelancers and small businesses that want AI-native business management.
```

---

### Section 2 — MCP Server Configuration

| Field | Value |
|-------|-------|
| MCP server URL | `https://openai-mcp.frihet.io/mcp` |
| Transport type | `streamable-http` |
| Authentication type | OAuth 2.0 + PKCE |
| Authorization endpoint | `https://openai-mcp.frihet.io/authorize` |
| Token endpoint | `https://openai-mcp.frihet.io/token` |
| Dynamic client registration | `https://openai-mcp.frihet.io/register` |
| Scopes | `read write` |

**Required: Add OpenAI's redirect URI to your OAuth config before submitting.**
OpenAI's callback URL (exact value provided during submission — add it alongside existing claude.ai callbacks).

---

### Section 3 — Domain Verification

OpenAI verifies domain ownership before publishing. The verification flow:

1. OpenAI provides a token (e.g., `abc123xyz789`) during submission
2. You must serve it at: `GET https://openai-mcp.frihet.io/.well-known/openai-apps-challenge`
3. Response must be **plain text** (not JSON, not HTML) — just the token string
4. OpenAI pings immediately on form submission — deploy the file BEFORE clicking submit

**Current `.well-known` routes on the Worker:**

The Worker already has an `openai-apps-challenge` route. Replace the token in `workers/remote-mcp/src/index.ts` with the current token OpenAI provides during submission, then deploy `--env openai` BEFORE submitting:

```typescript
// In the Cloudflare Worker (wrangler.toml / src/index.ts), add:
if (url.pathname === '/.well-known/openai-apps-challenge') {
  return new Response('OPENAI_TOKEN_GOES_HERE', {
    headers: { 'Content-Type': 'text/plain' }
  });
}
```

Replace `OPENAI_TOKEN_GOES_HERE` with the actual token OpenAI provides during submission. Deploy to Cloudflare before clicking submit.

**Alternative:** If OpenAI verifies a different host from the MCP URL, put the same challenge route on that host too. The intended OpenAI host is `openai-mcp.frihet.io`.
Reference: https://community.openai.com/t/chatgpt-app-submissions-domain-verification-step-does-not-support-subpath-hosted-mcp-servers/1379021

---

### Section 4 — OAuth Technical Requirements

OpenAI enforces strict OAuth 2.1 compliance. Verify before submitting:

**Required in authorization server metadata (`/.well-known/oauth-authorization-server`):**
```json
{
  "code_challenge_methods_supported": ["S256"],
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"],
  "token_endpoint_auth_methods_supported": ["none"]
}
```

**Critical:** If `code_challenge_methods_supported` is missing or doesn't include `S256`, ChatGPT will reject the OAuth flow with "unsupported OAuth config type". This is a hard block.

**OpenAI's OAuth state parameter** is 400+ chars of base64-encoded JSON. Ensure the OAuth state handler on `openai-mcp.frihet.io` accepts long state values (no length truncation).

---

### Section 5 — Branding & Assets

| Asset | Path | Notes |
|-------|------|-------|
| App icon (512×512 PNG) | `~/Documents/Frihet-Saas-Website/public/favicon.svg` | Export to PNG 512×512 |
| Hero image (1280×720) | `~/Documents/Frihet-Saas-Website/public/banners/frihet-banner-business-og.png` | Business-focused |
| LinkedIn banner | `~/Documents/Frihet-Saas-Website/public/banners/frihet-banner-business-linkedin.png` | Business audience |

**Screenshots to prepare (Viktor action required):**
1. ChatGPT: `"Show me all unpaid invoices"` → structured table response
2. ChatGPT: `"Create an invoice for Acme SL, 5 hours consulting at 100/h"` → invoice created
3. ChatGPT: `"Summarize my revenue and expenses for March 2026"` → monthly summary
4. ChatGPT: `"Log a 89 EUR expense for Adobe CC, category software"` → expense logged

---

### Section 6 — Compliance & Privacy

| Field | Value |
|-------|-------|
| Data storage | Per-request only — no persistent storage of user data server-side |
| Data residency | EU (europe-west1) |
| GDPR | Yes — see `https://www.frihet.io/en/privacy` |
| PII handling | API key / Bearer token transmitted in headers only. No PII logged. |
| EU users | Yes — primary market (Spain + EU) |

---

## Test Account (required for OpenAI review)

OpenAI reviewers will test the app end-to-end using OAuth flow:
- Create a test account at `https://app.frihet.io`
- Ensure it has: 2–3 clients, 3–5 invoices (mix of paid/unpaid/overdue), 5 expenses
- Include credentials in the submission form under "Test account"

---

## Verification Checklist

Before submitting:

- [ ] `https://openai-mcp.frihet.io/mcp` is reachable with valid MCP response
- [ ] OAuth metadata at `https://openai-mcp.frihet.io/.well-known/oauth-authorization-server` includes `code_challenge_methods_supported: ["S256"]`
- [ ] `FRIHET_OPENAI_MODE=true` is active and exposes 53 reviewed business tools + 3 read-only discovery meta-tools
- [ ] MCP prompts are hidden in OpenAI mode
- [ ] `/.well-known/openai-apps-challenge` route added to Worker (deploy BEFORE submitting)
- [ ] OpenAI redirect URI added to OAuth allowlist (exact URI provided by OpenAI during submission)
- [ ] OAuth state parameter handler accepts strings of 400+ chars (no truncation)
- [ ] Privacy policy live at `https://www.frihet.io/en/privacy`
- [ ] Terms of service live at `https://www.frihet.io/en/terms`
- [ ] App icon (512×512 PNG) prepared from `favicon.svg`
- [ ] Screenshots prepared (min 2)
- [ ] Test account created and credentials ready
- [ ] Worker deployed with domain verification token BEFORE clicking submit

---

## Pre-Submission Testing in Developer Mode

Test the full flow in ChatGPT before submitting:
1. Go to https://chatgpt.com → Settings → Developer Mode → "Create App"
2. Paste MCP URL: `https://openai-mcp.frihet.io/mcp`
3. Complete OAuth flow (should redirect to `openai-mcp.frihet.io/authorize` → Frihet login → back to ChatGPT)
4. Test 5 representative tools: `list_invoices`, `create_invoice`, `list_expenses`, `get_business_context`, `create_quote`
5. Verify structured JSON responses, not prose
6. Only submit after all 5 pass

---

## Submission Order Recommendation

Submit OpenAI **second** — after Cursor (faster, lower bar) but before Anthropic (longest review). OAuth domain verification adds complexity; allow 1–2 days for preparation.

See `../README.md` for full submission sequencing.
