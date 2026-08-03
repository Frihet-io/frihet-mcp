# OpenAI ChatGPT Apps Marketplace — Submission Package

> **DO NOT SUBMIT — draft correction in progress.**
> The 2026-07-28 rejection was caused by a mismatch between the selected verified
> individual and the Plugin Author field. The corrected draft must also pass the
> live runtime preflight below before the owner submits it.

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
| Subtitle | 30 chars | `Manage business operations` |
| Long description | 2,000 chars | See below |
| Category | — | `Business & Operations` |
| Developer Identity | — | `Individual — VICTOR BERTHELIUS PATO` |
| Plugin Author | — | `VICTOR BERTHELIUS PATO` (must exactly match the selected verified identity) |
| Website | — | `https://www.frihet.io` |
| Privacy policy URL | — | `https://www.frihet.io/en/privacy` |
| Terms of service URL | — | `https://www.frihet.io/en/terms` |
| Support URL | — | `https://docs.frihet.io/en/desarrolladores/mcp-server` |
| Demo Recording URL | — | `https://youtu.be/3_6mrhTvIEA` |

**Long description (copy-paste ready):**

```
Frihet connects ChatGPT to your business workspace. Create and update invoices, log expenses, manage clients, contacts, products, quotes, vendors, and webhooks, and review monthly business summaries without switching tabs.

Ask in plain language to find records, prepare draft invoices and quotes, mark invoices paid, or send documents to a client's saved email address. Mutating and external actions remain explicit and reviewable.

This ChatGPT integration uses a deliberately limited business-management surface. It does not expose government identifiers, banking data, payroll or HR records, accommodation or POS data, webhook secrets, or regulated filing and export workflows.

Sign in with OAuth 2.0 using an existing Frihet account. No API key is required. Frihet is an AI-native business operating system for organizations that want to run a connected business without operational friction.
```

**Public prompts configured in the portal:**

1. `Show me my unpaid invoices.`
2. `Summarize this month's revenue and expenses.`
3. `Log a €49 software expense for today.`

**Release notes:**

```
Initial release. 56 MCP tools for invoices, expenses, clients, contacts, products, quotes, vendors, webhooks, and business summaries. OAuth 2.0 sign-in; sensitive regulatory, banking, payroll, POS, accommodation, and secret-bearing workflows are excluded.
```

The Global section contains exactly 17 locales: English (US), Spanish (Spain),
Portuguese (Brazil), French (France), German, Italian, Japanese, Swedish,
Norwegian Bokmål, Danish, Finnish, Dutch, Turkish, Polish, Romanian, Greek, and
Hungarian. Every translation describes the limited reviewed surface, its
exclusions, and OAuth 2.0 sign-in; do not add a blank English duplicate or
Portuguese (Portugal).

### Developer identity and ownership evidence

- Select the already verified individual shown by OpenAI as
  `Individual — VICTOR BERTHELIUS PATO`.
- Set `Plugin Author` to `VICTOR BERTHELIUS PATO`, character-for-character.
- Keep `Frihet` as the app name/brand; do not use it as the legal author unless a
  business named Frihet is separately verified in the same OpenAI organization.
- Before submission, confirm the public Privacy and Terms pages identify the same
  legal owner. Do not assert a different business entity in the form.

### Commerce & Purchasing

| Field | Answer |
|-------|--------|
| Links or directs users out of ChatGPT to make purchases | **No** |
| Facilitates purchases of digital goods, services, or subscriptions | **No** |
| Shows pricing, upgrade prompts, checkout links, or payment instructions | **No** |

The app authenticates an existing Frihet account. It does not sell or promote a
Frihet subscription, initiate checkout, or direct users to upgrade from ChatGPT.
Do not enter SaaS plans in the “products you intend to sell” field; that field is
only applicable when the first commerce checkbox is selected.

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
| Directory icon — dark (512×512 PNG) | `marketplace/openai/frihet-directory-dark.png` | White Frihet disc with the same optical padding as the light icon |
| Composer icon — light (512×512 PNG) | `marketplace/openai/frihet-composer.png` | Black Frihet disc on a transparent canvas |
| Composer icon — dark (512×512 PNG) | `marketplace/openai/frihet-composer-dark.png` | White Frihet disc on a transparent canvas |
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
| Data residency | Google Cloud, EU-US Data Privacy Framework certified — compute in europe-west1 (Belgium); primary database in the US (Firestore nam5) |
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

- [ ] Developer Identity is `Individual — VICTOR BERTHELIUS PATO`
- [ ] Plugin Author is exactly `VICTOR BERTHELIUS PATO`
- [ ] Website, Privacy, Terms, and Support URLs return 200 to the reviewer
- [ ] Commerce purchase-link checkbox is **not** selected
- [ ] `https://openai-mcp.frihet.io/mcp` is reachable with valid MCP response
- [ ] `https://openai-mcp.frihet.io/health` returns HTTP 200 with `status: ok`
- [ ] OAuth metadata at `https://openai-mcp.frihet.io/.well-known/oauth-authorization-server` includes `code_challenge_methods_supported: ["S256"]`
- [ ] `FRIHET_OPENAI_MODE=true` is active and exposes 53 reviewed business tools + 3 read-only discovery meta-tools
- [ ] MCP prompts and resources are hidden in OpenAI mode
- [ ] `/.well-known/openai-apps-challenge` route added to Worker (deploy BEFORE submitting)
- [ ] OpenAI redirect URI added to OAuth allowlist (exact URI provided by OpenAI during submission)
- [ ] OAuth state parameter handler accepts strings of 400+ chars (no truncation)
- [ ] Privacy policy live at `https://www.frihet.io/en/privacy`
- [ ] Terms of service live at `https://www.frihet.io/en/terms`
- [x] Dark directory icon (512×512 PNG) prepared with light-icon geometry parity
- [x] Transparent composer icons (512×512 PNG) prepared separately for light and dark ChatGPT themes
- [x] Exactly 17 intended locales configured, including Portuguese (Brazil)
- [x] Three public prompts configured
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

## Submission stop condition

Do not click Submit while any required URL is non-2xx, OAuth/test-account flows
have not passed, identity and author differ, or the commerce answers describe a
digital subscription purchase. A rejected version is evidence, not a template to
resubmit unchanged.
