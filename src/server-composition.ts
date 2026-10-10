/**
 * Canonical registration path shared by the stdio server, remote Worker, and
 * generated public-surface contract. Transport/auth setup stays with each host;
 * the exposed MCP operations/resources/prompts are composed here exactly once.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IFrihetClient } from "./client-interface.js";
import {
  applyPublicCapabilityTruth,
  buildLocalDiscoveryCapability,
  CAPABILITY_META_KEY,
} from "./capability-truth.js";
import { applyFiscalAliases } from "./fiscal-aliases.js";
import { applyClaudeCandidateProfile, CLAUDE_CANDIDATE_TOOLS, CLAUDE_GROUP_METADATA } from "./claude-profile.js";
import {
  applyOpenAIProfile,
  applyOpenAIReviewProfiles,
} from "./openai-profile.js";
import { registerAllPrompts } from "./prompts/register-all.js";
import { registerAllResources } from "./resources/register-all.js";
import { applyToolExposureProfile } from "./tool-exposure.js";
import { registerAllTools } from "./tools/register-all.js";

export interface McpSurfaceComposition {
  readonly openaiMode: boolean;
  readonly groupedMode: boolean;
  readonly includeDynamicResources: boolean;
  readonly claudeMode?: boolean;
}

export function localMcpSurfaceComposition(
  openaiMode: boolean,
  groupedMode: boolean,
  claudeMode = false,
): McpSurfaceComposition {
  return { openaiMode, groupedMode, includeDynamicResources: true, claudeMode };
}

export function remoteMcpSurfaceComposition(
  openaiMode: boolean,
  groupedMode: boolean,
  claudeMode = false,
): McpSurfaceComposition {
  return { openaiMode, groupedMode, includeDynamicResources: false, claudeMode };
}

export function registerMcpSurface(
  server: McpServer,
  client: IFrihetClient,
  options: McpSurfaceComposition,
): void {
  if (options.openaiMode && options.claudeMode) {
    throw new Error("FRIHET_OPENAI_MODE and FRIHET_CLAUDE_MODE are mutually exclusive");
  }
  if (options.groupedMode) {
    if (options.openaiMode) {
      applyOpenAIReviewProfiles(server);
    } else {
      applyToolExposureProfile(server, {
        ...(options.claudeMode ? {
          allowlist: CLAUDE_CANDIDATE_TOOLS,
          groupMetadata: CLAUDE_GROUP_METADATA,
        } : {}),
        capabilityTruth: {
          metaKey: CAPABILITY_META_KEY,
          localDiscovery: buildLocalDiscoveryCapability,
        },
      });
    }
  } else if (options.openaiMode) {
    applyOpenAIProfile(server);
  }

  if (!options.openaiMode) {
    applyPublicCapabilityTruth(server);
  }

  if (options.claudeMode) {
    applyClaudeCandidateProfile(server);
  }

  registerAllTools(server, client);
  applyFiscalAliases(server);
  registerAllResources(server, options.includeDynamicResources ? client : undefined);
  registerAllPrompts(server);
}
