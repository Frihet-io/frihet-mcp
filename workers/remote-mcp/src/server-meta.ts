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
export const FULL_TOOL_COUNT = 158;

/**
 * Canonical legal URLs advertised by every discovery artifact in the fleet.
 *
 * These are metadata this Worker PUBLISHES, so they belong to the same single
 * source as the version and tool counts above — and for the same reason. They
 * had already drifted three ways (#145): `www.frihet.io`'s agents.json and
 * `api.frihet.io`'s both served `/legal/*`, which has never been a route and
 * returns 404, while this Worker served `/en/*`.
 *
 * Why it stayed published: measured 2026-08-18, a bare `curl` gets 403 from the
 * WAF on exactly those two dead paths while returning 200 on the live `/es/`
 * and `/en/` ones. So the cheapest possible check reports "403, probably just
 * the WAF" for a URL that is actually a 404, and reports a clean 200 for the
 * healthy ones — the failure is invisible precisely where it matters. Verifying
 * these needs a browser User-Agent.
 *
 * `/es/*` is canonical, not merely reachable: it is what the pages' own
 * `<link rel="canonical">` emits, what `x-default` resolves to, and what
 * `Frihet-Saas-Website/public/llms.txt` already publishes. Every other locale
 * stays reachable through the hreflang set on the page itself.
 *
 * `workers/api-proxy/worker.js` is a standalone Worker with no bundler, so it
 * cannot import this module; it carries the same two literals and is held to
 * them by the parity assertions in
 * `src/__tests__/discovery-legal-truth.test.ts`, which read THIS file as the
 * expected value rather than hardcoding a second copy.
 */
export const LEGAL_PRIVACY_URL = "https://www.frihet.io/es/privacy";
export const LEGAL_TERMS_URL = "https://www.frihet.io/es/terms";

export const FISCAL_ALIAS_TOOL_COUNT = Object.keys(FISCAL_MODELO_ALIASES).length;
export const FULL_REMOTE_TOOL_COUNT =
  FULL_TOOL_COUNT + FISCAL_ALIAS_TOOL_COUNT + GROUPED_META_TOOL_COUNT;
export const FULL_REMOTE_RESOURCE_COUNT = MCP_STATIC_RESOURCE_COUNT;
export const FULL_REMOTE_PROMPT_COUNT = MCP_PROMPT_COUNT;
