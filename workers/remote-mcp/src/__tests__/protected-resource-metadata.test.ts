import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildOpenAIReviewOAuthContract,
  buildReviewedMcpProtectedResourceMetadata,
  OPENAI_REVIEW_MCP_RESOURCE,
  OPENAI_REVIEW_MCP_RESOURCE_METADATA_PATH,
  OPENAI_REVIEW_ORIGIN,
} from "../../../../src/openai-review-oauth.ts";
import { reviewedMcpProtectedResourceMetadataResponse } from "../protected-resource-metadata.ts";

const metadataUrl = `${OPENAI_REVIEW_ORIGIN}${OPENAI_REVIEW_MCP_RESOURCE_METADATA_PATH}`;
const metadata = buildReviewedMcpProtectedResourceMetadata();

test("GET returns the frozen path-inserted document naming the exact MCP URL", async () => {
  const response = reviewedMcpProtectedResourceMetadataResponse(new Request(metadataUrl), metadata);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/u);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const body = await response.json();
  assert.deepEqual(body, buildOpenAIReviewOAuthContract().protectedResourceMcp);
  assert.equal(body.resource, OPENAI_REVIEW_MCP_RESOURCE);
});

test("browser clients get the same reflected CORS headers as the provider's root document", async () => {
  const origin = "http://localhost:6274";
  const get = reviewedMcpProtectedResourceMetadataResponse(
    new Request(metadataUrl, { headers: { Origin: origin } }),
    metadata,
  );
  assert.equal(get.headers.get("access-control-allow-origin"), origin);
  assert.equal(get.headers.get("access-control-allow-methods"), "*");
  assert.equal(get.headers.get("access-control-allow-headers"), "Authorization, *");
  assert.equal(get.headers.get("access-control-max-age"), "86400");

  const preflight = reviewedMcpProtectedResourceMetadataResponse(
    new Request(metadataUrl, { method: "OPTIONS", headers: { Origin: origin } }),
    metadata,
  );
  assert.equal(preflight.status, 204);
  assert.equal(await preflight.text(), "");
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
});

test("HEAD mirrors GET headers without a body", async () => {
  const origin = "http://localhost:6274";
  const head = reviewedMcpProtectedResourceMetadataResponse(
    new Request(metadataUrl, { method: "HEAD", headers: { Origin: origin } }),
    metadata,
  );
  assert.equal(head.status, 200);
  assert.match(head.headers.get("content-type") ?? "", /^application\/json/u);
  assert.equal(head.headers.get("access-control-allow-origin"), origin);
  assert.equal(await head.text(), "");
});

test("non-read methods are refused instead of echoing metadata", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = reviewedMcpProtectedResourceMetadataResponse(
      new Request(metadataUrl, { method, body: method === "DELETE" ? undefined : "{}" }),
      metadata,
    );
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS");
  }
});
