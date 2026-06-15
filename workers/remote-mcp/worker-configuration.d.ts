interface Env {
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  COOKIE_ENCRYPTION_KEY: string;
  FIREBASE_PROJECT_ID: string;
  FRIHET_API_BASE: string;
  FRIHET_OAUTH_API_KEY: string;
  PUBLIC_JWK_CACHE_KV: KVNamespace;
  /** Set to "true" to activate OpenAI-safe profile (strips gov IDs, fixes annotations) */
  FRIHET_OPENAI_MODE?: string;
  /** Set to "grouped" to activate progressive-disclosure tool exposure (default "full" = unchanged) */
  FRIHET_TOOL_MODE?: string;
  /** Langfuse observability — self-hosted at https://langfuse.frihet.io */
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL?: string;
  /**
   * Static assets binding for public/ directory.
   * Used to serve releases.json and other static AI-discoverability files.
   * Declared in wrangler.toml [assets] section.
   */
  ASSETS?: Fetcher;
}
