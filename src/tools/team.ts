/**
 * Team management tools for the Frihet MCP server — Wave Mature 3 (4 tools).
 *
 * Tools:
 *   1. list_team_members       — list all members in the workspace
 *   2. invite_team_member      — invite a new member by email with a role
 *   3. update_team_member_role — change the role of an existing member
 *   4. remove_team_member      — remove a member from the workspace (Trust Area)
 *
 * REST surface: /v1/team/members
 *
 * Backend: /v1/team/* endpoints live as of Wave 4-A (Frihet-ERP functions/src/publicApi.ts).
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
  READ_ONLY_ANNOTATIONS,
  CREATE_ANNOTATIONS,
  UPDATE_ANNOTATIONS,
  DELETE_ANNOTATIONS,
  paginatedOutput,
  actionResultOutput,
  teamMemberItemOutput,
} from "./shared.js";

export function registerTeamTools(server: McpServer, client: IFrihetClient): void {
  // -- list_team_members --

  server.registerTool(
    "list_team_members",
    {
      title: "List Team Members",
      description:
        "List all members in the workspace. " +
        "Returns member ID, name, email, role, and invite status (pending/active). " +
        "Useful for access management and auditing who has access to the account. " +
        "/ Lista todos los miembros del espacio de trabajo. " +
        "Devuelve ID, nombre, email, rol y estado de invitacion (pendiente/activo). " +
        "Util para gestion de accesos y auditoria de quien tiene acceso a la cuenta.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        role: z
          .enum(["owner", "admin", "member", "viewer"])
          .optional()
          .describe("Filter by role / Filtrar por rol"),
        status: z
          .enum(["active", "pending"])
          .optional()
          .describe("Filter by invite status / Filtrar por estado de invitacion"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (1-100) / Resultados maximos"),
        offset: z.number().int().min(0).optional().describe("Offset / Desplazamiento"),
      },
      outputSchema: paginatedOutput(teamMemberItemOutput),
    },
    async ({ role, status, limit, offset }) =>
      withToolLogging("list_team_members", async () => {
        const result = await client.listTeamMembers({ role, status, limit, offset });
        return {
          content: [listContent(formatPaginatedResponse("team_members", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- invite_team_member --

  server.registerTool(
    "invite_team_member",
    {
      title: "Invite Team Member",
      description:
        "Invite a new member to the workspace by email address. " +
        "An invitation email is sent — the member must accept before gaining access. " +
        "Roles: owner (full access), admin (manage account, no billing), member (operational access), viewer (read-only). " +
        "Example: email='ana@example.com', role='member' " +
        "/ Invita a un nuevo miembro al espacio de trabajo por correo electronico. " +
        "Se envia un email de invitacion — el miembro debe aceptar antes de acceder. " +
        "Roles: owner (acceso total), admin (gestion sin facturacion), member (acceso operativo), viewer (solo lectura).",
      annotations: CREATE_ANNOTATIONS,
      inputSchema: {
        email: z.string().email().describe("Email address of the invitee / Email del invitado"),
        role: z
          .enum(["admin", "member", "viewer"])
          .describe("Role to assign (owner cannot be invited, must be transferred) / Rol a asignar (owner no se puede invitar, debe transferirse)"),
        name: z
          .string()
          .optional()
          .describe("Display name for the invitation (optional) / Nombre para la invitacion (opcional)"),
      },
      outputSchema: teamMemberItemOutput,
    },
    async ({ email, role, name }) =>
      withToolLogging("invite_team_member", async () => {
        const result = await client.inviteTeamMember({ email, role, name });
        return {
          content: [mutateContent(formatRecord("Team member invited", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- update_team_member_role --

  server.registerTool(
    "update_team_member_role",
    {
      title: "Update Team Member Role",
      description:
        "Change the role of an existing team member. " +
        "Only workspace admins or owners can change roles. " +
        "Cannot change the owner's role — use a dedicated ownership transfer flow. " +
        "Example: memberId='mbr_abc123', role='admin' " +
        "/ Cambia el rol de un miembro existente del espacio de trabajo. " +
        "Solo administradores o propietarios pueden cambiar roles. " +
        "No se puede cambiar el rol del propietario — usa el flujo de transferencia de propiedad.",
      annotations: UPDATE_ANNOTATIONS,
      inputSchema: {
        memberId: z.string().describe("Team member ID / ID del miembro del equipo"),
        role: z
          .enum(["admin", "member", "viewer"])
          .describe("New role to assign / Nuevo rol a asignar"),
      },
      outputSchema: actionResultOutput,
    },
    async ({ memberId, role }) =>
      withToolLogging("update_team_member_role", async () => {
        const result = await client.updateTeamMemberRole(memberId, role);
        return {
          content: [mutateContent(formatRecord("Team member role updated", result))],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
  );

  // -- remove_team_member --

  server.registerTool(
    "remove_team_member",
    {
      title: "Remove Team Member",
      description:
        "Remove a member from the workspace. " +
        "The member immediately loses access. Their created records (invoices, expenses) are preserved. " +
        "Cannot remove the workspace owner — transfer ownership first. " +
        "Requires confirm=true to prevent accidental removal. " +
        "/ Elimina un miembro del espacio de trabajo. " +
        "El miembro pierde acceso inmediatamente. Sus registros creados (facturas, gastos) se conservan. " +
        "No se puede eliminar al propietario — transfiere la propiedad primero. " +
        "Requiere confirm=true para evitar eliminaciones accidentales.",
      annotations: DELETE_ANNOTATIONS,
      inputSchema: {
        memberId: z.string().describe("Team member ID / ID del miembro del equipo"),
        confirm: z
          .boolean()
          .describe("Must be true to confirm removal / Debe ser true para confirmar la eliminacion"),
      },
      outputSchema: actionResultOutput,
    },
    async ({ memberId, confirm }) => withToolLogging("remove_team_member", async () => {
      if (!confirm) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: confirm=true is required to remove a team member. " +
                "The member will immediately lose access to the workspace. Set confirm=true to proceed. / " +
                "Se requiere confirm=true para eliminar un miembro del equipo.",
            },
          ],
          isError: true,
        };
      }
      await client.removeTeamMember(memberId);
      return {
        content: [mutateContent(`Team member ${memberId} removed from workspace. / Miembro ${memberId} eliminado del espacio de trabajo.`)],
        structuredContent: { success: true, id: memberId } as unknown as Record<string, unknown>,
      };
    }),
  );
}
