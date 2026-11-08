/**
 * Test-only module hooks that let Node import the PRODUCTION `src/index.ts`.
 *
 * Node cannot load `cloudflare:*` specifiers, and the shared root `src/` uses
 * TypeScript parameter properties that strip-only mode rejects. This hook
 * (1) stubs the `cloudflare:*` runtime modules, (2) replaces the OAuth provider
 * package with a recorder that captures the options the Worker constructs it
 * with (so the real `apiHandler` and `tokenExchangeCallback` closures can be
 * driven directly), and (3) transforms TypeScript instead of strip-only.
 * Nothing here reimplements an authorization decision.
 */
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const CLOUDFLARE_STUB = `
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class WorkflowEntrypoint {}
export class RpcTarget {}
export class EmailMessage {}
export const env = {};
`;

const OAUTH_PROVIDER_RECORDER = `
export const GrantType = { AUTHORIZATION_CODE: "authorization_code", REFRESH_TOKEN: "refresh_token" };
export function getOAuthApi() { throw new Error("getOAuthApi is not available in the recorder"); }
export default class OAuthProvider {
  constructor(options) {
    this.options = options;
    (globalThis.__recordedOAuthProviders ??= []).push(options);
  }
  async fetch(request, env, ctx) {
    return globalThis.__recordedOAuthProviderFetch
      ? globalThis.__recordedOAuthProviderFetch(this.options, request, env, ctx)
      : new Response(null, { status: 204 });
  }
}
`;

const dataModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("cloudflare:")) {
    return { url: dataModule(CLOUDFLARE_STUB), shortCircuit: true };
  }
  if (specifier === "@cloudflare/workers-oauth-provider" && context.parentURL?.includes("/workers/remote-mcp/src/index.ts")) {
    return { url: dataModule(OAUTH_PROVIDER_RECORDER), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file://") && url.endsWith(".ts") && !url.includes("/node_modules/")) {
    const source = await readFile(fileURLToPath(url), "utf8");
    return {
      format: "module",
      source: stripTypeScriptTypes(source, { mode: "transform", sourceUrl: url }),
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
