# CLAUDE.md — Frihet MCP Server

Guidance for AI coding assistants working on this repository. See `AGENTS.md` for build commands and contribution conventions.

## What is this

MCP server that connects AI assistants (Claude · ChatGPT · Cursor · Windsurf · Cline · Antigravity · Codex · Copilot · Gemini CLI) to Frihet ERP. Natural language → invoices, expenses, clients, fiscal reports.

**Live:**
- npm: https://www.npmjs.com/package/@frihet/mcp-server — version: see `package.json`; surface counts are pinned by the generated public-capability contract
- MCP remote: https://mcp.frihet.io (Cloudflare Worker)
- Smithery: https://smithery.ai/servers/frihet/frihet-mcp
- Anthropic registry: https://registry.modelcontextprotocol.io/?q=io.frihet
- License: MIT

**Repo:** `Frihet-io/frihet-mcp`

---

## Stack

- Node.js >= 20
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
    register-all.ts    — authoritative tool registry (SoT — do not hand-count)
    <domain>.ts        — one module per domain (invoices, expenses, clients,
                         quotes, CRM, banking, fiscal/compliance, webhooks,
                         intelligence, …). `ls src/tools/` for the current list.
    shared.ts          — Cross-tool helpers
  resources/
    register-all.ts    — MCP resources (read-only context)
  prompts/
    register-all.ts    — MCP prompts (templated)
```

---

## Cross-references

- API client: hits `https://api.frihet.io/v1` (managed in `src/client.ts`)
- Auth: configured by the selected local or remote transport
- Observability: optional and constrained by `docs/observability.md`
- Remote host code lives under `workers/remote-mcp/`

---

## Tool design pattern

Every tool follows this contract:

```typescript
server.registerTool(
  'create_invoice',
  {
    title: 'Create invoice',
    description: 'Create a draft invoice for a client and return the structured invoice.',
    inputSchema: { /* Zod or JSON schema */ },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (input) => {
    // 1. Validate input (Zod)
    // 2. Call Frihet API V1 via client
    // 3. Return human-readable content plus schema-valid structuredContent
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    };
  }
);
```

**Rules**:
- Tool name: preserve the established canonical snake_case convention (for example `create_invoice`)
- `description` clear in 1 line, mentions input + output
- `inputSchema` strictly typed
- Output: MCP `content` plus outputSchema-valid `structuredContent`
- Idempotency where possible (use `Idempotency-Key` HTTP header)
- Errors: preserve actionable, sanitized API remediation via shared helpers

---

## Build & Test

```bash
npm run build          # tsc → dist/
npm test               # npm run build && node --test dist/__tests__/*.test.js
npm start              # node dist/index.js (local stdio)
```

Surface changes must update the generated public-capability contract and pass
the repository's existing CI gates. Release procedures are maintained outside
this public contributor guide.

---

## Quality bar

Tool errors propagate to user agents which act on the user's business data — treat every change accordingly.

- **Idempotency** — `src/client.ts` mints an `Idempotency-Key` for EVERY mutating
  request (`src/__tests__/idempotency-key-contract.test.ts` pins it on the wire).
  Accepting a caller-supplied key as a tool input is a separate, per-tool step:
  today only `create_credit_note` does (`src/tools/invoices.ts`). Adding it to a
  tool means adding its test in the same diff.
- **Input validation** — strict Zod schemas. Reject ambiguous input rather than infer.
- **Auth scope** — tools must respect API key scope. No privilege escalation.
- **Rate limiting** — client-side backoff on 429. Don't burn the user's quota.
- **PII** — never log full request bodies. Mask NIF/IBAN/email in logs.
- **Side effects** — destructive tools (delete, refund) need an explicit confirmation pattern.

---

## Contact

**Maintainer:** Frihet (https://frihet.io) · support@frihet.io
