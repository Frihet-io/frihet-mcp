# Registry Submission Checklist

> **Version: 1.14.5 | Tools: 157 | Updated: 2026-06-23**
>
> Single source of truth for the submit session. Each section: exact URL, exact steps, what is prepared, what needs Viktor's login.
> Directory submits and the awesome-mcp PR require Viktor's GitHub/account identity — Claude Code cannot complete them.

---

## UTM scheme (all marketing links are tagged)

Every "Homepage" or "Website" field pointing to frihet.io in a marketplace form uses:

```
https://frihet.io/?utm_source=<dir>&utm_medium=mcp_directory&utm_campaign=mcp_landgrab
```

Where `<dir>` is one of: `glama`, `mcp_so`, `pulsemcp`, `cline`, `smithery`, `openai`, `anthropic`, `cursor`.

README hero links use: `utm_source=github_readme&utm_medium=mcp_readme&utm_campaign=mcp_landgrab`.

Functional URLs (endpoint, docs, login) are NOT UTM-tagged.

---

## 1. Glama (`glama.ai/mcp/servers`)

**Status:** `glama.json` at repo root is complete and updated (157 tools, v1.14.5, UTM homepage).

**Mechanism:** Glama auto-indexes from GitHub `glama.json`. Submit repo URL or wait for crawler.

**Manual step (Viktor):**
1. Go to: https://glama.ai/mcp/servers/submit
2. Enter repo URL: `https://github.com/Frihet-io/frihet-mcp`
3. Glama reads `glama.json` automatically
4. Verify listing shows 157 tools and v1.14.5

**In-repo artifact:** `glama.json` — ready.

---

## 2. mcp.so

**Status:** Auto-indexes from npm + GitHub. No manifest needed.

**Manual step (Viktor — only if not auto-indexed within ~48h of npm publish):**
1. Go to: https://mcp.so/submit
2. Enter: `https://github.com/Frihet-io/frihet-mcp` or `@frihet/mcp-server`
3. Verify listing shows 157 tools and correct description

**Homepage field:** `https://frihet.io/?utm_source=mcp_so&utm_medium=mcp_directory&utm_campaign=mcp_landgrab`

---

## 3. PulseMCP (`pulsemcp.com`)

**Status:** Indexes from npm + MCP Registry weekly. Should auto-appear.

**Manual step (Viktor — only if not auto-indexed within ~1 week):**
1. Go to: https://www.pulsemcp.com/submit
2. Enter npm package: `@frihet/mcp-server`
3. Optionally GitHub: `https://github.com/Frihet-io/frihet-mcp`

**Homepage field:** `https://frihet.io/?utm_source=pulsemcp&utm_medium=mcp_directory&utm_campaign=mcp_landgrab`

---

## 4. Cline (VS Code extension marketplace, MCP section)

**Status:** Not submitted. Cline reads `marketplace/llms-install.md` for copy-paste install steps.

**Manual step (Viktor):**
1. Go to: https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev
2. Submit via Cline's MCP server listing form or open a PR to their community MCP list
3. Use `marketplace/llms-install.md` as the install guide

**Homepage field:** `https://frihet.io/?utm_source=cline&utm_medium=mcp_directory&utm_campaign=mcp_landgrab`

**Install guide asset:** `marketplace/llms-install.md` — ready.

---

## 5. Smithery (`smithery.ai/server/frihet/frihet-mcp`)

**Status:** LIVE. Listed at https://smithery.ai/server/frihet/frihet-mcp.

**Action:** Track install rate weekly. Update description via Smithery dashboard if stale.

**Homepage field (when updating):** `https://frihet.io/?utm_source=smithery&utm_medium=mcp_directory&utm_campaign=mcp_landgrab`

---

## 6. awesome-mcp-servers (GitHub)

**Status:** Not submitted. PR content is ready in `marketplace/awesome-mcp-servers-PR.md`.

**Manual step (Viktor):**
1. Fork or branch: https://github.com/punkpeye/awesome-mcp-servers
2. Add the list line from `marketplace/awesome-mcp-servers-PR.md` in the correct alphabetical position under Finance & Fintech / Business
3. Open PR with title and body from `marketplace/awesome-mcp-servers-PR.md`

**In-repo artifact:** `marketplace/awesome-mcp-servers-PR.md` — ready (copy-paste title + body + list line).

---

## 7. OpenAI ChatGPT Apps

**Status:** Submission package ready in `marketplace/openai/SUBMISSION.md`.

**Manual step (Viktor — requires ChatGPT Developer Mode):**
1. Go to: https://chatgpt.com → Settings → Developer Mode → "Create App"
2. Verify domain token is deployed to `https://openai-mcp.frihet.io/.well-known/openai-domain-verification.txt`
3. Test full OAuth flow in Developer Mode first
4. Fill form using `marketplace/openai/SUBMISSION.md` as copy-paste reference
5. Homepage field: `https://frihet.io/?utm_source=openai&utm_medium=mcp_directory&utm_campaign=mcp_landgrab`

**In-repo artifact:** `marketplace/openai/SUBMISSION.md` — ready.

---

## 8. Cursor Marketplace

**Status:** Submission package ready in `marketplace/cursor/SUBMISSION.md`.

**Manual step (Viktor):**
1. Go to: https://cursor.com/marketplace/publish (or email `kniparko@anysphere.com`)
2. Fill form / attach `plugin.json` using `marketplace/cursor/SUBMISSION.md` as reference
3. Homepage field: `https://frihet.io/?utm_source=cursor&utm_medium=mcp_directory&utm_campaign=mcp_landgrab`
4. Also submit to community directories (instant, no review):
   - https://cursor.directory/mcp — "Add server" form
   - https://mcpcursor.com — submit via website

**In-repo artifact:** `marketplace/cursor/SUBMISSION.md` — ready.

---

## 9. Anthropic Claude Connectors Directory

**Status:** Submission package ready in `marketplace/anthropic/SUBMISSION.md`. Connector bundle spec in `marketplace/anthropic/connector/manifest.json` (v1.14.5).

**Review timeline:** ~2 weeks.

**Manual step (Viktor):**
1. Verify `https://mcp.frihet.io/mcp` is reachable with valid MCP JSON-RPC response
2. Verify OAuth redirect URIs include `https://claude.ai/api/mcp/auth_callback` AND `https://claude.com/api/mcp/auth_callback`
3. Pack bundle: `cd marketplace/anthropic/connector && zip -r frihet-erp-1.14.5.mcpb manifest.json`
4. Go to: https://claude.ai/settings/connectors → "Submit your connector"
5. Fill form using `marketplace/anthropic/SUBMISSION.md` as copy-paste reference
6. Homepage field: `https://frihet.io/?utm_source=anthropic&utm_medium=mcp_directory&utm_campaign=mcp_landgrab`
7. Upload `frihet-erp-1.14.5.mcpb` where the form requests a bundle

**In-repo artifacts:**
- `marketplace/anthropic/SUBMISSION.md` — ready (v1.14.5)
- `marketplace/anthropic/connector/manifest.json` — ready (v1.14.5, capabilities.tools=157)

---

## 10. MCP Registry (Anthropic official)

**Status:** LIVE at `registry.modelcontextprotocol.io/?q=io.frihet`. isLatest=true on v1.14.5.

**Action:** Keep `server.json` description ≤ 100 chars on future releases. No action needed now.

---

## Pre-submission checklist (all directories)

| Item | Status |
|------|--------|
| `https://mcp.frihet.io/mcp` reachable | Verify before each submit |
| 157 tools with `readOnlyHint` correctly set | Verified in src/tools/*.ts |
| `https://www.frihet.io/en/privacy` live | Must verify before Anthropic submit |
| `https://www.frihet.io/en/terms` live | Must verify before Anthropic submit |
| `https://docs.frihet.io/desarrolladores/mcp-server` live | Must verify |
| App icon 512×512 PNG | **TODO Viktor:** export `favicon.svg` → 512×512 PNG via `rsvg-convert` (see `marketplace/assets/ASSETS.md`) |
| App icon 128×128 PNG (Cursor) | **TODO Viktor:** export `favicon.svg` → 128×128 PNG |
| Screenshots (min 2, max 4 per marketplace) | **TODO Viktor:** capture per `marketplace/assets/ASSETS.md` guide |
| OAuth redirect URIs for each marketplace | Update in Frihet OAuth config before each submit |
| Test account at app.frihet.io with sample data | Create before Anthropic review |

---

## In-repo artifacts summary

| File | Version | Status |
|------|---------|--------|
| `glama.json` | 1.14.5 / 157 tools | Ready + UTM homepage |
| `marketplace/README.md` | 1.14.5 | Ready |
| `marketplace/anthropic/SUBMISSION.md` | 1.14.5 | Ready + UTM homepage |
| `marketplace/anthropic/connector/manifest.json` | 1.14.5 | Ready |
| `marketplace/anthropic/connector/README.md` | 1.14.5 | Ready |
| `marketplace/cursor/SUBMISSION.md` | 1.14.5 | Ready + UTM homepage (plugin.json) |
| `marketplace/openai/SUBMISSION.md` | current | Ready + UTM homepage |
| `marketplace/llms-install.md` | — | Created — Cline install guide |
| `marketplace/awesome-mcp-servers-PR.md` | — | Created — PR title/body/list line |
| `REGISTRY-SUBMISSION-CHECKLIST.md` | this file | Updated 2026-06-23 |
