# Frihet ERP — Cursor plugin

Use your connected Frihet workspace for invoice drafting, expenses, clients,
receivables and other available business operations. The publisher is
[Frihet](https://www.frihet.io).

## Included

- `mcp.json` starts the local stdio server pinned to `@frihet/mcp-server@2.0.2`.
  Its full source catalogue contains **158 canonical operations plus five fiscal
  aliases: 163 tool names**. Availability still depends on the connected version,
  workspace configuration, permissions and each tool's capability metadata.
- `skills/` contains eight guided workflows: `frihet-mcp`, `clientes`, `cobros`,
  `documentos`, `gastos`, `operaciones`, `revision-mensual` and `tesoreria`.
- `rules/frihet-fiscal.mdc` provides fiscal operating safeguards.
- `assets/logo.svg` contains the Frihet logo; `LICENSE` contains the MIT license.

## Install and configure

The local server needs a Node.js version supported by the pinned package
(`^22.23.4 || ^24.22.1 || ^26.12.1`) and npm/npx. The pinned npm version must be
published; the configuration does not silently fall back to `latest`.

The following local repository installation was verified in Cursor. Marketplace
review and approval are separate from this local installation.

1. Open **Customize → Plugins → Add → From Local Repo**.
2. Select the **repository root** containing `.cursor-plugin/marketplace.json`,
   not the `plugins/frihet-erp` subdirectory.
3. Add **frihet-erp** from the loaded catalogue. Its installed entry should show
   **1 MCP server, 8 skills and 1 rule**.
4. Open the plugin's **Configure** screen and set the variables below. Choose
   **Save**, then run **Reload Window** from Cursor's command palette after
   changing variables, before testing the MCP server. In the verified flow,
   saved changes took effect after this reload.

`${VAR}` in this plugin is Cursor plugin-variable syntax. Set values in
**Configure**; never paste credentials into a conversation.

| Variable | Default | How to use it |
| --- | --- | --- |
| `FRIHET_DEMO` | `0` | Set `1` to use synthetic fixtures without a key. Keep `0` for your live workspace. |
| `FRIHET_API_KEY` | empty | Leave empty in demo. In live mode, set the key from [Frihet API settings](https://app.frihet.io/settings/api). |

Live mode with an empty key exits with `FRIHET_API_KEY_MISSING`; it does not
silently use demo data. Never put a key in the repository, chat, screenshots or
a shared bot template. Scope live credentials to the operations you intend to use.
The full tool catalogue is not itself a permission grant.

## Try the demo

1. In **Configure**, set `FRIHET_DEMO` to `1` and leave `FRIHET_API_KEY` empty.
2. Choose **Save**, then run **Reload Window** from the command palette.
3. Start a new conversation in **Agent** mode. Ask it to call
   `get_business_context` from **plugin-frihet-erp-frihet**. In the observed
   local flow, **Ask** mode blocked plugin tool execution.
4. Authorize only that individual read request; leave **Always Run** disabled.
5. Verify that the result identifies **Demo Studio SL**, currency **EUR**, and
   `_demo: true` before continuing with other read-only checks. A connected
   server and tool count alone do not establish demo mode.

You can then request a business summary or review overdue invoices and expenses,
approving individual reads as needed. The server labels results as demo.
Fixtures use a fixed reference date rather than today's business activity. Demo
mode serves example data without live API requests; any exposed write operations simulate results and do not persist them.
It is **not** a technical read-only permission boundary: for a read-only review,
instruct the agent to use reads only and use a host tool allowlist if supported.
Demo mode wins if a key is present, but leave the key empty to keep it out of the
review configuration.

An in-app installation test must verify the plugin, variable substitution,
server startup and skill discovery. Testing a manually configured MCP server
or a local source build alone does not establish those host behaviors.

## Using live data

Start by verifying the workspace, period and connected tool catalogue. The
skills inspect schemas and capability metadata, paginate lists and separate
currencies. Drafting a proposed change does not save or send it. An authorized
write follows the actual tool's permissions and confirmation requirements.
Do not infer tax treatment from an address or treat an API response as fiscal
acceptance, payment collection or message delivery without the relevant evidence.

## Links

- Product: <https://www.frihet.io>
- Documentation: <https://docs.frihet.io/desarrolladores/mcp-server>
- npm: <https://www.npmjs.com/package/@frihet/mcp-server>
- Source: <https://github.com/Frihet-io/frihet-mcp>
- Cursor plugin format: <https://cursor.com/docs/reference/plugins>
