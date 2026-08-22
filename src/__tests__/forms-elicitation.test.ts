/**
 * MCP Form / Elicitation Protocol Test Suite.
 *
 * Tests the interactive elicitation pattern using the isolated test server fixture.
 *
 * Run: npm test (after build)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createTestFormsElicitationServer,
  type ElicitationFormResponse,
  type FinalizedDraftResult,
} from "./fixtures/test-forms-elicitation-server.js";

describe("MCP Forms & Elicitation Fixture Contract", () => {
  async function setupClient() {
    const server = createTestFormsElicitationServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "test-elicitation-client", version: "1.0.0" },
      { capabilities: { roots: {}, sampling: {} } },
    );
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, server };
  }

  test("incomplete invoice draft triggers standard form elicitation response", async () => {
    const { client, server } = await setupClient();
    try {
      const res = await client.callTool({
        name: "draft_invoice_with_elicitation",
        arguments: {
          clientName: "Empresa Incompleta SL",
          items: [{ description: "Servicios IT", quantity: 10, unitPrice: 100 }],
        },
      });

      assert.equal(res.isError, undefined);
      assert.ok(Array.isArray(res.content));
      assert.ok(res.content[0]?.text?.includes("Elicitation Request"));

      const structured = res.structuredContent as unknown as ElicitationFormResponse;
      assert.equal(structured.type, "form_elicitation_request");
      assert.equal(structured.formId, "form_draft_inv_missing_fields");
      assert.equal(structured.fields.length, 2);
      assert.deepEqual(
        structured.fields.map((f) => f.name).sort(),
        ["clientTaxId", "taxRate"],
      );
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  test("submitting complete draft with elicited fields finalizes successfully", async () => {
    const { client, server } = await setupClient();
    try {
      const res = await client.callTool({
        name: "draft_invoice_with_elicitation",
        arguments: {
          clientName: "Empresa Completa SL",
          clientTaxId: "B12345678",
          items: [{ description: "Servicios IT", quantity: 10, unitPrice: 100 }],
          taxRate: 21,
        },
      });

      assert.equal(res.isError, undefined);
      assert.ok(Array.isArray(res.content));
      assert.ok(res.content[0]?.text?.includes("Draft finalized successfully"));

      const structured = res.structuredContent as unknown as FinalizedDraftResult;
      assert.equal(structured.type, "draft_completed");
      assert.equal(structured.clientName, "Empresa Completa SL");
      assert.equal(structured.clientTaxId, "B12345678");
      assert.equal(structured.subtotal, 1000);
      assert.equal(structured.taxAmount, 210);
      assert.equal(structured.total, 1210);
      assert.equal(structured.status, "draft");
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
