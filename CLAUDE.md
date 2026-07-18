# CLAUDE.md — Frihet MCP Server

Guidance for AI coding assistants working on this repository. See `AGENTS.md` for build commands and contribution conventions.

## What is this

MCP server that connects AI assistants (Claude Code, Cursor, Copilot, Codex, Windsurf, Gemini CLI, ChatGPT Desktop) to Frihet ERP. Natural language → invoices, expenses, clients, fiscal reports.

**Live:**
- npm: https://www.npmjs.com/package/@frihet/mcp-server (v1.16.0, 157 tools)
- MCP remote: https://mcp.frihet.io (Cloudflare Worker)
- Smithery: https://smithery.ai/server/frihet/frihet-mcp
- Anthropic registry: https://registry.modelcontextprotocol.io/?q=io.frihet
- License: MIT

**Repo:** `Frihet-io/frihet-mcp`

---

## Stack

- Node.js >= 18
- TypeScript (strict, target ES2022)
- `@modelcontextprotocol/sdk` (peer dep)
- Zero runtime deps (only 1 in package.json — minimal surface)
- Distribution: npm + Cloudflare Worker (mcp.frihet.io) + Smithery
- Tests: native `node --test` runner

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
    invoices.ts        — invoice tools
    expenses.ts        — expense tools
    clients.ts         — client tools
    products.ts        — product tools
    quotes.ts          — quote tools
    crm.ts             — CRM tools
    deposits.ts        — deposit tools
    vendors.ts         — vendor tools
    webhooks.ts        — webhook tools
    einvoice.ts        — e-invoice tools
    intelligence.ts    — AI insights tools
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
- Observability: Langfuse wired, optional (env `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY`) — see `docs/observability.md`
- Worker: `mcp.frihet.io` is a Cloudflare Worker — separate deployment surface (`workers/remote-mcp/`)

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
```

**Pre-publish checklist**:
- [ ] `npm run build` clean
- [ ] `npm test` all pass
- [ ] Tool count in README badge matches actual count
- [ ] CHANGELOG.md updated
- [ ] Version bumped (semver)
- [ ] Smoke test: install fresh from npm in temp dir + run

---

## Quality bar

Tool errors propagate to user agents which act on the user's business data — treat every change accordingly.

- **Idempotency** — every mutating tool MUST support `Idempotency-Key`. Test it.
- **Input validation** — strict Zod schemas. Reject ambiguous input rather than infer.
- **Auth scope** — tools must respect API key scope. No privilege escalation.
- **Rate limiting** — client-side backoff on 429. Don't burn the user's quota.
- **PII** — never log full request bodies. Mask NIF/IBAN/email in logs.
- **Side effects** — destructive tools (delete, refund) need an explicit confirmation pattern.

---

## Contact

**Maintainer:** Frihet (https://frihet.io) · support@frihet.io
