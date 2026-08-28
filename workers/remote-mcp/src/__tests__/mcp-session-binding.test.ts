import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bindMcpSessionId,
  createPrincipalBoundMcpHandler,
  fingerprintSessionPrincipal,
  isMcpRouteConfusion,
  unbindMcpSessionId,
} from "../mcp-session-binding.ts";

const RAW_SESSION_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const API_KEY_A = `fri_${"A".repeat(43)}`;
const API_KEY_B = `fri_${"B".repeat(43)}`;
const SIGNING_SECRET = "session-signing-secret-that-is-at-least-thirty-two-bytes";

test("principal fingerprint is stable across access-token refreshes", async () => {
  const props = {
    apiKey: API_KEY_A,
    keyId: "key-openai-a",
    userId: "user-a",
    accessProfile: "openai",
    authMethod: "oauth",
  };
  assert.equal(
    await fingerprintSessionPrincipal(props),
    await fingerprintSessionPrincipal({ ...props }),
  );
});

test("same MCP session id is rejected for a different authenticated principal", async () => {
  const fingerprintA = await fingerprintSessionPrincipal({
    apiKey: API_KEY_A,
    keyId: "key-openai-a",
    userId: "user-a",
    accessProfile: "openai",
    authMethod: "oauth",
  });
  const fingerprintB = await fingerprintSessionPrincipal({
    apiKey: API_KEY_B,
    keyId: "key-openai-b",
    userId: "user-b",
    accessProfile: "openai",
    authMethod: "oauth",
  });
  assert.ok(fingerprintA);
  assert.ok(fingerprintB);
  assert.notEqual(fingerprintA, fingerprintB);

  const clientVisible = await bindMcpSessionId(RAW_SESSION_ID, fingerprintA, SIGNING_SECRET);
  assert.ok(clientVisible);
  assert.deepEqual(await unbindMcpSessionId(clientVisible, fingerprintA, SIGNING_SECRET), {
    ok: true,
    rawSessionId: RAW_SESSION_ID,
  });
  assert.deepEqual(await unbindMcpSessionId(clientVisible, fingerprintB, SIGNING_SECRET), { ok: false });
});

test("raw, malformed, short and tampered session ids fail closed", async () => {
  const fingerprint = await fingerprintSessionPrincipal({ apiKey: API_KEY_A });
  assert.ok(fingerprint);
  const bound = await bindMcpSessionId(RAW_SESSION_ID, fingerprint, SIGNING_SECRET);
  assert.ok(bound);

  for (const candidate of [
    RAW_SESSION_ID,
    "v1.short.deadbeef",
    `${bound}extra`,
    bound.replace(/.$/u, bound.endsWith("a") ? "b" : "a"),
  ]) {
    assert.deepEqual(await unbindMcpSessionId(candidate, fingerprint, SIGNING_SECRET), { ok: false }, candidate);
  }
});

test("an attacker cannot splice its valid tag onto another raw session id", async () => {
  const fingerprint = await fingerprintSessionPrincipal({ apiKey: API_KEY_A });
  assert.ok(fingerprint);
  const ownRaw = "a".repeat(64);
  const victimRaw = "b".repeat(64);
  const ownBound = await bindMcpSessionId(ownRaw, fingerprint, SIGNING_SECRET);
  assert.ok(ownBound);
  const ownTag = ownBound.split(".")[2];
  assert.deepEqual(
    await unbindMcpSessionId(`v1.${victimRaw}.${ownTag}`, fingerprint, SIGNING_SECRET),
    { ok: false },
  );
});

test("missing or unusable auth props cannot create a principal binding", async () => {
  assert.equal(await fingerprintSessionPrincipal(undefined), undefined);
  assert.equal(await fingerprintSessionPrincipal({}), undefined);
  assert.equal(await fingerprintSessionPrincipal({ apiKey: "" }), undefined);
  assert.equal(await fingerprintSessionPrincipal({ apiKey: "x".repeat(513) }), undefined);
});

test("missing or weak envelope secret fails closed", async () => {
  const fingerprint = await fingerprintSessionPrincipal({ apiKey: API_KEY_A });
  assert.ok(fingerprint);
  assert.equal(await bindMcpSessionId(RAW_SESSION_ID, fingerprint, "short"), undefined);
  assert.deepEqual(
    await unbindMcpSessionId(`v1.${RAW_SESSION_ID}.${"a".repeat(64)}`, fingerprint, "short"),
    { ok: false },
  );
});

test("handler binds initialization and rejects another token before the SDK sees it", async () => {
  const calls: Request[] = [];
  const rawHandler = {
    async fetch(request: Request): Promise<Response> {
      calls.push(request);
      return new Response("ok", { headers: { "mcp-session-id": RAW_SESSION_ID } });
    },
  };
  const handler = createPrincipalBoundMcpHandler(rawHandler);
  const env = { COOKIE_ENCRYPTION_KEY: SIGNING_SECRET };
  const principalA = { props: { apiKey: API_KEY_A, keyId: "key-a" } } as ExecutionContext;
  const principalB = { props: { apiKey: API_KEY_B, keyId: "key-b" } } as ExecutionContext;

  const initialized = await handler.fetch(
    new Request("https://openai-mcp.frihet.io/mcp", { method: "POST" }),
    env,
    principalA,
  );
  const boundSessionId = initialized.headers.get("mcp-session-id");
  assert.ok(boundSessionId);
  assert.equal(calls.length, 1);

  const accepted = await handler.fetch(
    new Request("https://openai-mcp.frihet.io/mcp", {
      headers: { "mcp-session-id": boundSessionId },
    }),
    env,
    principalA,
  );
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("mcp-session-id"), boundSessionId);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.headers.get("mcp-session-id"), RAW_SESSION_ID);

  const deleted = await handler.fetch(
    new Request("https://openai-mcp.frihet.io/mcp", {
      method: "DELETE",
      headers: { "mcp-session-id": boundSessionId },
    }),
    env,
    principalA,
  );
  assert.equal(deleted.status, 200);
  assert.equal(deleted.headers.get("mcp-session-id"), boundSessionId);
  assert.equal(calls.length, 3);
  assert.equal(calls[2]?.method, "DELETE");
  assert.equal(calls[2]?.headers.get("mcp-session-id"), RAW_SESSION_ID);

  const rejected = await handler.fetch(
    new Request("https://openai-mcp.frihet.io/mcp", {
      method: "DELETE",
      headers: { "mcp-session-id": boundSessionId },
    }),
    env,
    principalB,
  );
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get("cache-control"), "no-store");
  assert.equal(calls.length, 3, "principal mismatch must not reach the SDK handler");
});

test("outer routing rejects MCP prefix confusion but preserves discovery", () => {
  for (const path of ["/mcp/", "/mcpfoo", "/MCP", "/%6dcp/extra"]) {
    assert.equal(isMcpRouteConfusion(path), true, path);
  }
  for (const path of ["/mcp", "/mcp.json", "/.well-known/mcp", "/other"]) {
    assert.equal(isMcpRouteConfusion(path), false, path);
  }
});

test("handler rejects route confusion, raw legacy ids, and response identity changes", async () => {
  const env = { COOKIE_ENCRYPTION_KEY: SIGNING_SECRET };
  const ctx = { props: { apiKey: API_KEY_A } } as ExecutionContext;
  const handler = createPrincipalBoundMcpHandler({
    async fetch(): Promise<Response> {
      return new Response("ok", { headers: { "mcp-session-id": "c".repeat(64) } });
    },
  });

  for (const path of ["/mcp/", "/mcpfoo", "/%6dcp/extra"]) {
    const response = await handler.fetch(new Request(`https://openai-mcp.frihet.io${path}`), env, ctx);
    assert.equal(response.status, 404, path);
  }
  const raw = await handler.fetch(
    new Request("https://openai-mcp.frihet.io/mcp", {
      headers: { "mcp-session-id": RAW_SESSION_ID },
    }),
    env,
    ctx,
  );
  assert.equal(raw.status, 403);

  const fingerprint = await fingerprintSessionPrincipal({ apiKey: API_KEY_A });
  assert.ok(fingerprint);
  const bound = await bindMcpSessionId(RAW_SESSION_ID, fingerprint, SIGNING_SECRET);
  assert.ok(bound);
  const changed = await handler.fetch(
    new Request("https://openai-mcp.frihet.io/mcp", {
      headers: { "mcp-session-id": bound },
    }),
    env,
    ctx,
  );
  assert.equal(changed.status, 502);
});
