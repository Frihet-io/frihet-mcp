/**
 * RFC 9728 path-inserted protected-resource metadata for the reviewed host.
 *
 * workers-oauth-provider 0.3.0 serves only `/.well-known/oauth-protected-resource`,
 * whose `resource` is the legacy origin. Claude requires the document it
 * reads to name the exact connector URL (`https://openai-mcp.frihet.io/mcp`),
 * so the Worker serves this second document and the 401 challenge points to
 * it. CORS mirrors the provider's `addCorsHeaders` for its root document so a
 * browser client such as MCP Inspector can read either one.
 *
 * The document is passed in (index.ts supplies
 * `buildReviewedMcpProtectedResourceMetadata()`) so this module has no value
 * imports and runs unchanged under the Node test runner.
 */

const ALLOWED_METHODS = "GET, HEAD, OPTIONS";

function withProviderCors(response: Response, request: Request): Response {
  const origin = request.headers.get("Origin");
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "*");
  headers.set("Access-Control-Allow-Headers", "Authorization, *");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function reviewedMcpProtectedResourceMetadataResponse(
  request: Request,
  metadata: Readonly<Record<string, unknown>>,
): Response {
  if (request.method === "OPTIONS") {
    return withProviderCors(
      new Response(null, { status: 204, headers: { "Content-Length": "0" } }),
      request,
    );
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(
      JSON.stringify({ error: "method_not_allowed" }),
      {
        status: 405,
        headers: { "Content-Type": "application/json", Allow: ALLOWED_METHODS },
      },
    );
  }
  const body = JSON.stringify(metadata);
  return withProviderCors(
    new Response(request.method === "HEAD" ? null : body, {
      headers: { "Content-Type": "application/json" },
    }),
    request,
  );
}
