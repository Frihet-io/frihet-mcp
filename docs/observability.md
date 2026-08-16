# Langfuse Observability — Env Var Setup

Self-hosted Langfuse at `https://langfuse.frihet.io` traces every MCP tool call
(tool name, response time, success/failure, bounded error classification). Tool
inputs, outputs, business content, and workspace/user identity are omitted by
default. Fail-open: missing keys or
Langfuse down → tool calls proceed unchanged.

> **Never commit real keys to this repo.** This is a public repository. All values
> below are placeholders. Obtain the real `pk-lf-…` / `sk-lf-…` pair from the Langfuse
> project settings (Settings → API Keys) and store them only as Wrangler secrets,
> `.dev.vars` (gitignored), or your MCP client config — never in tracked files.

---

## Cloudflare Worker (mcp.frihet.io)

Run once per secret. These are stored as encrypted Wrangler secrets, never in `wrangler.toml`.

```bash
# From workers/remote-mcp/
cd workers/remote-mcp

wrangler secret put LANGFUSE_PUBLIC_KEY
# Enter: pk-lf-...

wrangler secret put LANGFUSE_SECRET_KEY
# Enter: sk-lf-...

wrangler secret put LANGFUSE_BASE_URL
# Enter: https://langfuse.frihet.io
```

For the OpenAI environment (`--env openai`), repeat with `--env openai`:

```bash
wrangler secret put LANGFUSE_PUBLIC_KEY --env openai
wrangler secret put LANGFUSE_SECRET_KEY --env openai
wrangler secret put LANGFUSE_BASE_URL --env openai
```

---

## npm stdio (Claude Desktop, Cursor, Windsurf)

Add to the MCP server config in `mcpServers`:

```json
{
  "mcpServers": {
    "frihet": {
      "command": "npx",
      "args": ["-y", "@frihet/mcp-server"],
      "env": {
        "FRIHET_API_KEY": "fri_...",
        "LANGFUSE_PUBLIC_KEY": "pk-lf-...",
        "LANGFUSE_SECRET_KEY": "sk-lf-...",
        "LANGFUSE_BASE_URL": "https://langfuse.frihet.io"
      }
    }
  }
}
```

Langfuse keys are **optional** — omit them and the server runs with tracing disabled
(fail-open). Client labels and user/workspace identity are intentionally omitted.
`LANGFUSE_BASE_URL` is restricted to the exact documented
`https://langfuse.frihet.io` origin because the ingestion request carries Basic
Authorization; custom hosts, paths, ports, and redirects are not accepted.

---

## Local dev (Wrangler)

Create `workers/remote-mcp/.dev.vars` (gitignored — never tracked):

```
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://langfuse.frihet.io
```

`.dev.vars` is gitignored in this repo (see `.gitignore`).

---

## What gets traced

Every tool call emits a `trace-create` + `span-create` batch to `/api/public/ingestion`:

| Field | Value |
|-------|-------|
| `trace.name` | `mcp_request` |
| `trace.tags` | `["mcp.tool.<toolName>"]` |
| `span.name` | `tool.<toolName>` |
| Tool input/output | Omitted — no business payload crosses the telemetry boundary |
| `span.level` | `DEFAULT`, `WARNING` (stub), or `ERROR` |
| `span.metadata.durationMs` | Wall-clock time |
| Error detail | Bounded class/code/status only; raw messages and provider bodies omitted |
| Workspace/user identity | Omitted |

Stable pseudonymous workspace correlation would require a separately
provisioned, rotatable, domain-separated HMAC secret and session-scoped design.
No such infrastructure dependency is introduced by the default telemetry path.
