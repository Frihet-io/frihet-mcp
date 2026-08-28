# Marketplace metadata

This directory contains public listing copy, manifests, and approved visual
assets for MCP directories. It is not an operational submission runbook.

Public contract facts:

- package: `@frihet/mcp-server`;
- MCP identity: `io.frihet/erp`;
- remote endpoint: `https://mcp.frihet.io/mcp`;
- catalogue: 157 canonical operations;
- local full surface: 162 tool names, 11 resources, 10 prompts;
- grouped remote surface: 165 tool names, 7 resources, 10 prompts;
- OpenAI-reviewed surface: 33 business tool names with complete descriptions, 0 discovery meta-tools, 0 resources, 0 prompts.

Catalogue membership does not prove that a backing API is enabled for a
workspace. Full-surface clients should read `_meta["io.frihet/capability"]` and
the standard MCP action annotations.

Submission credentials, test accounts, provider configuration, approval state,
and release sequencing are maintained outside this public repository.
