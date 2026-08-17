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
import { FISCAL_MODELO_ALIASES } from "../../../src/fiscal-aliases.js";
import { MCP_PROMPT_COUNT } from "../../../src/prompts/register-all.js";
import { MCP_STATIC_RESOURCE_COUNT } from "../../../src/resources/register-all.js";
import { GROUPED_META_TOOL_COUNT } from "../../../src/tool-exposure.js";

/** The published @frihet/mcp-server version (single source: root package.json). */
export const MCP_SERVER_VERSION: string = (pkg as { version: string }).version;

/**
 * Canonical business-operation catalogue size. This is NOT the number of names
 * served by tools/list: aliases and grouped discovery names are separate.
 * audit:mcp-refs pins this to registerTool sites; the generated public-capability
 * contract pins the actual profile compositions.
 */
export const FULL_TOOL_COUNT = 157;

export const FISCAL_ALIAS_TOOL_COUNT = Object.keys(FISCAL_MODELO_ALIASES).length;
export const FULL_REMOTE_TOOL_COUNT =
  FULL_TOOL_COUNT + FISCAL_ALIAS_TOOL_COUNT + GROUPED_META_TOOL_COUNT;
export const FULL_REMOTE_RESOURCE_COUNT = MCP_STATIC_RESOURCE_COUNT;
export const FULL_REMOTE_PROMPT_COUNT = MCP_PROMPT_COUNT;
