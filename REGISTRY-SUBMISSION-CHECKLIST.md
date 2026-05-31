# Registry Submission Checklist

Artifacts for mcp.so, PulseMCP, and Glama are prepared in this branch.
The steps below require Viktor's account/login — Claude Code cannot complete them.

---

## 1. Glama (`glama.ai/mcp/servers`)

**What was prepared:** `glama.json` at repo root is now complete (name, title, description, license, categories, npm, remote, repository, maintainers).

**Submission mechanism:** Glama auto-indexes from GitHub. The `glama.json` manifest at repo root is the trigger. After merging this PR + npm publish, submit via the Glama web form OR wait for their crawler.

**Manual step:**
1. Go to: https://glama.ai/mcp/servers/submit (or https://glama.ai/mcp/servers — look for "Submit server" button)
2. Enter repo URL: `https://github.com/Frihet-io/frihet-mcp`
3. Glama will auto-read `glama.json` from the root and populate the listing
4. Verify the listing shows 152 tools and correct description

---

## 2. mcp.so

**Submission mechanism:** mcp.so auto-indexes from the npm registry and GitHub. No manifest file needed. Listings are auto-generated from `package.json` metadata (name, description, keywords, repository, homepage) and the GitHub README.

**Manual step (if not auto-indexed within ~48h of npm publish):**
1. Go to: https://mcp.so/submit (or look for "Add server" / "Submit" on homepage)
2. Enter: `https://github.com/Frihet-io/frihet-mcp` or `@frihet/mcp-server`
3. Verify listing shows correct tool count and description

**Keywords added to package.json** (`hr`, `payroll`, `vacation-rental`, `spanish-tax`, `e-invoicing`) improve mcp.so category matching.

---

## 3. PulseMCP (`pulsemcp.com`)

**Submission mechanism:** PulseMCP indexes from the npm registry (weekly crawl) and the official Anthropic MCP Registry. No separate manifest needed. Since `@frihet/mcp-server` is already on npm AND on `registry.modelcontextprotocol.io`, it should auto-appear after their next crawl.

**Manual step (if not auto-indexed within ~1 week):**
1. Go to: https://www.pulsemcp.com/submit (check homepage for submission form)
2. Enter npm package: `@frihet/mcp-server`
3. Optionally enter GitHub: `https://github.com/Frihet-io/frihet-mcp`
4. Verify listing appears with correct metadata

---

## 4. MCP Registry (Anthropic) — already live, version sync needed

The server is already live at `registry.modelcontextprotocol.io/?q=io.frihet`.
`server.json` has been updated to v1.12.0-beta.1 with 152 tools.

**Manual step to sync the registry entry:**
1. If the registry auto-syncs from GitHub, merge this PR — done.
2. If it requires a PR to https://github.com/modelcontextprotocol/registry:
   - Check if there's an existing entry at `servers/io.frihet-erp/`
   - Update the entry to reference v1.12.0-beta.1 and point to updated `server.json`
   - Open a PR to that repo

---

## Summary of in-repo artifacts prepared

| File | Change |
|------|--------|
| `glama.json` | Full metadata (was stub with only `maintainers`) |
| `server.json` | Tool count 127→152, version 1.10.0-beta.4→1.12.0-beta.1 |
| `package.json` | Description 133→152 tools; added keywords for discoverability |
| `README.md` | Badge 127→152; all tool sections complete (was missing 10 sections); Distribution table updated |
| `src/tools/register-all.ts` | Stale comments 127/133→152 |
