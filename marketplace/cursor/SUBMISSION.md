# Cursor marketplace public contract

The repository marketplace manifest points to `plugins/frihet-erp`. The Cursor
plugin pins the local stdio server to `@frihet/mcp-server@2.0.2` and declares its
configuration variables in `.cursor-plugin/plugin.json` inside that directory.

The canonical source catalogue contains 158 operations. The local full profile
adds five fiscal alias names (163 tool names total) and serves eleven resources
and ten prompts. Per-tool callability and side-effect truth is published in
`_meta["io.frihet/capability"]`; catalogue membership alone is not an availability
guarantee.

`FRIHET_DEMO=1` selects fixture-only data without an API key or live API calls.
The default, `FRIHET_DEMO=0`, requires the user's key; an empty key fails closed.
The [plugin README](../../plugins/frihet-erp/README.md) documents the host's
configuration flow and the distinction between demo and read-only permissions.

The pinned npm version must exist before an installation can be accepted. A
source or manually configured MCP test does not substitute for a clean host
plugin installation, variable expansion, skill discovery and MCP startup test.

Operational submission steps, contacts, approval state, and release sequencing
are intentionally maintained outside this public repository.
