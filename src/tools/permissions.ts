/**
 * Permissions tools for the Frihet MCP server — D4-B megasprint (2 tools).
 *
 * Tools:
 *   1. permissions_matrix — full role/permission matrix for the workspace
 *   2. permissions_me     — caller's own role + permissions
 *
 * REST surface: /v1/permissions/matrix, /v1/permissions/me
 *
 * Permissions are derived from role + workspace overrides. Tools are read-only —
 * mutating roles is done via team_invite / team_role_update (existing).
 *
 * NOTE: ERP backend endpoints land in parallel D4-A wave. 404s propagate as isError
 * until backend ships.
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

export function registerPermissionsTools(server: McpServer, client: IFrihetClient): void {
  // -- permissions_matrix --

  server.registerTool(
    "permissions_matrix",
    {
      title: "Permissions Matrix",
      description:
        "Return the full role-to-permission matrix for the workspace. " +
        "Lists every role with the permissions it grants and every protected resource. " +
        "Useful for security audits, role design, and compliance reporting. " +
        "/ Devuelve la matriz completa de roles y permisos del workspace.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {},
      outputSchema: permissionsMatrixOutput,
    },
    async () => withToolLogging("permissions_matrix", async () => {
      const result = await client.getPermissionsMatrix();
      return {
        content: [getContent(formatRecord("Permissions matrix", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );

  // -- permissions_me --

  server.registerTool(
    "permissions_me",
    {
      title: "My Permissions",
      description:
        "Return the caller's effective role + permissions in the current workspace. " +
        "Useful for client-side UI gating, debugging access errors, and capability discovery. " +
        "/ Devuelve el rol efectivo y los permisos del llamante en el workspace actual.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {},
      outputSchema: permissionsMeOutput,
    },
    async () => withToolLogging("permissions_me", async () => {
      const result = await client.getMyPermissions();
      return {
        content: [getContent(formatRecord("My permissions", result))],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }),
  );
}
