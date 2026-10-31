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
- Google Connected Apps curated profile: 18 focused small-business tools (read-only queries + draft-only invoices/quotes/expenses);
- Meta Muse official connector: 18 curated small-business tools (`marketplace/muse/manifest.json`);
- OpenAI-reviewed surface: 33 business tool names with complete descriptions, 0 discovery meta-tools, 0 resources, 0 prompts;
- Multi-agent SDK toolkits: native Python integration harnesses in `marketplace/crewai/` and `marketplace/langchain/` (LangGraph HITL).

Catalogue membership does not prove that a backing API is enabled for a
workspace. Full-surface clients should read `_meta["io.frihet/capability"]` and
the standard MCP action annotations.

Submission credentials, test accounts, provider configuration, approval state,
and release sequencing are maintained outside this public repository.
