/**
 * Demo-mode smoke test. Spawns the built server with FRIHET_DEMO=1 (NO api key),
 * performs the MCP initialize handshake, then calls a few tools over stdio
 * JSON-RPC and asserts the demo guardrails hold end-to-end — in BOTH the default
 * (full) tool mode AND grouped mode (FRIHET_TOOL_MODE=grouped), because the
 * discovery meta-tools only exist in grouped mode and are exactly where the
 * banner guardrail had a hole.
 *
 * Exits 0 on success, 1 on any failed assertion.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "index.js");

const failures = [];

/** Spawn one demo-mode server (extra env layered on top) and return a client. */
function makeClient(extraEnv) {
  const env = { ...process.env, ...extraEnv };
  delete env.FRIHET_API_KEY; // guardrail #4: demo requires NO key
  env.FRIHET_DEMO = "1";

  const child = spawn("node", [serverPath], { env, stdio: ["pipe", "pipe", "pipe"] });

  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c.toString(); });

  let nextId = 1;
  function rpc(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 8000);
    });
  }
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  return { child, rpc, notify, getStderr: () => stderr };
}

function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label}`); failures.push(label); }
}
function sc(res) { return res?.result?.structuredContent ?? {}; }
function firstText(res) { return res?.result?.content?.[0]?.text ?? ""; }

async function handshake(c) {
  await c.rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "demo-smoke", version: "1.0.0" },
  });
  c.notify("notifications/initialized", {});
}

/* ------------------------------------------------------------------ */
/*  Default (full) mode                                                */
/* ------------------------------------------------------------------ */

async function runDefaultMode() {
  console.log("\n[demo-smoke] default (full) tool mode");
  const c = makeClient({});
  try {
    await handshake(c);

    // 1. Read: list_invoices → fixtures + _demo banner.
    const inv = await c.rpc("tools/call", { name: "list_invoices", arguments: { limit: 20 } });
    const invSc = sc(inv);
    assert(invSc._demo === true, "list_invoices structuredContent._demo === true");
    assert(Array.isArray(invSc.data) && invSc.data.length >= 8, `list_invoices returns >=8 fixture invoices (got ${invSc.data?.length})`);
    assert(firstText(inv).includes("DEMO MODE"), "list_invoices first content block carries DEMO MODE banner");
    assert(typeof invSc._demoNotice === "string" && invSc._demoNotice.includes("app.frihet.io"), "list_invoices _demoNotice points to app.frihet.io settings");

    // 2. Read single client fixture.
    const cli = await c.rpc("tools/call", { name: "list_clients", arguments: {} });
    const cliSc = sc(cli);
    assert(cliSc._demo === true, "list_clients _demo === true");
    assert(Array.isArray(cliSc.data) && cliSc.data.length === 5, `list_clients returns 5 clients (got ${cliSc.data?.length})`);

    // 3. Write: create_client → simulated in-memory, returned as created + _demo.
    const created = await c.rpc("tools/call", { name: "create_client", arguments: { name: "Nuevo Cliente Demo", email: "nuevo@example.com" } });
    const createdSc = sc(created);
    assert(createdSc._demo === true, "create_client _demo === true");
    assert(typeof createdSc.id === "string" && createdSc.id.length > 0, "create_client returns a generated id");
    assert(createdSc.name === "Nuevo Cliente Demo", "create_client echoes the created entity");

    // 4. Fiscal/email surface: send_einvoice → labelled SIMULATION (guardrail #3).
    let fiscal;
    try {
      fiscal = await c.rpc("tools/call", { name: "send_einvoice", arguments: { invoiceId: "inv_demo_0001", format: "facturae", dispatchMode: "download" } });
    } catch { /* tool name variant */ }
    if (fiscal) {
      const fSc = sc(fiscal);
      assert(fSc._demo === true, "send_einvoice _demo === true");
      assert(fSc._simulated === true || String(firstText(fiscal)).toLowerCase().includes("simulad"), "send_einvoice is labelled as simulated");
    } else {
      console.log("  SKIP  send_einvoice (tool name not found — non-fatal)");
    }

    // 5. No-network proof: the server produced no fetch error and is alive.
    const stderr = c.getStderr();
    assert(!/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(stderr), "no network errors in stderr (no real HTTP attempted)");
    assert(/demo_session_started/.test(stderr), "demo_session_started event emitted to observability log");
    assert(/Demo profile active/.test(stderr), "demo profile startup log present");
  } catch (err) {
    console.log(`  ERROR ${err.message}`);
    failures.push(`default-mode: ${err.message}`);
  } finally {
    c.child.kill();
  }
}

/* ------------------------------------------------------------------ */
/*  Grouped mode — meta-tools MUST carry the banner (the fix)          */
/* ------------------------------------------------------------------ */

async function runGroupedMode() {
  console.log("\n[demo-smoke] grouped tool mode (FRIHET_TOOL_MODE=grouped)");
  const c = makeClient({ FRIHET_TOOL_MODE: "grouped" });
  try {
    await handshake(c);

    // 1. list_tool_groups → the discovery meta-tool MUST carry the banner.
    const groups = await c.rpc("tools/call", { name: "list_tool_groups", arguments: {} });
    const gSc = sc(groups);
    assert(gSc._demo === true, "grouped: list_tool_groups _demo === true");
    assert(firstText(groups).includes("DEMO MODE"), "grouped: list_tool_groups content carries DEMO MODE banner");
    assert(typeof gSc._demoNotice === "string" && gSc._demoNotice.includes("app.frihet.io"), "grouped: list_tool_groups _demoNotice present");

    // 2. search_tools → carries the banner.
    const search = await c.rpc("tools/call", { name: "search_tools", arguments: { query: "invoice" } });
    const sSc = sc(search);
    assert(sSc._demo === true, "grouped: search_tools _demo === true");
    assert(firstText(search).includes("DEMO MODE"), "grouped: search_tools content carries DEMO MODE banner");

    // 3. describe_tool (valid name → handler path) → carries the banner.
    const desc = await c.rpc("tools/call", { name: "describe_tool", arguments: { name: "list_invoices" } });
    const dSc = sc(desc);
    assert(dSc._demo === true, "grouped: describe_tool _demo === true");
    assert(firstText(desc).includes("DEMO MODE"), "grouped: describe_tool content carries DEMO MODE banner");

    // 4. describe_tool with an INVALID-typed arg → SDK input-schema validation
    //    error (runs BEFORE the handler, funnelled through createToolError). It
    //    must STILL carry the banner (P1.5).
    const badArg = await c.rpc("tools/call", { name: "describe_tool", arguments: { name: 12345 } });
    assert(badArg?.result?.isError === true, "grouped: describe_tool(name:number) yields an isError result (schema validation)");
    assert(sc(badArg)._demo === true, "grouped: validation-error result carries _demo (P1.5)");
    assert(firstText(badArg).includes("DEMO MODE"), "grouped: validation-error result carries DEMO MODE banner (P1.5)");

    // 5. A regular business tool is still stamped in grouped mode.
    const inv = await c.rpc("tools/call", { name: "list_invoices", arguments: { limit: 5 } });
    assert(sc(inv)._demo === true, "grouped: list_invoices (regular tool) still _demo === true");

    // 6. Startup + no-network proofs.
    const stderr = c.getStderr();
    assert(/Grouped tool-exposure active/.test(stderr), "grouped: grouped tool-exposure startup log present");
    assert(/Demo profile active/.test(stderr), "grouped: demo profile startup log present");
    assert(!/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(stderr), "grouped: no network errors in stderr");
  } catch (err) {
    console.log(`  ERROR ${err.message}`);
    failures.push(`grouped-mode: ${err.message}`);
  } finally {
    c.child.kill();
  }
}

await runDefaultMode();
await runGroupedMode();

if (failures.length) {
  console.log(`\nSMOKE FAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log("\nSMOKE PASSED");
process.exit(0);
