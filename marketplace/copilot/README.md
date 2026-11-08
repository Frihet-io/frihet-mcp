# Frihet ERP for GitHub Copilot & VS Code

Guidelines and configuration for [GitHub Copilot](https://github.com/features/copilot) and VS Code developers working with Frihet ERP APIs and MCP server.

## Instructions File
Copy [`copilot-instructions.md`](./copilot-instructions.md) to `.github/copilot-instructions.md` in your project repository. GitHub Copilot automatically reads this file to align AI completions with Frihet's fiscal invariants (draft-only safeguard, VAT regimes, PII protection).

## VS Code Copilot Chat MCP Setup
In `.vscode/settings.json`:

```json
{
  "github.copilot.chat.mcpServers": {
    "frihet": {
      "command": "npx",
      "args": ["-y", "@frihet/mcp-server@latest"],
      "env": {
        "FRIHET_API_KEY": "${env:FRIHET_API_KEY}"
      }
    }
  }
}
```
