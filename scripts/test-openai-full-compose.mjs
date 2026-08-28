#!/usr/bin/env node
/**
 * Read-only live smoke for the OpenAI full-description composition.
 *
 * Run only against a coordinated release candidate after obtaining a scoped
 * OAuth access token. This script lists descriptors and public OAuth metadata;
 * it never calls a Frihet business tool.
 *
 * Usage:
 *   FRIHET_OAUTH_ACCESS_TOKEN=... node scripts/test-openai-full-compose.mjs
 *   node scripts/test-openai-full-compose.mjs --endpoint https://openai-mcp.frihet.io/mcp --token ...
 */

import { readFileSync } from "node:fs";

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
const ACCESS_TOKEN = arg("--token") || process.env.FRIHET_OAUTH_ACCESS_TOKEN;
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

if (!ACCESS_TOKEN) {
  console.error("✗ Missing OAuth access token. Pass --token or set FRIHET_OAUTH_ACCESS_TOKEN.");
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
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  if (!response.ok) throw new Error(`${method} → HTTP ${response.status} ${response.statusText}`);
  sessionId = response.headers.get("mcp-session-id") || sessionId;
  const contentType = response.headers.get("content-type") || "";
  let payload;
  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    if (!dataLines.length) throw new Error(`${method} → empty SSE body`);
    payload = JSON.parse(dataLines[dataLines.length - 1]);
  } else {
    payload = await response.json();
  }
  if (payload.error) throw new Error(`${method} → JSON-RPC error: ${JSON.stringify(payload.error)}`);
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
  const failures = [];
  const note = (ok, label) => {
    console.log(`${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failures.push(label);
  };

  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "openai-full-compose-smoke", version: "1.0.0" },
  });

  const listed = await rpc("tools/list", {});
  const tools = listed.tools || [];
  const names = new Set(tools.map((tool) => tool.name));
  note(
    JSON.stringify(canonicalTools(tools)) === JSON.stringify(canonicalTools(SNAPSHOT.tools)),
    "tools/list matches the exact reviewed descriptor",
  );
  note(tools.length === 33, `tools/list returns exactly 33 tools (got ${tools.length})`);
  for (const name of DISCOVERY_META_TOOLS) note(!names.has(name), `discovery meta-tool absent: ${name}`);
  for (const name of MUST_NOT_LEAK) note(!names.has(name), `non-reviewed tool absent: ${name}`);

  for (const tool of tools) {
    const description = tool.description || "";
    note(description.length >= 80, `${tool.name} keeps its complete description`);
    note(!/^\[[a-z]+\] /u.test(description), `${tool.name} is not grouped/collapsed`);
    note(!description.includes("describe_tool("), `${tool.name} is self-contained`);
    note(/openWorldHint: (?:true|false)/u.test(description), `${tool.name} explains openWorldHint`);
    for (const hint of ["readOnlyHint", "openWorldHint", "destructiveHint", "idempotentHint"]) {
      note(typeof tool.annotations?.[hint] === "boolean", `${tool.name}.${hint} is explicit`);
    }
  }

  const origin = new URL(ENDPOINT).origin;
  const authorizationServer = await fetch(
    `${origin}/.well-known/oauth-authorization-server`,
  ).then((response) => response.json());
  note(
    JSON.stringify(canonicalize(authorizationServer)) ===
      JSON.stringify(canonicalize(SNAPSHOT.oauth.authorizationServer)),
    "OAuth authorization-server discovery matches the reviewed contract",
  );
  const protectedResource = await fetch(
    `${origin}/.well-known/oauth-protected-resource`,
  ).then((response) => response.json());
  note(
    JSON.stringify(canonicalize(protectedResource)) ===
      JSON.stringify(canonicalize(SNAPSHOT.oauth.protectedResource)),
    "OAuth protected-resource metadata matches the reviewed contract",
  );
  const challenge = await fetch(ENDPOINT, {
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
  note(challenge.status === 401, `unauthenticated tools/list returns 401 (got ${challenge.status})`);
  note(
    challenge.headers.get("www-authenticate") ===
      SNAPSHOT.oauth.wwwAuthenticate.missingTokenHeader,
    "WWW-Authenticate resource_metadata URL matches the reviewed contract",
  );

  console.log("");
  if (failures.length) {
    console.error(`FAIL — ${failures.length} invariant violation(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`PASS — all 33-tool full-description invariants hold on ${ENDPOINT}`);
}

main().catch((error) => {
  console.error(`✗ transport/setup error: ${error.message}`);
  process.exit(2);
});
