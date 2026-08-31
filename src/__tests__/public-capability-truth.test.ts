import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_META_KEY,
  buildPublicCapabilityTruth,
} from "../capability-truth.js";
import {
  assertPublicCapabilityContract,
  capturePublicCapabilityContract,
  type PublicCapabilityContract,
} from "../public-capability-contract.js";

const EXPECTED = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../src/__tests__/fixtures/public-capability-contract.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as PublicCapabilityContract;
const WRANGLER_TOML = readFileSync(
  fileURLToPath(
    new URL("../../workers/remote-mcp/wrangler.toml", import.meta.url),
  ),
  "utf8",
);
const ROOT_INDEX_SOURCE = readFileSync(
  fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
  "utf8",
);
const WORKER_INDEX_SOURCE = readFileSync(
  fileURLToPath(
    new URL("../../workers/remote-mcp/src/index.ts", import.meta.url),
  ),
  "utf8",
);
const TOOL_SOURCE_DIRECTORY = fileURLToPath(
  new URL("../../src/tools/", import.meta.url),
);

const ALIAS_NAMES = new Set([
  "frihet_modelo_303_summary",
  "frihet_modelo_130_summary",
  "frihet_modelo_390_summary",
  "frihet_modelo_180_summary",
  "frihet_modelo_347_summary",
]);
const DISCOVERY_NAMES = new Set([
  "list_tool_groups",
  "search_tools",
  "describe_tool",
]);
const DEFERRED_NAMES = new Set([
  "period_close",
  "period_reopen",
  "gestoria_message_send",
  "gestoria_messages_list",
  "gestoria_template_bulk_send",
  "gestoria_aging_consolidated",
  "create_reservation",
  "sync_channel",
]);

function canonicalRemoteTools(contract: PublicCapabilityContract) {
  return contract.surfaces.remoteGrouped.tools.filter(
    (tool) => !ALIAS_NAMES.has(tool.name) && !DISCOVERY_NAMES.has(tool.name),
  );
}

function backendGuardedNames(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(TOOL_SOURCE_DIRECTORY)) {
    if (!file.endsWith(".ts") || file === "backend-availability.ts") continue;
    const source = readFileSync(join(TOOL_SOURCE_DIRECTORY, file), "utf8");
    for (const match of source.matchAll(/withBackendGuard\(\s*"([^"]+)"/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

function strictEInvoiceFallbackNames(): Set<string> {
  const source = readFileSync(join(TOOL_SOURCE_DIRECTORY, "einvoice.ts"), "utf8");
  const registrations = [...source.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)];
  const names = new Set<string>();
  for (const [index, registration] of registrations.entries()) {
    const start = registration.index ?? 0;
    const end = registrations[index + 1]?.index ?? source.length;
    if (source.slice(start, end).includes("if (isNotFoundError(err))")) {
      names.add(registration[1]);
    }
  }
  return names;
}

function assertCallabilityMatchesRuntimeGuards(
  contract: PublicCapabilityContract,
  guarded = backendGuardedNames(),
  strictFallbacks = strictEInvoiceFallbackNames(),
): void {
  const runtimeChecked = new Set(
    canonicalRemoteTools(contract)
      .filter((tool) => tool.capability?.callability === "runtime_checked")
      .map((tool) => tool.name),
  );
  const expected = new Set(
    [...guarded].filter((name) => !DEFERRED_NAMES.has(name)),
  );
  for (const name of strictFallbacks) expected.add(name);
  assert.deepEqual([...runtimeChecked].sort(), [...expected].sort());
}

const actualPromise = capturePublicCapabilityContract();

test("known deferred and unavailable operations fail closed", () => {
  assert.equal(buildPublicCapabilityTruth("period_close", {}).callability, "deferred");
  assert.equal(buildPublicCapabilityTruth("create_reservation", {}).callability, "deferred");
  assert.equal(buildPublicCapabilityTruth("ksef_submit", {}).callability, "unavailable");
});

test("generated remote profiles match the committed Worker configuration", () => {
  assert.equal(
    [...WRANGLER_TOML.matchAll(/^FRIHET_TOOL_MODE\s*=\s*"grouped"$/gm)].length,
    1,
    "only the full Worker profile opts into grouped mode",
  );
  assert.match(
    WRANGLER_TOML,
    /^FRIHET_OPENAI_MODE\s*=\s*"true"$/m,
    "OpenAI Worker profile must remain explicitly scoped",
  );
  assert.match(
    ROOT_INDEX_SOURCE,
    /localMcpSurfaceComposition\(openaiMode, toolMode === "grouped"\)/,
  );
  assert.match(
    WORKER_INDEX_SOURCE,
    /const groupedMode = !openaiMode && toolMode === "grouped"/,
  );
});

test("catalogue membership never becomes an unconditional available claim", () => {
  const truth = buildPublicCapabilityTruth("list_invoices", { readOnlyHint: true });
  assert.equal(truth.registered, true);
  assert.equal(truth.callability, "api_dependent");
  assert.notEqual(truth.callability as string, "available");
  assert.equal(CAPABILITY_META_KEY, "io.frihet/capability");
});

test("external side effects are explicit and closed by default", () => {
  const send = buildPublicCapabilityTruth("send_invoice", {});
  assert.equal(send.externalInteraction, true);
  assert.deepEqual(send.externalSideEffects, [
    "email_or_invitation",
    "webhook_delivery_or_configuration",
    "fiscal_or_einvoice_submission",
  ]);

  const read = buildPublicCapabilityTruth("list_invoices", { readOnlyHint: true });
  assert.equal(read.externalInteraction, false);
  assert.deepEqual(read.externalSideEffects, []);
});

test("real SDK surfaces match the generated public capability contract", async () => {
  const actual = await actualPromise;
  assert.doesNotThrow(() => assertPublicCapabilityContract(actual, EXPECTED));
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(actual.surfaces).map(([name, surface]) => [
        name,
        {
          tools: surface.tools.length,
          resources: surface.resources.length,
          prompts: surface.prompts.length,
        },
      ]),
    ),
    {
      localFull: { tools: 163, resources: 11, prompts: 10 },
      remoteGrouped: { tools: 166, resources: 7, prompts: 10 },
      openaiFull: { tools: 33, resources: 0, prompts: 0 },
    },
  );
});

test("full-surface action hints expose destructive and external effects", async () => {
  const { tools } = (await actualPromise).surfaces.remoteGrouped;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  assert.deepEqual(byName.get("send_invoice")?.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.deepEqual(byName.get("frihet_portal_domain_verify")?.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  for (const name of ["send_einvoice", "face_submit", "ticketbai_submit"]) {
    assert.deepEqual(byName.get(name)?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  }
  assert.deepEqual(byName.get("einvoice_export")?.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.equal(byName.get("einvoice_export")?.capability?.writesFrihet, true);
  assert.equal(byName.get("delete_webhook")?.annotations?.openWorldHint, true);
  assert.equal(byName.get("refund_sale")?.capability?.externalInteraction, true);
  assert.deepEqual(byName.get("refund_sale")?.capability?.externalSideEffects, [
    "money_movement",
  ]);

  const externalNames = tools
    .filter((tool) => tool.capability?.externalInteraction)
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(externalNames, [
    "create_client",
    "create_credit_note",
    "create_expense",
    "create_invoice",
    "create_product",
    "create_quote",
    "create_webhook",
    "delete_invoice",
    "delete_quote",
    "delete_webhook",
    "duplicate_invoice",
    "face_status",
    "face_submit",
    "frihet_portal_domain_add",
    "frihet_portal_domain_remove",
    "frihet_portal_domain_verify",
    "frihet_tax_id_vies_lookup",
    "gestoria_message_send",
    "gestoria_template_bulk_send",
    "invite_team_member",
    "log_client_activity",
    "mark_invoice_paid",
    "refund_sale",
    "send_einvoice",
    "send_invoice",
    "send_quote",
    "sync_channel",
    "test_webhook",
    "ticketbai_submit",
    "update_client",
    "update_expense",
    "update_invoice",
    "update_product",
    "update_quote",
    "update_webhook",
    "verifactu_resubmit",
  ]);
});

test("canonical callability classes remain conservative and exhaustive", async () => {
  const contract = await actualPromise;
  const counts: Record<string, number> = {};
  for (const tool of canonicalRemoteTools(contract)) {
    const callability = tool.capability?.callability;
    assert.ok(callability);
    counts[callability] = (counts[callability] ?? 0) + 1;
  }
  assert.deepEqual(counts, {
    api_dependent: 100,
    runtime_checked: 49,
    deferred: 8,
    unavailable: 1,
  });
  const deferred = canonicalRemoteTools(contract)
    .filter((tool) => tool.capability?.callability === "deferred")
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(deferred, [...DEFERRED_NAMES].sort());
  assertCallabilityMatchesRuntimeGuards(contract);
});

test("grouped discovery returns the same public truth as tools/list", async () => {
  const contract = await actualPromise;
  const listed = contract.surfaces.remoteGrouped.tools.find(
    (tool) => tool.name === "send_invoice",
  );
  assert.ok(listed);
  assert.deepEqual(contract.surfaces.remoteGrouped.discovery, {
    searchTools: listed,
    describeTool: listed,
  });
  for (const name of DISCOVERY_NAMES) {
    assert.equal(
      contract.surfaces.remoteGrouped.tools.find((tool) => tool.name === name)
        ?.capability?.canonicalOperation,
      name,
    );
  }
});

test("mutation: resource-count drift turns the generated gate red", async () => {
  const actual = structuredClone(await actualPromise);
  actual.surfaces.remoteGrouped.resources.pop();
  assert.throws(() => assertPublicCapabilityContract(actual, EXPECTED));
});

test("mutation: external-side-effect annotation drift turns the gate red", async () => {
  const actual = structuredClone(await actualPromise);
  const sendInvoice = actual.surfaces.remoteGrouped.tools.find(
    (tool) => tool.name === "send_invoice",
  );
  assert.ok(sendInvoice?.annotations);
  sendInvoice.annotations.openWorldHint = false;
  assert.throws(() => assertPublicCapabilityContract(actual, EXPECTED));
});

test("mutation: catalogue/capability conflation turns the gate red", async () => {
  const actual = structuredClone(await actualPromise);
  const listInvoices = actual.surfaces.remoteGrouped.tools.find(
    (tool) => tool.name === "list_invoices",
  );
  assert.ok(listInvoices?.capability);
  (listInvoices.capability as { callability: string }).callability = "available";
  assert.throws(() => assertPublicCapabilityContract(actual, EXPECTED));
});

test("mutation: runtime-guard/callability drift turns the semantic check red", async () => {
  const actual = await actualPromise;
  const guarded = backendGuardedNames();
  guarded.delete("get_modelo_303_summary");
  assert.throws(() =>
    assertCallabilityMatchesRuntimeGuards(
      actual,
      guarded,
      strictEInvoiceFallbackNames(),
    ),
  );

  const strictFallbacks = strictEInvoiceFallbackNames();
  strictFallbacks.delete("send_einvoice");
  assert.throws(() =>
    assertCallabilityMatchesRuntimeGuards(
      actual,
      backendGuardedNames(),
      strictFallbacks,
    ),
  );
});

test("mutation: grouped discovery truth drift turns the generated gate red", async () => {
  const actual = structuredClone(await actualPromise);
  const discovery = actual.surfaces.remoteGrouped.discovery;
  assert.ok(discovery?.searchTools.capability);
  delete discovery.searchTools.capability;
  assert.throws(() => assertPublicCapabilityContract(actual, EXPECTED));
});
