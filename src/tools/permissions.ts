/**
 * Permissions tools for the Frihet MCP server — D4-B megasprint (2 tools).
 *
 * Tools:
 *   1. permissions_matrix — documented RBAC-model snapshot
 *   2. permissions_me     — RBAC model + actual API-key scope reporting
 *
 * REST surface: /v1/permissions/matrix, /v1/permissions/me
 *
 * These read-only reports are useful for discovery, but neither is an exhaustive
 * runtime-authorization prediction. A backend 403 remains authoritative.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IFrihetClient } from "../client-interface.js";
import {
  withToolLogging,
  formatRecord,
  getContent,
  READ_ONLY_ANNOTATIONS,
  permissionsMatrixOutput,
  permissionsMeOutput,
} from "./shared.js";
import { withBackendGuard } from "./backend-availability.js";

export function registerPermissionsTools(server: McpServer, client: IFrihetClient): void {
  // -- permissions_matrix --

  server.registerTool(
    "permissions_matrix",
    {
      title: "Permissions Matrix",
      description:
        "Return the backend's documented RBAC-model snapshot by role, resource, and action. " +
        "It is not derived from Firestore rules and is not a runtime authorization guarantee; " +
        "a backend 403 is authoritative. / Devuelve el modelo RBAC documentado, no una garantia exhaustiva de autorizacion.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {},
      outputSchema: permissionsMatrixOutput,
    },
    async () => withToolLogging("permissions_matrix", () =>
      withBackendGuard("permissions_matrix", "/v1/permissions/matrix", async () => {
        const result = await client.getPermissionsMatrix();
        return {
          content: [getContent(formatRecord("Permissions matrix", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );

  // -- permissions_me --

  server.registerTool(
    "permissions_me",
    {
      title: "My Permissions",
      description:
        "Return the caller's backwards-compatible RBAC-model fields separately from actual API-key scopes, " +
        "unrestricted-key semantics, known e-invoice scope denial, and surfaces not reported here. " +
        "This is non-exhaustive; use the exact backend 403 as authority. " +
        "/ Separa el modelo RBAC de los scopes reales de la API key; no es una autorizacion exhaustiva.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {},
      outputSchema: permissionsMeOutput,
    },
    async () => withToolLogging("permissions_me", () =>
      withBackendGuard("permissions_me", "/v1/permissions/me", async () => {
        const result = await client.getMyPermissions();
        return {
          content: [getContent(formatRecord("My permissions", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    ),
  );
}
