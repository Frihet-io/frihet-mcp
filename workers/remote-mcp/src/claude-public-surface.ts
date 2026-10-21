import { CLAUDE_CANDIDATE_PROMPTS, CLAUDE_CANDIDATE_TOOLS } from "../../../src/claude-profile.js";
import { MCP_SERVER_VERSION, LEGAL_PRIVACY_URL, LEGAL_TERMS_URL } from "./server-meta.js";
import { FISCAL_MODELO_ALIASES } from "../../../src/fiscal-aliases.js";
import { GROUPED_META_TOOL_COUNT } from "../../../src/tool-exposure.js";
import { CLAUDE_ORIGIN, CLAUDE_MCP_RESOURCE } from "./oauth-profile.js";
import { readReleaseMeta } from "./release-meta.js";

const DOCS = "https://docs.frihet.io/desarrolladores/mcp-server";
const PROVIDER_PATHS = new Set([
  "/mcp", "/authorize", "/callback", "/token", "/register", "/userinfo",
  "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp", "/.well-known/openid-configuration",
]);

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const SUPPORT = page("Frihet Claude connector", `<p>Connect to <code>${CLAUDE_MCP_RESOURCE}</code> with your Frihet account through OAuth. A verified email is required. Your Frihet plan and workspace permissions govern tool availability.</p><p>The operational Claude profile covers supported invoicing, quotes, expenses, CRM, banking, catalog, team and business operations. Guided workflows inspect records and carry out specifically authorized changes. Review configured notifications, webhooks, delivery and fiscal effects before approving an action. Transfers of money, deferred handlers and unsupported e-invoice routes are excluded.</p><p>Connect with a verified Frihet account. Access depends on whether the connector is enabled for your account; your Frihet plan and workspace permissions still apply. Installing the plugin does not grant access or establish Directory availability.</p><p>Credentials expire within 30 days. Disconnect the connector to revoke its grant and schedule credential cleanup; reconnect if the underlying credential has expired.</p><p><a href="${DOCS}">Setup and API documentation</a> · <a href="mailto:hola@frihet.io">Support: hola@frihet.io</a></p>`);
const PRIVACY = page("Frihet Claude connector privacy", `<p>This notice covers <code>${CLAUDE_MCP_RESOURCE}</code> and supplements the <a href="${LEGAL_PRIVACY_URL}">Frihet Privacy Policy</a>. Tools process the workspace records required by your requests: invoices, quotes, expenses, clients, vendors, products, banking, fiscal, team and operational records. They do not request Claude conversation history or memory.</p><p>Anthropic receives the MCP tool inputs and results needed for your requests in Claude, under your Anthropic account terms. Cloudflare handles OAuth and MCP sessions. Firebase Authentication verifies your identity, and Frihet's Google Cloud backend processes business records. The Claude host disables Langfuse telemetry. Frihet backend writes may emit business events to PostHog EU and notify eligible workspace members through Novu according to workspace configuration and the Frihet Privacy Policy. Operational logs contain bounded metadata and sanitized errors; business retention follows the Frihet Privacy Policy.</p><p>OAuth grants contain the credential required to access your workspace. Access tokens last up to one hour; the underlying credential and refresh authorization expire within 30 days. Disconnect revokes the OAuth grant and schedules backend credential cleanup, which may require retries if an upstream service is unavailable.</p><p>Sending invoices, supported VeriFactu operations and configured workspace integrations can disclose records to the selected recipient, fiscal authority, email provider or webhook endpoint. Even draft creation may assign numbering or trigger configured business events. Review those effects before approving a write. Bookkeeping entries and reconciliation do not transfer funds. Sensitive fields are omitted under the shared Claude output policy; free-text fields still require appropriate care. Contact <a href="mailto:hola@frihet.io">hola@frihet.io</a> for privacy questions. <a href="${LEGAL_TERMS_URL}">Frihet Terms</a>.</p>`);

/** Closed public routing keeps the full catalogue and assets off this host. */
export function claudePublicSurface(request: Request, env: Env, grouped: boolean): Response | undefined {
  const path = new URL(request.url).pathname;
  if (PROVIDER_PATHS.has(path)) return undefined;
  const methods = "GET, HEAD, OPTIONS";
  const operationCount = CLAUDE_CANDIDATE_TOOLS.size;
  const aliasCount = Object.values(FISCAL_MODELO_ALIASES).filter((canonical) => CLAUDE_CANDIDATE_TOOLS.has(canonical)).length;
  const toolCount = operationCount + aliasCount + (grouped ? GROUPED_META_TOOL_COUNT : 0);
  const info = {
    name: "Frihet", version: MCP_SERVER_VERSION,
    description: "Business records and authorized ERP workflows through the Frihet Claude profile.",
    mcp: CLAUDE_MCP_RESOURCE, docs: DOCS, privacy: `${CLAUDE_ORIGIN}/privacy`, support: `${CLAUDE_ORIGIN}/support`,
    auth: { type: "oauth2", authorization_server: `${CLAUDE_ORIGIN}/.well-known/oauth-authorization-server` },
    tools: toolCount, catalogueOperations: operationCount, aliasNames: aliasCount,
    discoveryNames: grouped ? GROUPED_META_TOOL_COUNT : 0, resources: 1, prompts: CLAUDE_CANDIDATE_PROMPTS.size,
  };
  const surfaces: Record<string, { body: string; type: string }> = {
    "/": { body: JSON.stringify(info), type: "application/json" },
    "/.well-known/mcp": { body: JSON.stringify(info), type: "application/json" },
    "/mcp.json": { body: JSON.stringify(info), type: "application/json" },
    "/health": { body: JSON.stringify({ status: "ok", accessProfile: "claude", ...readReleaseMeta(env) }), type: "application/json" },
    "/support": { body: SUPPORT, type: "text/html; charset=utf-8" },
    "/privacy": { body: PRIVACY, type: "text/html; charset=utf-8" },
    "/robots.txt": { body: `User-agent: *\nAllow: /\nSitemap: ${CLAUDE_ORIGIN}/sitemap.xml\n`, type: "text/plain; charset=utf-8" },
    "/sitemap.xml": { body: `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${CLAUDE_ORIGIN}/</loc></url></urlset>`, type: "application/xml" },
    "/llms.txt": { body: `# Frihet Claude profile\n\n${info.description}\n\nMCP: ${CLAUDE_MCP_RESOURCE}\nDocumentation: ${DOCS}\nSupport: ${CLAUDE_ORIGIN}/support\nPrivacy: ${CLAUDE_ORIGIN}/privacy\n${operationCount} canonical operations, ${aliasCount} aliases, 1 remote resource, ${info.prompts} prompts. Discover availability through this session's MCP lists.\n`, type: "text/plain; charset=utf-8" },
  };
  const surface = surfaces[path];
  if (!surface) return new Response("Not Found", { status: 404 });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { Allow: methods } });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: methods } });
  }
  return new Response(request.method === "HEAD" ? null : surface.body, { headers: { "Content-Type": surface.type } });
}
