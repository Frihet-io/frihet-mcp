/**
 * Isolated verification suite for the ChatGPT 1.0.3 capability expansion candidate.
 *
 * Tests:
 * 1. 1.0.2 baseline preservation (33 tools unchanged when candidateVersion is omitted)
 * 2. 1.0.3 read-only candidate surface (37 tools: +get_daily_operational_brief,
 *    +get_business_period_summary, +search_clients, +search_vendors)
 * 3. Wire-level OAuth securitySchemes, closed inputSchema, and zero tax-ID /
 *    tax-return fields in inputSchema or outputSchema
 * 4. Task-level product behavior:
 *    - Daily operational brief with partial coverage, multi-currency, and unavailable amount
 *    - Month-over-month period comparison (Sept vs Oct) with multi-currency separation
 *    - Ambiguous and unambiguous commercial-name client search + tax-ID query rejection
 *    - Commercial-name vendor search + tax-ID query rejection
 * 5. Phase-2 optional draft-only edit study (`update_draft_invoice`): atomic status,
 *    fiscal-containment, and expectedDocumentNumber checks.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
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
  registerOpenAI103CandidateTools,
  type RegisterOpenAI103Options,
} from "../tools/openai-expansion-103.js";

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
        currentMonth: { revenue: 4200, expenses: 620, profit: 3580, invoiceCount: 3, expenseCount: 2 },
      };
    },

    async listInvoices(params?: unknown) {
      const p = (params ?? {}) as Record<string, unknown>;
      const from = typeof p.from === "string" ? p.from : undefined;
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
              status: "paid",
              currency: "USD",
              total: 500,
              items: [{ description: "US Advisory", quantity: 1, unitPrice: 500, taxRate: 0 }],
            },
          ],
          total: 2,
          limit: 100,
          offset: 0,
          hasMore: false,
        };
      }

      return {
        data: [
          {
            id: "inv_oct_overdue",
            documentNumber: "F-2026-011",
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
            clientName: "Acme Iberia SL",
            issueDate: "2026-10-20",
            dueDate: "2026-11-05",
            status: "paid",
            currency: "EUR",
            total: 2420,
            items: [{ description: "Implementacion ERP", quantity: 1, unitPrice: 2000, taxRate: 21 }],
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
        hasMore: false,
      };
    },

    async searchInvoices(query?: unknown) {
      const q = String(query ?? "").toLowerCase();
      const all = [
        {
          id: "inv_oct_overdue",
          documentNumber: "F-2026-011",
          clientName: "Acme Iberia SL",
          issueDate: "2026-10-01",
          dueDate: "2026-10-15",
          status: "overdue",
          currency: "EUR",
          total: 1815,
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
        },
      ];
      const filtered = all.filter((i) => i.clientName.toLowerCase().includes(q));
      return { data: filtered, total: filtered.length, limit: 5, offset: 0, hasMore: false };
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
        hasMore: false,
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
          hasMore: false,
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
        ],
        total: 2,
        limit: 100,
        offset: 0,
        hasMore: false,
      };
    },

    async listClients() {
      return {
        data: [
          {
            id: "cli_acme_es",
            name: "Acme Iberia SL",
            stage: "active",
            email: "facturacion@acme-iberia.es",
            phone: "+34910001122",
            taxId: "B87654321",
            address: { street: "Calle Mayor 10", city: "Madrid" },
          },
          {
            id: "cli_acme_us",
            name: "Acme Global Consulting",
            stage: "proposal",
            email: "ap@acmeglobal.example",
            taxId: "US99887766",
          },
          {
            id: "cli_beta",
            name: "Beta Retail SL",
            stage: "lead",
            email: "hola@betaretail.es",
            taxId: "B11223344",
          },
        ],
        total: 3,
        limit: 100,
        offset: 0,
        hasMore: false,
      };
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
          hasMore: false,
        };
      }
      return { data: [], total: 0, limit: 5, offset: 0, hasMore: false };
    },

    async listVendors() {
      return {
        data: [
          {
            id: "ven_1",
            name: "Cloud Hosting EU",
            email: "billing@cloudhosting.eu",
            taxId: "DE123456789",
            address: { street: "Hauptstr 1", city: "Berlin" },
          },
          {
            id: "ven_2",
            name: "Restaurante Puerto",
            taxId: "B55667788",
          },
        ],
        total: 2,
        limit: 100,
        offset: 0,
        hasMore: false,
      };
    },

    async getInvoice(id: unknown) {
      if (id === "inv_oct_draft") {
        return {
          id: "inv_oct_draft",
          documentNumber: "DRAFT-2026-004",
          status: "draft",
          clientName: "Beta Retail SL",
          issueDate: "2026-10-27",
          dueDate: "2026-11-27",
          currency: "EUR",
          taxRate: 21,
          items: [{ description: "Propuesta inicial", quantity: 1, unitPrice: 500, taxRate: 21 }],
        };
      }
      if (id === "inv_oct_paid") {
        return {
          id: "inv_oct_paid",
          documentNumber: "F-2026-012",
          status: "paid",
          clientName: "Acme Iberia SL",
          issueDate: "2026-10-20",
          dueDate: "2026-11-05",
          currency: "EUR",
          taxRate: 21,
          items: [{ description: "Implementacion ERP", quantity: 1, unitPrice: 2000, taxRate: 21 }],
        };
      }
      if (id === "inv_shopify_staged") {
        return {
          id: "inv_shopify_staged",
          documentNumber: "SHOP-1001",
          status: "draft",
          fiscalStage: "shopify_order_staged",
          fiscalIssuanceAuthorized: false,
          clientName: "Shopify Customer",
          issueDate: "2026-10-28",
          items: [{ description: "Item", quantity: 1, unitPrice: 50 }],
        };
      }
      return null;
    },

    async updateInvoice(id: unknown, payload: unknown) {
      const p = (payload ?? {}) as Record<string, unknown>;
      return {
        id: String(id),
        documentNumber: "DRAFT-2026-004",
        status: "draft",
        clientName: p.clientName ?? "Beta Retail SL",
        issueDate: p.issueDate ?? "2026-10-27",
        dueDate: p.dueDate ?? "2026-11-27",
        currency: p.currency ?? "EUR",
        taxRate: p.taxRate ?? 21,
        notes: p.notes,
        items: p.items ?? [{ description: "Propuesta inicial", quantity: 1, unitPrice: 500, taxRate: 21 }],
      };
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
  registerOptions: RegisterOpenAI103Options | undefined,
  fn: (mcpClient: Client, spyCalls: Array<{ method: string; args: unknown[] }>) => Promise<T>,
): Promise<T> {
  const spyCalls: Array<{ method: string; args: unknown[] }> = [];
  const server = new McpServer({ name: "Frihet", version: "1.18.0" });
  applyOpenAIProfile(server, profileOptions);
  const apiClient = createSyntheticClient(spyCalls);
  registerAllTools(server, apiClient);
  if (profileOptions?.candidateVersion === "1.0.3") {
    registerOpenAI103CandidateTools(server, apiClient, registerOptions);
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

describe("ChatGPT 1.0.2 baseline vs 1.0.3 candidate profile", () => {
  test("1.0.2 default profile stays frozen at exactly 33 tools", async () => {
    await withOpenAICandidateClient(undefined, undefined, async (mcpClient) => {
      const { tools } = await mcpClient.listTools();
      assert.equal(tools.length, 33);
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        [...OPENAI_REVIEWED_TOOL_ALLOWLIST].sort(),
      );
    });
  });

  test("1.0.3 read-only candidate exposes 37 tools with full OAuth schemes and zero tax-ID / tax-filing schema fields", async () => {
    await withOpenAICandidateClient(
      { candidateVersion: "1.0.3" },
      { includeDraftInvoiceEdit: false },
      async (mcpClient) => {
        const { tools } = await mcpClient.listTools();
        assert.equal(tools.length, 37);
        const names = new Set(tools.map((t) => t.name));
        for (const candidate of OPENAI_103_READ_ONLY_CANDIDATE_TOOLS) {
          assert.ok(names.has(candidate), `missing 1.0.3 candidate tool ${candidate}`);
        }
        assert.ok(!names.has("update_draft_invoice"), "phase-2 draft edit must be off by default");

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

  test("Task 1: get_daily_operational_brief separates drafts from issued receivables, preserves multi-currency, and maps recommended tools to the OpenAI surface", async () => {
    await withOpenAICandidateClient({ candidateVersion: "1.0.3" }, undefined, async (mcpClient) => {
      const res = await mcpClient.callTool({
        name: "get_daily_operational_brief",
        arguments: { asOfDate: "2026-10-28", pageLimit: 25 },
      });
      assert.notEqual(res.isError, true);
      const sc = res.structuredContent as Record<string, unknown>;
      assert.ok(sc);
      const sep = sc.activitySeparation as Record<string, unknown>;
      const draftAct = sep.draftActivity as Record<string, unknown>;
      const issuedAct = sep.issuedActivity as Record<string, unknown>;

      assert.equal(draftAct.invoiceDraftsCount, 1);
      assert.equal(issuedAct.realOutstandingBalanceDeterminable, false);
      assert.equal(issuedAct.issuedInvoicesCount, 3);
      assert.equal(issuedAct.overdueNominalInvoicesCount, 1);

      const unpaidTotal = issuedAct.unpaidNominalTotal as Record<string, unknown>;
      assert.equal(unpaidTotal.currency, "MIXED");
      assert.equal(unpaidTotal.amount, null);

      const priorities = sc.priorities as Array<Record<string, unknown>>;
      assert.ok(priorities.length > 0);
      for (const p of priorities) {
        const next = p.suggestedNextAction as Record<string, unknown>;
        assert.ok(
          OPENAI_REVIEWED_TOOL_ALLOWLIST.has(String(next.recommendedTool)),
          `recommendedTool ${String(next.recommendedTool)} must exist in OpenAI allowlist`,
        );
      }
    });
  });

  test("Task 2: get_business_period_summary compares September vs October by currency without cross-currency addition or fiscal-return fields", async () => {
    await withOpenAICandidateClient({ candidateVersion: "1.0.3" }, undefined, async (mcpClient) => {
      const res = await mcpClient.callTool({
        name: "get_business_period_summary",
        arguments: { period: "2026-10", compareWithPeriod: "2026-09" },
      });
      assert.notEqual(res.isError, true);
      const sc = res.structuredContent as Record<string, unknown>;
      assert.ok(sc);
      assert.equal("taxLiability" in sc, false);

      const primary = sc.primaryPeriod as Record<string, unknown>;
      const primaryIssued = (primary.issuedInvoices as Record<string, unknown>).issuedTotal as Record<string, unknown>;
      assert.equal(primaryIssued.currency, "MIXED");
      assert.equal(primaryIssued.amount, null);

      const comparison = sc.comparison as Record<string, unknown>;
      assert.equal(comparison.primaryMonth, "2026-10");
      assert.equal(comparison.compareWithMonth, "2026-09");
      const deltas = comparison.deltasByCurrency as Array<Record<string, unknown>>;
      const eurDelta = deltas.find((d) => d.currency === "EUR")!;
      const usdDelta = deltas.find((d) => d.currency === "USD")!;
      // Oct EUR issued = 1815 + 2420 = 4235 (draft 605 excluded!); Sep EUR issued = 1210 -> delta = +3025
      assert.equal(eurDelta.primaryIssuedRevenue, 4235);
      assert.equal(eurDelta.comparisonIssuedRevenue, 1210);
      assert.equal(eurDelta.issuedRevenueDelta, 3025);
      // Oct USD issued = 800; Sep USD issued = 500 -> delta = +300
      assert.equal(usdDelta.primaryIssuedRevenue, 800);
      assert.equal(usdDelta.comparisonIssuedRevenue, 500);
      assert.equal(usdDelta.issuedRevenueDelta, 300);
    });
  });

  test("Task 3: search_clients resolves commercial names, flags ambiguity for 'Acme', includes meeting context, never passes q to listClients, and rejects tax IDs", async () => {
    await withOpenAICandidateClient({ candidateVersion: "1.0.3" }, undefined, async (mcpClient, spyCalls) => {
      // 1. Tax ID rejection before touching backend
      const taxIdRes = await mcpClient.callTool({
        name: "search_clients",
        arguments: { query: "B87654321" },
      });
      assert.equal(taxIdRes.isError, true);
      assert.equal(spyCalls.length, 0, "tax ID query must be rejected before calling backend");

      // 2. Ambiguous commercial query 'Acme' -> 2 matches ('Acme Iberia SL' and 'Acme Global Consulting')
      const ambigRes = await mcpClient.callTool({
        name: "search_clients",
        arguments: { query: "Acme", includeContext: true },
      });
      assert.notEqual(ambigRes.isError, true);
      const listClientsCall = spyCalls.find((c) => c.method === "listClients");
      assert.ok(listClientsCall);
      assert.equal(
        (listClientsCall.args[0] as Record<string, unknown> | undefined)?.q,
        undefined,
        "search_clients must never pass q to backend listClients",
      );

      const sc = ambigRes.structuredContent as Record<string, unknown>;
      assert.equal(sc.matchStatus, "ambiguous");
      const matches = sc.matches as Array<Record<string, unknown>>;
      assert.equal(matches.length, 2);
      for (const m of matches) {
        assert.equal("taxId" in m, false);
        assert.equal("address" in m, false);
        assert.ok(m.context, "meeting-prep context should be populated for <= 3 matches");
      }

      // 3. Exact query 'Acme Iberia SL' -> exact single match
      const exactRes = await mcpClient.callTool({
        name: "search_clients",
        arguments: { query: "Acme Iberia SL" },
      });
      const exactSc = exactRes.structuredContent as Record<string, unknown>;
      assert.equal(exactSc.matchStatus, "exact");
      assert.equal((exactSc.matches as Array<Record<string, unknown>>).length, 1);
    });
  });

  test("Task 4: search_vendors searches commercial vendor names, includes recent expenses, never passes q to listVendors, and rejects tax IDs", async () => {
    await withOpenAICandidateClient({ candidateVersion: "1.0.3" }, undefined, async (mcpClient, spyCalls) => {
      const taxIdRes = await mcpClient.callTool({
        name: "search_vendors",
        arguments: { query: "DE123456789" },
      });
      assert.equal(taxIdRes.isError, true);
      assert.equal(spyCalls.length, 0);

      const res = await mcpClient.callTool({
        name: "search_vendors",
        arguments: { query: "Cloud Hosting", includeRecentExpenses: true },
      });
      assert.notEqual(res.isError, true);
      const listVendorsCall = spyCalls.find((c) => c.method === "listVendors");
      assert.ok(listVendorsCall);
      assert.equal(
        (listVendorsCall.args[0] as Record<string, unknown> | undefined)?.q,
        undefined,
        "search_vendors must never pass q to backend listVendors",
      );

      const sc = res.structuredContent as Record<string, unknown>;
      assert.equal(sc.matchStatus, "unambiguous");
      const matches = sc.matches as Array<Record<string, unknown>>;
      assert.equal(matches.length, 1);
      assert.equal(matches[0].name, "Cloud Hosting EU");
      assert.equal("taxId" in matches[0], false);
      const recentExpenses = matches[0].recentExpenses as Array<Record<string, unknown>>;
      assert.equal(recentExpenses.length, 1);
      assert.equal(recentExpenses[0].id, "exp_oct_1");
    });
  });

  test("Task 5 (Phase-2 Study): update_draft_invoice enforces confirm=true, draft-only status, Shopify fiscal-containment guard, and expectedDocumentNumber", async () => {
    await withOpenAICandidateClient(
      { candidateVersion: "1.0.3", includeDraftInvoiceEdit: true },
      { includeDraftInvoiceEdit: true },
      async (mcpClient) => {
        // 1. Refuse non-draft invoice ('paid')
        const paidAttempt = await mcpClient.callTool({
          name: "update_draft_invoice",
          arguments: {
            id: "inv_oct_paid",
            expectedDocumentNumber: "F-2026-012",
            notes: "Intento de editar factura pagada",
            confirm: true,
          },
        });
        assert.equal(paidAttempt.isError, true);

        // 2. Refuse Shopify staged order draft
        const shopifyAttempt = await mcpClient.callTool({
          name: "update_draft_invoice",
          arguments: {
            id: "inv_shopify_staged",
            expectedDocumentNumber: "SHOP-1001",
            notes: "Intento de editar pedido Shopify en cuarentena",
            confirm: true,
          },
        });
        assert.equal(shopifyAttempt.isError, true);

        // 3. Refuse mismatched expectedDocumentNumber
        const mismatchAttempt = await mcpClient.callTool({
          name: "update_draft_invoice",
          arguments: {
            id: "inv_oct_draft",
            expectedDocumentNumber: "WRONG-NUMBER",
            notes: "Cambio con numero obsoleto",
            confirm: true,
          },
        });
        assert.equal(mismatchAttempt.isError, true);

        // 4. Succeed on clean draft with matching expectedDocumentNumber and confirm=true
        const validAttempt = await mcpClient.callTool({
          name: "update_draft_invoice",
          arguments: {
            id: "inv_oct_draft",
            expectedDocumentNumber: "DRAFT-2026-004",
            notes: "Descuento acordado en llamada",
            items: [{ description: "Propuesta ajustada", quantity: 2, unitPrice: 450, taxRate: 21 }],
            confirm: true,
          },
        });
        assert.notEqual(validAttempt.isError, true);
        const sc = validAttempt.structuredContent as Record<string, unknown>;
        assert.equal(sc.status, "draft");
        assert.equal(sc.invoiceNumber, "DRAFT-2026-004");
        assert.equal(sc.notes, "Descuento acordado en llamada");
      },
    );
  });
});
