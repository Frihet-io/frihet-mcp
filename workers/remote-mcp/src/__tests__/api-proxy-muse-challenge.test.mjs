import assert from "node:assert/strict";
import { test } from "node:test";
import apiProxy from "../../../api-proxy/worker.js";

const CHALLENGE = "e664c1dbdfd917b8d656f1f4c7e0dd57d34d73919ec25b5015c18e0a8267b590";
const PATH = `/.well-known/muse-challenge/${CHALLENGE}`;
const URL = `https://api.frihet.io${PATH}`;
const BODY = `muse-challenge=${CHALLENGE}`;
const EXPIRES_AT = Date.parse("2026-11-20T20:52:00.000Z");

test("Muse proof GET is public, exact, uncached, and never calls upstream", async (t) => {
  t.mock.method(Date, "now", () => EXPIRES_AT - 1);
  const upstream = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Host proof must not call upstream");
  });
  const response = await apiProxy.fetch(new Request(URL), {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), BODY);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.has("www-authenticate"), false);
  assert.equal(upstream.mock.callCount(), 0);
});

test("Muse proof HEAD has the GET status and headers but no body", async (t) => {
  t.mock.method(Date, "now", () => EXPIRES_AT - 1);
  const upstream = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Host proof must not call upstream");
  });
  const get = await apiProxy.fetch(new Request(URL), {});
  const head = await apiProxy.fetch(new Request(URL, { method: "HEAD" }), {});
  assert.equal(head.status, 200);
  assert.deepEqual([...head.headers], [...get.headers]);
  assert.equal(head.body, null);
  assert.equal(await head.text(), "");
  assert.equal(upstream.mock.callCount(), 0);
});

test("Muse proof expires at the exact deadline, including within a reused Worker", async (t) => {
  let now = EXPIRES_AT - 1;
  t.mock.method(Date, "now", () => now);
  const upstream = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Expired host proof must not call upstream");
  });
  assert.equal((await apiProxy.fetch(new Request(URL), {})).status, 200);
  for (const timestamp of [EXPIRES_AT, EXPIRES_AT + 1, EXPIRES_AT + 86_400_000]) {
    now = timestamp;
    for (const method of ["GET", "HEAD"]) {
      const response = await apiProxy.fetch(new Request(URL, { method }), {});
      assert.equal(response.status, 404);
      assert.equal(await response.text(), "");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("Muse proof does not intercept neighboring paths, other hosts, HTTP or queries", async (t) => {
  t.mock.method(Date, "now", () => EXPIRES_AT - 1);
  const upstream = t.mock.method(globalThis, "fetch", async () => new Response("upstream"));
  const alternatives = [
    `${URL}/`, `${URL}/other`, `${URL}?probe=1`,
    `https://api.frihet.io${PATH.slice(0, -1)}1`,
    `https://api.frihet.io/v1${PATH}`,
    `https://other.example${PATH}`, `http://api.frihet.io${PATH}`,
  ];
  for (const alternative of alternatives) {
    const response = await apiProxy.fetch(new Request(alternative), {});
    assert.equal(await response.text(), "upstream");
  }
  assert.equal(upstream.mock.callCount(), alternatives.length);
});

test("Muse proof leaves non-read methods and existing CORS handling unchanged", async (t) => {
  t.mock.method(Date, "now", () => EXPIRES_AT - 1);
  const upstream = t.mock.method(globalThis, "fetch", async () => new Response("upstream"));
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await apiProxy.fetch(new Request(URL, { method }), {});
    assert.equal(await response.text(), "upstream");
    assert.equal(upstream.mock.calls.at(-1).arguments[1].method, method);
  }
  const preflight = await apiProxy.fetch(new Request(URL, { method: "OPTIONS" }), {});
  assert.equal(preflight.status, 403);
  assert.equal(upstream.mock.callCount(), 4);
});

test("Muse expiry does not affect existing static discovery or API forwarding", async (t) => {
  t.mock.method(Date, "now", () => EXPIRES_AT + 1);
  const upstream = t.mock.method(globalThis, "fetch", async () => new Response("api-response"));
  const discovery = await apiProxy.fetch(new Request("https://api.frihet.io/llms.txt"), {});
  assert.equal(discovery.status, 200);
  assert.match(await discovery.text(), /^# Frihet/);
  assert.equal(upstream.mock.callCount(), 0);
  const api = await apiProxy.fetch(new Request("https://api.frihet.io/v1/invoices?limit=1"), {});
  assert.equal(await api.text(), "api-response");
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal(upstream.mock.calls[0].arguments[0],
    "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/publicApi/api/v1/invoices?limit=1");
});
