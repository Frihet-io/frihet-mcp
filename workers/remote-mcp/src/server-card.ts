/**
 * MCP Server Card (SEP-1649 draft) served at `/.well-known/mcp.json`.
 *
 * Everything a client/registry needs to discover the server WITHOUT running an
 * initialize handshake: identity, transport endpoint, auth schemes, and docs.
 * One builder so the default host and the scoped OpenAI host produce
 * structurally identical cards that differ only in host/counts.
 *
 * Kept as a leaf module (no package.json import) so it stays testable under
 * `node --experimental-strip-types`; the version is passed in by the caller,
 * which sources it from server-meta (MCP_SERVER_VERSION → root package.json).
 *
 * @see https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1649
 */

/**
 * MCP protocol revision advertised by this Worker's discovery surfaces.
 * Kept here so the server card reads ONE value.
 */
export const MCP_PROTOCOL_VERSION = "2025-11-05";

export interface ServerCardInput {
  /** Reverse-DNS server identity, e.g. "io.frihet/erp". */
  readonly name: string;
  /** Human-readable title. */
  readonly title: string;
  /** Published server version (single-sourced from package.json by the caller). */
  readonly version: string;
  /** One-line capability summary. */
  readonly description: string;
  /** Origin serving this card, e.g. "https://mcp.frihet.io" (no trailing slash). */
  readonly host: string;
  /** Live MCP tool count for this host's profile. */
  readonly toolCount: number;
  /** Static MCP resource count for this host's profile. */
  readonly resourceCount: number;
  /** Static MCP prompt count for this host's profile. */
  readonly promptCount: number;
}

/**
 * Build the SEP-1649 server card. Standard SEP fields first; the
 * `tools_count`/`resources_count`/`prompts_count`/`npm` extras mirror the
 * sibling `/.well-known/mcp` descriptor's house style so registries reading
 * either surface see the same numbers.
 */
export function buildServerCard(input: ServerCardInput): Record<string, unknown> {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
    version: "1.0",
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: {
      name: input.name,
      title: input.title,
      version: input.version,
    },
    description: input.description,
    iconUrl: "https://www.frihet.io/logo.png",
    documentationUrl: "https://docs.frihet.io/desarrolladores/mcp-server",
    homepage: "https://frihet.io",
    transport: {
      type: "streamable-http",
      endpoint: `${input.host}/mcp`,
    },
    capabilities: {
      tools: { listChanged: true },
      prompts: { listChanged: true },
      resources: { listChanged: true },
    },
    authentication: {
      required: true,
      // oauth2 = remote browser flow (mcp.frihet.io); bearer = API-key token
      // used by the local @frihet/mcp-server (FRIHET_API_KEY).
      schemes: ["oauth2", "bearer"],
      authorizationServer: `${input.host}/.well-known/oauth-authorization-server`,
    },
    npm: "@frihet/mcp-server",
    tools_count: input.toolCount,
    resources_count: input.resourceCount,
    prompts_count: input.promptCount,
  };
}
