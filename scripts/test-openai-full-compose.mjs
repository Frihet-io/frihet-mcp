#!/usr/bin/env node
/**
 * Read-only live smoke for the OpenAI full-description composition.
 *
 * The script never calls a Frihet business tool. Its optional evidence file is
 * deliberately limited to named boolean invariants; response bodies, JSON-RPC
 * errors, OAuth tokens, session IDs, and business data are never serialized.
 *
 * Usage:
 *   FRIHET_OAUTH_ACCESS_TOKEN=... node scripts/test-openai-full-compose.mjs
 *   node scripts/test-openai-full-compose.mjs \
 *     --endpoint https://openai-mcp.frihet.io/mcp \
 *     --evidence .openai-release-evidence/authenticated-compose.json
 *   node scripts/test-openai-full-compose.mjs --readiness-only \
 *     --endpoint https://openai-mcp.frihet.io/mcp
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SNAPSHOT = JSON.parse(
  readFileSync(
    new URL("../src/__tests__/fixtures/openai-review-descriptor.snapshot.json", import.meta.url),
    "utf8",
  ),
);

const ARGS = process.argv.slice(2);
function arg(flag) {
  const index = ARGS.indexOf(flag);
  return index >= 0 ? ARGS[index + 1] : undefined;
}

const ENDPOINT = arg("--endpoint") || "https://openai-mcp.frihet.io/mcp";
const EVIDENCE_PATH = arg("--evidence");
const READINESS_ONLY = ARGS.includes("--readiness-only");
const ACCESS_TOKEN = arg("--token") || process.env.FRIHET_OAUTH_ACCESS_TOKEN;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const DISCOVERY_META_TOOLS = ["list_tool_groups", "search_tools", "describe_tool"];
const MUST_NOT_LEAK = [
  "get_quarterly_taxes",
  "get_invoice_einvoice",
  "send_einvoice",
  "get_modelo_303_summary",
  "create_reservation",
  "payroll_export",
  "apply_late_fee",
  "update_invoice",
  "mark_invoice_paid",
  "delete_invoice",
  "send_invoice",
  "send_quote",
  "update_quote",
  "delete_client",
  "delete_expense",
  "delete_product",
  "get_monthly_summary",
  "delete_vendor",
];

class SafeFailure extends Error {}

const invariants = {};
function check(name, condition) {
  invariants[name] = Boolean(condition);
}

function writeEvidence(passed) {
  if (!EVIDENCE_PATH) return;
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(
    EVIDENCE_PATH,
    `${JSON.stringify({ passed: Boolean(passed), invariants }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function boundedFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

async function boundedText(response, label, allowedContentTypes) {
  const contentType = (response.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!allowedContentTypes.includes(contentType)) {
    throw new SafeFailure(`${label} returned an unsupported content type`);
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new SafeFailure(`${label} returned an invalid content length`);
    }
    if (parsedLength > MAX_RESPONSE_BYTES) {
      throw new SafeFailure(`${label} exceeded the response size limit`);
    }
  }
  if (!response.body) {
    throw new SafeFailure(`${label} returned an empty body`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new SafeFailure(`${label} exceeded the response size limit`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { contentType, text };
}

async function safeJson(response, label) {
  if (!response.ok) {
    throw new SafeFailure(`${label} returned HTTP ${response.status}`);
  }
  try {
    const { text } = await boundedText(response, label, ["application/json"]);
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SafeFailure) throw error;
    throw new SafeFailure(`${label} returned invalid JSON`);
  }
}

if (!ACCESS_TOKEN) {
  writeEvidence(false);
  console.error("FAIL — OAuth access token is absent");
  process.exit(2);
}

let nextId = 1;
let sessionId;
async function rpc(method, params) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${ACCESS_TOKEN}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const response = await boundedFetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  if (!response.ok) throw new SafeFailure(`${method} returned HTTP ${response.status}`);
  sessionId = response.headers.get("mcp-session-id") || sessionId;
  let payload;
  try {
    const { contentType, text } = await boundedText(response, method, [
      "application/json",
      "text/event-stream",
    ]);
    if (contentType === "text/event-stream") {
      const dataLines = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);
      if (!dataLines.length) throw new Error("empty");
      payload = JSON.parse(dataLines[dataLines.length - 1]);
    } else {
      payload = JSON.parse(text);
    }
  } catch {
    throw new SafeFailure(`${method} returned an invalid JSON-RPC response`);
  }
  if (!payload || typeof payload !== "object" || payload.error || !("result" in payload)) {
    throw new SafeFailure(`${method} returned a JSON-RPC error response`);
  }
  return payload.result;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function canonicalTools(tools) {
  return [...tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(canonicalize);
}

async function main() {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "openai-full-compose-smoke", version: "1.0.0" },
  });

  const listed = await rpc("tools/list", {});
  const tools = Array.isArray(listed?.tools) ? listed.tools : [];
  check("authenticatedInitializeSucceeded", true);
  check("authenticatedToolsListSucceeded", Array.isArray(listed?.tools));
  if (READINESS_ONLY) {
    const passed = Object.values(invariants).every(Boolean);
    writeEvidence(passed);
    if (!passed) {
      console.error("FAIL — pre-mutation OAuth readiness invariants did not hold");
      process.exit(1);
    }
    console.log("PASS — OAuth token works on the compatible pre-mutation baseline");
    return;
  }
  const names = new Set(tools.map((tool) => tool.name));
  check(
    "descriptorMatchesReviewedSnapshot",
    JSON.stringify(canonicalTools(tools)) === JSON.stringify(canonicalTools(SNAPSHOT.tools)),
  );
  check("toolCountIs33", tools.length === 33);
  check("discoveryMetaToolsAbsent", DISCOVERY_META_TOOLS.every((name) => !names.has(name)));
  check("nonReviewedToolsAbsent", MUST_NOT_LEAK.every((name) => !names.has(name)));
  check(
    "descriptionsComplete",
    tools.every((tool) => typeof tool.description === "string" && tool.description.length >= 80),
  );
  check(
    "descriptionsNotGrouped",
    tools.every((tool) => !/^\[[a-z]+\] /u.test(tool.description || "")),
  );
  check(
    "descriptionsSelfContained",
    tools.every((tool) => !(tool.description || "").includes("describe_tool(")),
  );
  check(
    "openWorldHintExplained",
    tools.every((tool) => /openWorldHint: (?:true|false)/u.test(tool.description || "")),
  );
  check(
    "allActionHintsExplicit",
    tools.every((tool) =>
      ["readOnlyHint", "openWorldHint", "destructiveHint", "idempotentHint"]
        .every((hint) => typeof tool.annotations?.[hint] === "boolean")),
  );

  const origin = new URL(ENDPOINT).origin;
  const authorizationServer = await safeJson(
    await boundedFetch(`${origin}/.well-known/oauth-authorization-server`),
    "OAuth authorization-server metadata",
  );
  check(
    "authorizationServerMatchesSnapshot",
    JSON.stringify(canonicalize(authorizationServer)) ===
      JSON.stringify(canonicalize(SNAPSHOT.oauth.authorizationServer)),
  );
  const protectedResource = await safeJson(
    await boundedFetch(`${origin}/.well-known/oauth-protected-resource`),
    "OAuth protected-resource metadata",
  );
  check(
    "protectedResourceMatchesSnapshot",
    JSON.stringify(canonicalize(protectedResource)) ===
      JSON.stringify(canonicalize(SNAPSHOT.oauth.protectedResource)),
  );
  const challenge = await boundedFetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "descriptor-auth-check",
      method: "tools/list",
      params: {},
    }),
  });
  await challenge.body?.cancel();
  check("unauthenticatedToolsListIs401", challenge.status === 401);
  check(
    "unauthenticatedChallengeMatchesSnapshot",
    challenge.headers.get("www-authenticate") ===
      SNAPSHOT.oauth.wwwAuthenticate.missingTokenHeader,
  );

  const passed = Object.values(invariants).every(Boolean);
  writeEvidence(passed);
  if (!passed) {
    console.error("FAIL — authenticated OpenAI compose invariant mismatch; inspect boolean evidence");
    process.exit(1);
  }
  console.log("PASS — authenticated OpenAI compose invariants hold");
}

main().catch((error) => {
  check("transportAndSetupCompleted", false);
  writeEvidence(false);
  const message = error instanceof SafeFailure ? error.message : "unexpected transport/setup failure";
  console.error(`FAIL — ${message}`);
  process.exit(2);
});
