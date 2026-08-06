/**
 * LANE B1 golden-flow E2E — exercises the REAL MCP layer (McpServer + MCP SDK
 * Client over InMemoryTransport) against the LIVE Frihet API (api.frihet.io/v1).
 *
 * NOT committed. Run from the worktree root so bare SDK imports resolve:
 *   FRIHET_API_KEY=$(cat scratch/lane-b1-key.txt) node golden-flow-e2e.mjs
 *
 * Flow: create_invoice -> (recover id) -> get_invoice -> list_invoices(fields
 * projection) -> mark_invoice_paid -> verifactu_status -> delete_invoice.
 * Every created invoice is tagged clientName=MARKER and swept at the end via the
 * raw client (so a failing create that still hit the backend leaves no orphan).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FrihetClient } from "./dist/client.js";
import { registerAllTools } from "./dist/tools/register-all.js";

const KEY = process.env.FRIHET_API_KEY;
if (!KEY) { console.error("FRIHET_API_KEY required"); process.exit(2); }

const MARKER = "LANE-B1-e2e-TEMP";
const runId = new Date().toISOString();
const raw = new FrihetClient(KEY); // default https://api.frihet.io/v1

// --- wire a real MCP server + client pair over InMemoryTransport ---
const server = new McpServer({ name: "frihet-erp-e2e", version: "0.0.0" });
registerAllTools(server, new FrihetClient(KEY));
const client = new Client({ name: "lane-b1-harness", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
await client.connect(b);

let pass = 0, fail = 0;
function line(s) { console.log(s); }
function textOf(res) {
  return (res?.content ?? []).map((c) => c.text ?? "").join(" | ").slice(0, 500);
}
async function step(name, args) {
  try {
    const res = await client.callTool({ name, arguments: args });
    const ok = !res.isError;
    if (ok) pass++; else fail++;
    line(`\n[${ok ? "PASS" : "FAIL"}] ${name}(${JSON.stringify(args).slice(0, 120)})`);
    if (!ok) line(`   -> ${textOf(res)}`);
    else line(`   -> structuredContent keys: ${Object.keys(res.structuredContent ?? {}).join(",")}`);
    return res;
  } catch (e) {
    fail++;
    line(`\n[THROW] ${name} -> ${e?.message ?? e}`);
    return { isError: true, error: e };
  }
}

line(`=== LANE B1 golden flow — runId ${runId} ===`);

// 1. create_invoice (BUG-1: mutation {data,meta} envelope)
await step("create_invoice", {
  clientName: MARKER,
  items: [{ description: "E2E golden line", quantity: 1, unitPrice: 100 }],
  taxRate: 21,
  notes: `golden-flow ${runId}`,
});

// recover the created invoice UUID from the backend (create may have failed at
// the MCP schema layer but still created the row). Newest MARKER invoice.
let invoiceId;
{
  const listed = await raw.listInvoices({ limit: 50 });
  const rows = (listed.data ?? []).filter((r) => r.clientName === MARKER);
  invoiceId = rows[0]?.id;
  line(`\n(recovered invoiceId from backend: ${invoiceId} — ${rows.length} MARKER rows)`);
}

// 2. get_invoice (control — reads already unwrap since #64; should PASS)
if (invoiceId) await step("get_invoice", { id: invoiceId });

// 3. list_invoices with field projection (BUG-2: {id}-shaped rows vs schema)
await step("list_invoices", { fields: "id,total", limit: 5 });

// 4. mark_invoice_paid (BUG-1: action {data,meta} envelope + BUG-3: UUID)
if (invoiceId) await step("mark_invoice_paid", { id: invoiceId });

// 5. verifactu_status (BUG-3: UUID reaches fiscal endpoint)
if (invoiceId) await step("verifactu_status", { invoiceId });

// 6. delete_invoice via MCP (result built locally; validates)
if (invoiceId) await step("delete_invoice", { id: invoiceId });

// --- cleanup: sweep ALL MARKER invoices via raw client (orphans included) ---
try {
  const listed = await raw.listInvoices({ limit: 100 });
  const rows = (listed.data ?? []).filter((r) => r.clientName === MARKER);
  for (const r of rows) {
    try { await raw.deleteInvoice(r.id); } catch (e) { line(`cleanup delete ${r.id} failed: ${e?.message}`); }
  }
  line(`\n(cleanup: swept ${rows.length} MARKER invoices)`);
} catch (e) { line(`cleanup list failed: ${e?.message}`); }

line(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
await client.close();
await server.close();
process.exit(fail > 0 ? 1 : 0);
