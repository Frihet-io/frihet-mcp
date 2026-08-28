/**
 * Bind each client-visible MCP session id to the authenticated Frihet principal.
 *
 * The Agents SDK addresses a Durable Object using only `mcp-session-id`. Its
 * `props` initialize the object but are not an authorization check for later
 * requests. Returning a principal-bound envelope prevents a valid token for a
 * different Frihet principal from reusing a leaked session id.
 */

export type SessionPrincipalProps = {
  apiKey?: unknown;
  keyId?: unknown;
  userId?: unknown;
  accessProfile?: unknown;
  authMethod?: unknown;
};

const SESSION_ENVELOPE_VERSION = "v1";
const RAW_SESSION_ID_RE = /^[A-Za-z0-9_-]{16,128}$/u;
const PRINCIPAL_FINGERPRINT_RE = /^[a-f0-9]{64}$/u;
const SESSION_TAG_RE = /^[a-f0-9]{64}$/u;

function normalizedOptional(value: unknown, maxLength: number): string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : "";
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/** Return a stable, non-secret principal binding or undefined for invalid props. */
export async function fingerprintSessionPrincipal(
  props: SessionPrincipalProps | undefined,
): Promise<string | undefined> {
  const apiKey = normalizedOptional(props?.apiKey, 512);
  if (!apiKey) return undefined;

  const material = JSON.stringify([
    "frihet-mcp-session-principal-v1",
    normalizedOptional(props?.accessProfile, 32),
    normalizedOptional(props?.authMethod, 32),
    normalizedOptional(props?.userId, 256),
    normalizedOptional(props?.keyId, 256),
    apiKey,
  ]);
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material)));
}

async function sessionTag(
  rawSessionId: string,
  fingerprint: string,
  signingSecret: string,
): Promise<string | undefined> {
  if (
    !RAW_SESSION_ID_RE.test(rawSessionId)
    || !PRINCIPAL_FINGERPRINT_RE.test(fingerprint)
    || typeof signingSecret !== "string"
    || signingSecret.length < 32
    || signingSecret.length > 4_096
  ) {
    return undefined;
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`frihet-mcp-session-envelope-v1\0${rawSessionId}\0${fingerprint}`),
  ));
}

/** Reject paths that could be prefix-routed to /mcp without being that route. */
export function isMcpRouteConfusion(pathname: string): boolean {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape cannot be the canonical route; inspect its raw form.
  }
  const candidate = decoded.toLowerCase();
  return decoded !== "/mcp"
    && decoded !== "/mcp.json"
    && candidate.startsWith("/mcp");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function bindMcpSessionId(
  rawSessionId: string,
  fingerprint: string,
  signingSecret: string,
): Promise<string | undefined> {
  const tag = await sessionTag(rawSessionId, fingerprint, signingSecret);
  return tag ? `${SESSION_ENVELOPE_VERSION}.${rawSessionId}.${tag}` : undefined;
}

export type UnboundMcpSession =
  | { ok: true; rawSessionId: string }
  | { ok: false };

/** Validate a client-visible id and recover only the SDK's internal id. */
export async function unbindMcpSessionId(
  boundSessionId: string,
  expectedFingerprint: string,
  signingSecret: string,
): Promise<UnboundMcpSession> {
  if (!PRINCIPAL_FINGERPRINT_RE.test(expectedFingerprint)) return { ok: false };
  const match = boundSessionId.match(/^v1\.([A-Za-z0-9_-]{16,128})\.([a-f0-9]{64})$/u);
  if (!match || !SESSION_TAG_RE.test(match[2])) return { ok: false };
  const expectedTag = await sessionTag(match[1], expectedFingerprint, signingSecret);
  if (!expectedTag || !constantTimeEqual(match[2], expectedTag)) return { ok: false };
  return { ok: true, rawSessionId: match[1] };
}

type PrincipalBoundEnvironment = {
  COOKIE_ENCRYPTION_KEY: string;
};

type McpFetchHandler<Environment> = {
  fetch(request: Request, env: Environment, ctx: ExecutionContext): Promise<Response>;
};

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Wrap an authenticated Streamable HTTP MCP handler with principal-bound ids.
 * The OAuth provider has already populated `ctx.props` before this runs.
 */
export function createPrincipalBoundMcpHandler<Environment extends PrincipalBoundEnvironment>(
  unboundHandler: McpFetchHandler<Environment>,
  route = "/mcp",
): McpFetchHandler<Environment> {
  return {
    async fetch(request, env, ctx): Promise<Response> {
      if (new URL(request.url).pathname !== route) {
        return new Response("Not Found", { status: 404 });
      }
      const authProps = (ctx as ExecutionContext & { props?: SessionPrincipalProps }).props;
      const fingerprint = await fingerprintSessionPrincipal(authProps);
      if (!fingerprint) return jsonError("Invalid MCP authentication context", 401);

      let sdkRequest = request;
      let incomingRawSessionId: string | undefined;
      const clientSessionId = request.headers.get("mcp-session-id");
      if (clientSessionId) {
        const unbound = await unbindMcpSessionId(
          clientSessionId,
          fingerprint,
          env.COOKIE_ENCRYPTION_KEY,
        );
        if (!unbound.ok) {
          return jsonError("MCP session does not belong to this principal", 403);
        }
        incomingRawSessionId = unbound.rawSessionId;
        const headers = new Headers(request.headers);
        headers.set("mcp-session-id", incomingRawSessionId);
        sdkRequest = new Request(request, { headers });
      }

      const response = await unboundHandler.fetch(sdkRequest, env, ctx);
      const rawResponseSessionId = response.headers.get("mcp-session-id");
      if (!rawResponseSessionId) return response;
      if (incomingRawSessionId && incomingRawSessionId !== rawResponseSessionId) {
        return jsonError("MCP session response changed identity", 502);
      }

      const boundResponseSessionId = await bindMcpSessionId(
        rawResponseSessionId,
        fingerprint,
        env.COOKIE_ENCRYPTION_KEY,
      );
      if (!boundResponseSessionId) return jsonError("Invalid MCP session response", 502);

      const headers = new Headers(response.headers);
      headers.set("mcp-session-id", boundResponseSessionId);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}
