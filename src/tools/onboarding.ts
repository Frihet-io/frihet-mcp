/**
 * Onboarding tools for the Frihet MCP server — D4-B megasprint (2 tools).
 *
 * Tools:
 *   1. onboarding_status      — current workspace onboarding state (completed/pending steps)
 *   2. onboarding_persona_set — set workspace persona (autonomo/empresa/agencia/gestoria)
 *
 * REST surface: /v1/onboarding/status, /v1/onboarding/persona
 *
 * Persona drives module visibility + default chart-of-accounts + onboarding checklist.
 * Persona can only be set once during onboarding; later changes require workspace admin.
 *
 * NOTE: ERP backend endpoints land in parallel D4-A wave. 404s propagate as isError
 * until backend ships.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import {
  withToolLogging,
  formatRecord,
  getContent,
  mutateContent,
  READ_ONLY_ANNOTATIONS,
  UPDATE_ANNOTATIONS,
  onboardingStatusOutput,
  onboardingPersonaResultOutput,
} from "./shared.js";

export function registerOnboardingTools(server: McpServer, client: IFrihetClient): void {
  // -- onboarding_status --

  server.registerTool(
    "onboarding_status",
    {
      title: "Onboarding Status",
      description:
        "Return the current workspace onboarding state — persona, completed steps, pending steps, " +
        "percent complete. Useful to drive in-app guidance, sales follow-up triggers, " +
        "and partner program tracking. " +
        "/ Devuelve el estado actual del onboarding del workspace (persona, pasos completados/pendientes).",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {},
      outputSchema: onboardingStatusOutput,
    },
    async () => withToolLogging("onboarding_status", async () => {
      const result = await client.getOnboardingStatus();
      return {
        content: [getContent(formatRecord("Onboarding status", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- onboarding_persona_set --

  server.registerTool(
    "onboarding_persona_set",
    {
      title: "Set Onboarding Persona",
      description:
        "Set the workspace persona. Drives module visibility, default chart-of-accounts, " +
        "and onboarding checklist. Personas:\n" +
        "  - 'autonomo' — self-employed (autonomo Spain)\n" +
        "  - 'empresa'  — small/medium business\n" +
        "  - 'agencia'  — agency / consultancy\n" +
        "  - 'gestoria' — accounting firm (manages multiple client workspaces)\n" +
        "\n" +
        "Idempotent: setting the same persona again is a no-op. " +
        "/ Define la persona del workspace. Determina modulos visibles, plan contable y checklist.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        persona: z
          .enum(["autonomo", "empresa", "agencia", "gestoria"])
          .describe("Workspace persona / Persona del workspace"),
      },
      outputSchema: onboardingPersonaResultOutput,
    },
    async ({ persona }) => withToolLogging("onboarding_persona_set", async () => {
      const result = await client.setOnboardingPersona({ persona });
      return {
        content: [mutateContent(formatRecord("Persona set", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );
}
