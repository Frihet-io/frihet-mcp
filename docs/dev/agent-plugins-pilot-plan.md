# Agent Plugins 1.0: Frihet Developer Pilot Architecture Plan (`frihet-dev`)

## Executive Summary

As AI agent frameworks standardize on **Agent Plugins 1.0** and **Model Context Protocol (MCP)** across Claude Code, OpenAI ChatGPT/Operator, Cursor, Windsurf, Codex, and Antigravity, Frihet requires a disciplined developer packaging strategy.

This document defines the architecture and implementation-ready packaging plan for the **`frihet-dev`** pilot.

---

## 1. Official Plugin Specification & Client Compatibility Matrix

| Client / Environment | Manifest & Location | MCP Integration Support | Permissions Model | Read-Only Safe Seam |
|---|---|---|---|---|
| **Claude Code** | `.claude-plugin/plugin.json` + `skills/` | Direct Stdio / SSE / StreamableHTTP | Prompt confirmation on tools | Supported (`FRIHET_DEMO=1` or read-only tools) |
| **Cursor** | `.cursor-plugin/marketplace.json` + `mcp.json` | Stdio / SSE connection | User approves tool execution | Supported via read-only tools |
| **Codex / AGY SDK** | `.agents/skills/` / `.gemini/` | Native MCP Client | RBAC & Sandbox isolation | Supported via read-only tools & Demo client |
| **OpenAI / ChatGPT** | `openai-profile.ts` (JSON Schema) | GPT Actions / MCP Connector | OAuth 2.0 PKCE / Static Key | Supported via 45-tool restricted safe profile |
| **Windsurf / Cline** | `~/.codeium/windsurf/mcp_config.json` | Stdio MCP | Interactive per-tool confirm | Supported via Stdio |

---

## 2. Hard Governance & Safety Constraints

1. **No Fake Duplication of Canonical Skills**:
   - `skill/` is the single source of truth (SoT) for Frihet skills (as codified in `skill/CANONICAL.md`).
   - Packaging mirrors must only be generated via audited synchronization scripts (`audit-mcp-refs.mjs`), never hand-cloned with unmerged drift.
2. **Zero Secret Leakage**:
   - Manifests, plugin descriptions, and schemas must never contain API tokens, private keys, or environment secrets.
3. **Zero Mutation / Read-Only Enforcement**:
   - `frihet-dev` pilot is strictly scoped to diagnostic, reconnaissance, and validation capabilities. No write or mutating operations are bundled in developer-facing pilot packages.

---

## 3. The `frihet-dev` Pilot Specification

The `frihet-dev` pilot encapsulates three core developer commands:

```
frihet-dev
├── live-recon          # Introspect live/demo server capabilities and operational status
├── trust-review        # Static & runtime verification of tool contracts, schemas, and idempotency
└── production-proof    # Non-destructive pre-flight readiness checks before deployment
```

### A. `live-recon` (Read-Only Surface Introspection)
- **Objective**: Provide AI assistants with deterministic knowledge of available tools, active subscriptions, deployed endpoints, and fiscal zone settings without modifying state.
- **Operations Bundled**:
  - `get_business_context`
  - `permissions_me`
  - `permissions_matrix`
  - `onboarding_status`
  - `period_close_status`
  - `verifactu_status`
- **Output**: Structured JSON + human-readable diagnostics explaining which tools are callable, runtime-checked, or deferred.

### B. `trust-review` (Security & Contract Verification)
- **Objective**: Inspect tool definitions against the public capability contract and adversarial security rules.
- **Verification Gates**:
  1. Idempotency assertion: mutative tools must declare `idempotentHint` or require idempotency headers.
  2. Side-effect transparency: external integrations (AEAT submission, email dispatch) must explicitly declare `openWorldHint: true` and `externalSideEffects`.
  3. Strict schema adherence: output schemas must not leak undeclared fields into `structuredContent`.

### C. `production-proof` (Safe Pre-flight Diagnostics)
- **Objective**: Validate end-to-end MCP compatibility in CI/CD before releasing new server versions.
- **Execution Mechanism**:
  - Executes `canary:inspector:check` against the committed Inspector 2.3.0 golden baseline.
  - Verifies that zero mutating calls are made during verification runs.
  - Generates machine-readable verification receipts for audit logs.

---

## 4. Phased Implementation Roadmap

1. **Phase 1 (Current Sprint — Completed)**:
   - Establish Inspector 2.3.0 golden baseline harness (`npm run canary:inspector`).
   - Validate 157 canonical operations with zero mutations.
   - Implement test-only form/elicitation fixture.
2. **Phase 2 (Next Sprint — Packaging `frihet-dev`)**:
   - Scaffold `plugins/frihet-dev` manifest conforming to Agent Plugins 1.0 schema.
   - Bundle `live-recon`, `trust-review`, and `production-proof` CLI entries.
   - Add automated drift guard to `pnpm gate` / CI.
3. **Phase 3 (MCP v2 Transition)**:
   - Migrate transport layer to StreamableHTTP (`@modelcontextprotocol/server@2.x`).
   - Run `npm run canary:inspector:check` to ensure 100% backward compatibility against golden baseline.
