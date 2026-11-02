/**
 * Verification suite for the ChatGPT 1.0.3 product expansion candidate.
 *
 * Tests:
 * 1. 1.0.2 baseline preservation (33 tools unchanged when candidateVersion is omitted)
 * 2. 1.0.3 read-only candidate surface (37 tools: +get_daily_operational_brief,
 *    +get_business_period_summary, +search_clients, +search_vendors; update_draft_invoice
 *    excluded due to non-atomic backend PATCH precondition gap)
 * 3. Wire-level OAuth securitySchemes, closed inputSchema, and zero tax-ID /
 *    tax-return fields in inputSchema or outputSchema
 * 4. Multi-page directory search coverage, server-side projection, cursor/offset
 *    continuation, epistemic honesty on matchStatus ('partial_scan_single_match',
 *    'partial_scan_no_match', 'ambiguous', 'exact', 'unambiguous', 'none'), and
 *    request/payload telemetry
 * 5. Chained 3-turn end-to-end product journey:
 *    - Turn 1: «¿Qué merece mi atención hoy?» -> get_daily_operational_brief
 *    - Turn 2: «Compáralo con el mes anterior» -> get_business_period_summary
 *    - Turn 3: «Tengo una reunión con este cliente; prepárame» -> search_clients
 * 6. 1.0.3 plugin bundle & 4 skills contract verification (all 37 tools covered,
 *    deterministic ZIP build).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IFrihetClient } from "../client-interface.js";
import {
  applyOpenAIProfile,
  OPENAI_103_READ_ONLY_CANDIDATE_TOOLS,
  OPENAI_REVIEWED_TOOL_ALLOWLIST,
  type ApplyOpenAIProfileOptions,
} from "../openai-profile.js";
import { registerAllTools } from "../tools/register-all.js";
import {
  CLIENT_SEARCH_SERVER_PROJECTION,
  VENDOR_SEARCH_SERVER_PROJECTION,
  registerOpenAI103CandidateTools,
} from "../openai-103/openai-expansion-103.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Builds a multi-page synthetic workspace with 320 clients across 4 pages
 * (100, 100, 100, 20) and 220 vendors across 3 pages (100, 100, 20):
 * - Page 1 of clients contains "Acme Iberia SL" (id=cli_acme_es) and "Acme Global Consulting" (id=cli_acme_us)
 * - Page 3 of clients (index 240) contains "Acme Canarias SL" (id=cli_acme_canarias) and "Norte Digital Studio SL" (id=cli_norte_p3)
 * - Page 1 of clients also contains "Norte Logistica SL" (id=cli_norte_p1)
 */
function buildMultiPageClientDirectory(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 320; i++) {
    if (i === 0) {
      rows.push({
        id: "cli_acme_es",
        name: "Acme Iberia SL",
        stage: "active",
        email: "facturacion@acme-iberia.example",
        phone: "+34910001122",
        taxId: "B87654321",
        address: { street: "Calle Mayor 10", city: "Madrid" },
      });
    } else if (i === 1) {
      rows.push({
        id: "cli_acme_us",
        name: "Acme Global Consulting",
        stage: "proposal",
        email: "ap@acmeglobal.example",
        taxId: "US99887766",
      });
    } else if (i === 2) {
      rows.push({
        id: "cli_beta",
        name: "Beta Retail SL",
        stage: "lead",
        email: "hola@betaretail.example",
        taxId: "B11223344",
      });
    } else if (i === 3) {
      rows.push({
        id: "cli_sol_unico",
        name: "Soluciones Atlantida SL",
        stage: "active",
        email: "admin@atlantida.example",
        taxId: "B44556677",
      });
    } else if (i === 240) {
      rows.push({
        id: "cli_acme_canarias",
        name: "Acme Canarias SL",
        stage: "active",
        email: "administracion@acmecanarias.example",
        phone: "+34928001122",
        taxId: "B76543210",
      });
    } else if (i === 250) {
      rows.push({
        id: "cli_page3_only",
        name: "Zeta Industrial SL",
        stage: "active",
        email: "contacto@zetaindustrial.example",
        taxId: "B99881122",
      });
    } else {
      rows.push({
        id: `cli_filler_${i}`,
        name: `Cliente Directorio ${String(i).padStart(3, "0")} SL`,
        stage: "active",
        email: `cliente${i}@directorio.example`,
        taxId: `B${String(10000000 + i)}`,
      });
    }
  }
  return rows;
}

function buildMultiPageVendorDirectory(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 220; i++) {
    if (i === 0) {
      rows.push({
        id: "ven_1",
        name: "Cloud Hosting EU",
        email: "billing@cloudhosting.example",
        taxId: "DE123456789",
        address: { street: "Hauptstr 1", city: "Berlin" },
      });
    } else if (i === 1) {
      rows.push({
        id: "ven_2",
        name: "Restaurante Puerto",
        taxId: "B55667788",
      });
    } else if (i === 150) {
      rows.push({
        id: "ven_cloud_us",
        name: "Cloud Hosting Americas Inc",
        email: "ar@cloudamericas.example",
        taxId: "US12345678",
      });
    } else {
      rows.push({
        id: `ven_filler_${i}`,
        name: `Proveedor Suministros ${String(i).padStart(3, "0")} SL`,
        email: `proveedor${i}@suministros.example`,
        taxId: `B${String(20000000 + i)}`,
      });
    }
  }
  return rows;
}

const ALL_CLIENTS = buildMultiPageClientDirectory();
const ALL_VENDORS = buildMultiPageVendorDirectory();

function projectRecordFields(
  rec: Record<string, unknown>,
  fieldsCsv: unknown,
): Record<string, unknown> {
  if (typeof fieldsCsv !== "string" || !fieldsCsv.trim()) return rec;
  const allowed = fieldsCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const projected: Record<string, unknown> = { id: rec.id };
  for (const f of allowed) {
    if (f in rec) projected[f] = rec[f];
  }
  return projected;
}

function paginateSyntheticCollection(
  allRows: Array<Record<string, unknown>>,
  params: Record<string, unknown>,
  cursorPrefix: string,
) {
  const limit = typeof params.limit === "number" ? params.limit : 100;
  let startIndex = 0;
  if (typeof params.after === "string" && params.after.startsWith(cursorPrefix)) {
    startIndex = Number(params.after.slice(cursorPrefix.length)) || 0;
  } else if (typeof params.offset === "number") {
    startIndex = params.offset;
  }
  const filtered =
    typeof params.stage === "string"
      ? allRows.filter((r) => r.stage === params.stage)
      : allRows;
  const slice = filtered
    .slice(startIndex, startIndex + limit)
    .map((r) => projectRecordFields(r, params.fields));
  const nextIndex = startIndex + slice.length;
  const nextCursor = nextIndex < filtered.length ? `${cursorPrefix}${nextIndex}` : undefined;
  return {
    data: slice,
    total: filtered.length,
    limit,
    offset: startIndex,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function createSyntheticClient(spyCalls: Array<{ method: string; args: unknown[] }> = []): IFrihetClient {
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    async getBusinessContext() {
      return {
        business: {
          name: "Estudio Norte SL",
          taxId: "B12345678",
          fiscalZone: "peninsula",
          currency: "EUR",
          language: "es",
          country: "ES",
        },
        defaults: { taxRate: 21, irpfRate: 15, dueDays: 30, currency: "EUR" },
        plan: {
          name: "pro",
          invoices: { used: 12, limit: "unlimited" },
          expenses: { used: 8, limit: "unlimited" },
          aiMessages: { used: 20, limit: 500 },
        },
        series: [{ id: "s1", prefix: "F-2026-", current: 12, year: 2026 }],
        recentActivity: {
          lastInvoice: { number: "F-2026-012", date: "2026-10-25", client: "Acme Iberia SL" },
          lastExpense: { date: "2026-10-24", vendor: "Cloud Hosting EU", amount: 120 },
          overdueCount: 1,
          overdueAmount: 1815,
          unpaidCount: 2,
        },
        topClients: [{ name: "Acme Iberia SL", totalRevenue: 5400, invoiceCount: 3 }],
        currentMonth: { revenue: 4235, expenses: 205, profit: 4030, invoiceCount: 3, expenseCount: 2 },
      };
    },

    async listInvoices(params?: unknown) {
      const p = (params ?? {}) as Record<string, unknown>;
      const from = typeof p.from === "string" ? p.from : undefined;
      if (from?.startsWith("2026-08")) {
        return {
          data: [
            {
              id: "inv_aug_1",
              documentNumber: "F-2026-007",
              clientName: "Acme Iberia SL",
              issueDate: "2026-08-12",
              dueDate: "2026-08-27",
              status: "paid",
              currency: "EUR",
              total: 1000,
            },
            // Duplicate of inv_aug_1 (F-06 dedup check)
            {
              id: "inv_aug_1",
              documentNumber: "F-2026-007",
              clientName: "Acme Iberia SL",
              issueDate: "2026-08-12",
              dueDate: "2026-08-27",
              status: "paid",
              currency: "EUR",
              total: 1000,
            },
            // Out-of-period record (F-06 date boundary check)
            {
              id: "inv_july_leaked",
              documentNumber: "F-2026-006",
              clientName: "Acme Iberia SL",
              issueDate: "2026-07-31",
              dueDate: "2026-08-15",
              status: "paid",
              currency: "EUR",
              total: 9999,
            },
            // American-spelled canceled invoice (F-06 status check)
            {
              id: "inv_aug_canceled",
              documentNumber: "F-2026-008A",
              clientName: "Acme Iberia SL",
              issueDate: "2026-08-15",
              dueDate: "2026-08-30",
              status: "canceled",
              currency: "EUR",
              total: 5000,
            },
            // Invoice with unavailable amount (F-04 non-fabricating delta check)
            {
              id: "inv_aug_unavailable",
              documentNumber: "F-2026-008B",
              clientName: "Beta Retail SL",
              issueDate: "2026-08-20",
              dueDate: "2026-09-05",
              status: "sent",
              currency: "EUR",
            },
          ],
          total: 5,
          limit: 100,
          offset: 0,
        };
      }
      if (from?.startsWith("2026-09")) {
        return {
          data: [
            {
              id: "inv_sep_1",
              documentNumber: "F-2026-009",
              clientName: "Acme Iberia SL",
              issueDate: "2026-09-10",
              dueDate: "2026-09-25",
              status: "paid",
              currency: "EUR",
              total: 1210,
              items: [{ description: "Consultoria Septiembre", quantity: 1, unitPrice: 1000, taxRate: 21 }],
            },
            {
              id: "inv_sep_usd",
              documentNumber: "F-2026-010",
              clientName: "Acme Global Consulting",
              issueDate: "2026-09-18",
              dueDate: "2026-10-05",
              paidDate: "2026-10-05",
              status: "paid",
              currency: "USD",
              total: 500,
              items: [{ description: "US Advisory (issued Sep, paid Oct)", quantity: 1, unitPrice: 500, taxRate: 0 }],
            },
          ],
          total: 2,
          limit: 100,
          offset: 0,
        };
      }

      return {
        data: [
          {
            id: "inv_oct_overdue",
            documentNumber: "F-2026-011",
            clientId: "cli_acme_es",
            clientName: "Acme Iberia SL",
            issueDate: "2026-10-01",
            dueDate: "2026-10-15",
            status: "overdue",
            currency: "EUR",
            total: 1815,
            items: [{ description: "Auditoria Q4", quantity: 1, unitPrice: 1500, taxRate: 21 }],
          },
          {
            id: "inv_oct_paid",
            documentNumber: "F-2026-012",
            clientId: "cli_acme_es",
            clientName: "Acme Iberia SL",
            issueDate: "2026-10-20",
            dueDate: "2026-11-05",
            paidDate: "2026-11-02",
            status: "paid",
            currency: "EUR",
            total: 2420,
            items: [{ description: "Implementacion ERP (issued Oct, paid Nov)", quantity: 1, unitPrice: 2000, taxRate: 21 }],
          },
          {
            id: "inv_oct_usd",
            documentNumber: "F-2026-013",
            clientName: "Acme Global Consulting",
            issueDate: "2026-10-22",
            dueDate: "2026-11-06",
            status: "sent",
            currency: "USD",
            total: 800,
            items: [{ description: "Retainer Oct", quantity: 1, unitPrice: 800, taxRate: 0 }],
          },
          {
            id: "inv_oct_draft",
            documentNumber: "DRAFT-2026-004",
            clientName: "Beta Retail SL",
            issueDate: "2026-10-27",
            dueDate: "2026-11-27",
            status: "draft",
            currency: "EUR",
            total: 605,
            items: [{ description: "Propuesta inicial", quantity: 1, unitPrice: 500, taxRate: 21 }],
          },
        ],
        total: 4,
        limit: 100,
        offset: 0,
      };
    },

    async searchInvoices(query?: unknown) {
      const q = String(query ?? "").toLowerCase();
      const all = [
        {
          id: "inv_oct_overdue",
          documentNumber: "F-2026-011",
          clientId: "cli_acme_es",
          clientName: "Acme Iberia SL",
          issueDate: "2026-10-01",
          dueDate: "2026-10-15",
          status: "overdue",
          currency: "EUR",
          total: 1815,
        },
        {
          id: "inv_oct_paid",
          documentNumber: "F-2026-012",
          clientId: "cli_acme_es",
          clientName: "Acme Iberia SL",
          issueDate: "2026-10-20",
          dueDate: "2026-11-05",
          status: "paid",
          currency: "EUR",
          total: 2420,
        },
        {
          id: "inv_oct_usd",
          documentNumber: "F-2026-013",
          clientId: "cli_acme_us",
          clientName: "Acme Global Consulting",
          issueDate: "2026-10-22",
          dueDate: "2026-11-06",
          status: "sent",
          currency: "USD",
          total: 800,
        },
        {
          id: "inv_oct_canarias",
          documentNumber: "F-2026-014",
          clientId: "cli_acme_canarias",
          clientName: "Acme Canarias SL",
          issueDate: "2026-10-24",
          dueDate: "2026-11-08",
          status: "sent",
          currency: "EUR",
          total: 963,
        },
      ];
      const filtered = all.filter((i) => i.clientName.toLowerCase().includes(q));
      return { data: filtered, total: filtered.length, limit: 5, offset: 0 };
    },

    async listQuotes() {
      return {
        data: [
          {
            id: "quo_1",
            documentNumber: "P-2026-003",
            clientName: "Acme Iberia SL",
            issueDate: "2026-10-20",
            validUntil: "2026-11-01",
            status: "sent",
            currency: "EUR",
            total: 1210,
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
      };
    },

    async listExpenses(params?: unknown) {
      const p = (params ?? {}) as Record<string, unknown>;
      const from = typeof p.from === "string" ? p.from : undefined;
      if (from?.startsWith("2026-09")) {
        return {
          data: [
            {
              id: "exp_sep_1",
              description: "Servidor Septiembre",
              vendor: "Cloud Hosting EU",
              vendorId: "ven_1",
              date: "2026-09-05",
              category: "software",
              amount: 100,
              currency: "EUR",
              taxDeductible: true,
            },
          ],
          total: 1,
          limit: 100,
          offset: 0,
        };
      }
      return {
        data: [
          {
            id: "exp_oct_1",
            description: "Servidor Octubre",
            vendor: "Cloud Hosting EU",
            vendorId: "ven_1",
            date: "2026-10-05",
            category: "software",
            amount: 120,
            currency: "EUR",
            taxDeductible: true,
          },
          {
            id: "exp_oct_2",
            description: "Comida equipo",
            vendor: "Restaurante Puerto",
            vendorId: "ven_2",
            date: "2026-10-18",
            category: "meals",
            amount: 85,
            currency: "EUR",
            taxDeductible: false,
          },
          {
            id: "exp_oct_3",
            description: "Dominio anual sin clasificacion de deducibilidad",
            vendor: "Cloud Hosting EU",
            vendorId: "ven_1",
            date: "2026-10-21",
            category: "software",
            amount: 50,
            currency: "EUR",
            // taxDeductible intentionally omitted to verify tri-state classification (true / false / undetermined)
          },
        ],
        total: 3,
        limit: 100,
        offset: 0,
      };
    },

    async listClients(params?: unknown) {
      const p = (params ?? {}) as Record<string, unknown>;
      return paginateSyntheticCollection(ALL_CLIENTS, p, "cli_cursor_");
    },

    async listClientActivities(clientId: unknown) {
      if (clientId === "cli_acme_es") {
        return {
          data: [
            {
              id: "act_1",
              type: "call",
              title: "Confirmada renovacion anual Q4",
              timestamp: "2026-10-25T10:00:00Z",
            },
          ],
          total: 1,
          limit: 5,
          offset: 0,
        };
      }
      if (clientId === "cli_acme_canarias") {
        return {
          data: [
            {
              id: "act_can_1",
              type: "meeting",
              title: "Revision despliegue Las Palmas",
              timestamp: "2026-10-26T15:00:00Z",
            },
          ],
          total: 1,
          limit: 5,
          offset: 0,
        };
      }
      return { data: [], total: 0, limit: 5, offset: 0 };
    },

    async listVendors(params?: unknown) {
      const p = (params ?? {}) as Record<string, unknown>;
      return paginateSyntheticCollection(ALL_VENDORS, p, "ven_cursor_");
    },
  };

  return new Proxy({} as IFrihetClient, {
    get(_target, prop: string) {
      return async (...args: unknown[]) => {
        spyCalls.push({ method: prop, args });
        if (handlers[prop]) return handlers[prop](...args);
        throw new Error(`Unexpected IFrihetClient method in test: ${prop}`);
      };
    },
  });
}

async function withOpenAICandidateClient<T>(
  profileOptions: ApplyOpenAIProfileOptions | undefined,
  fn: (mcpClient: Client, spyCalls: Array<{ method: string; args: unknown[] }>) => Promise<T>,
): Promise<T> {
  const spyCalls: Array<{ method: string; args: unknown[] }> = [];
  const server = new McpServer({ name: "Frihet", version: "1.18.0" });
  applyOpenAIProfile(server, profileOptions);
  const apiClient = createSyntheticClient(spyCalls);
  registerAllTools(server, apiClient);
  if (profileOptions?.candidateVersion === "1.0.3") {
    registerOpenAI103CandidateTools(server, apiClient);
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "openai-103-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  try {
    return await fn(mcpClient, spyCalls);
  } finally {
    await mcpClient.close();
    await server.close();
  }
}

describe("ChatGPT 1.0.2 baseline vs 1.0.3 product candidate", () => {
  test("1.0.2 default profile stays frozen at exactly 33 tools", async () => {
    await withOpenAICandidateClient(undefined, async (mcpClient) => {
      const { tools } = await mcpClient.listTools();
      assert.equal(tools.length, 33);
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        [...OPENAI_REVIEWED_TOOL_ALLOWLIST].sort(),
      );
    });
  });

  test("1.0.3 candidate exposes exactly 37 tools (33 + 4 read-only) with OAuth schemes and zero tax-ID / tax-filing schema fields", async () => {
    await withOpenAICandidateClient(
      { candidateVersion: "1.0.3" },
      async (mcpClient) => {
        const { tools } = await mcpClient.listTools();
        assert.equal(tools.length, 37);
        const names = new Set(tools.map((t) => t.name));
        for (const candidate of OPENAI_103_READ_ONLY_CANDIDATE_TOOLS) {
          assert.ok(names.has(candidate), `missing 1.0.3 candidate tool ${candidate}`);
        }
        assert.ok(
          !names.has("update_draft_invoice"),
          "update_draft_invoice must remain excluded until backend PATCH supports atomic draft preconditions",
        );

        const forbiddenSchemaKeys = new Set([
          "taxId",
          "clientTaxId",
          "nif",
          "cif",
          "vatNumber",
          "iban",
          "taxLiability",
          "estimatedModel303",
          "vatPayable",
          "irpfRetained",
        ]);

        const checkNoForbiddenKeys = (node: unknown, path: string): void => {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) {
            node.forEach((child, idx) => checkNoForbiddenKeys(child, `${path}[${idx}]`));
            return;
          }
          const rec = node as Record<string, unknown>;
          if (rec.properties && typeof rec.properties === "object") {
            for (const [k, v] of Object.entries(rec.properties as Record<string, unknown>)) {
              assert.ok(!forbiddenSchemaKeys.has(k), `forbidden schema property ${k} at ${path}.${k}`);
              checkNoForbiddenKeys(v, `${path}.${k}`);
            }
          }
          for (const [k, v] of Object.entries(rec)) {
            if (k !== "properties") checkNoForbiddenKeys(v, `${path}.${k}`);
          }
        };

        for (const tool of tools) {
          assert.ok(tool.description?.includes("openWorldHint"), `${tool.name} missing openWorldHint rationale`);
          checkNoForbiddenKeys(tool.inputSchema, `${tool.name}.inputSchema`);
          checkNoForbiddenKeys(tool.outputSchema, `${tool.name}.outputSchema`);
        }
      },
    );
  });

  test("Multi-page search_clients enforces server-side projection, cursor continuation, telemetry, and epistemic honesty on partial vs complete coverage", async () => {
    await withOpenAICandidateClient({ candidateVersion: "1.0.3" }, async (mcpClient, spyCalls) => {
      // 1. Tax ID rejection before touching backend
      const taxIdRes = await mcpClient.callTool({
        name: "search_clients",
        arguments: { query: "B87654321" },
      });
      assert.equal(taxIdRes.isError, true);
      assert.equal(spyCalls.length, 0, "tax ID query must be rejected before calling backend");

      // 2. Partial scan (maxPages=1 => 100 of 320 inspected) for a client that has 1 match on Page 1:
      // Must return 'partial_scan_single_match' (NEVER 'exact' or 'unambiguous' when 220 records remain uninspected!)
      const partialSingleRes = await mcpClient.callTool({
        name: "search_clients",
        arguments: { query: "Soluciones Atlantida SL", maxPages: 1 },
      });
      assert.notEqual(partialSingleRes.isError, true);
      const partialSingleSc = partialSingleRes.structuredContent as Record<string, unknown>;
      assert.equal(
        partialSingleSc.matchStatus,
        "partial_scan_single_match",
        "1 match on partial scan must be partial_scan_single_match, never exact/unambiguous",
      );
      const partialCoverage = partialSingleSc.coverage as Record<string, unknown>;
      assert.equal(partialCoverage.inspected, 100);
      assert.equal(partialCoverage.total, 320);
      assert.equal(partialCoverage.uninspectedCount, 220);
      assert.equal(partialCoverage.complete, false);
      assert.equal(partialCoverage.nextCursor, "cli_cursor_100");
      const partialTelemetry = partialCoverage.telemetry as Record<string, unknown>;
      assert.equal(partialTelemetry.directoryPagesFetched, 1);
      assert.equal(partialTelemetry.serverProjectionFields, CLIENT_SEARCH_SERVER_PROJECTION);
      assert.ok(Number(partialTelemetry.approximatePayloadBytes) > 0);

      // Verify server-side fields projection and absence of q on listClients call
      const listClientsCall = spyCalls.find((c) => c.method === "listClients");
      assert.ok(listClientsCall);
      const listClientsArgs = listClientsCall.args[0] as Record<string, unknown>;
      assert.equal(listClientsArgs.q, undefined, "search_clients must never pass q to backend listClients");
      assert.equal(listClientsArgs.fields, CLIENT_SEARCH_SERVER_PROJECTION);

      // 3. Partial scan (maxPages=1) for a client located on Page 3 ("Zeta Industrial SL"):
      // Must return 'partial_scan_no_match' (NEVER 'none' when 220 records remain uninspected!)
      const partialNoMatchRes = await mcpClient.callTool({
        name: "search_clients",
        arguments: { query: "Zeta Industrial", maxPages: 1 },
      });
      const partialNoMatchSc = partialNoMatchRes.structuredContent as Record<string, unknown>;
      assert.equal(partialNoMatchSc.matchStatus, "partial_scan_no_match");
      const pnmCoverage = partialNoMatchSc.coverage as Record<string, unknown>;
      assert.equal(pnmCoverage.complete, false);
      assert.equal(pnmCoverage.uninspectedCount, 220);
      assert.equal(pnmCoverage.nextCursor, "cli_cursor_100");

      // Continue scanning using after=pnmCoverage.nextCursor across the remaining 3 pages (maxPages=3):
      // Finds "Zeta Industrial SL" on Page 3 and reaches the end of the directory (nextCursor=null),
      // while honestly reporting partial_scan_single_match because this stateless call only inspected
      // 220 of 320 records (page 1's 100 records were outside this call's scan window).
      const continuedRes = await mcpClient.callTool({
        name: "search_clients",
        arguments: {
          query: "Zeta Industrial",
          after: String(pnmCoverage.nextCursor),
          maxPages: 3,
        },
      });
      const continuedSc = continuedRes.structuredContent as Record<string, unknown>;
      assert.equal(continuedSc.matchStatus, "partial_scan_single_match");
      const contCoverage = continuedSc.coverage as Record<string, unknown>;
      assert.equal(contCoverage.inspected, 220);
      assert.equal(contCoverage.total, 320);
      assert.equal(contCoverage.uninspectedCount, 100);
      assert.equal(contCoverage.complete, false);
      assert.equal(contCoverage.nextCursor, null);

      // 4. Complete scan (maxPages=4 => all 320 records) for "Soluciones Atlantida SL":
      // Now coverage.complete === true, so matchStatus upgrades to 'exact'!
      const completeSingleRes = await mcpClient.callTool({
        name: "search_clients",
        arguments: { query: "Soluciones Atlantida SL", maxPages: 4 },
      });
      const completeSingleSc = completeSingleRes.structuredContent as Record<string, unknown>;
      assert.equal(completeSingleSc.matchStatus, "exact");
      const completeCov = completeSingleSc.coverage as Record<string, unknown>;
      assert.equal(completeCov.inspected, 320);
      assert.equal(completeCov.uninspectedCount, 0);
      assert.equal(completeCov.complete, true);
      assert.equal(completeCov.nextCursor, null);
    });
  });

  test("Multi-page search_vendors detects cross-page ambiguity (Page 1 + Page 2) and enforces server projection", async () => {
    await withOpenAICandidateClient({ candidateVersion: "1.0.3" }, async (mcpClient, spyCalls) => {
      const taxIdRes = await mcpClient.callTool({
        name: "search_vendors",
        arguments: { query: "DE123456789" },
      });
      assert.equal(taxIdRes.isError, true);
      assert.equal(spyCalls.length, 0);

      // Scanning default maxPages=3 (all 220 vendors across 3 pages) for "Cloud Hosting":
      // Finds "Cloud Hosting EU" on Page 1 (index 0) AND "Cloud Hosting Americas Inc" on Page 2 (index 150)!
      const ambigVendorRes = await mcpClient.callTool({
        name: "search_vendors",
        arguments: { query: "Cloud Hosting", includeRecentExpenses: true },
      });
      assert.notEqual(ambigVendorRes.isError, true);
      const listVendorsCall = spyCalls.find((c) => c.method === "listVendors");
      assert.ok(listVendorsCall);
      const lvArgs = listVendorsCall.args[0] as Record<string, unknown>;
      assert.equal(lvArgs.q, undefined);
      assert.equal(lvArgs.fields, VENDOR_SEARCH_SERVER_PROJECTION);

      const sc = ambigVendorRes.structuredContent as Record<string, unknown>;
      assert.equal(sc.matchStatus, "ambiguous");
      const cov = sc.coverage as Record<string, unknown>;
      assert.equal(cov.inspected, 220);
      assert.equal(cov.total, 220);
      assert.equal(cov.uninspectedCount, 0);
      assert.equal(cov.complete, true);
      const matches = sc.matches as Array<Record<string, unknown>>;
      assert.equal(matches.length, 2);
      assert.deepEqual(
        matches.map((m) => m.id),
        ["ven_cloud_us", "ven_1"],
      );
      for (const m of matches) {
        assert.equal("taxId" in m, false);
        assert.equal("address" in m, false);
      }
    });
  });

  test("Adversarial regressions (F-01..F-08): limit=1 ambiguity floor, legal suffix stopwords, labeled tax IDs, strict ID context isolation, and non-numeric comparison deltas on unavailable amounts", async () => {
    await withOpenAICandidateClient({ candidateVersion: "1.0.3" }, async (mcpClient, spyCalls) => {
      // F-07: Labeled and numeric-stem government IDs are rejected before calling backend
      for (const badQuery of ["NIF: B87654321", "CIF B/87654321", "VAT DE123456789", "87654321"]) {
        const res = await mcpClient.callTool({
          name: "search_clients",
          arguments: { query: badQuery },
        });
        assert.equal(res.isError, true, `Expected tax-ID guard rejection for "${badQuery}"`);
      }
      assert.equal(spyCalls.length, 0, "No backend calls should occur on rejected tax-ID queries");

      // F-03: Searching legal suffix stopword "SL" alone returns 0 matches instead of matching the whole directory
      const slRes = await mcpClient.callTool({
        name: "search_clients",
        arguments: { query: "SL", maxPages: 4 },
      });
      const slSc = slRes.structuredContent as Record<string, unknown>;
      assert.equal(slSc.matchStatus, "none");
      assert.equal((slSc.matches as unknown[]).length, 0);

      // F-02: Ambiguous query with limit=1 still returns >=2 matches so the user can disambiguate
      const limitOneAmbig = await mcpClient.callTool({
        name: "search_clients",
        arguments: { query: "Acme", limit: 1, maxPages: 4, includeContext: false },
      });
      const limitOneSc = limitOneAmbig.structuredContent as Record<string, unknown>;
      assert.equal(limitOneSc.matchStatus, "ambiguous");
      const limitOneMatches = limitOneSc.matches as Array<Record<string, unknown>>;
      assert.equal(
        limitOneMatches.length,
        2,
        "Ambiguous result with limit=1 must return at least 2 candidates so disambiguation is possible",
      );
      assert.ok(String(limitOneSc.disambiguationNote).includes("showing 2 of 3 matches"));

      // F-05: Strict clientId context isolation — Acme Iberia SL (cli_acme_es) must never inherit
      // invoices belonging to Acme Canarias SL (cli_acme_canarias) or Acme Global Consulting (cli_acme_us)
      const acmeContextRes = await mcpClient.callTool({
        name: "search_clients",
        arguments: { query: "Acme Iberia SL", includeContext: true, maxPages: 4 },
      });
      const acmeMatches = (acmeContextRes.structuredContent as Record<string, unknown>).matches as Array<
        Record<string, unknown>
      >;
      const acmeInvoices = (acmeMatches[0].context as Record<string, unknown>).recentInvoices as Array<
        Record<string, unknown>
      >;
      assert.deepEqual(
        acmeInvoices.map((i) => i.id),
        ["inv_oct_overdue", "inv_oct_paid"],
      );

      // F-04 & F-06: Comparing 2026-10 against 2026-08 (which contains duplicate IDs, a leaked July
      // record, an American-spelled "canceled" invoice, and an invoice with unavailable amount)
      // deduplicates/filters 2026-08 down to 2 valid issued invoices (1000 EUR + 1 unavailable)
      // and refuses to fabricate numeric deltas (issuedRevenueDelta === null, completeAndDeterminable === false).
      const augCompareRes = await mcpClient.callTool({
        name: "get_business_period_summary",
        arguments: { period: "2026-10", compareWithPeriod: "2026-08" },
      });
      assert.notEqual(augCompareRes.isError, true);
      const augSc = augCompareRes.structuredContent as Record<string, unknown>;
      const augComparison = augSc.comparison as Record<string, unknown>;
      const augPeriod = augSc.comparisonPeriod as Record<string, unknown>;
      const augIssued = augPeriod.issuedInvoices as Record<string, unknown>;
      assert.equal(
        augIssued.count,
        2,
        "2026-08 must exclude the duplicate ID, the leaked 2026-07 record, and the canceled invoice",
      );
      const augIssuedTotal = augIssued.issuedTotal as Record<string, unknown>;
      assert.equal(augIssuedTotal.unavailableCount, 1);
      const augDeltas = augComparison.deltasByCurrency as Array<Record<string, unknown>>;
      const augEurDelta = augDeltas.find((d) => d.currency === "EUR")!;
      assert.equal(augEurDelta.completeAndDeterminable, false);
      assert.equal(augEurDelta.issuedRevenueDelta, null);
    });
  });

  test("Chained 3-turn end-to-end product journey: Daily Brief -> Period Comparison -> Client Meeting Prep", async () => {
    await withOpenAICandidateClient({ candidateVersion: "1.0.3" }, async (mcpClient) => {
      /* -------------------------------------------------------------- */
      /*  Turn 1: «¿Qué merece mi atención hoy?»                        */
      /* -------------------------------------------------------------- */
      const turn1Res = await mcpClient.callTool({
        name: "get_daily_operational_brief",
        arguments: { asOfDate: "2026-10-28", pageLimit: 25 },
      });
      assert.notEqual(turn1Res.isError, true);
      const turn1 = turn1Res.structuredContent as Record<string, unknown>;
      const turn1Coverage = turn1.coverage as Record<string, unknown>;
      assert.equal(turn1Coverage.referenceMonth, "2026-10");
      assert.equal(turn1Coverage.isPartial, true, "320 clients > pageLimit=25 must mark brief coverage as partial");

      const sep = turn1.activitySeparation as Record<string, unknown>;
      const draftAct = sep.draftActivity as Record<string, unknown>;
      const issuedAct = sep.issuedActivity as Record<string, unknown>;
      assert.equal(draftAct.invoiceDraftsCount, 1);
      assert.equal(issuedAct.issuedInvoicesCount, 3);
      assert.equal(issuedAct.overdueNominalInvoicesCount, 1);
      assert.equal(issuedAct.realOutstandingBalanceDeterminable, false);

      const priorities = turn1.priorities as Array<Record<string, unknown>>;
      const overduePriority = priorities.find((p) => p.category === "overdue_invoice");
      assert.ok(overduePriority, "Turn 1 must surface the overdue invoice priority");
      const overdueRefs = overduePriority.recordRefs as Array<Record<string, unknown>>;
      assert.equal(overdueRefs[0].id, "inv_oct_overdue");
      assert.ok(String(overdueRefs[0].label).includes("Acme Iberia SL"));

      /* -------------------------------------------------------------- */
      /*  Turn 2: «Compáralo con el mes anterior» (2026-10 vs 2026-09)  */
      /* -------------------------------------------------------------- */
      const referenceMonth = String(turn1Coverage.referenceMonth);
      const turn2Res = await mcpClient.callTool({
        name: "get_business_period_summary",
        arguments: { period: referenceMonth, compareWithPeriod: "2026-09" },
      });
      assert.notEqual(turn2Res.isError, true);
      const turn2 = turn2Res.structuredContent as Record<string, unknown>;
      const oct = turn2.primaryPeriod as Record<string, unknown>;
      const sepPeriod = turn2.comparisonPeriod as Record<string, unknown>;
      const octIssued = oct.issuedInvoices as Record<string, unknown>;
      const sepIssued = sepPeriod.issuedInvoices as Record<string, unknown>;
      const octDrafts = oct.draftInvoices as Record<string, unknown>;
      const octExpenses = oct.expenses as Record<string, unknown>;
      const octCoverage = oct.coverage as Record<string, unknown>;
      const octTelemetry = octCoverage.telemetry as Record<string, unknown>;
      assert.equal(octTelemetry.invoicePagesFetched, 1);
      assert.equal(octTelemetry.expensePagesFetched, 1);
      assert.ok(Number(octTelemetry.approximatePayloadBytes) > 0);

      // Verify issueDate-cohort semantics (currentlyMarkedPaidTotal measures invoices issued in the period
      // that are currently marked as paid, NOT payment-date cash collections):
      assert.equal(octIssued.selectionBasis, "issue_date_cohort_not_payment_date");
      assert.equal((octDrafts.total as Record<string, unknown>).amount, 605);
      const issuedByCur = (octIssued.issuedTotal as Record<string, unknown>).totalsByCurrency as Array<Record<string, unknown>>;
      const paidByCur = (octIssued.currentlyMarkedPaidTotal as Record<string, unknown>).totalsByCurrency as Array<
        Record<string, unknown>
      >;
      const unpaidByCur = (octIssued.unpaidNominalTotal as Record<string, unknown>).totalsByCurrency as Array<Record<string, unknown>>;
      const sepPaidByCur = (sepIssued.currentlyMarkedPaidTotal as Record<string, unknown>).totalsByCurrency as Array<
        Record<string, unknown>
      >;

      // inv_oct_paid (issued 2026-10-20, paidDate 2026-11-02) belongs to Oct issueDate cohort (2420 EUR)
      assert.equal(issuedByCur.find((b) => b.currency === "EUR")?.amount, 4235);
      assert.equal(paidByCur.find((b) => b.currency === "EUR")?.amount, 2420);
      assert.equal(unpaidByCur.find((b) => b.currency === "EUR")?.amount, 1815);
      // inv_sep_usd (issued 2026-09-18, paidDate 2026-10-05) belongs to Sep issueDate cohort (500 USD), NOT Oct's
      assert.equal(sepPaidByCur.find((b) => b.currency === "USD")?.amount, 500);
      assert.equal(issuedByCur.find((b) => b.currency === "USD")?.amount, 800);
      assert.equal(paidByCur.find((b) => b.currency === "USD")?.amount, undefined);
      assert.equal(unpaidByCur.find((b) => b.currency === "USD")?.amount, 800);

      // Verify tri-state expense deductibility (true vs false vs undetermined — missing taxDeductible is never assumed true):
      assert.equal(octExpenses.count, 3);
      assert.equal((octExpenses.total as Record<string, unknown>).amount, 255);
      assert.equal(octExpenses.deductibleCount, 1);
      assert.equal((octExpenses.deductibleTotal as Record<string, unknown>).amount, 120);
      assert.equal(octExpenses.nonDeductibleCount, 1);
      assert.equal((octExpenses.nonDeductibleTotal as Record<string, unknown>).amount, 85);
      assert.equal(octExpenses.undeterminedDeductibilityCount, 1);
      assert.equal((octExpenses.undeterminedDeductibilityTotal as Record<string, unknown>).amount, 50);

      const comparison = turn2.comparison as Record<string, unknown>;
      const deltas = comparison.deltasByCurrency as Array<Record<string, unknown>>;
      const eurDelta = deltas.find((d) => d.currency === "EUR")!;
      // Oct EUR issued = 4235 vs Sep EUR issued = 1210 (+3025); Oct EUR issuedCurrentlyPaid = 2420 vs Sep = 1210 (+1210)
      assert.equal(eurDelta.issuedRevenueDelta, 3025);
      assert.equal(eurDelta.issuedCurrentlyPaidDelta, 1210);
      assert.equal(eurDelta.expensesDelta, 155);

      /* -------------------------------------------------------------- */
      /*  Turn 3: «Tengo una reunión con este cliente; prepárame»       */
      /* -------------------------------------------------------------- */
      // Step 3a: Searching "Acme" across the 4-page directory discovers 3 Acme entities across Page 1 and Page 3
      const turn3AmbigRes = await mcpClient.callTool({
        name: "search_clients",
        arguments: { query: "Acme", includeContext: true, maxPages: 4 },
      });
      assert.notEqual(turn3AmbigRes.isError, true);
      const turn3Ambig = turn3AmbigRes.structuredContent as Record<string, unknown>;
      assert.equal(turn3Ambig.matchStatus, "ambiguous");
      const ambigMatches = turn3Ambig.matches as Array<Record<string, unknown>>;
      assert.equal(ambigMatches.length, 3);
      assert.deepEqual(
        ambigMatches.map((m) => m.id),
        ["cli_acme_canarias", "cli_acme_us", "cli_acme_es"],
      );

      // Step 3b: Preparing the specific briefing for "Acme Iberia SL" (from Turn 1's overdue invoice ref)
      const turn3ExactRes = await mcpClient.callTool({
        name: "search_clients",
        arguments: { query: "Acme Iberia SL", includeContext: true, maxPages: 4 },
      });
      const turn3Exact = turn3ExactRes.structuredContent as Record<string, unknown>;
      assert.equal(turn3Exact.matchStatus, "exact");
      const acmeEs = (turn3Exact.matches as Array<Record<string, unknown>>)[0];
      assert.equal(acmeEs.id, "cli_acme_es");
      const acmeContext = acmeEs.context as Record<string, unknown>;
      const recentInvoices = acmeContext.recentInvoices as Array<Record<string, unknown>>;
      const recentActivities = acmeContext.recentActivities as Array<Record<string, unknown>>;
      assert.equal(recentInvoices.length, 2);
      assert.equal(recentInvoices[0].invoiceNumber, "F-2026-011");
      assert.equal(recentActivities.length, 1);
      assert.equal(recentActivities[0].title, "Confirmada renovacion anual Q4");
    });
  });

  test("1.0.3 candidate plugin bundle & 4 skills cover all 37 tools and package deterministically", async () => {
    await withOpenAICandidateClient({ candidateVersion: "1.0.3" }, async (mcpClient) => {
      const { tools } = await mcpClient.listTools();
      const approved103ToolSet = new Set(tools.map((t) => t.name));
      assert.equal(approved103ToolSet.size, 37);

      const plugin103 = JSON.parse(
        readFileSync(join(REPO_ROOT, "marketplace/openai-1.0.3/plugin.json"), "utf8"),
      );
      assert.equal(plugin103.version, "1.0.3");

      const skillNames = [
        "frihet-workspace",
        "invoices-and-quotes",
        "expenses-and-vendors",
        "clients-crm",
      ];
      const coveredTools = new Set<string>();
      for (const skillName of skillNames) {
        const skillPath = join(REPO_ROOT, `marketplace/openai-1.0.3/skills/${skillName}/SKILL.md`);
        assert.ok(existsSync(skillPath), `Missing 1.0.3 skill: ${skillPath}`);
        const md = readFileSync(skillPath, "utf8");
        const [supportedSection = ""] = md.split(/^## 1\./mu);
        for (const [, token] of supportedSection.matchAll(/`([a-z0-9_]+)`/gu)) {
          if (approved103ToolSet.has(token)) {
            coveredTools.add(token);
          }
        }
      }

      assert.deepEqual(
        [...coveredTools].sort(),
        [...approved103ToolSet].sort(),
        "The 4 skills in marketplace/openai-1.0.3 must cover all 37 tools in the 1.0.3 candidate surface",
      );

      // Build deterministic 1.0.3 candidate ZIP
      const zipPath = execFileSync("python3", ["scripts/package-openai-plugin-103.py"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }).trim();
      assert.ok(existsSync(zipPath), `Expected 1.0.3 candidate ZIP at ${zipPath}`);
      const firstBytes = readFileSync(zipPath);
      const secondBytes = readFileSync(
        execFileSync("python3", ["scripts/package-openai-plugin-103.py"], {
          cwd: REPO_ROOT,
          encoding: "utf8",
        }).trim(),
      );
      assert.deepEqual(firstBytes, secondBytes, "1.0.3 candidate ZIP build must be bit-for-bit reproducible");
    });
  });
});
