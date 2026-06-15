#!/usr/bin/env node
/**
 * LIVE smoke for the OpenAI × grouped COMPOSITION on openai-mcp.frihet.io.
 *
 * ⚠️ DO NOT RUN until the openai-mcp Worker has been deployed with
 *    FRIHET_TOOL_MODE=grouped (env.openai). The composition is gated behind
 *    Viktor's prod flip + an OpenAI app re-review (see DECISION_SPEC.md).
 *    Running it before deploy asserts against the OLD ("full") surface and will
 *    fail on the meta-tool checks — that failure is expected pre-deploy.
 *
 * What it asserts against the LIVE MCP endpoint (after a deploy):
 *   (1) tools/list returns 56 tools: the 53 reviewed business tools + the 3
 *       discovery meta-tools (search_tools, describe_tool, list_tool_groups).
 *   (2) Every reviewed business tool has a collapsed description that still
 *       carries an openWorldHint rationale marker.
 *   (3) search_tools (browse-all) and describe_tool only ever surface tools that
 *       are in tools/list — i.e. the catalog never leaks a non-reviewed tool.
 *
 * Usage (AFTER deploy only):
 *   FRIHET_API_KEY=fri_xxx node scripts/test-openai-grouped-compose.mjs
 *   node scripts/test-openai-grouped-compose.mjs --endpoint https://openai-mcp.frihet.io/mcp --key fri_xxx
 *
 * Exit 0 = all invariants hold. Exit 1 = a violation. Exit 2 = setup/transport error.
 */

const ARGS = process.argv.slice(2);
function arg(flag) {
  const i = ARGS.indexOf(flag);
  return i >= 0 ? ARGS[i + 1] : undefined;
}

const ENDPOINT = arg("--endpoint") || "https://openai-mcp.frihet.io/mcp";
const API_KEY = arg("--key") || process.env.FRIHET_API_KEY;

// The 3 grouped discovery meta-tools (must be PRESENT in the composed surface).
const META_TOOLS = ["list_tool_groups", "search_tools", "describe_tool"];
// A handful of tools that exist on the FULL server but must NEVER surface here.
const MUST_NOT_LEAK = [
  "get_quarterly_taxes",
  "get_invoice_einvoice",
  "send_einvoice",
  "get_modelo_303_summary",
  "create_reservation",
  "payroll_export",
];
const EXPECTED_BUSINESS = 53;
const EXPECTED_TOTAL = EXPECTED_BUSINESS + META_TOOLS.length; // 56

if (!API_KEY || !API_KEY.startsWith("fri_")) {
  console.error("✗ Missing/invalid API key. Pass --key fri_* or set FRIHET_API_KEY (fri_*).");
  process.exit(2);
}

let nextId = 1;
async function rpc(method, params) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  if (!res.ok) throw new Error(`${method} → HTTP ${res.status} ${res.statusText}`);
  const ct = res.headers.get("content-type") || "";
  let payload;
  if (ct.includes("text/event-stream")) {
    // Parse the last data: line of an SSE response.
    const text = await res.text();
    const dataLines = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    if (!dataLines.length) throw new Error(`${method} → empty SSE body`);
    payload = JSON.parse(dataLines[dataLines.length - 1]);
  } else {
    payload = await res.json();
  }
  if (payload.error) throw new Error(`${method} → JSON-RPC error: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

function parseToolText(callResult) {
  const block = (callResult?.content || []).find((c) => c.type === "text");
  return block ? JSON.parse(block.text) : null;
}

async function main() {
  const failures = [];
  const note = (ok, label) => {
    console.log(`${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failures.push(label);
  };

  // Handshake.
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "openai-grouped-compose-smoke", version: "1.0.0" },
  });

  // ---- tools/list ----------------------------------------------------------
  const list = await rpc("tools/list", {});
  const tools = list.tools || [];
  const names = new Set(tools.map((t) => t.name));

  // Invariant (1): 56 tools, meta-tools present.
  note(tools.length === EXPECTED_TOTAL, `tools/list returns ${EXPECTED_TOTAL} tools (got ${tools.length})`);
  for (const m of META_TOOLS) note(names.has(m), `meta-tool present: ${m}`);
  const businessCount = tools.filter((t) => !META_TOOLS.includes(t.name)).length;
  note(businessCount === EXPECTED_BUSINESS, `exactly ${EXPECTED_BUSINESS} reviewed business tools (got ${businessCount})`);
  for (const leak of MUST_NOT_LEAK) note(!names.has(leak), `non-reviewed tool absent: ${leak}`);

  // Meta-tools are read-only + closed-world.
  for (const m of META_TOOLS) {
    const t = tools.find((x) => x.name === m);
    const ann = t?.annotations || {};
    note(ann.readOnlyHint === true && ann.openWorldHint === false, `${m} is read-only + closed-world`);
  }

  // Invariant (2): every business tool collapsed + carries openWorldHint rationale.
  let collapsedOk = true;
  let owOk = true;
  for (const t of tools) {
    if (META_TOOLS.includes(t.name)) continue;
    const d = t.description || "";
    if (!/^\[[a-z]+\] /.test(d) || !d.includes(`describe_tool('${t.name}')`)) collapsedOk = false;
    if (!d.includes("openWorldHint")) owOk = false;
  }
  note(collapsedOk, "every reviewed tool has a collapsed [group] … describe_tool() description");
  note(owOk, "every reviewed tool's collapsed description carries an openWorldHint rationale");

  // Invariant (3): catalog only ever surfaces tools that are in tools/list.
  const search = await rpc("tools/call", { name: "search_tools", arguments: { query: "", limit: 500 } });
  const searchPayload = parseToolText(search);
  const searchNames = (searchPayload?.tools || []).map((x) => x.name);
  const searchLeaks = searchNames.filter((n) => !names.has(n));
  note(searchLeaks.length === 0, `search_tools (browse-all) leaks nothing (leaks: ${searchLeaks.join(", ") || "none"})`);
  note(
    searchNames.length === EXPECTED_BUSINESS,
    `search_tools browse-all returns the ${EXPECTED_BUSINESS} reviewed tools (got ${searchNames.length})`,
  );

  // A fiscal query must surface no non-reviewed tool.
  const fiscal = await rpc("tools/call", { name: "search_tools", arguments: { query: "modelo 303 verifactu" } });
  const fiscalNames = (parseToolText(fiscal)?.tools || []).map((x) => x.name);
  note(fiscalNames.every((n) => names.has(n)), "search_tools('modelo 303') surfaces no non-reviewed tool");

  // describe_tool rejects a non-reviewed tool.
  const desc = await rpc("tools/call", { name: "describe_tool", arguments: { name: "get_quarterly_taxes" } });
  note(desc?.isError === true, "describe_tool('get_quarterly_taxes') is rejected (not in reviewed catalog)");

  // list_tool_groups totals 53.
  const groups = await rpc("tools/call", { name: "list_tool_groups", arguments: {} });
  const gPayload = parseToolText(groups);
  note(gPayload?.totalTools === EXPECTED_BUSINESS, `list_tool_groups totalTools === ${EXPECTED_BUSINESS} (got ${gPayload?.totalTools})`);

  console.log("");
  if (failures.length) {
    console.error(`FAIL — ${failures.length} invariant violation(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`PASS — all ${EXPECTED_TOTAL}-tool composition invariants hold on ${ENDPOINT}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`✗ transport/setup error: ${err.message}`);
  process.exit(2);
});
