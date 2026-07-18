/**
 * Self-onboard & VIES tools for the Frihet MCP server — Day 1 Megasprint (2 tools).
 *
 * Tools:
 *   1. frihet_portal_onboard_link_generate — generate a self-onboard link (gestor admin side)
 *   2. frihet_tax_id_vies_lookup           — validate an EU tax ID via VIES
 *
 * Skipped (public portal flows, not appropriate for MCP):
 *   - validatePortalOnboardToken  — public token validation
 *   - selfOnboardClient           — self-service client registration (browser flow)
 *
 * REST surface: /v1/portal/onboard/* proxies Firebase callables:
 *   generatePortalOnboardLink, lookupTaxIdViaVIES (eu-west1)
 *
 * Backend status (post-Day 1 Megasprint, May 2026):
 *   Frihet-ERP PR #398 — Self-onboard VIES MERGED.
 *   Tools will surface 404 errors until backend REST shell ships.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { IFrihetClient } from "../client-interface.js";
import {
  withToolLogging,
  formatRecord,
  getContent,
  mutateContent,
  openObjectOutput,
  READ_ONLY_ANNOTATIONS,
  CREATE_ANNOTATIONS,
} from "./shared.js";
import { withBackendGuard } from "./backend-availability.js";

export function registerOnboardViesTools(server: McpServer, client: IFrihetClient): void {
  // -- frihet_portal_onboard_link_generate ----------------------------------

  server.registerTool(
    "frihet_portal_onboard_link_generate",
    {
      title: "Generate Portal Self-Onboard Link",
      description:
        "Generate a time-limited, single-use self-onboard invitation link for a prospective client. " +
        "The client follows the link to register their company details (CIF, address, contact) " +
        "without requiring manual data entry by the gestor. " +
        "Requires gestor/admin role. " +
        "Example: email='cliente@empresa.com', expiresInHours=72. " +
        "/ Genera un enlace de auto-registro para un cliente potencial. " +
        "El cliente completa sus datos sin que el gestor tenga que introducirlos manualmente. " +
        "Requiere rol gestor/admin.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        email: z.string().describe("Prospective client email address / Email del cliente potencial"),
        name: z.string().optional().describe("Prospective client name (pre-fills the form) / Nombre del cliente (pre-rellena el formulario)"),
        expiresInHours: z.number().int().min(1).max(168).optional()
          .describe("Link expiry in hours, 1-168 (default 72h) / Caducidad del enlace en horas (por defecto 72h)"),
        workspaceId: z.string().optional().describe("Target gestor workspace ID / ID del workspace del gestor"),
      },
      outputSchema: openObjectOutput(
        "Generated self-onboard link with expiry and token / Enlace de auto-registro generado con caducidad y token",
      ),
    },
    async ({ email, name, expiresInHours, workspaceId }) => withToolLogging("frihet_portal_onboard_link_generate", () =>
      withBackendGuard("frihet_portal_onboard_link_generate", "/v1/portal/onboard/link", async () => {
        const result = await client.generatePortalOnboardLink({ email, name, expiresInHours, workspaceId });
        return {
          content: [
            mutateContent(
              formatRecord(`Self-onboard link generated for ${email}`, result) +
              "\n\nSend this link to the client via email or chat. It is single-use and time-limited." +
              "\nEnvia este enlace al cliente por email o chat. Es de uso único y tiene caducidad.",
            ),
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );

  // -- frihet_tax_id_vies_lookup --------------------------------------------

  server.registerTool(
    "frihet_tax_id_vies_lookup",
    {
      title: "Lookup Tax ID via VIES (EU VAT Validation)",
      description:
        "Validate an EU VAT number (CIF intracomunitario) via the VIES (VAT Information Exchange System). " +
        "Returns company name, address, and validity status from the official EU registry. " +
        "Essential for intra-EU invoicing compliance — always validate before adding a EU client. " +
        "Example: vatNumber='ES12345678A', countryCode='ES'. " +
        "/ Valida un numero de IVA intracomunitario (CIF) via el sistema VIES de la UE. " +
        "Devuelve nombre, direccion y validez desde el registro oficial europeo.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        vatNumber: z.string().describe("EU VAT number to validate (without country prefix) / Numero de IVA intracomunitario (sin prefijo de pais)"),
        countryCode: z.string().length(2).describe("ISO 3166-1 alpha-2 country code (e.g. 'ES', 'DE', 'FR') / Codigo de pais ISO (ej. 'ES', 'DE', 'FR')"),
      },
      outputSchema: openObjectOutput(
        "VIES lookup result: company name, address and validity status / Resultado VIES: nombre, dirección y validez",
      ),
    },
    async ({ vatNumber, countryCode }) => withToolLogging("frihet_tax_id_vies_lookup", () =>
      withBackendGuard("frihet_tax_id_vies_lookup", "/v1/portal/onboard/vies", async () => {
        const result = await client.lookupTaxIdViaVIES({ vatNumber, countryCode });
        return {
          content: [getContent(formatRecord(`VIES lookup: ${countryCode}${vatNumber}`, result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );
}
