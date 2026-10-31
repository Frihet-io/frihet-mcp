# Frihet ERP for Claude Code & Anthropic Claude

Connect [Claude Code](https://claude.ai/code) and Claude Desktop directly to Frihet ERP using the Model Context Protocol (MCP).

## Claude Code CLI Setup

Claude Code is Anthropic's agentic command-line interface. To connect Frihet ERP in one command:

### Option A: Local stdio execution (Recommended)

```bash
claude mcp add frihet -- npx -y @frihet/mcp-server@latest
```

Set your API key in your environment:
```bash
export FRIHET_API_KEY="fri_live_your_api_key_here"
```

### Option B: Remote SSE streaming endpoint

```bash
claude mcp add frihet https://mcp.frihet.io/mcp
```

### Option C: Dedicated Claude Profile (Sanitized output)

```bash
claude mcp add frihet --env FRIHET_CLAUDE_MODE=true -- npx -y @frihet/mcp-server@latest
```

## Claude Desktop Configuration

In `claude_desktop_config.json` (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "frihet": {
      "command": "npx",
      "args": [
        "-y",
        "@frihet/mcp-server@latest"
      ],
      "env": {
        "FRIHET_API_KEY": "YOUR_FRIHET_API_KEY",
        "FRIHET_CLAUDE_MODE": "true"
      }
    }
  }
}
```

## Available Prompts in Claude
Frihet MCP provides pre-configured multi-step review workflows:
- `overdue-followup`: Review uncollected receivables and draft polite email reminders.
- `invoice-aging-review`: Categorize outstanding balances by aging buckets (30/60/90 days).

## Safety & Compliance Invariant
- **Draft-Only Guarantees:** All created documents are strictly reviewable drafts.
- **Redaction by Design:** NIF/CIF, IBAN, and client contact information are deeply sanitized and redacted according to Anthropic Software Directory guidelines.
