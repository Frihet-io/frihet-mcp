/**
 * Route-level harness for the reviewed host's real OAuth flow:
 * `/register -> /authorize -> /callback -> provision -> completeAuthorization
 * -> /token -> /mcp`.
 *
 * Runs the exact locked workers-oauth-provider 0.3.0 dist (only its
 * `cloudflare:workers` import line is replaced) with the production
 * `authHandler`, `OAuthStateStore` and token-family exchange. Firebase ID
 * tokens are real RS256 JWTs verified by the real verifier against a local
 * key seeded in KV. The ERP provisioning authority is an in-memory fake of the
 * documented contract installed on `globalThis.fetch`, with fault injection at
 * every boundary. KV and Durable Objects are in-memory fakes with fault hooks.
 *
 * Not a test file (outside the `*.test.ts` glob): reusable by route tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  OAUTH_PROVIDER_REVIEW_OPTIONS,
  OPENAI_REVIEW_MCP_RESOURCE,
  OPENAI_REVIEW_OAUTH_RESOURCES,
  OPENAI_REVIEW_OAUTH_SCOPES,
  OPENAI_REVIEW_ORIGIN,
} from "../../../../../src/openai-review-oauth.ts";
import { authHandler } from "../../auth-handler.ts";
import { OAuthStateStore } from "../../oauth-state-store.ts";
import {
  isOAuthAccessTokenFamilyActive,
  OAuthTokenFamilyExchange,
} from "../../oauth-token-family.ts";

const PROVIDER_IMPORT_LINE = 'import { WorkerEntrypoint } from "cloudflare:workers";';
export const ERP_AUTHORITY_URL =
  "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/oauthApiKeyProvisioning";
export const FIREBASE_PROJECT_ID = "frihet-route-test";
export const SERVICE_SECRET = "route-test-service-secret-0123456789abcdef";
export const USER_ID = "firebase-route-user";
export const REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";
const CODE_VERIFIER = "v".repeat(64);
const FIREBASE_KID = "route-test-kid";

type LockedProvider = {
  OAuthProvider: new (options: Record<string, unknown>) => {
    fetch(request: Request, env: Record<string, unknown>, ctx: unknown): Promise<Response>;
  };
};

let lockedProvider: Promise<LockedProvider> | undefined;

function loadLockedProvider(): Promise<LockedProvider> {
  lockedProvider ??= (async () => {
    const source = readFileSync(
      fileURLToPath(
        new URL(
          "../../../node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js",
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
    const dir = mkdtempSync(join(tmpdir(), "frihet-oauth-route-"));
    try {
      const file = join(dir, "oauth-provider.mjs");
      writeFileSync(file, `class WorkerEntrypoint {}${source.slice(newline)}`);
      return await import(pathToFileURL(file).href) as LockedProvider;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
  return lockedProvider;
}

// ---------------------------------------------------------------------------
// Firebase: one local RS256 signing key, published through the KV key cache
// ---------------------------------------------------------------------------

const firebaseKeys = crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
) as Promise<CryptoKeyPair>;

async function firebasePublicJwks(): Promise<string> {
  const jwk = await crypto.subtle.exportKey("jwk", (await firebaseKeys).publicKey);
  return JSON.stringify([{ ...jwk, kid: FIREBASE_KID }]);
}

function base64url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

/** Mint a Firebase-shaped ID token; `expired`/`kid` produce verifier failures. */
export async function mintIdToken(
  options: { uid?: string; expired?: boolean; kid?: string } = {},
): Promise<string> {
  const uid = options.uid ?? USER_ID;
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = options.expired ? now - 7200 : now - 5;
  const header = { alg: "RS256", kid: options.kid ?? FIREBASE_KID, typ: "JWT" };
  const payload = {
    iss: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
    aud: FIREBASE_PROJECT_ID,
    sub: uid,
    user_id: uid,
    iat: issuedAt,
    auth_time: issuedAt,
    exp: options.expired ? now - 3600 : now + 3600,
    email: "route-user@example.com",
    email_verified: true,
    firebase: { identities: {}, sign_in_provider: "password" },
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    (await firebaseKeys).privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

// ---------------------------------------------------------------------------
// KV and Durable Object fakes
// ---------------------------------------------------------------------------

export class FakeKv {
  readonly values = new Map<string, string>();
  grantWrites = 0;
  /** Throws on the matching put before writing; return true to fail it. */
  putFault: ((key: string) => boolean) | undefined;

  async get(key: string, options?: { type?: string } | string): Promise<unknown> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    const type = typeof options === "string" ? options : options?.type;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: unknown): Promise<void> {
    if (this.putFault?.(key)) throw new Error("injected KV put failure");
    if (key.startsWith("grant:") && !this.values.has(key)) this.grantWrites += 1;
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

  grantKeys(): string[] {
    return [...this.values.keys()].filter((key) => key.startsWith("grant:"));
  }
}

export class FakeStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;

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

  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
  }
}

export class FakeState {
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

type StoreLike = { fetch(request: Request): Promise<Response>; alarm(): Promise<void> };
export type StateStoreFactory = (state: FakeState, env: Record<string, unknown>) => StoreLike;

type DoFault = { path: string; when: "before" | "after"; remaining: number };

export class FakeDurableObjectNamespace {
  readonly objects = new Map<string, { state: FakeState; store: StoreLike }>();
  private readonly faults: DoFault[] = [];
  private readonly env: Record<string, unknown>;
  private readonly events: string[];
  private readonly factory: StateStoreFactory;

  constructor(env: Record<string, unknown>, events: string[], factory: StateStoreFactory) {
    this.env = env;
    this.events = events;
    this.factory = factory;
  }

  /** Fail the next `times` stub calls to `path`: before reaching the object, or after it ran (lost response). */
  fail(path: string, when: "before" | "after", times = 1): void {
    this.faults.push({ path, when, remaining: times });
  }

  idFromName(name: string): DurableObjectId {
    return { name } as unknown as DurableObjectId;
  }

  object(name: string): { state: FakeState; store: StoreLike } {
    let entry = this.objects.get(name);
    if (!entry) {
      const state = new FakeState();
      entry = { state, store: this.factory(state, this.env) };
      this.objects.set(name, entry);
    }
    return entry;
  }

  get(id: DurableObjectId): DurableObjectStub {
    const name = (id as unknown as { name: string }).name;
    return {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (!path.startsWith("/token-family")) this.events.push(`do:${path}`);
        const fault = this.faults.find((entry) => entry.path === path && entry.remaining > 0);
        if (fault?.when === "before") {
          fault.remaining -= 1;
          throw new Error("injected Durable Object failure");
        }
        const response = await this.object(name).store.fetch(request);
        if (fault?.when === "after") {
          fault.remaining -= 1;
          throw new Error("injected Durable Object lost response");
        }
        return response;
      },
    } as unknown as DurableObjectStub;
  }
}

export const productionStateStore: StateStoreFactory = (state, env) =>
  new OAuthStateStore(state as unknown as DurableObjectState, env as never);

/**
 * Regression mutant: the pre-lease contract, where the first callback to take
 * a state destroys it before any I/O. The taking attempt still runs, but no
 * later callback can reserve the state again. Route tests must fail on it.
 */
export const consumeOnReserveStateStore: StateStoreFactory = (state, env) => {
  const store = new OAuthStateStore(state as unknown as DurableObjectState, env as never);
  let consumed = false;
  return {
    alarm: () => store.alarm(),
    async fetch(request: Request): Promise<Response> {
      const reserve = new URL(request.url).pathname === "/reserve";
      if (reserve && consumed) {
        return new Response(JSON.stringify({ outcome: "missing" }), { status: 200 });
      }
      const response = await store.fetch(request);
      if (reserve) {
        const body = await response.clone().json() as { outcome?: string };
        consumed ||= body.outcome === "reserved";
      }
      return response;
    },
  };
};

// ---------------------------------------------------------------------------
// ERP provisioning authority (documented contract, in memory)
// ---------------------------------------------------------------------------

export type PostFault =
  | { kind: "network-before" }
  | { kind: "lost-after" }
  | { kind: "timeout-after" }
  | { kind: "status-before"; status: number; body?: unknown }
  | { kind: "status-after"; status: number; body?: unknown }
  | { kind: "malformed-after" }
  | { kind: "hang" };

export type DeleteFault =
  | { kind: "network" }
  | { kind: "status"; status: number }
  /** Runs `before` (e.g. advance the clock: a slow DELETE), then answers normally. */
  | { kind: "slow"; before: () => void }
  /** Revokes as asked, but answers a bare 200 that is not the proof shape. */
  | { kind: "not-proof" };

type IssuedKey = { uid: string; correlationId: string; apiKey: string; revoked: boolean };

function randomAlnum(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return [...crypto.getRandomValues(new Uint8Array(length))]
    .map((byte) => alphabet[byte % alphabet.length])
    .join("");
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class FakeErpAuthority {
  readonly keys = new Map<string, IssuedKey>();
  readonly correlations = new Map<string, { uid: string; keyId?: string; tombstoned: boolean }>();
  readonly postCorrelations: string[] = [];
  readonly postFaults: PostFault[] = [];
  readonly deleteFaults: DeleteFault[] = [];
  private hangRelease: (() => void) | undefined;
  private hangArrived: (() => void) | undefined;
  readonly hangStarted: Promise<void>;
  private readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
    this.hangStarted = new Promise((resolve) => {
      this.hangArrived = resolve;
    });
  }

  activeKeyIds(): string[] {
    return [...this.keys].filter(([, key]) => !key.revoked).map(([keyId]) => keyId);
  }

  issuedApiKeys(): string[] {
    return [...this.keys.values()].map((key) => key.apiKey);
  }

  releaseHang(): void {
    this.hangRelease?.();
  }

  private mint(uid: string, correlationId: string) {
    const keyId = randomAlnum(20);
    const apiKey = `fri_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    this.keys.set(keyId, { uid, correlationId, apiKey, revoked: false });
    this.correlations.set(correlationId, { uid, keyId, tombstoned: false });
    return {
      apiKey,
      keyId,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  private async provision(uid: string, correlationId: string, fault: PostFault | undefined): Promise<Response> {
    if (fault?.kind === "hang") {
      await new Promise<void>((resolve) => {
        this.hangRelease = resolve;
        this.hangArrived?.();
      });
    }
    if (fault?.kind === "network-before") throw new TypeError("fetch failed");
    if (fault?.kind === "status-before") {
      return json(fault.body ?? { error: "injected" }, fault.status);
    }
    if (this.correlations.has(correlationId)) {
      return json({ error: "OAuth API-key correlation already consumed" }, 409);
    }
    const issued = this.mint(uid, correlationId);
    if (fault?.kind === "lost-after") throw new TypeError("fetch failed");
    if (fault?.kind === "timeout-after") {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    if (fault?.kind === "status-after") {
      return json(fault.body ?? { error: "injected" }, fault.status);
    }
    if (fault?.kind === "malformed-after") {
      return json({ apiKey: issued.apiKey, keyId: issued.keyId });
    }
    return json(issued);
  }

  private revokeCorrelation(uid: string, correlationId: string): Response {
    const existing = this.correlations.get(correlationId);
    if (existing && existing.uid !== uid) return json({ error: "not found" }, 404);
    const key = existing?.keyId ? this.keys.get(existing.keyId) : undefined;
    const alreadyRevoked = existing?.tombstoned === true || key?.revoked === true;
    if (key) key.revoked = true;
    this.correlations.set(correlationId, { uid, keyId: existing?.keyId, tombstoned: true });
    return json({ revoked: true, alreadyRevoked, correlationTombstoned: true, activeKeys: 0 });
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    assert.equal(request.url, ERP_AUTHORITY_URL, `unexpected outbound fetch: ${request.url}`);
    assert.equal(request.headers.get("x-frihet-oauth-key"), SERVICE_SECRET);
    const body = await request.json() as Record<string, unknown>;
    const uid = String(body.uid);
    if (request.method === "POST") {
      assert.deepEqual(Object.keys(body).sort(), ["correlationId", "uid"]);
      assert.match(request.headers.get("authorization") ?? "", /^Bearer \S+$/u);
      const correlationId = String(body.correlationId);
      this.events.push(`erp:POST:${correlationId}`);
      this.postCorrelations.push(correlationId);
      return this.provision(uid, correlationId, this.postFaults.shift());
    }
    assert.equal(request.method, "DELETE");
    assert.equal(request.headers.get("authorization"), null, "revocation never sends a user token");
    if (typeof body.correlationId === "string") {
      this.events.push(`erp:DELETE:${body.correlationId}`);
      const fault = this.deleteFaults.shift();
      if (fault?.kind === "slow") fault.before();
      if (fault?.kind === "network") throw new TypeError("fetch failed");
      if (fault?.kind === "status") return json({ error: "injected" }, fault.status);
      const revoked = this.revokeCorrelation(uid, body.correlationId);
      return fault?.kind === "not-proof" ? json({ revoked: true }) : revoked;
    }
    const key = this.keys.get(String(body.keyId));
    if (!key || key.uid !== uid) return json({ error: "not found" }, 404);
    key.revoked = true;
    return json({ revoked: true });
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export type CallbackResult = { status: number; body: Record<string, unknown> };

async function s256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("base64url");
}

function executionContext(): Record<string, unknown> {
  return { waitUntil() {}, passThroughOnException() {} };
}

export async function createOAuthRouteHarness(
  t: TestContext,
  options: { stateStore?: StateStoreFactory } = {},
) {
  const { OAuthProvider } = await loadLockedProvider();
  const events: string[] = [];
  const logs: string[] = [];
  const clock = { offsetMs: 0 };
  const realNow = Date.now.bind(Date);
  t.mock.method(Date, "now", () => realNow() + clock.offsetMs);
  t.mock.method(console, "error", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  const erp = new FakeErpAuthority(events);
  t.mock.method(globalThis, "fetch", erp.fetch);

  const kv = new FakeKv();
  // The Firebase key cache is a per-process singleton bound to the first KV it
  // sees, so every harness seeds the same verifier key.
  kv.values.set("firebase-public-keys", await firebasePublicJwks());
  const env: Record<string, unknown> = {
    OAUTH_KV: kv,
    FIREBASE_PROJECT_ID,
    FRIHET_OPENAI_MODE: "true",
    FRIHET_API_BASE: "https://api.frihet.io/v1",
    FRIHET_OAUTH_API_KEY: SERVICE_SECRET,
  };
  const namespace = new FakeDurableObjectNamespace(
    env,
    events,
    options.stateStore ?? productionStateStore,
  );
  env.OAUTH_STATE = namespace;

  const apiHandler = {
    async fetch(request: Request, handlerEnv: Record<string, unknown>, ctx: { props?: Record<string, unknown> }) {
      const userId = typeof ctx.props?.userId === "string" ? ctx.props.userId : undefined;
      if (!await isOAuthAccessTokenFamilyActive(
        handlerEnv.OAUTH_STATE as DurableObjectNamespace,
        request,
        userId,
      )) {
        return json({ error: "invalid_token" }, 401);
      }
      return json({ keyId: ctx.props?.keyId, userId });
    },
  };
  const provider = (exchange?: OAuthTokenFamilyExchange) => new OAuthProvider({
    ...OAUTH_PROVIDER_REVIEW_OPTIONS,
    apiHandler,
    defaultHandler: authHandler,
    // Mirrors the Worker's guarded provider: the token family is bound to the
    // exact backend key carried by the grant the callback completed.
    tokenExchangeCallback: async (callbackOptions: { props: Record<string, unknown>; userId: string }) => {
      const props = callbackOptions.props;
      if (exchange) {
        await exchange.reserve(callbackOptions as never, {
          uid: callbackOptions.userId,
          keyId: String(props.keyId),
          accessProfile: "openai",
          oauthResource: OPENAI_REVIEW_ORIGIN,
        });
      }
      return {
        accessTokenProps: props,
        newProps: props,
        accessTokenScope: [...OPENAI_REVIEW_OAUTH_SCOPES],
        accessTokenTTL: 3600,
      };
    },
  });
  const send = (request: Request, exchange?: OAuthTokenFamilyExchange) =>
    provider(exchange).fetch(request, env, executionContext());

  async function register(): Promise<string> {
    const registration = await send(new Request(`${OPENAI_REVIEW_ORIGIN}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "ChatGPT",
      }),
    }));
    assert.equal(registration.status, 201);
    return (await registration.json() as { client_id: string }).client_id;
  }

  /**
   * DCR (unless reconnecting an existing client) + GET /authorize; returns
   * the state the login page would post back.
   */
  async function startLogin(
    existingClientId?: string,
  ): Promise<{ clientId: string; stateKey: string }> {
    const clientId = existingClientId ?? await register();
    const url = new URL(`${OPENAI_REVIEW_ORIGIN}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: OPENAI_REVIEW_OAUTH_SCOPES.join(" "),
      state: "client-state",
      code_challenge: await s256(CODE_VERIFIER),
      code_challenge_method: "S256",
      resource: OPENAI_REVIEW_MCP_RESOURCE,
    }).toString();
    const page = await send(new Request(url));
    assert.equal(page.status, 200);
    const html = await page.text();
    const match = /<script type="application\/json" id="server-data">(.*?)<\\?\/script>/su.exec(html);
    assert.ok(match, "login page must embed its server data");
    const { stateKey } = JSON.parse(match[1]!) as { stateKey: string };
    return { clientId, stateKey };
  }

  /** POST /callback exactly as the login page does. */
  async function callback(stateKey: string, idToken: string): Promise<CallbackResult> {
    const response = await send(new Request(`${OPENAI_REVIEW_ORIGIN}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stateKey, idToken, locale: "es" }),
    }));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  /** Redeem the callback's code at /token and call /mcp with the access token. */
  async function redeem(clientId: string, redirectTo: unknown) {
    assert.equal(typeof redirectTo, "string");
    const code = new URL(redirectTo as string).searchParams.get("code");
    assert.ok(code, "redirect must carry an authorization code");
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: CODE_VERIFIER,
    });
    const exchange = OAuthTokenFamilyExchange.fromForm(
      form,
      namespace as unknown as DurableObjectNamespace,
      kv as unknown as KVNamespace,
      OPENAI_REVIEW_OAUTH_RESOURCES,
    );
    assert.ok(exchange, "token family guard must engage");
    const tokenResponse = await send(new Request(`${OPENAI_REVIEW_ORIGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }), exchange);
    const settlement = await exchange.settle(tokenResponse);
    const tokens = await settlement.response.json() as Record<string, unknown>;
    assert.equal(settlement.response.status, 200, JSON.stringify(tokens));
    const accessToken = String(tokens.access_token);
    const mcp = await callMcp(accessToken);
    assert.equal(mcp.status, 200);
    return { ...await mcp.json() as { keyId: string; userId: string }, accessToken };
  }

  function callMcp(accessToken: string): Promise<Response> {
    return send(new Request(`${OPENAI_REVIEW_ORIGIN}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: "{}",
    }));
  }

  /** Run the expired-state alarm of the state object behind `stateKey`. */
  async function runStateAlarm(stateKey: string) {
    const entry = namespace.object(stateKey);
    await entry.store.alarm();
    return entry.state.storage;
  }

  return {
    env,
    kv,
    namespace,
    erp,
    events,
    logs,
    clock,
    startLogin,
    callback,
    redeem,
    callMcp,
    runStateAlarm,
  };
}
