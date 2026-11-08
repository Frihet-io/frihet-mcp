/**
 * Route-level harness for the reviewed host's real OAuth flow:
 * `/register -> /authorize -> /callback -> provision -> completeAuthorization
 * -> /token -> /mcp`.
 *
 * Runs locked workers-oauth-provider 0.3.0 dist, with the audited localhost
 * build patch only for Claude and a Node adapter for `cloudflare:workers`, with the production
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
import { patchClaudeOAuthProvider } from "../../../../../scripts/prepare-claude-oauth-provider.mjs";

import {
  OAUTH_PROVIDER_REVIEW_OPTIONS,
  buildReviewedMcpProtectedResourceMetadata,
  OPENAI_REVIEW_OAUTH_SCOPES,
  OPENAI_REVIEW_ORIGIN,
} from "../../../../../src/openai-review-oauth.ts";
import { authHandler } from "../../auth-handler.ts";
import {
  DEFAULT_CLEANUP_AUTHORITIES,
  type OAuthCleanupAuthorities,
  OAuthStateStore,
} from "../../oauth-state-store.ts";
import { boundOAuthProfile, CLAUDE_ORIGIN, ClaudeAdmissionPolicyError, claudeAdmissionUnavailableResponse, isClaudeIdentityAdmitted, isVerifiedClaudeIdentity, resolveWorkerAccessProfile } from "../../oauth-profile.ts";
import { resolveOAuthApiKeyUrl } from "../../api-url.ts";
import {
  reconcileOAuthApiKeyCorrelation,
  resolveOAuthServiceSecret,
} from "../../oauth-provisioning.ts";
import {
  isOAuthAccessTokenFamilyActive,
  OAuthTokenFamilyExchange,
  OAuthTokenFamilyRevocation,
} from "../../oauth-token-family.ts";

const PROVIDER_IMPORT_LINE = 'import { WorkerEntrypoint } from "cloudflare:workers";';
export const ERP_AUTHORITY_URL =
  "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/oauthApiKeyProvisioning";
export const FIREBASE_PROJECT_ID = "frihet-route-test";
export const SERVICE_SECRET = "route-test-service-secret-0123456789abcdef";
export const CLAUDE_SERVICE_SECRET = "claude-route-test-service-secret-0123456789abcdef";
export const USER_ID = "firebase-route-user";
export const REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";
export const CLAUDE_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const CODE_VERIFIER = "v".repeat(64);
const FIREBASE_KID = "route-test-kid";

type LockedProvider = {
  OAuthProvider: new (options: Record<string, unknown>) => {
    fetch(request: Request, env: Record<string, unknown>, ctx: unknown): Promise<Response>;
  };
  getOAuthApi(options: Record<string, unknown>, env: unknown): {
    revokeGrant(grantId: string, userId: string): Promise<void>;
  };
};

const lockedProviders: Partial<Record<"openai" | "claude", Promise<LockedProvider>>> = {};

function loadLockedProvider(profile: "openai" | "claude"): Promise<LockedProvider> {
  lockedProviders[profile] ??= (async () => {
    let source = readFileSync(
      fileURLToPath(
        new URL(
          "../../../node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    if (profile === "claude") {
      const sdkVersion = JSON.parse(readFileSync(new URL(
        "../../../node_modules/@cloudflare/workers-oauth-provider/package.json", import.meta.url,
      ), "utf8")).version;
      source = patchClaudeOAuthProvider(source, sdkVersion);
    }
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
  return lockedProviders[profile]!;
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
  options: { uid?: string; expired?: boolean; kid?: string; email?: unknown; emailVerified?: unknown } = {},
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
    email: "email" in options ? options.email : "route-user@example.com",
    email_verified: "emailVerified" in options ? options.emailVerified : true,
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

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(options: { prefix?: string } = {}): Promise<Map<string, unknown>> {
    const prefix = options.prefix ?? "";
    const matched = new Map<string, unknown>();
    for (const [key, value] of this.values) {
      if (key.startsWith(prefix)) matched.set(key, structuredClone(value));
    }
    return matched;
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

const UNUSED_HANDLER = {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};

/**
 * The production cleanup authorities, except that `revokeGrant` runs on the
 * same locked provider dist as the routes: Node cannot load the
 * `cloudflare:workers` entry the Durable Object imports.
 */
const HARNESS_CLEANUP_AUTHORITIES: OAuthCleanupAuthorities = {
  ...DEFAULT_CLEANUP_AUTHORITIES,
  async revokeGrant(env, userId, grantId): Promise<void> {
    const { getOAuthApi } = await loadLockedProvider();
    await getOAuthApi(
      { ...OAUTH_PROVIDER_REVIEW_OPTIONS, apiHandler: UNUSED_HANDLER, defaultHandler: UNUSED_HANDLER },
      env,
    ).revokeGrant(grantId, userId);
  },
};

export const productionStateStore: StateStoreFactory = (state, env) =>
  new OAuthStateStore(state as unknown as DurableObjectState, env as never, HARNESS_CLEANUP_AUTHORITIES);

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
  readonly requests: Array<{ method: string; body: Record<string, unknown> }> = [];
  private hangRelease: (() => void) | undefined;
  private hangArrived: (() => void) | undefined;
  readonly hangStarted: Promise<void>;
  private readonly events: string[];
  private readonly authorityUrl: string;
  private readonly serviceSecret: string;

  constructor(events: string[], authorityUrl = ERP_AUTHORITY_URL, serviceSecret = SERVICE_SECRET) {
    this.events = events;
    this.authorityUrl = authorityUrl;
    this.serviceSecret = serviceSecret;
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
    if (existing && existing.uid !== uid) {
      return json({ error: "not found" }, 404);
    }
    const key = existing?.keyId ? this.keys.get(existing.keyId) : undefined;
    const alreadyRevoked = existing?.tombstoned === true || key?.revoked === true;
    if (key) key.revoked = true;
    this.correlations.set(correlationId, { uid, keyId: existing?.keyId, tombstoned: true });
    return json({ revoked: true, alreadyRevoked, correlationTombstoned: true, activeKeys: 0 });
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    assert.equal(request.url, this.authorityUrl, `unexpected outbound fetch: ${request.url}`);
    assert.equal(request.headers.get("x-frihet-oauth-key"), this.serviceSecret);
    const body = await request.json() as Record<string, unknown>;
    this.requests.push({ method: request.method, body });
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
      assert.deepEqual(Object.keys(body).sort(), ["correlationId", "uid"]);
      this.events.push(`erp:DELETE:${body.correlationId}`);
      const fault = this.deleteFaults.shift();
      if (fault?.kind === "slow") fault.before();
      if (fault?.kind === "network") throw new TypeError("fetch failed");
      if (fault?.kind === "status") return json({ error: "injected" }, fault.status);
      const revoked = this.revokeCorrelation(uid, body.correlationId);
      return fault?.kind === "not-proof" ? json({ revoked: true }) : revoked;
    }
    assert.deepEqual(Object.keys(body).sort(), ["keyId", "uid"]);
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
  options: {
    stateStore?: StateStoreFactory;
    profile?: "openai" | "claude";
    registeredRedirectUri?: string;
    redirectUri?: string;
  } = {},
) {
  const profile = options.profile ?? "openai";
  const { OAuthProvider, getOAuthApi } = await loadLockedProvider(profile);
  const boundary = boundOAuthProfile(profile);
  const origin = boundary.origin;
  const mcpResource = `${origin}/mcp`;
  const redirectUri = options.redirectUri ?? (profile === "claude" ? CLAUDE_REDIRECT_URI : REDIRECT_URI);
  const registeredRedirectUri = options.registeredRedirectUri ?? redirectUri;
  const providerOptions = profile === "claude"
    ? {
        ...OAUTH_PROVIDER_REVIEW_OPTIONS,
        resourceMetadata: {
          ...buildReviewedMcpProtectedResourceMetadata(origin),
          resource_name: "Frihet Claude connector",
        },
      }
    : OAUTH_PROVIDER_REVIEW_OPTIONS;
  const events: string[] = [];
  const logs: string[] = [];
  const clock = { offsetMs: 0 };
  const baseNowMs = Date.now();
  t.mock.method(Date, "now", () => baseNowMs + clock.offsetMs);
  t.mock.method(console, "error", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  const erp = new FakeErpAuthority(
    events,
    resolveOAuthApiKeyUrl(undefined, profile),
    profile === "claude" ? CLAUDE_SERVICE_SECRET : SERVICE_SECRET,
  );
  t.mock.method(globalThis, "fetch", erp.fetch);

  const kv = new FakeKv();
  // The Firebase key cache is a per-process singleton bound to the first KV it
  // sees, so every harness seeds the same verifier key.
  kv.values.set("firebase-public-keys", await firebasePublicJwks());
  const env: Record<string, unknown> = {
    OAUTH_KV: kv,
    FIREBASE_PROJECT_ID,
    FRIHET_OPENAI_MODE: profile === "openai" ? "true" : "false",
    ...(profile === "claude" ? {
      FRIHET_CLAUDE_MODE: "true",
      FRIHET_CLAUDE_OAUTH_API_KEY: CLAUDE_SERVICE_SECRET,
      FRIHET_CLAUDE_QA_UIDS: JSON.stringify([USER_ID]),
    } : {}),
    FRIHET_API_BASE: "https://api.frihet.io/v1",
    FRIHET_OAUTH_API_KEY: SERVICE_SECRET,
  };
  const namespace = new FakeDurableObjectNamespace(
    env,
    events,
    options.stateStore ?? ((state, storeEnv) => new OAuthStateStore(
      state as unknown as DurableObjectState,
      storeEnv as never,
      {
        // Production hand-offs (token-family supersede) stay; only the
        // profile-bound authorities below are replaced for Node.
        ...DEFAULT_CLEANUP_AUTHORITIES,
        // Node cannot import cloudflare:workers; use getOAuthApi from the same
        // exact SDK build already adapted by loadLockedProvider above.
        async revokeGrant(cleanupEnv, userId, grantId) {
          await getOAuthApi({ ...providerOptions, apiHandler, defaultHandler: authHandler }, cleanupEnv).revokeGrant(grantId, userId);
        },
        async revokeBackendCorrelation(cleanupEnv, attempt) {
          const bound = boundOAuthProfile(resolveWorkerAccessProfile(cleanupEnv));
          return reconcileOAuthApiKeyCorrelation(
            resolveOAuthApiKeyUrl(cleanupEnv.FRIHET_API_BASE, bound.accessProfile),
            resolveOAuthServiceSecret(cleanupEnv, bound.accessProfile),
            bound.accessProfile === "claude"
              ? { ...attempt, accessProfile: bound.accessProfile, oauthResource: CLAUDE_ORIGIN }
              : { ...attempt, accessProfile: bound.accessProfile, oauthResource: OPENAI_REVIEW_ORIGIN },
          );
        },
      },
    )),
  );
  env.OAUTH_STATE = namespace;

  const apiHandler = {
    async fetch(request: Request, handlerEnv: Record<string, unknown>, ctx: { props?: Record<string, unknown> }) {
      const userId = typeof ctx.props?.userId === "string" ? ctx.props.userId : undefined;
      const identity = { uid: userId, email: ctx.props?.email, emailVerified: ctx.props?.emailVerified };
      if (profile === "claude" && !isVerifiedClaudeIdentity(identity)) {
        return json({ error: "invalid_token" }, 401);
      }
      if (!await isOAuthAccessTokenFamilyActive(
        handlerEnv.OAUTH_STATE as DurableObjectNamespace,
        request,
        userId,
      )) {
        return json({ error: "invalid_token" }, 401);
      }
      if (profile === "claude" && request.method !== "DELETE" && !isClaudeIdentityAdmitted(handlerEnv, identity)) {
        return claudeAdmissionUnavailableResponse();
      }
      return json({ keyId: ctx.props?.keyId, userId });
    },
  };
  const provider = (exchange?: OAuthTokenFamilyExchange) => new OAuthProvider({
    ...providerOptions,
    apiHandler,
    defaultHandler: authHandler,
    // Mirrors the Worker's guarded provider: the token family is bound to the
    // exact backend key carried by the grant the callback completed.
    tokenExchangeCallback: async (callbackOptions: { props: Record<string, unknown>; userId: string }) => {
      const props = callbackOptions.props;
      const identity = { uid: props.userId, email: props.email, emailVerified: props.emailVerified };
      if (profile === "claude" && (!isVerifiedClaudeIdentity(identity) || props.userId !== callbackOptions.userId)) {
        throw new Error("Invalid Claude grant identity");
      }
      const apiKeyBinding = {
        uid: callbackOptions.userId,
        keyId: String(props.keyId),
        ...(profile === "claude"
          ? { accessProfile: profile, oauthResource: CLAUDE_ORIGIN, ...(props.correlationId === undefined ? {} : { correlationId: String(props.correlationId) }) }
          : { accessProfile: profile, oauthResource: OPENAI_REVIEW_ORIGIN }),
      };
      if (profile === "claude" && !isClaudeIdentityAdmitted(env, identity)) {
        if (exchange) await exchange.assertPolicyPauseIsSafe(callbackOptions as never, apiKeyBinding);
        throw new ClaudeAdmissionPolicyError();
      }
      if (exchange) {
        await exchange.reserve(callbackOptions as never, apiKeyBinding);
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
    const registration = await send(new Request(`${origin}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [registeredRedirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: profile === "claude" ? "Claude" : "ChatGPT",
      }),
    }));
    assert.equal(registration.status, 201);
    return (await registration.json() as { client_id: string }).client_id;
  }

  async function authorize(clientId: string, resource = mcpResource): Promise<Response> {
    const url = new URL(`${origin}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: OPENAI_REVIEW_OAUTH_SCOPES.join(" "),
      state: "client-state",
      code_challenge: await s256(CODE_VERIFIER),
      code_challenge_method: "S256",
      resource,
    }).toString();
    return send(new Request(url));
  }

  /**
   * DCR (unless reconnecting an existing client) + GET /authorize; returns
   * the state the login page would post back.
   */
  async function startLogin(
    existingClientId?: string,
  ): Promise<{ clientId: string; stateKey: string }> {
    const clientId = existingClientId ?? await register();
    const page = await authorize(clientId);
    assert.equal(page.status, 200);
    const html = await page.text();
    const match = /<script type="application\/json" id="server-data">(.*?)<\\?\/script>/su.exec(html);
    assert.ok(match, "login page must embed its server data");
    const { stateKey } = JSON.parse(match[1]!) as { stateKey: string };
    return { clientId, stateKey };
  }

  /** POST /callback exactly as the login page does. */
  async function callback(stateKey: string, idToken: string): Promise<CallbackResult> {
    const response = await send(new Request(`${origin}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stateKey, idToken, locale: "es" }),
    }));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  async function exchangeToken(form: URLSearchParams): Promise<Response> {
    const exchange = OAuthTokenFamilyExchange.fromForm(
      form,
      namespace as unknown as DurableObjectNamespace,
      kv as unknown as KVNamespace,
      boundary.acceptedResources,
    );
    const revocation = OAuthTokenFamilyRevocation.fromForm(
      form,
      namespace as unknown as DurableObjectNamespace,
      kv as unknown as KVNamespace,
    );
    let request = new Request(`${origin}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (revocation) request = await revocation.protectRequest(request, form);
    try {
      const response = await send(request, exchange);
      if (exchange) return (await exchange.settle(response)).response;
      if (revocation) return (await revocation.settle(response)).response;
      return response;
    } catch (error) {
      if (profile === "claude" && error instanceof ClaudeAdmissionPolicyError && !exchange?.hasLease()) {
        return claudeAdmissionUnavailableResponse();
      }
      const settlement = await exchange?.settleThrown(error);
      if (settlement) return settlement.response;
      if (!exchange) throw error;
      // The Worker's generic token-exchange fallback also closes when the
      // provider callback refuses before a family lease is reserved.
      return json({ error: "invalid_grant" }, 400);
    }
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
      redirect_uri: redirectUri,
      code_verifier: CODE_VERIFIER,
    });
    const tokenResponse = await exchangeToken(form);
    const tokens = await tokenResponse.json() as Record<string, unknown>;
    assert.equal(tokenResponse.status, 200, JSON.stringify(tokens));
    const accessToken = String(tokens.access_token);
    const mcp = await callMcp(accessToken);
    assert.equal(mcp.status, 200);
    return { ...await mcp.json() as { keyId: string; userId: string }, accessToken, refreshToken: String(tokens.refresh_token), tokens };
  }

  function callMcp(accessToken: string): Promise<Response> {
    return send(new Request(`${origin}/mcp`, {
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

  /**
   * Fire every Durable Object alarm that is due at the harness clock, as the
   * runtime would: an alarm is consumed when it fires and only a handler that
   * still has work re-arms it. Repeats until nothing is due. The clock does not
   * move by itself: an alarm armed for `now + 1` (a tombstone's cleanup) is due
   * only after the test advances `clock.offsetMs`, so drive multi-hop outboxes
   * in rounds.
   */
  async function runDueAlarms(maxRounds = 20): Promise<void> {
    for (let round = 0; round < maxRounds; round += 1) {
      const due = [...namespace.objects.values()].filter(({ state }) => (
        state.storage.alarmAt !== null && state.storage.alarmAt <= Date.now()
      ));
      if (due.length === 0) return;
      for (const { state, store } of due) {
        state.storage.alarmAt = null;
        await store.alarm();
      }
    }
    throw new Error("Durable Object alarms did not settle");
  }

  async function runFamilyAlarms(): Promise<void> {
    for (const { store, state } of namespace.objects.values()) {
      if (state.storage.values.has("oauth_token_family_cleanup")) await store.alarm();
    }
  }

  return {
    env,
    kv,
    namespace,
    erp,
    events,
    logs,
    clock,
    profile,
    origin,
    mcpResource,
    redirectUri,
    send,
    register,
    authorize,
    startLogin,
    callback,
    redeem,
    callMcp,
    runStateAlarm,
    runDueAlarms,
    exchangeToken,
    runFamilyAlarms,
  };
}
