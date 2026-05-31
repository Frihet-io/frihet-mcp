# CLAUDE.md — Frihet MCP Server

See also: `SOUL.md` (symlink → `Frihet-ERP/SOUL.md`) for product voice, branding, V2 AI-distribution moat doctrine. `AGENTS.md` for build commands, multi-agent dispatch, LiteLLM cost rules. `~/SOUL.md` for Viktor's personal context.

## What is this

MCP server that connects AI assistants (Claude Code, Cursor, Copilot, Codex, Windsurf, Gemini CLI, ChatGPT Desktop) to Frihet ERP. Natural language → invoices, expenses, clients, fiscal reports.

**Live:**
- npm: https://www.npmjs.com/package/@frihet/mcp-server (v1.12.0-beta.1, 152 tools)
- MCP remote: https://mcp.frihet.io (Cloudflare Worker)
- Smithery: https://smithery.ai/server/frihet/frihet-mcp
- Anthropic registry: https://registry.modelcontextprotocol.io/?q=io.frihet
- License: MIT

**Repo:** `Frihet-io/frihet-mcp`
**Sister repos:** `berthelius/Frihet-ERP`, `berthelius/Frihet-Saas-Website`, `berthelius/frihet-docs`

---

## Stack

- Node.js >= 18
- TypeScript (strict, target ES2022)
- `@modelcontextprotocol/sdk` (peer dep)
- Zero runtime deps (only 1 in package.json — minimal surface)
- Distribution: npm + Cloudflare Worker (mcp.frihet.io) + Smithery
- Tests: native `node --test` runner

---

## V2 Brutal — north star (mayo 2026)

**This is the moat surface.** When a developer or agent asks "MCP for ERP / facturación / Spanish e-invoice", we want @frihet/mcp-server as the top result.

### Discoverability targets

| Channel | Status | Action |
|---|---|---|
| npm package | LIVE 152 tools | 110+ target exceeded; keep registry listings fresh |
| Smithery installs | LIVE | Track install rate weekly |
| MCP Registry (anthropic) | LIVE | Verify keep updated on major release |
| ChatGPT MCP marketplace | not submitted | Wave 4 submission |
| Cursor MCP marketplace | not submitted | Wave 4 submission |
| Claude Desktop MCP gallery | not submitted | Wave 4 submission |
| GitHub stars | track | Weekly update |
| `mcp.frihet.io/llms.txt` | ✓ 200 | Wave 1 DONE — inlined in Worker |
| `mcp.frihet.io/openapi.json` | ✓ 200 | Wave 1 DONE — proxies api.frihet.io |
| `mcp.frihet.io/.well-known/mcp` | ✓ 200 | Wave 1 DONE — inlined in Worker |
| `mcp.frihet.io/robots.txt` | ✓ 200 | Wave 1 DONE — inlined in Worker |
| `mcp.frihet.io/agents.json` | ✓ 200 | Wave 1 DONE — inlined in Worker |
| `mcp.frihet.io/releases.json` | ✓ 200 | Wave 1 DONE — ASSETS binding public/ |
| `api.frihet.io/llms.txt` | ✓ 200 | Wave 1 DONE — inlined in api-proxy |
| `api.frihet.io/agents.json` | ✓ 200 | Wave 1 DONE — inlined in api-proxy |
| `api.frihet.io/.well-known/mcp` | ✓ 200 | Wave 1 DONE — inlined in api-proxy |
| `api.frihet.io/robots.txt` | ✓ 200 | Wave 1 DONE — inlined in api-proxy |

**Wave 1 PR**: `feat(worker): static AI-discoverability surface` — SHIPPED (branch `feat/ai-surface`). Both workers now serve full AI-discoverability surface. Cloudflare Worker serves static files for crawlers AND handles MCP JSON-RPC for clients.

### Tool coverage targets (62 → 110+)

Current (v1.12.0-beta.1, 152 tools):

| File | Tools | Coverage |
|---|---|---|
| invoices | 12 | CRUD + send + pay + PDF + drafts |
| crm | 8 | activities + notes + leads |
| deposits | 7 | CRUD + apply + refund |
| quotes | 6 | CRUD + accept + convert |
| clients | 5 | CRUD + import |
| expenses | 5 | CRUD + OCR |
| products | 5 | CRUD + pricing |
| vendors | 5 | CRUD + sync |
| webhooks | 5 | CRUD + replay |
| einvoice | 4 | send + status + validate + DATEV (beta) |
| intelligence | 4 | summary + insights + anomalies + forecast |
| register-all | 3 | meta-tools |

**Missing for V2 (target 110+ tools)**:
- banking (5+): accounts list/get, tx list/categorize/match, payments send
- fiscal (8+): modelo 303/130/390/180/347, verifactu status/resubmit, ticketbai status/submit
- time (6+): timesheets CRUD + attendance checkin/out + projects
- recurring (4+): recurring_invoices CRUD + run_now + pause
- team (4+): members + roles + invites
- integrations (5+): list + connect + disconnect + run + status
- ai_copilot (3+): explain + suggest + optimize (meta-tools)
- webhooks v2 (3+): signing rotation + replay + filter expressions

Total V2 target: ~38 new tools across 8 new files. v2.0.0 release.

---

## Architecture

```
src/
  index.ts             — MCP server entry (Server + transport)
  client.ts            — Frihet API HTTP client (Bearer auth)
  client-interface.ts  — Typed interface for client mocking
  types.ts             — Shared TypeScript types
  logger.ts            — Structured logging
  observability.ts     — Langfuse LLM observability
  metrics.ts           — Tool call metrics
  openai-profile.ts    — OpenAI compatibility profile
  tools/
    register-all.ts    — Tool registration entry
    invoices.ts        — 12 invoice tools
    expenses.ts        — 5 expense tools
    clients.ts         — 5 client tools
    products.ts        — 5 product tools
    quotes.ts          — 6 quote tools
    crm.ts             — 8 CRM tools
    deposits.ts        — 7 deposit tools
    vendors.ts         — 5 vendor tools
    webhooks.ts        — 5 webhook tools
    einvoice.ts        — 4 einvoice tools (beta)
    intelligence.ts    — 4 AI insights tools
    shared.ts          — Cross-tool helpers
  resources/
    register-all.ts    — MCP resources (read-only context)
  prompts/
    register-all.ts    — MCP prompts (templated)
```

---

## Cross-references

- API client: hits `https://api.frihet.io/v1` (managed in `src/client.ts`)
- Auth: Bearer token from env `FRIHET_API_KEY` (format `fri_*`)
- Observability: Langfuse wired (env `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY`)
- Worker: `mcp.frihet.io` is Cloudflare Worker — separate deployment surface (NOT in this repo, see ops)

---

## Tool design pattern

Every tool follows this contract:

```typescript
server.registerTool(
  'frihet.invoices.create',
  {
    title: 'Create invoice',
    description: 'Create a new invoice for a client. Returns invoice ID + total + PDF URL.',
    inputSchema: { /* Zod or JSON schema */ },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (input) => {
    // 1. Validate input (Zod)
    // 2. Call Frihet API V1 via client
    // 3. Return structured output (NOT prose)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);
```

**Rules**:
- Tool name: `frihet.<resource>.<action>` (dot-separated, lowercase)
- `description` clear in 1 line, mentions input + output
- `inputSchema` strictly typed
- Output: structured JSON, NOT prose
- Idempotency where possible (use `Idempotency-Key` HTTP header)
- Errors: throw `McpError` with cause + suggestion

---

## Build & Test

```bash
npm run build          # tsc → dist/
npm test               # npm run build && node --test dist/__tests__/*.test.js
npm start              # node dist/index.js (local stdio)
npm publish --tag beta # publish beta
npm publish            # publish stable (v2.0.0+)
```

**Pre-publish checklist**:
- [ ] `npm run build` clean
- [ ] `npm test` all pass
- [ ] Tool count in README badge matches actual count
- [ ] CHANGELOG.md updated
- [ ] Version bumped (semver)
- [ ] Smoke test: install fresh from npm in temp dir + run

---

## Trust Areas

This repo is itself a Trust Area. Tool errors propagate to user agents which act on user's business data.

- **Idempotency** — every mutating tool MUST support `Idempotency-Key`. Test it.
- **Input validation** — strict Zod schemas. Reject ambiguous input rather than infer.
- **Auth scope** — tools must respect API key scope. No privilege escalation.
- **Rate limiting** — client-side backoff on 429. Don't burn user's quota.
- **PII** — never log full request bodies. Mask NIF/IBAN/email in logs.
- **Side effects** — destructive tools (delete, refund) need explicit confirmation pattern.

---

## V2 release plan

1. Sprint Wave 1 (this week): static AI surface for `mcp.frihet.io` Worker
2. Sprint Wave 2 (next week): banking + fiscal + time tool families (+25 tools)
3. Sprint Wave 3: recurring + team + integrations + ai_copilot + webhooks v2 (+13 tools)
4. v2.0.0 release: 110+ tools, OpenAPI v2 alignment, Langfuse instrumentation
5. Wave 4: marketplace submissions (Cursor, ChatGPT, Claude Desktop)

---

## Contact

**Owner:** Viktor / BRTHLS
**Sister projects:** see `Frihet-ERP/CLAUDE.md` for ERP, `Frihet-Saas-Website/CLAUDE.md` for marketing, `frihet-docs/CLAUDE.md` for docs.
