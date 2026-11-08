import {
  OPENAI_REVIEW_ORIGIN,
  OPENAI_REVIEW_OAUTH_RESOURCES,
  isVerifiedOpenAIIdentity,
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

export type ClaudeAdmissionPolicy = {
  mode: "qa" | "customers";
  qaUids: string[];
};

/** Legacy QA array or a strict versioned policy; never normalize identities. */
export function readClaudeAdmissionPolicy(
  env: { FRIHET_CLAUDE_QA_UIDS?: unknown },
): ClaudeAdmissionPolicy | undefined {
  if (typeof env.FRIHET_CLAUDE_QA_UIDS !== "string") return undefined;
  let configured: unknown;
  try {
    configured = JSON.parse(env.FRIHET_CLAUDE_QA_UIDS);
  } catch {
    return undefined;
  }
  let mode: ClaudeAdmissionPolicy["mode"] = "qa";
  let qaUids: unknown = configured;
  if (!Array.isArray(configured)) {
    if (
      configured === null
      || typeof configured !== "object"
      || Object.keys(configured).length !== 3
      || !Object.keys(configured).every((key) => ["version", "mode", "qaUids"].includes(key))
    ) return undefined;
    const policy = configured as Record<string, unknown>;
    if (policy.version !== 1 || (policy.mode !== "qa" && policy.mode !== "customers")) return undefined;
    mode = policy.mode;
    qaUids = policy.qaUids;
  }
  if (
    !Array.isArray(qaUids)
    || qaUids.length === 0
    || !qaUids.every(isSafeFirebaseUid)
    || new Set(qaUids).size !== qaUids.length
  ) return undefined;
  return { mode, qaUids };
}

/** Retained QA identities, including when a customer policy is active. */
export function isClaudeQaUidAllowed(
  env: { FRIHET_CLAUDE_QA_UIDS?: unknown },
  uid: unknown,
): uid is string {
  return isSafeFirebaseUid(uid) && readClaudeAdmissionPolicy(env)?.qaUids.includes(uid) === true;
}

export type ClaudeVerifiedIdentity = { uid: string; email: string; emailVerified: true };

/** Only pass identity verified by Firebase or authenticated encrypted grant props. */
export function isVerifiedClaudeIdentity(value: {
  uid?: unknown; email?: unknown; emailVerified?: unknown;
}): value is ClaudeVerifiedIdentity {
  return isSafeFirebaseUid(value.uid) && isVerifiedOpenAIIdentity(value);
}

export function isClaudeIdentityAdmitted(
  env: { FRIHET_CLAUDE_QA_UIDS?: unknown },
  identity: { uid?: unknown; email?: unknown; emailVerified?: unknown },
): boolean {
  if (!isVerifiedClaudeIdentity(identity)) return false;
  const policy = readClaudeAdmissionPolicy(env);
  return policy !== undefined && (policy.mode === "customers" || policy.qaUids.includes(identity.uid));
}

/** A reversible policy pause, distinct from an invalid or replayed credential. */
export class ClaudeAdmissionPolicyError extends Error {
  constructor() {
    super("Frihet Claude access is temporarily unavailable");
    this.name = "ClaudeAdmissionPolicyError";
  }
}

export function claudeAdmissionUnavailableResponse(): Response {
  return Response.json({
    error: "temporarily_unavailable",
    error_description: "Frihet Claude access is temporarily unavailable. Try again later.",
  }, {
    status: 503,
    headers: { "Cache-Control": "no-store", "Pragma": "no-cache", "Retry-After": "60" },
  });
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
