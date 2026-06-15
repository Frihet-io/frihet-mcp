# Marketplace Submission Packages

> **DO NOT SUBMIT anything here without Viktor's explicit OK.**
> Each `SUBMISSION.md` file is a complete, copy-paste-ready package — not a trigger to submit.

Wave Mature 3 — prepared May 2026.

---

## Status

| Marketplace | Package | Status | Priority |
|-------------|---------|--------|----------|
| Cursor Marketplace | `cursor/SUBMISSION.md` | Ready — submit first | HIGH |
| OpenAI ChatGPT Apps | `openai/SUBMISSION.md` | Ready — submit second | HIGH |
| Anthropic Claude Directory | `anthropic/SUBMISSION.md` | Ready — submit last (~2wk review) | HIGH |

---

## Recommended Submission Order

**1. Cursor (submit first)**
- Fastest review cycle, community-driven
- Lower technical bar (no OAuth domain verification required)
- Use as messaging test run before higher-stakes submissions
- URL: https://cursor.com/marketplace/publish
- Also submit in parallel to cursor.directory/mcp and mcpcursor.com (community directories, instant)

**2. OpenAI ChatGPT Apps (submit second)**
- Requires domain verification token deployed to Worker BEFORE submitting
- OAuth must include `code_challenge_methods_supported: ["S256"]`
- Test full OAuth flow in Developer Mode first
- URL: https://chatgpt.com → Settings → Developer Mode → "Create App"

**3. Anthropic Claude Directory (submit last)**
- ~2 week review cycle
- Strictest requirements: production-ready, full OAuth, tool annotations, privacy policy live
- Requires `-beta` version dropped OR explicitly noted
- URL: https://claude.ai/settings/connectors
- Submission form: https://claude.com/docs/connectors/building/submission

---

## Pre-Submission Checklist (all three)

- [ ] `https://mcp.frihet.io/mcp` reachable with valid MCP response
- [ ] `server.json` description ≤ 100 chars (PR #fix/server-json-desc-100chars merged)
- [ ] All 151 tools have `readOnlyHint` correctly set
- [ ] `https://www.frihet.io/en/privacy` live
- [ ] `https://www.frihet.io/en/terms` live
- [ ] `https://docs.frihet.io/desarrolladores/mcp-server` live and public
- [ ] Test account created at app.frihet.io with sample data
- [ ] App icon 512×512 PNG exported from favicon.svg
- [ ] Min 2 screenshots per marketplace prepared
- [ ] OAuth redirect URIs updated for each marketplace's callback URL

---

## Assets

All visual assets are documented in `assets/ASSETS.md`.
No binary files are stored in this repo — assets live in `Frihet-Saas-Website/public/`.

---

## Also Relevant (already live or separate submissions)

| Platform | Status | Action needed |
|----------|--------|---------------|
| Anthropic MCP Registry (`registry.modelcontextprotocol.io`) | LIVE — `io.frihet/erp` | Keep `server.json` updated on releases |
| Smithery | LIVE — `smithery.ai/server/frihet/frihet-mcp` | Track install rate weekly |
| npm | LIVE — `@frihet/mcp-server` v1.13.0 | Current stable |
| Glama / mcpservers.org | Not verified | Submit separately (15min) |
| PulseMCP | Not verified | Submit separately (15min) |
| mcp.so | Not verified | Submit separately (15min) |
| LobeHub MCP | Not verified | Submit separately (15min) |
| Docker MCP Catalog | Not submitted | Wave 4 (requires Dockerfile) |

Full distribution roadmap: `../DISTRIBUTION-ROADMAP.md`
