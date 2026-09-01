/**
 * Release-source SHA — surfaced in /health so the release workflow can
 * prove the deployed Worker is the SAME commit that produced the published
 * tarball (no stale Worker, no metadata-only follow-up tag, no silent
 * post-publish rebuild drift).
 *
 * Sourced from a Wrangler var set by `.github/workflows/release-mcp-npm.yml`
 * at deploy time (`wrangler deploy --var RELEASE_SOURCE_SHA:<sha>`). Falls
 * back to `unknown` outside the release pipeline (regular `wrangler deploy`)
 * so day-to-day deploys do not lie about provenance they cannot prove.
 *
 * NOT a substitute for the npm gitHead anchor (that is `scripts/assert-publish-anchor.mjs`
 * at publish time). This is the second half of the end-to-end provenance chain:
 *   publish-anchor:  npm gitHead === origin/main HEAD at publish
 *   release-meta:    Worker /health.releaseSha === origin/main HEAD at deploy
 * If both agree and match the GitHub Release tag, the bytes on the registry,
 * the bytes on the Worker, and the bytes the tag points at are the SAME bytes.
 */

export interface ReleaseMeta {
  releaseSha: string;
  releaseVersion: string | null;
  source: "wrangler-var" | "fallback-unknown";
}

/**
 * Read release-time provenance from the Worker environment.
 * `vars.RELEASE_SOURCE_SHA` / `vars.RELEASE_VERSION` are injected by
 * `wrangler deploy --var ...`; absent outside the release pipeline.
 */
export function readReleaseMeta(env: {
  RELEASE_SOURCE_SHA?: unknown;
  RELEASE_VERSION?: unknown;
}): ReleaseMeta {
  const rawSha = typeof env.RELEASE_SOURCE_SHA === "string" ? env.RELEASE_SOURCE_SHA.trim() : "";
  const rawVersion = typeof env.RELEASE_VERSION === "string" ? env.RELEASE_VERSION.trim() : "";
  if (rawSha && /^[a-f0-9]{40}$/i.test(rawSha)) {
    return {
      releaseSha: rawSha.toLowerCase(),
      releaseVersion: rawVersion || null,
      source: "wrangler-var",
    };
  }
  return { releaseSha: "unknown", releaseVersion: rawVersion || null, source: "fallback-unknown" };
}
