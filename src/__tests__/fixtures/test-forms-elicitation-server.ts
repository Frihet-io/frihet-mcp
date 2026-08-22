/**
 * Test Server Fixture: MCP Form/Elicitation Standard.
 *
 * Demonstrates standard MCP interactive form elicitation for missing
 * invoice-draft fields (e.g. missing client taxId/NIF or line-item tax rate)
 * in an isolated test environment.
 *
 * This fixture is strictly test-only and NEVER exposed as a public Frihet tool.
 */

import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_ONLY_ANNOTATIONS } from "../../tools/shared.js";

export interface InvoiceDraftInput {
  clientName: string;
  clientTaxId?: string;
  items: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
  }>;
  taxRate?: number;
}

export interface ElicitationFormField {
  name: string;
  title: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
}

export interface ElicitationFormResponse {
  type: "form_elicitation_request";
  formId: string;
  title: string;
  message: string;
  fields: ElicitationFormField[];
  partialDraft: InvoiceDraftInput;
}

export interface FinalizedDraftResult {
  type: "draft_completed";
  id: string;
  clientName: string;
  clientTaxId: string;
  taxRate: number;
  subtotal: number;
  taxAmount: number;
  total: number;
  status: "draft";
}

export function createTestFormsElicitationServer(): McpServer {
  const server = new McpServer({
    name: "test-forms-elicitation-server",
    version: "1.0.0",
  });

  server.registerTool(
    "draft_invoice_with_elicitation",
    {
      title: "Draft Invoice With Elicitation (Test Fixture)",
      description: "Test-only tool that evaluates invoice draft completeness and returns elicitation form if fields are missing.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        clientName: z.string().describe("Client name"),
        clientTaxId: z.string().optional().describe("Client NIF/CIF/TaxId"),
        items: z.array(
          z.object({
            description: z.string(),
            quantity: z.number(),
            unitPrice: z.number(),
          }),
        ).describe("Line items"),
        taxRate: z.number().optional().describe("VAT/Tax rate percentage"),
      },
    },
    async (input: InvoiceDraftInput) => {
      const missingFields: ElicitationFormField[] = [];

      if (!input.clientTaxId) {
        missingFields.push({
          name: "clientTaxId",
          title: "Client Tax ID (NIF/CIF)",
          type: "string",
          required: true,
          description: "Spanish tax identifier required for compliant invoice draft (e.g. B12345678 or 12345678Z)",
        });
      }

      if (input.taxRate === undefined) {
        missingFields.push({
          name: "taxRate",
          title: "Tax Rate (%)",
          type: "number",
          required: true,
          description: "Applicable VAT/IGIC rate (e.g. 21 for general IVA, 7 for IGIC)",
        });
      }

      if (missingFields.length > 0) {
        const elicitation: ElicitationFormResponse = {
          type: "form_elicitation_request",
          formId: "form_draft_inv_missing_fields",
          title: "Missing Required Invoice Fields",
          message: "Please provide the missing client Tax ID and tax rate to complete the invoice draft.",
          fields: missingFields,
          partialDraft: input,
        };

        return {
          content: [
            {
              type: "text",
              text: `Elicitation Request: Missing required fields for client ${input.clientName} (${missingFields.map((f) => f.name).join(", ")})`,
            },
          ],
          structuredContent: elicitation as unknown as Record<string, unknown>,
        };
      }

      // If all fields present, finalize draft
      const taxRate = input.taxRate!;
      const clientTaxId = input.clientTaxId!;
      const subtotal = input.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
      const taxAmount = Math.round(subtotal * (taxRate / 100) * 100) / 100;
      const total = Math.round((subtotal + taxAmount) * 100) / 100;

      const finalized: FinalizedDraftResult = {
        type: "draft_completed",
        id: "demo_draft_elicited_001",
        clientName: input.clientName,
        clientTaxId,
        taxRate,
        subtotal,
        taxAmount,
        total,
        status: "draft",
      };

      return {
        content: [
          {
            type: "text",
            text: `Draft finalized successfully for ${input.clientName} (Total: €${total})`,
          },
        ],
        structuredContent: finalized as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}
