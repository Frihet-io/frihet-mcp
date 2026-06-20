/**
 * White-label portal domain tools for the Frihet MCP server — Day 1 Megasprint (3 tools).
 *
 * Tools:
 *   1. frihet_portal_domain_add    — add a custom domain to the client portal
 *   2. frihet_portal_domain_verify — verify DNS propagation for a custom domain
 *   3. frihet_portal_domain_remove — remove a custom portal domain
 *
 * REST surface: /v1/portal/domain/* proxies Firebase callables:
 *   addCustomPortalDomain, verifyCustomPortalDomain, removeCustomPortalDomain (eu-west1)
 *
 * Backend status (post-Day 1 Megasprint, May 2026):
 *   Frihet-ERP PR #397 — White-label portal domain MERGED.
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
  READ_ONLY_ANNOTATIONS,
  CREATE_ANNOTATIONS,
  DELETE_ANNOTATIONS,
} from "./shared.js";
import { withBackendGuard } from "./backend-availability.js";

export function registerPortalDomainTools(server: McpServer, client: IFrihetClient): void {
  // -- frihet_portal_domain_add ---------------------------------------------

  server.registerTool(
    "frihet_portal_domain_add",
    {
      title: "Add Custom Portal Domain",
      description:
        "Add a custom domain to the Frihet client portal for white-label branding. " +
        "Returns DNS records (CNAME) that must be configured at the registrar before verification. " +
        "Example: domain='portal.miempresa.com'. " +
        "/ Agrega un dominio personalizado al portal de clientes Frihet para marca blanca. " +
        "Devuelve los registros DNS (CNAME) que deben configurarse en el registrador antes de verificar.",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        domain: z.string().describe("Custom domain to add (e.g. 'portal.miempresa.com') / Dominio personalizado (ej. 'portal.miempresa.com')"),
        workspaceId: z.string().optional().describe("Target workspace ID (defaults to caller's workspace) / ID del workspace destino"),
      },
    },
    async ({ domain, workspaceId }) => withToolLogging("frihet_portal_domain_add", () =>
      withBackendGuard("frihet_portal_domain_add", "/v1/portal/domain/add", async () => {
        const result = await client.addCustomPortalDomain({ domain, workspaceId });
        return {
          content: [
            mutateContent(
              formatRecord(`Custom portal domain added: ${domain}`, result) +
              "\n\nNext step: Configure the returned CNAME record at your DNS registrar, then call frihet_portal_domain_verify." +
              "\nSiguiente paso: Configura el registro CNAME en tu registrador DNS, luego llama a frihet_portal_domain_verify.",
            ),
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );

  // -- frihet_portal_domain_verify ------------------------------------------

  server.registerTool(
    "frihet_portal_domain_verify",
    {
      title: "Verify Custom Portal Domain",
      description:
        "Verify DNS propagation for a custom portal domain added via frihet_portal_domain_add. " +
        "Returns verification status (pending/verified/failed) and any DNS errors. " +
        "DNS propagation can take up to 48 hours — retry if status is 'pending'. " +
        "Example: domain='portal.miempresa.com'. " +
        "/ Verifica la propagacion DNS de un dominio de portal personalizado. " +
        "Devuelve estado (pending/verified/failed). La propagacion puede tardar hasta 48h.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        domain: z.string().describe("Custom domain to verify / Dominio personalizado a verificar"),
      },
    },
    async ({ domain }) => withToolLogging("frihet_portal_domain_verify", () =>
      withBackendGuard("frihet_portal_domain_verify", "/v1/portal/domain/verify", async () => {
        const result = await client.verifyCustomPortalDomain({ domain });
        return {
          content: [getContent(formatRecord(`Domain verification status: ${domain}`, result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );

  // -- frihet_portal_domain_remove ------------------------------------------

  server.registerTool(
    "frihet_portal_domain_remove",
    {
      title: "Remove Custom Portal Domain",
      description:
        "Remove a custom domain from the Frihet client portal. " +
        "The portal will revert to the default Frihet subdomain. " +
        "Example: domain='portal.miempresa.com'. " +
        "/ Elimina un dominio personalizado del portal de clientes Frihet. " +
        "El portal volverá al subdominio predeterminado de Frihet.",
      annotations: DELETE_ANNOTATIONS,
      inputSchema: {
        domain: z.string().describe("Custom domain to remove / Dominio personalizado a eliminar"),
      },
    },
    async ({ domain }) => withToolLogging("frihet_portal_domain_remove", () =>
      withBackendGuard("frihet_portal_domain_remove", "/v1/portal/domain/remove", async () => {
        const result = await client.removeCustomPortalDomain({ domain });
        return {
          content: [
            mutateContent(
              formatRecord(`Custom portal domain removed: ${domain}`, result),
            ),
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );
}
