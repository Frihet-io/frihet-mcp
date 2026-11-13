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

This repository's `.cursor-plugin/marketplace.json` points to this plugin's
subdirectory. A repository listing and an installed plugin are different from
marketplace approval. Use the host's plugin installation flow for the repository.
The local server needs a Node.js version supported by the pinned package
(`^22.23.4 || ^24.22.1 || ^26.12.1`) and npm/npx. The pinned npm version must be
published; the configuration does not silently fall back to `latest`.

Set the following plugin variables under **Plugins → Configure** (or the host's
corresponding plugin configuration screen). `${VAR}` in this plugin is Cursor
plugin-variable syntax, not a request to paste credentials into a conversation.

| Variable | Default | How to use it |
| --- | --- | --- |
| `FRIHET_DEMO` | `0` | Set `1` to use synthetic fixtures without a key. Keep `0` for your live workspace. |
| `FRIHET_API_KEY` | empty | Leave empty in demo. In live mode, set the key from [Frihet API settings](https://app.frihet.io/settings/api). |

Live mode with an empty key exits with `FRIHET_API_KEY_MISSING`; it does not
silently use demo data. Never put a key in the repository, chat, screenshots or
a shared bot template. Scope live credentials to the operations you intend to use.
The full tool catalogue is not itself a permission grant.

## Try the demo

Set `FRIHET_DEMO=1`, leave `FRIHET_API_KEY` empty and reconnect the plugin's MCP
server. Ask for a business summary or a review of overdue invoices and expenses.
The server labels results as demo. Fixtures use a fixed reference date rather
than today's business activity. Demo mode serves example data without live API
requests; any exposed write operations simulate results and do not persist them.
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
