/**
 * Canonical registration path shared by the stdio server, remote Worker, and
 * generated public-surface contract. Transport/auth setup stays with each host;
 * the exposed MCP operations/resources/prompts are composed here exactly once.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { READ_STAMP } from "./demo-fixtures.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IFrihetClient } from "./client-interface.js";
import {
  applyPublicCapabilityTruth,
  buildLocalDiscoveryCapability,
  CAPABILITY_META_KEY,
} from "./capability-truth.js";
import { applyFiscalAliases } from "./fiscal-aliases.js";
import { applyClaudeCandidateProfile, CLAUDE_CANDIDATE_TOOLS, CLAUDE_GROUP_METADATA } from "./claude-profile.js";
import { applyGoogleProfile, GOOGLE_CANDIDATE_TOOLS } from "./google-profile.js";
import { applyMuseProfile, MUSE_CANDIDATE_TOOLS } from "./muse-profile.js";
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
  readonly googleMode?: boolean;
  readonly museMode?: boolean;
  readonly demoMode?: boolean;
}

export function localMcpSurfaceComposition(
  openaiMode: boolean,
  groupedMode: boolean,
  claudeMode = false,
  googleMode = false,
  museMode = false,
): McpSurfaceComposition {
  return { openaiMode, groupedMode, includeDynamicResources: true, claudeMode, googleMode, museMode };
}

export function remoteMcpSurfaceComposition(
  openaiMode: boolean,
  groupedMode: boolean,
  claudeMode = false,
  googleMode = false,
  museMode = false,
): McpSurfaceComposition {
  return { openaiMode, groupedMode, includeDynamicResources: false, claudeMode, googleMode, museMode };
}

export function registerMcpSurface(
  server: McpServer,
  client: IFrihetClient,
  options: McpSurfaceComposition,
): void {
  const activeModes = [options.openaiMode, options.claudeMode, options.googleMode, options.museMode].filter(Boolean).length;
  if (activeModes > 1) {
    throw new Error("FRIHET_OPENAI_MODE, FRIHET_CLAUDE_MODE, FRIHET_GOOGLE_MODE, and FRIHET_MUSE_MODE are mutually exclusive");
  }
  if (options.claudeMode) {
    // Directory reads annotations.title. Install before grouped discovery eagerly
    // registers its meta-tools, and clone annotations to preserve shared hints.
    const registerTool = server.registerTool.bind(server);
    server.registerTool = (name, config, handler) => registerTool(name, {
      ...config,
      annotations: { ...config.annotations, title: config.title },
    }, handler);
  }
  let clientIsDemo = false;
  try {
    clientIsDemo =
      (client as { isDemoClient?: unknown } | undefined)?.isDemoClient === true ||
      (client as { constructor?: { name?: string } } | undefined)?.constructor?.name === "DemoFrihetClient";
  } catch {
    clientIsDemo = false;
  }
  const isDemoMode = options.demoMode === true || clientIsDemo;
  if (isDemoMode) {
    // Install closest to the SDK so profile projection/redaction runs first.
    // Only trusted server/client configuration enables this boundary; neither
    // input arguments nor response metadata can switch a live server to demo.
    const registerTool = server.registerTool.bind(server);
    server.registerTool = (name, config, handler) => {
      const schema = config.outputSchema;
      if (!(schema instanceof z.ZodObject)
        || !["data", "total", "limit", "offset"].every((key) => key in schema.shape)) {
        return registerTool(name, config, handler);
      }
      return registerTool(name, {
        ...config,
        outputSchema: schema.extend({
          _demo: z.literal(true),
          _demoNotice: z.literal(READ_STAMP._demoNotice),
        }),
      }, (async (args: unknown, extra: unknown) => {
        const result = await (handler as (args: unknown, extra: unknown) => Promise<CallToolResult>)(args, extra);
        if (result.isError || !result.structuredContent) return result;
        const structuredContent = { ...result.structuredContent, ...READ_STAMP };
        return {
          ...result,
          structuredContent,
          // JSON mirrors structuredContent for hosts that only read text.
          // Keep existing summaries/hints too; no warning is silently dropped.
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }, ...result.content],
        };
      }) as Parameters<typeof registerTool>[2]);
    };
  }
  if (options.groupedMode) {
    if (options.openaiMode) {
      applyOpenAIReviewProfiles(server);
    } else {
      applyToolExposureProfile(server, {
        ...(options.claudeMode ? {
          allowlist: CLAUDE_CANDIDATE_TOOLS,
          groupMetadata: CLAUDE_GROUP_METADATA,
          describeToolExample: "list_invoices",
        } : {}),
        capabilityTruth: {
          metaKey: CAPABILITY_META_KEY,
          localDiscovery: buildLocalDiscoveryCapability,
        },
        demoMode: isDemoMode,
      });
    }
  } else if (options.openaiMode) {
    applyOpenAIProfile(server);
  }

  if (!options.openaiMode && !options.googleMode && !options.museMode) {
    applyPublicCapabilityTruth(server);
  }

  if (options.claudeMode) {
    applyClaudeCandidateProfile(server);
  } else if (options.googleMode) {
    applyGoogleProfile(server);
  } else if (options.museMode) {
    applyMuseProfile(server);
  }

  registerAllTools(server, client);
  applyFiscalAliases(server);
  registerAllResources(server, options.includeDynamicResources ? client : undefined);
  registerAllPrompts(server);
}
