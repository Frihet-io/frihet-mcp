import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BoundedRequestBodyError,
  readBoundedTextRequest,
} from "../bounded-request-body.ts";

function post(body: BodyInit, headers?: HeadersInit): Request {
  return new Request("https://openai-mcp.frihet.io/token", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

async function expectCode(
  promise: Promise<unknown>,
  code: BoundedRequestBodyError["code"],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof BoundedRequestBodyError);
    assert.equal(error.code, code);
    return true;
  });
}

test("accepts the exact limit and rebuilds a byte-identical request", async () => {
  const bounded = await readBoundedTextRequest(post("12345678"), 8);
  assert.equal(bounded.text, "12345678");
  assert.equal(bounded.sizeBytes, 8);
  assert.equal(await bounded.request.text(), "12345678");
  assert.equal(bounded.request.headers.get("content-length"), null);
});

test("rejects limit plus one without relying on Content-Length", async () => {
  await expectCode(readBoundedTextRequest(post("123456789"), 8), "too_large");
});

test("counts chunked bodies and cancels the reader after overflow", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("1234"));
      controller.enqueue(new TextEncoder().encode("56789"));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expectCode(readBoundedTextRequest(post(stream), 8), "too_large");
  assert.equal(cancelled, true);
});

test("rejects invalid, oversized, and dishonest Content-Length values", async () => {
  await expectCode(
    readBoundedTextRequest(post("abc", { "Content-Length": "invalid" }), 8),
    "invalid_length",
  );
  await expectCode(
    readBoundedTextRequest(post("abc", { "Content-Length": "9" }), 8),
    "too_large",
  );
  await expectCode(
    readBoundedTextRequest(post("abcdef", { "Content-Length": "3" }), 8),
    "invalid_length",
  );
});

test("uses byte length for UTF-8 and rejects malformed encoding", async () => {
  const multiByte = "éé";
  const accepted = await readBoundedTextRequest(post(multiByte), 4);
  assert.equal(accepted.text, multiByte);
  await expectCode(readBoundedTextRequest(post(multiByte), 3), "too_large");
  await expectCode(
    readBoundedTextRequest(post(new Uint8Array([0xc3, 0x28])), 2),
    "invalid_utf8",
  );
});

test("MCP, token, callback, and registration routes all use bounded streaming reads", () => {
  const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const authSource = readFileSync(new URL("../auth-handler.ts", import.meta.url), "utf8");

  assert.match(indexSource, /const OPENAI_MCP_MAX_BODY_BYTES = 256 \* 1024;/u);
  assert.match(indexSource, /const OAUTH_TOKEN_MAX_BODY_BYTES = 16 \* 1024;/u);
  assert.match(indexSource, /const OAUTH_REGISTRATION_MAX_BODY_BYTES = 1024 \* 1024;/u);
  assert.match(authSource, /const OAUTH_CALLBACK_MAX_BODY_BYTES = 20 \* 1024;/u);
  assert.equal(
    [...indexSource.matchAll(/await readBoundedTextRequest\(/gu)].length,
    3,
    "Worker router must bound MCP, token, and dynamic-registration bodies",
  );
  assert.match(
    indexSource,
    /openai && request\.method === "POST" && url\.pathname === "\/mcp"[\s\S]*?readBoundedTextRequest\(request, OPENAI_MCP_MAX_BODY_BYTES\)/u,
  );
  assert.equal(
    [...authSource.matchAll(/await readBoundedTextRequest\(/gu)].length,
    1,
    "auth handler must bound the callback body",
  );
  assert.doesNotMatch(`${indexSource}\n${authSource}`, /request\.clone\(\)\.text\(\)/u);
});
