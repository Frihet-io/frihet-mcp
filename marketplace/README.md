# Frihet ERP — Multi-Surface Distribution & Ecosystem Matrix

This directory contains public listing copy, official manifests, SDK toolkits, and approved visual assets for MCP directories, agent frameworks, and developer platforms. It is not an operational submission runbook.

## Public Contract Facts

- **npm Package:** `@frihet/mcp-server`
- **MCP Server Identity:** `io.frihet/erp`
- **Remote Streamable HTTP Endpoint:** `https://mcp.frihet.io/mcp`
- **Canonical Catalogue:** 157 operations
- **Local Full Surface:** 162 tool names, 11 resources, 10 prompts
- **Grouped Remote Surface:** 165 tool names, 7 resources, 10 prompts
- **Safety Invariant:** All agent-triggered document creations are non-destructive and strictly in **`draft`** status; irreversible fiscal submissions (AEAT, VeriFactu, TicketBAI) and real-money movements require explicit human confirmation in Frihet ERP web dashboard.

---

## Ecosystem Distribution Matrix

Lifecycle states follow a strict, evidence-based taxonomy:
- **`PUBLISHED_VERIFIED`**: Package or connector is live and verified in the target registry/store.
- **`SUBMITTED`**: Official submission package delivered to partner directory; awaiting reviewer evaluation.
- **`PREVIEW_APPLIED`**: Formal developer preview access request submitted; awaiting partner onboarding.
- **`CONTRACT_TESTED`**: Integration code, schemas, and safety invariants pass automated tests in this repository.

| Platform / Surface | Format / Location | Target Surface | Safety Boundary | Verified Lifecycle State |
|---|---|---|---|---|
| **n8n Community Node** | `n8n-nodes-frihet@1.0.2` | n8n self-hosted & cloud | Sigstore provenance, governed credentials | **`PUBLISHED_VERIFIED`** |
| **OpenAI ChatGPT Store** | `marketplace/openai/` | ChatGPT Plus & Team | 33-tool profile, draft-only mutations | **`PUBLISHED_VERIFIED`** |
| **ClawHub Registry** | `marketplace/openclaw/` | OpenClaw agent network | Governed skill package (`@frihet-io` v1.1.0) | **`PUBLISHED_VERIFIED`** |
| **Glama Directory** | `glama.json` | MCP directory users | Full catalogue listing metadata | **`PUBLISHED_VERIFIED`** |
| **Smithery Registry** | `smithery.yaml` | AI agent developers | Full stdio / CLI configuration | **`PUBLISHED_VERIFIED`** |
| **Anthropic Claude Directory** | `marketplace/anthropic/` | Claude Desktop & Enterprise | 132 tools, Sanitized PII | **`SUBMITTED`** (PR open, CI green) |
| **Composio Toolkit** | `Remote MCP / REST` | 1500+ agent ecosystem | Full OpenAPI & MCP profile, draft invariant | **`SUBMITTED`** (Email & web form verified) |
| **Meta Muse Connector** | `src/muse-profile.ts` | WhatsApp & Meta AI SMB | Curated 18-tool profile, forced draft | **`SUBMITTED`** (Catalog submission & server profile) |
| **Google Connected Apps** | `src/google-profile.ts` | Gemini & Google Search | Curated 18-tool profile, forced draft | **`PREVIEW_APPLIED`** (Form 46 preview access) |
| **Official MCP Registry** | `server.json` | MCP ecosystem standard | Full (157 ops) / Draft invariant | **`CONTRACT_TESTED`** |
| **Vercel AI SDK** | `marketplace/vercel-ai/` | Next.js & TypeScript agents | Curated 10 tools, Zod schemas, Idempotency | **`CONTRACT_TESTED`** |
| **Google Genkit** | `marketplace/genkit/` | Gemini & Firebase workflows | Curated 10 tools, Zod schemas, Idempotency | **`CONTRACT_TESTED`** |
| **Microsoft AutoGen** | `marketplace/autogen/` | Python enterprise multi-agent | v0.4+ / v0.2 compatible, Pydantic validation | **`CONTRACT_TESTED`** |
| **LangChain / LangGraph** | `marketplace/langchain/` | LangGraph HITL pipelines | BaseTool definitions, Idempotency, Redaction | **`CONTRACT_TESTED`** |
| **CrewAI** | `marketplace/crewai/` | Role-based autonomous crews | BaseTool definitions, Idempotency, Redaction | **`CONTRACT_TESTED`** |
| **LlamaIndex** | `marketplace/llamaindex/` | Financial RAG & data agents | ToolSpec & FunctionTools, Pydantic validation | **`CONTRACT_TESTED`** |
| **Zapier Platform Schema** | `marketplace/zapier/` | Zapier Platform CLI & AI Actions | Declarative triggers/actions schema (#2101) | **`CONTRACT_TESTED`** |
| **Google Workspace Add-on** | `googleapps_sdk` | Gmail & Google Drive | OAuth sensitive scope approved, 6 canonical scopes | **`SUBMITTED`** (Marketplace SDK under review) |
| **Raycast Extension** | `frihet-raycast` | macOS founders & engineers | 5 commands, API client, tenant isolation, read-only | **`SUBMITTED`** (PR [raycast/extensions#33017](https://github.com/raycast/extensions/pull/33017), CI green) |
| **Dify Tool Provider** | `marketplace/dify/` | Enterprise LLM workflows | Curated YAML tools, draft-only invariant | **`CONTRACT_TESTED`** |
| **Flowise Custom Tool** | `marketplace/flowise/` | Drag-and-drop LangChain canvas | JavaScript tool node, draft-only invariant | **`CONTRACT_TESTED`** |
| **Make.com (Integromat)** | `marketplace/make/` | Visual SMB workflow scenarios | App definition with canonical routes | **`CONTRACT_TESTED`** |
| **Postman Official Collection** | `marketplace/postman/` | API developers & integration QA | Collection v2.1.0 with canonical tests & env | **`CONTRACT_TESTED`** |
| **Cursor IDE Rules** | `marketplace/cursor/` | Cursor Composer/Agent | `.cursor/mcp.json` & `.mdc` system rules | **`CONTRACT_TESTED`** |
| **Windsurf IDE (Codeium)** | `marketplace/windsurf/` | Cascade Agent & Composer | `mcp_config.json` & `.windsurfrules` | **`CONTRACT_TESTED`** |
| **Claude Code CLI Guide** | `marketplace/anthropic/claude-code.md` | Terminal AI developers | Stdio & Remote SSE setup guide | **`CONTRACT_TESTED`** |
| **GitHub Copilot Instructions** | `marketplace/copilot/` | Copilot Workspace & VS Code | `.github/copilot-instructions.md` | **`CONTRACT_TESTED`** |

---

## Contract Verification & Drift Guard

Run the automated cross-platform validator to verify all marketplace schemas, manifests, canonical endpoints, and safety invariants:

```bash
node scripts/check-marketplace-contracts.mjs
```

Validates that:
1. All JSON manifests (`server.json`, `glama.json`, Zapier, Cursor, Raycast, Muse, Make, Postman) parse with zero syntax errors.
2. All YAML specifications (`smithery.yaml`, Dify) conform to spec.
3. Every toolkit enforces the **Draft-Only Invariant** (`status: 'draft'`).
4. All endpoints in manifests and code use canonical Frihet routes (`/monthly?month=`, `/quarterly?quarter=`) and reject non-canonical legacy forms (`/summaries/monthly`, `/taxes/quarterly`).
5. All mutating integrations include **Idempotency-Key** protection and sensitive field redaction.
6. Zero credentials or secret tokens are leaked in examples.

---

## Guidance for AI Agents & Consumers

Catalogue membership alone does not prove that a backing API is enabled for a specific workspace. Full-surface clients should read `_meta["io.frihet/capability"]` and the standard MCP action annotations (`readOnlyHint`, `destructiveHint`).

Submission credentials, synthetic test accounts, provider configuration, approval state, and release sequencing are maintained outside this public repository.
