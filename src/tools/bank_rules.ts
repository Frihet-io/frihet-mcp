/**
 * Bank rules tools for the Frihet MCP server — Day 1 Megasprint (2 tools).
 *
 * Tools:
 *   1. frihet_bank_rules_list  — list bank auto-categorization rules for the workspace
 *   2. frihet_bank_rule_create — create a new bank categorization rule
 *
 * Skipped (external webhook handlers, not MCP-callable):
 *   - plaidWebhook  — Plaid inbound webhook
 *   - tinkWebhook   — Tink/Revolut inbound webhook
 *
 * REST surface: /v1/banking/rules — admin-side rule management.
 *   Backend callables: #394 Banking Q3 flag (Frihet-ERP PR #394).
 *   Tools surface 404 until backend callable wrapper ships.
 *
 * NOTE: Bank rules are Q3-flagged in Frihet-ERP. These tools are wired here
 * so AI agents can read + create rules once the backend ships, without an MCP
 * bump. Backend may still be Firestore-direct writes; tools will 404 gracefully.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import {
  withToolLogging,
  formatPaginatedResponse,
  formatRecord,
  listContent,
  mutateContent,
  openObjectOutput,
  READ_ONLY_ANNOTATIONS,
  CREATE_ANNOTATIONS,
  paginatedOutput,
} from "./shared.js";
import { withBackendGuard } from "./backend-availability.js";

const bankRuleItemOutput = z.object({
  id: z.string(),
  name: z.string(),
  bankConditions: z.array(z.object({
    field: z.string(),
    operator: z.string(),
    value: z.string(),
  })).optional(),
  action: z.string().optional(),
  actionConfig: z.record(z.string(), z.unknown()).optional(),
  conditions: z.array(z.object({
    field: z.string(),
    operator: z.string(),
    value: z.string(),
  })).optional(),
  actions: z.array(z.object({
    type: z.string(),
    value: z.string(),
  })).optional(),
  isActive: z.boolean().optional(),
  createdAt: z.string().optional(),
}).passthrough();

const CONDITION_FIELD = z.enum(["description", "amount", "counterparty", "iban", "reference"]);
const CONDITION_OPERATOR = z.enum(["contains", "startsWith", "endsWith", "equals", "greaterThan", "lessThan"]);
const RULE_ACTION = z.enum(["setCategory", "addTag", "assignClient"]);

export function registerBankRulesTools(server: McpServer, client: IFrihetClient): void {
  // -- frihet_bank_rules_list -----------------------------------------------

  server.registerTool(
    "frihet_bank_rules_list",
    {
      title: "List Bank Categorization Rules",
      description:
        "List all bank auto-categorization rules for the workspace. " +
        "Rules automatically categorize transactions matching conditions (description, amount, counterparty). " +
        "Returns rule name, conditions, actions (category/tag/client assign), and active status. " +
        "/ Lista las reglas de categorizacion automatica de transacciones bancarias del workspace. " +
        "Devuelve nombre, condiciones, acciones (categoria/etiqueta/cliente) y estado activo.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        isActive: z.boolean().optional().describe("Filter by active/inactive rules / Filtrar por reglas activas/inactivas"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results / Resultados maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
      },
      outputSchema: paginatedOutput(bankRuleItemOutput),
    },
    async ({ isActive, limit, offset }) => withToolLogging("frihet_bank_rules_list", () =>
      withBackendGuard("frihet_bank_rules_list", "/v1/banking/rules", async () => {
        const result = await client.listBankRules({ isActive, limit, offset });
        return {
          content: [listContent(formatPaginatedResponse("bank_rules", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );

  // -- frihet_bank_rule_create ----------------------------------------------

  server.registerTool(
    "frihet_bank_rule_create",
    {
      title: "Create Bank Categorization Rule",
      description:
        "Create a new bank auto-categorization rule. " +
        "Rules apply automatically to matching incoming transactions. " +
        "The new ERP engine expects `bankConditions` (AND logic) plus a single `action` " +
        "(setCategory / addTag / assignClient) and its `actionConfig` payload. " +
        "Example: name='Mercadona groceries', bankConditions=[{field:'description', operator:'contains', value:'MERCADONA'}], " +
        "action='setCategory', actionConfig={category:'groceries'}. " +
        "/ Crea una nueva regla de categorizacion automatica de transacciones bancarias. " +
        "El nuevo motor ERP espera `bankConditions` (logica AND) y un unico `action` con su `actionConfig`.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        name: z.string().describe("Rule name for identification / Nombre de la regla"),
        bankConditions: z
          .array(
            z.object({
              field: CONDITION_FIELD.describe("Transaction field to match / Campo de transaccion a comparar"),
              operator: CONDITION_OPERATOR.describe("Comparison operator / Operador de comparacion"),
              value: z.string().describe("Value to match against / Valor a comparar"),
            }),
          )
          .min(1)
          .describe("Rule conditions (AND logic — all must match) / Condiciones (logica AND — todas deben cumplirse)"),
        action: RULE_ACTION.describe("Action to apply when the rule matches / Accion a aplicar cuando la regla se cumple"),
        actionConfig: z
          .record(z.string(), z.unknown())
          .describe(
            "Action-specific payload. For setCategory: {category:string}. For addTag: {tag:string}. " +
            "For assignClient: {clientId:string}. / Payload segun la accion.",
          ),
        isActive: z.boolean().optional().describe("Whether the rule is active (default true) / Si la regla esta activa (por defecto true)"),
      },
      outputSchema: openObjectOutput(
        "Created bank rule record with ID, conditions and action / Regla bancaria creada con ID, condiciones y accion",
      ),
    },
    async ({ name, bankConditions, action, actionConfig, isActive }) => withToolLogging("frihet_bank_rule_create", () =>
      withBackendGuard("frihet_bank_rule_create", "/v1/banking/rules", async () => {
        const result = await client.createBankRule({ name, bankConditions, action, actionConfig, isActive });
        return {
          content: [
            mutateContent(
              formatRecord(`Bank rule created: ${name}`, result),
            ),
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );
}
