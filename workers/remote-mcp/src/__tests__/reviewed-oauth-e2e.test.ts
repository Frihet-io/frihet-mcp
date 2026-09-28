/**
 * End-to-end pin for the reviewed host's OAuth flow with both accepted RFC 8707
 * resource identifiers.
 *
 * Runs the exact locked workers-oauth-provider 0.3.0 dist (only its
 * `cloudflare:workers` import line is replaced by a local base class, which the
 * provider uses solely for handler type detection) together with the real
 * OAuthTokenFamilyExchange and OAuthStateStore. KV and the Durable Object
 * namespace are in-memory fakes. The flow mirrors index.ts: DCR ->
 * authorize (boundary check) -> completeAuthorization -> POST /token guarded by
 * the token family -> settle -> refresh -> API call on /mcp.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  FRIHET_CONNECTOR_SCOPE,
  OAUTH_PROVIDER_REVIEW_OPTIONS,
  OPENAI_REVIEW_MCP_RESOURCE,
  OPENAI_REVIEW_OAUTH_RESOURCES,
  OPENAI_REVIEW_ORIGIN,
  validateOAuthBoundary,
} from "../../../../src/openai-review-oauth.ts";
import { OAuthStateStore } from "../oauth-state-store.ts";
import { OAuthTokenFamilyExchange } from "../oauth-token-family.ts";

const PROVIDER_IMPORT_LINE = 'import { WorkerEntrypoint } from "cloudflare:workers";';

async function loadLockedProvider(): Promise<{
  OAuthProvider: new (options: Record<string, unknown>) => {
    fetch(request: Request, env: Record<string, unknown>, ctx: unknown): Promise<Response>;
  };
  getOAuthApi: (options: Record<string, unknown>, env: Record<string, unknown>) => unknown;
}> {
  const source = readFileSync(
    fileURLToPath(
      new URL(
        "../../node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const newline = source.indexOf("\n");
  assert.equal(
    source.slice(0, newline),
    PROVIDER_IMPORT_LINE,
    "the locked provider entry changed; re-review this harness",
  );
  const dir = mkdtempSync(join(tmpdir(), "frihet-oauth-provider-"));
  const file = join(dir, "oauth-provider.mjs");
  writeFileSync(file, `class WorkerEntrypoint {}${source.slice(newline)}`);
  return import(pathToFileURL(file).href);
}

class FakeKv {
  readonly values = new Map<string, string>();

  async get(key: string, options?: { type?: string } | string): Promise<unknown> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    const type = typeof options === "string" ? options : options?.type;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(options: { prefix?: string } = {}) {
    const prefix = options.prefix ?? "";
    return {
      keys: [...this.values.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    };
  }
}

class FakeStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async transaction<T>(callback: (transaction: DurableObjectTransaction) => Promise<T>): Promise<T> {
    const snapshot = new Map(
      [...this.values].map(([key, value]) => [key, structuredClone(value)]),
    );
    try {
      return await callback(this as unknown as DurableObjectTransaction);
    } catch (error) {
      this.values.clear();
      for (const [key, value] of snapshot) this.values.set(key, value);
      throw error;
    }
  }

  async setAlarm(): Promise<void> {}

  async deleteAll(): Promise<void> {
    this.values.clear();
  }
}

class FakeState {
  readonly storage = new FakeStorage();
  private queue: Promise<void> = Promise.resolve();

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const prior = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return prior.then(callback).finally(release);
  }
}

class FakeDurableObjectNamespace {
  private readonly stores = new Map<string, OAuthStateStore>();

  idFromName(name: string): DurableObjectId {
    return { name } as unknown as DurableObjectId;
  }

  get(id: DurableObjectId): DurableObjectStub {
    const name = (id as unknown as { name: string }).name;
    let store = this.stores.get(name);
    if (!store) {
      store = new OAuthStateStore(new FakeState() as unknown as DurableObjectState);
      this.stores.set(name, store);
    }
    return {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        store!.fetch(new Request(input, init)),
    } as unknown as DurableObjectStub;
  }
}

const USER_ID = "firebase-reviewer";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const CODE_VERIFIER = "v".repeat(64);
const BINDING = {
  uid: USER_ID,
  keyId: "AbCdEfGhIjKlMnOpQrSt",
  accessProfile: "openai",
  oauthResource: OPENAI_REVIEW_ORIGIN,
} as const;
const PROPS = {
  apiKey: `fri_${"A".repeat(43)}`,
  keyId: BINDING.keyId,
  apiKeyExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  userId: USER_ID,
  accessProfile: "openai",
  oauthScope: FRIHET_CONNECTOR_SCOPE,
  oauthResource: OPENAI_REVIEW_ORIGIN,
  authMethod: "oauth",
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function s256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("base64url");
}

async function harness() {
  const { OAuthProvider, getOAuthApi } = await loadLockedProvider();
  const kv = new FakeKv();
  const namespace = new FakeDurableObjectNamespace();
  const env: Record<string, unknown> = { OAUTH_KV: kv };

  const providerOptions = (exchange?: OAuthTokenFamilyExchange) => ({
    ...OAUTH_PROVIDER_REVIEW_OPTIONS,
    apiHandler: { fetch: async () => new Response("reviewed-mcp") },
    defaultHandler: { fetch: async () => new Response("not found", { status: 404 }) },
    tokenExchangeCallback: async (options: { props: unknown }) => {
      if (exchange) await exchange.reserve(options as never, BINDING);
      return {
        accessTokenProps: options.props,
        newProps: options.props,
        accessTokenScope: [FRIHET_CONNECTOR_SCOPE],
        accessTokenTTL: 3600,
      };
    },
  });
  const provider = (exchange?: OAuthTokenFamilyExchange) =>
    new OAuthProvider(providerOptions(exchange));

  /** index.ts pre-provider /token boundary + guarded provider + settle. */
  async function token(form: URLSearchParams) {
    const resources = form.getAll("resource");
    const boundary = validateOAuthBoundary(
      {
        resource: resources.length === 0 ? undefined : resources.length === 1 ? resources[0] : resources,
        scope: undefined,
        requireResource: false,
        requireScope: false,
      },
      OPENAI_REVIEW_OAUTH_RESOURCES,
    );
    assert.equal(boundary.ok, true, "the Worker token boundary must admit this request");
    const exchange = OAuthTokenFamilyExchange.fromForm(
      form,
      namespace as unknown as DurableObjectNamespace,
      kv as unknown as KVNamespace,
      OPENAI_REVIEW_OAUTH_RESOURCES,
    );
    assert.ok(exchange, "token family guard must engage");
    const response = await provider(exchange).fetch(
      new Request(`${OPENAI_REVIEW_ORIGIN}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      env,
      ctx,
    );
    const settlement = await exchange.settle(response);
    const body = await settlement.response.clone().json() as Record<string, unknown>;
    return { settlement, body };
  }

  async function authorize(resource: string): Promise<{ clientId: string; code: string }> {
    const registration = await provider().fetch(
      new Request(`${OPENAI_REVIEW_ORIGIN}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          client_name: "Claude",
        }),
      }),
      env,
      ctx,
    );
    assert.equal(registration.status, 201);
    const clientId = (await registration.json() as { client_id: string }).client_id;

    const url = new URL(`${OPENAI_REVIEW_ORIGIN}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: FRIHET_CONNECTOR_SCOPE,
      state: "state-1",
      code_challenge: await s256(CODE_VERIFIER),
      code_challenge_method: "S256",
      resource,
    }).toString();
    const helpers = getOAuthApi(providerOptions(), env) as {
      parseAuthRequest(request: Request): Promise<{ resource?: string; scope: string[] }>;
      completeAuthorization(options: Record<string, unknown>): Promise<{ redirectTo: string }>;
    };
    const oauthReq = await helpers.parseAuthRequest(new Request(url));
    assert.deepEqual(
      validateOAuthBoundary(
        { resource: oauthReq.resource, scope: oauthReq.scope, requireResource: true, requireScope: true },
        OPENAI_REVIEW_OAUTH_RESOURCES,
      ),
      { ok: true },
    );
    const { redirectTo } = await helpers.completeAuthorization({
      request: oauthReq,
      userId: USER_ID,
      metadata: {},
      scope: oauthReq.scope,
      props: PROPS,
    });
    const code = new URL(redirectTo).searchParams.get("code");
    assert.ok(code);
    return { clientId, code };
  }

  async function callMcp(accessToken: string, origin = OPENAI_REVIEW_ORIGIN) {
    return provider().fetch(
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: "{}",
      }),
      env,
      ctx,
    );
  }

  return { authorize, token, callMcp };
}

for (const resource of OPENAI_REVIEW_OAUTH_RESOURCES) {
  for (const sendResourceAtToken of [false, true]) {
    test(`authorize -> token -> refresh -> /mcp succeeds for resource ${resource}${sendResourceAtToken ? " (echoed at /token)" : ""}`, async () => {
      const { authorize, token, callMcp } = await harness();
      const { clientId, code } = await authorize(resource);

      const codeForm = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_verifier: CODE_VERIFIER,
      });
      if (sendResourceAtToken) codeForm.set("resource", resource);
      const first = await token(codeForm);
      assert.equal(first.settlement.response.status, 200, JSON.stringify(first.body));
      assert.equal(first.settlement.revokeGrant, false);
      assert.equal(first.body.resource, resource);
      assert.equal(first.body.scope, FRIHET_CONNECTOR_SCOPE);

      const refreshForm = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: String(first.body.refresh_token),
        client_id: clientId,
      });
      if (sendResourceAtToken) refreshForm.set("resource", resource);
      const refreshed = await token(refreshForm);
      assert.equal(refreshed.settlement.response.status, 200, JSON.stringify(refreshed.body));
      assert.equal(refreshed.settlement.revokeGrant, false);
      assert.equal(refreshed.body.resource, resource);

      const api = await callMcp(String(refreshed.body.access_token));
      assert.equal(api.status, 200);
      assert.equal(await api.text(), "reviewed-mcp");

      const crossHost = await callMcp(String(refreshed.body.access_token), "https://mcp.frihet.io");
      assert.equal(crossHost.status, 401, "a reviewed-host token must not authorize the full host");
    });
  }
}

test("a /token resource outside the authorized grant is refused without issuing tokens", async () => {
  const { authorize, token } = await harness();
  const { clientId, code } = await authorize(OPENAI_REVIEW_MCP_RESOURCE);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_verifier: CODE_VERIFIER,
    resource: OPENAI_REVIEW_ORIGIN,
  });
  const result = await token(form);
  assert.equal(result.settlement.response.status, 400);
  assert.equal("access_token" in result.body, false);
  assert.equal("refresh_token" in result.body, false);
});
