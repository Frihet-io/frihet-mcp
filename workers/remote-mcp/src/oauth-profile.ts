import {
  OPENAI_REVIEW_ORIGIN,
  OPENAI_REVIEW_OAUTH_RESOURCES,
  resolveFrihetAccessProfile,
} from "../../../src/openai-review-oauth.js";

export const CLAUDE_ORIGIN = "https://claude-mcp.frihet.io";
export const CLAUDE_MCP_RESOURCE = `${CLAUDE_ORIGIN}/mcp`;
export const CLAUDE_OAUTH_RESOURCES: readonly string[] = Object.freeze([CLAUDE_MCP_RESOURCE]);

export type WorkerAccessProfile = "openai" | "claude" | "full";

function isSafeFirebaseUid(value: unknown): value is string {
  // Match the ERP provisioning authority exactly; never normalize identity.
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 128
    && !value.includes("/")
    && !value.includes("\0")
    && value !== "."
    && value !== "..";
}

/** Private Claude pilot membership; re-read on every authorization decision. */
export function isClaudeQaUidAllowed(
  env: { FRIHET_CLAUDE_QA_UIDS?: unknown },
  uid: unknown,
): uid is string {
  if (!isSafeFirebaseUid(uid) || typeof env.FRIHET_CLAUDE_QA_UIDS !== "string") return false;
  let configured: unknown;
  try {
    configured = JSON.parse(env.FRIHET_CLAUDE_QA_UIDS);
  } catch {
    return false;
  }
  return Array.isArray(configured)
    && configured.length > 0
    && configured.every(isSafeFirebaseUid)
    && new Set(configured).size === configured.length
    && configured.includes(uid);
}

export function resolveWorkerAccessProfile(env: {
  FRIHET_OPENAI_MODE?: string;
  FRIHET_CLAUDE_MODE?: string;
}): WorkerAccessProfile {
  const existing = resolveFrihetAccessProfile(env.FRIHET_OPENAI_MODE);
  if (env.FRIHET_CLAUDE_MODE === undefined || env.FRIHET_CLAUDE_MODE === "false") return existing;
  if (env.FRIHET_CLAUDE_MODE !== "true" || existing === "openai") {
    throw new Error("Claude requires FRIHET_CLAUDE_MODE=true and FRIHET_OPENAI_MODE=false");
  }
  return "claude";
}

export function boundOAuthProfile(profile: WorkerAccessProfile) {
  if (profile === "full") throw new Error("Full OAuth authority is not enabled");
  return profile === "claude"
    ? { accessProfile: profile, origin: CLAUDE_ORIGIN, acceptedResources: CLAUDE_OAUTH_RESOURCES } as const
    : { accessProfile: profile, origin: OPENAI_REVIEW_ORIGIN, acceptedResources: OPENAI_REVIEW_OAUTH_RESOURCES } as const;
}
