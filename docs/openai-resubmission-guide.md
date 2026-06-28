# OpenAI App Re-Submission Guide

> Addresses all 5 rejection points from the OpenAI review email.

## Status Summary

| # | Issue | Status | Action |
|---|-------|--------|--------|
| 1 | Developer name mismatch | **MANUAL** | Viktor: platform.openai.com/settings |
| 2 | openWorldHint wrong | **DONE** | 4 tools corrected + justifications |
| 3 | Test cases failing | **READY** | 15 test cases documented |
| 4 | Privacy policy gaps | **DONE** | Section 10 added (11 sections, 17 langs) |
| 5 | Sensitive data collection | **DONE** | OpenAI allowlist enforced: 53 reviewed business tools + 3 read-only discovery meta-tools, prompts/resources hidden, restricted fields redacted |

---

## Issue 1: Developer Name

**What to do:** Go to https://platform.openai.com/settings

- If publishing as individual: verify name matches "Victor Berthelius Pato"
- If publishing as business: complete business verification for "Frihet"

**Note:** Only organization owners can complete verification.

---

## Issue 2: openWorldHint Annotations

**Fixed in:** `src/openai-profile.ts`

| Tool | openWorldHint | Justification |
|------|:---:|---|
| `send_invoice` | `true` | Triggers email delivery to client's external email |
| `send_quote` | `true` | Triggers email delivery to client's external email |
| `create_webhook` | `true` | Configures Frihet to POST data to external URL |
| `update_webhook` | `true` | Can modify the external URL receiving notifications |
| All other 49 tools | `false` | Operate within Frihet's closed API (api.frihet.io) |

Justifications are embedded in tool descriptions as `[openWorldHint: true — ...]`.

---

## Issue 3: Test Cases

**Document:** `docs/openai-test-cases.md`

15 test cases covering all tool categories. Must pass on both ChatGPT web AND mobile.

**Pre-requisites:**
1. Deploy `openai-mcp.frihet.io` (see Deploy section below)
2. Ensure demo API key has sample data
3. Run each test case sequentially, verify expected output

---

## Issue 4: Privacy Policy

**Updated:** `src/i18n/*.json` (all 17 languages) + `privacy.astro` (date → 2026-04-03)

**New Section 10: "AI, API, and Developer Integrations"** covers:
- API and MCP server as data access surfaces
- Complete list of data categories accessible via tools
- Data minimization in OpenAI/third-party integrations (taxId excluded)
- AI processing disclosure (Google Gemini, not for training)
- OAuth token lifecycle (1h access, 30d refresh)
- Explicit "no training on your data" statement

**Also updated:**
- Section 2: Added "Business data" category (client/vendor records, invoices, etc.)
- Section 5: Added OpenAI and Google Gemini as data recipients
- `ai-plugin.json`: Changed `legal_info_url` from `/legal` to `/en/privacy`

**Privacy URL for submission:** `https://www.frihet.io/en/privacy`

---

## Issue 5: Sensitive Data Collection

**Fixed in:** `src/openai-profile.ts` — activated by `FRIHET_OPENAI_MODE=true`

### OpenAI-visible tool surface

OpenAI mode now enforces an explicit allowlist of 53 reviewed business tools. The live grouped ChatGPT surface also includes 3 read-only discovery meta-tools (`list_tool_groups`, `search_tools`, `describe_tool`) whose catalog is pinned to that same 53-tool allowlist. The full MCP server can keep growing for Claude, Cursor, Windsurf, Cline, Codex, and direct MCP clients without automatically broadening the ChatGPT submission surface.

Hidden from OpenAI mode:
- Payroll, HR, stay/PMS, POS, banking, e-invoicing XML, VIES lookup, VeriFactu/FACe/TicketBAI/KSeF submission, time tracking, recurring invoices, gestoria bulk-send, permissions, onboarding, and period-close tools.
- All MCP prompts and resources, because several prompt/resource templates reference tools, fields, or modules that are intentionally hidden from OpenAI mode.
- `get_quarterly_taxes` and `get_invoice_einvoice`, retained as explicit exclusions for defense in depth.

### Input fields removed (8 tools)
| Field | Tools | Reason |
|-------|-------|--------|
| `taxId` | create/update client, create/update vendor | Government-issued identifier |
| `to` | send_invoice, send_quote | Don't solicit email — use stored |
| `secret` | create/update webhook | Auth credential |

### Output fields redacted (ALL tools)
| Field | Redacted from |
|-------|---------------|
| `taxId` | structuredContent + display text |
| `secret` | structuredContent + display text |
| `idDocument` / `passport` / `dni` / `nationalId` | structuredContent + display text |
| `apiKey` / tokens / password-like fields | structuredContent + display text |
| `requestId` / `traceId` / `sessionId` / `userId` / `verifactuHash` | structuredContent + display text |

Deep recursive redaction ensures nested objects and paginated arrays are clean.

### Regression test

`npm test` now includes `dist/__tests__/openai-profile.test.js`, which asserts:
- OpenAI mode exposes 56 total tools: 53 reviewed business tools + 3 read-only discovery meta-tools.
- OpenAI mode exposes 0 prompts and 0 resources.
- Sensitive/newer full-server tools are not visible.
- Only `send_invoice`, `send_quote`, `create_webhook`, and `update_webhook` have `openWorldHint: true`.
- Restricted input/output fields are stripped/redacted.

---

## Deploy Checklist

### 1. DNS (Cloudflare)

Add a proxied record for `openai-mcp.frihet.io`:

```
CNAME  openai-mcp  mcp.frihet.io  (proxied)
```

Or use a dummy A record (Cloudflare will route via Worker):
```
A  openai-mcp  192.0.2.1  (proxied)
```

### 2. Copy secrets to OpenAI env

```bash
cd ~/Documents/frihet-mcp/workers/remote-mcp

# List current secrets
wrangler secret list

# Copy each to the openai env
wrangler secret put COOKIE_ENCRYPTION_KEY --env openai
wrangler secret put FRIHET_OAUTH_API_KEY --env openai
wrangler secret put FIREBASE_PROJECT_ID --env openai
```

### 3. Deploy

```bash
# Deploy the OpenAI-safe worker
wrangler deploy --env openai

# Verify
curl https://openai-mcp.frihet.io/health
curl https://openai-mcp.frihet.io/.well-known/openai-apps-challenge
```

### 4. Website deploy (auto on push)

```bash
cd ~/Documents/Frihet-Saas-Website
git add -A && git commit -m "Update privacy policy for OpenAI app submission"
git push origin main  # Vercel auto-deploys
```

### 5. Verify privacy policy

```bash
curl -s https://www.frihet.io/en/privacy | grep -c "AI, API, and Developer"
# Should return 1
```

### 6. Submit

1. Go to https://platform.openai.com/apps
2. Update MCP endpoint to `openai-mcp.frihet.io/mcp`
3. Update privacy policy URL to `https://www.frihet.io/en/privacy`
4. Run test cases (docs/openai-test-cases.md) on ChatGPT web + mobile
5. Submit for review

---

## Architecture: Full vs OpenAI-safe

```
┌─────────────────────────────────────────┐
│         Frihet MCP Server               │
│         (149+ tools, MIT)               │
│                                         │
│  ┌──────────────┐  ┌────────────────┐   │
│  │ mcp.frihet.io│  │openai-mcp.     │   │
│  │ (full)       │  │frihet.io       │   │
│  │              │  │(OpenAI-safe)   │   │
│  │ Full surface │  │ 53 business    │   │
│  │              │  │ + 3 discovery  │   │
│  │ All fields   │  │ No taxId       │   │
│  │ All data     │  │ No secret      │   │
│  │              │  │ No quarterly   │   │
│  │              │  │ No einvoice    │   │
│  │ Claude       │  │ ChatGPT        │   │
│  │ Cursor       │  │                │   │
│  │ Windsurf     │  │                │   │
│  │ Cline        │  │                │   │
│  │ Codex        │  │                │   │
│  └──────────────┘  └────────────────┘   │
│                                         │
│  Same codebase, same Worker, same DO    │
│  Difference: FRIHET_OPENAI_MODE=true    │
│  + explicit 53-tool business allowlist  │
└─────────────────────────────────────────┘
```
