# Frihet ERP — Multi-Surface Distribution & Ecosystem Matrix

This directory contains public listing copy, official manifests, SDK toolkits, and approved visual assets for MCP directories, agent frameworks, and developer platforms. It is not an operational submission runbook.

## Public Contract Facts

- **npm Package:** `@frihet/mcp-server`
- **MCP Server Identity:** `io.frihet/erp`
- **Remote Streamable HTTP Endpoint:** `https://mcp.frihet.io/mcp`
- **Canonical Catalogue:** 157 operations
- **Local Full Surface:** 162 tool names, 11 resources, 10 prompts
- **Grouped Remote Surface:** 165 tool names, 7 resources, 10 prompts
- **Safety Invariant:** All agent-triggered document creations are non-destructive and strictly in **`draft`** status; irreversible fiscal submissions (AEAT, VeriFactu, TicketBAI) and real-money movements require explicit human confirmation.

---

## Ecosystem Distribution Matrix

| Platform / Surface | Format / Location | Target Audience | Safety Profile | Status |
|---|---|---|---|---|
| **Official MCP Registry** | `server.json` | MCP ecosystem standard | Full (157 ops) / Draft invariant | Conformance Validated |
| **Smithery** | `smithery.yaml` | AI agent developers | Full stdio / CLI | Active |
| **Glama** | `glama.json` | MCP directory users | Full catalogue | Listed |
| **Vercel AI SDK** | `marketplace/vercel-ai/` | Next.js & TypeScript agents | Curated 10 tools, Zod schemas | Available |
| **Google Genkit** | `marketplace/genkit/` | Gemini & Firebase workflows | Curated 10 tools, Zod schemas | Available |
| **Microsoft AutoGen** | `marketplace/autogen/` | Python enterprise multi-agent | Curated 10 tools, Pydantic v2 | Available |
| **LangChain / LangGraph** | `marketplace/langchain/` | LangGraph HITL pipelines | Curated tools, Draft HITL | Available |
| **CrewAI** | `marketplace/crewai/` | Role-based autonomous crews | Curated tools, Draft invariant | Available |
| **LlamaIndex** | `marketplace/llamaindex/` | Financial RAG & data agents | ToolSpec & FunctionTools | Available |
| **Zapier Actions & MCP** | `marketplace/zapier/` | No-code enterprise automation | Webhooks (HMAC) + Actions | Available |
| **n8n Community Node** | `n8n-nodes-frihet@1.0.2` | Self-hosted & cloud workflow automation | Full node package with Sigstore provenance | Live on npm |
| **Meta Muse** | `marketplace/muse/` | WhatsApp & Meta AI small business | Curated 18-tool profile | Submitted |
| **Google Connected Apps** | `src/google-profile.ts` | Gemini & Google Search users | Curated 18-tool profile | In Review |
| **Anthropic Claude Directory** | `marketplace/anthropic/` | Claude Desktop & Enterprise | 132 tools, Sanitized PII | In Review |
| **Claude Code CLI** | `marketplace/anthropic/claude-code.md` | Terminal AI developers | Stdio & Remote SSE | Documented |
| **Cursor IDE** | `marketplace/cursor/` | Developers using Cursor Composer/Agent | `.cursor/mcp.json` & `.mdc` rules | Documented |
| **OpenAI ChatGPT Store** | `marketplace/openai/` | ChatGPT Plus & Team | 33-tool approved profile | Frozen / Prepared |
| **Raycast Extension** | `marketplace/raycast/` | macOS founders & engineers | HUD summary, search, expense capture | Package Defined |
| **Dify Tool Provider** | `marketplace/dify/` | Open-source enterprise LLM workflows | Curated YAML tools / Draft invariant | Defined & Tested |
| **Flowise Custom Tool** | `marketplace/flowise/` | Drag-and-drop LangChain canvas | JavaScript tool node / Draft invariant | Available |
| **Make.com (Integromat)** | `marketplace/make/` | Visual SMB workflow scenarios | HMAC webhooks + Actions | App Defined |
| **Postman Official Collection** | `marketplace/postman/` | API developers & integration QA | Collection v2.1.0 with tests & env | Complete |
| **GitHub Copilot & VS Code** | `marketplace/copilot/` | Copilot Workspace & VS Code Chat | `.github/copilot-instructions.md` | Documented |

---

## Contract Verification & Drift Guard

Run the automated cross-platform validator to verify all marketplace schemas, manifests, and safety invariants:

```bash
node scripts/check-marketplace-contracts.mjs
```

Validates that:
1. All JSON manifests (`server.json`, `glama.json`, Zapier, Cursor, Raycast, Muse, Make, Postman) parse with zero syntax errors.
2. All YAML specifications (`smithery.yaml`, Dify) conform to spec.
3. Every toolkit (Vercel AI, Genkit, AutoGen, LlamaIndex, LangChain, CrewAI, Flowise) enforces the **Draft-Only Invariant** (`status: 'draft'`).
4. Zero credentials or secret tokens are leaked in examples.

---

## Guidance for AI Agents & Consumers

Catalogue membership alone does not prove that a backing API is enabled for a specific workspace. Full-surface clients should read `_meta["io.frihet/capability"]` and the standard MCP action annotations (`readOnlyHint`, `destructiveHint`).

Submission credentials, synthetic test accounts, provider configuration, approval state, and release sequencing are maintained outside this public repository.
