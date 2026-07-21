/**
 * Single source of truth for the Worker's advertised server metadata.
 *
 * Historically the version + tool count were hardcoded across several Worker
 * surfaces (root `/`, `/health`, JSON-LD, `.well-known/mcp`, releases.json),
 * which drifted apart (root said 1.5.2/52 while /health said 1.13.0). These
 * constants give every surface ONE place to read from.
 *
 * MCP_SERVER_VERSION is derived from the published package.json so a single
 * `npm version` bump propagates everywhere — it can never re-drift.
 *
 * @see feedback-frihet-mcp-drift-multi-sot-coverage-gap (memory)
 */

import pkg from "../../../package.json";

/** The published @frihet/mcp-server version (single source: root package.json). */
export const MCP_SERVER_VERSION: string = (pkg as { version: string }).version;

/**
 * Full MCP surface size (business tools + grouped discovery meta-tools).
 * Mirrors the audit:mcp-refs SoT (count of registerTool calls across src/tools);
 * the gate asserts this constant equals that count, so it cannot silently drift.
 */
export const FULL_TOOL_COUNT = 157;
