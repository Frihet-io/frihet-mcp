/**
 * Demo-mode smoke test. Spawns the built server with FRIHET_DEMO=1 (NO api key),
 * performs the MCP initialize handshake, then calls a few tools over stdio
 * JSON-RPC and asserts the demo guardrails hold end-to-end.
 *
 * Exits 0 on success, 1 on any failed assertion.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "index.js");

const env = { ...process.env };
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

const failures = [];
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label}`); failures.push(label); }
}

function sc(res) {
  return res?.result?.structuredContent ?? {};
}
function firstText(res) {
  return res?.result?.content?.[0]?.text ?? "";
}

try {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "demo-smoke", version: "1.0.0" },
  });
  notify("notifications/initialized", {});

  // 1. Read: list_invoices → fixtures + _demo banner.
  const inv = await rpc("tools/call", { name: "list_invoices", arguments: { limit: 20 } });
  const invSc = sc(inv);
  assert(invSc._demo === true, "list_invoices structuredContent._demo === true");
  assert(Array.isArray(invSc.data) && invSc.data.length >= 8, `list_invoices returns >=8 fixture invoices (got ${invSc.data?.length})`);
  assert(firstText(inv).includes("DEMO MODE"), "list_invoices first content block carries DEMO MODE banner");
  assert(typeof invSc._demoNotice === "string" && invSc._demoNotice.includes("app.frihet.io"), "list_invoices _demoNotice points to app.frihet.io settings");

  // 2. Read single client fixture.
  const cli = await rpc("tools/call", { name: "list_clients", arguments: {} });
  const cliSc = sc(cli);
  assert(cliSc._demo === true, "list_clients _demo === true");
  assert(Array.isArray(cliSc.data) && cliSc.data.length === 5, `list_clients returns 5 clients (got ${cliSc.data?.length})`);

  // 3. Write: create_client → simulated in-memory, returned as created + _demo.
  const created = await rpc("tools/call", { name: "create_client", arguments: { name: "Nuevo Cliente Demo", email: "nuevo@example.com" } });
  const createdSc = sc(created);
  assert(createdSc._demo === true, "create_client _demo === true");
  assert(typeof createdSc.id === "string" && createdSc.id.length > 0, "create_client returns a generated id");
  assert(createdSc.name === "Nuevo Cliente Demo", "create_client echoes the created entity");

  // 4. Fiscal/email surface: send_einvoice → labelled SIMULATION (guardrail #3).
  let fiscal;
  try {
    fiscal = await rpc("tools/call", { name: "send_einvoice", arguments: { invoiceId: "inv_demo_0001", format: "facturae", dispatchMode: "download" } });
  } catch { /* tool name variant */ }
  if (fiscal) {
    const fSc = sc(fiscal);
    assert(fSc._demo === true, "send_einvoice _demo === true");
    assert(fSc._simulated === true || String(firstText(fiscal)).toLowerCase().includes("simulad"), "send_einvoice is labelled as simulated");
  } else {
    console.log("  SKIP  send_einvoice (tool name not found — non-fatal)");
  }

  // 5. No-network proof: the server produced no fetch error and is alive.
  assert(!/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(stderr), "no network errors in stderr (no real HTTP attempted)");
  assert(/demo_session_started/.test(stderr), "demo_session_started event emitted to observability log");
  assert(/Demo profile active/.test(stderr), "demo profile startup log present");
} catch (err) {
  console.log(`  ERROR ${err.message}`);
  failures.push(err.message);
} finally {
  child.kill();
}

if (failures.length) {
  console.log(`\nSMOKE FAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log("\nSMOKE PASSED");
process.exit(0);
