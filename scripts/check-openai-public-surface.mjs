#!/usr/bin/env node
/** Read-only public preflight. It never authenticates or certifies submission readiness. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const root = new URL("../", import.meta.url);
const json = path => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const contract = json("src/__tests__/fixtures/openai-review-descriptor.snapshot.json");
const release = json("workers/remote-mcp/public-openai/releases.json");
const pkg = json("package.json");
export const REVIEW_ORIGIN = contract.oauth.authorizationServer.issuer;
const MAX_BYTES = 256 * 1024;
const OWNER = "VICTOR BERTHELIUS PATO";

export const PUBLIC_PROBES = Object.freeze([
  ["root", "/", "GET"],
  ["health", "/health", "GET"],
  ["discovery", "/.well-known/mcp", "GET"],
  ["manifest", "/mcp.json", "GET"],
  ["authorization", "/.well-known/oauth-authorization-server", "GET"],
  ["resource", "/.well-known/oauth-protected-resource", "GET"],
  ["privacy", "/privacy", "GET"],
  ["support", "/support", "GET"],
  ["openapiJson", "/openapi.json", "GET"],
  ["openapiJsonHead", "/openapi.json", "HEAD"],
  ["openapiYaml", "/openapi.yaml", "GET"],
  ["openapiYamlHead", "/openapi.yaml", "HEAD"],
  ["challenge", "/mcp", "POST"],
]);

async function capture(probe, fetchImpl, timeoutMs) {
  const [id, path, method] = probe;
  const controller = new AbortController();
  let timer;
  let response;
  let reader;
  let status;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("TIMEOUT")); }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      response = await fetchImpl(`${REVIEW_ORIGIN}${path}`, {
        method, redirect: "manual", credentials: "omit", signal: controller.signal,
        headers: { Accept: "application/json, text/html", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: "public-preflight", method: "tools/list" }) } : {}),
      });
      status = response.status;
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BYTES)) throw new Error("BODY_LIMIT");
      let text = "";
      let bytes = 0;
      const decoder = new TextDecoder();
      if (response.body) {
        reader = response.body.getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BYTES) throw new Error("BODY_LIMIT");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      }
      let data = null;
      try { data = JSON.parse(text); } catch { /* Not every probe returns JSON. */ }
      return { id, status, text, data, contentType: response.headers.get("content-type") ?? "", challenge: response.headers.get("www-authenticate") };
    })()]);
  } catch (error) {
    // Do not echo server content, Location, URLs, or exception messages.
    const failure = error?.message === "BODY_LIMIT" ? "body_limit"
      : controller.signal.aborted ? "timeout" : "network_error";
    return { id, status: status ?? null, unavailable: failure };
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
  }
}

export async function inspectPublicSurface({ fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const responses = {};
  // Keep pressure bounded; this command probes only the dedicated reviewed host.
  for (const probe of PUBLIC_PROBES) responses[probe[0]] = await capture(probe, fetchImpl, timeoutMs);
  const checks = [];
  const check = (id, probe, predicate) => {
    const response = responses[probe];
    checks.push({ id, status: response.unavailable ? "unknown" : predicate(response) ? "pass" : "fail" });
  };
  const count = contract.tools.length;
  check("rootProfile", "root", r => r.status === 200 && r.data?.tools === count
    && r.data?.reviewedBusinessOperations === count && r.data?.discoveryNames === 0
    && r.data?.resources === 0 && r.data?.prompts === 0
    && r.data?.mcp === `${REVIEW_ORIGIN}/mcp`
    && r.data?.auth?.authorization_server === `${REVIEW_ORIGIN}/.well-known/oauth-authorization-server`
    && r.data?.docs === `${REVIEW_ORIGIN}/support` && r.data?.privacy === `${REVIEW_ORIGIN}/privacy`
    && !Object.hasOwn(r.data, "openapi"));
  check("healthProvenance", "health", r => r.status === 200 && r.data?.status === "ok"
    && r.data?.version === pkg.version && r.data?.releaseVersion === pkg.version
    && r.data?.releaseSource === "wrangler-var" && /^[a-f0-9]{40}$/u.test(r.data?.releaseSha ?? ""));
  for (const id of ["discovery", "manifest"]) {
    check(`${id}Profile`, id, r => r.status === 200 && r.data?.endpoint === `${REVIEW_ORIGIN}/mcp`
      && r.data?.tools_count === count && r.data?.reviewed_business_tools_count === count
      && r.data?.discovery_meta_tools_count === 0 && r.data?.resources_count === 0 && r.data?.prompts_count === 0
      && r.data?.docs === `${REVIEW_ORIGIN}/support` && r.data?.privacy === `${REVIEW_ORIGIN}/privacy`
      && r.data?.auth?.authorization_server === `${REVIEW_ORIGIN}/.well-known/oauth-authorization-server`
      && r.data?.auth?.authorization_endpoint === `${REVIEW_ORIGIN}/authorize`
      && r.data?.auth?.token_endpoint === `${REVIEW_ORIGIN}/token`
      && r.data?.auth?.registration_endpoint === `${REVIEW_ORIGIN}/register`
      && isDeepStrictEqual(r.data?.auth?.scopes, contract.oauth.authorizationServer.scopes_supported));
  }
  check("authorizationMetadata", "authorization", r => r.status === 200 && isDeepStrictEqual(r.data, contract.oauth.authorizationServer));
  check("resourceMetadata", "resource", r => r.status === 200 && isDeepStrictEqual(r.data, contract.oauth.protectedResource));
  for (const id of ["privacy", "support"]) {
    check(`${id}Ownership`, id, r => r.status === 200 && r.contentType.includes("text/html")
      && r.text.includes(OWNER) && r.text.includes("ayuda@frihet.io") && r.text.includes("openai-mcp.frihet.io"));
  }
  for (const id of ["openapiJson", "openapiJsonHead", "openapiYaml", "openapiYamlHead"]) check(`${id}Absent`, id, r => r.status === 404);
  check("unauthenticatedMcpChallenge", "challenge", r => r.status === 401
    && r.challenge === contract.oauth.wwwAuthenticate.missingTokenHeader);

  const failed = checks.some(c => c.status === "fail");
  const unknown = checks.some(c => c.status === "unknown");
  return {
    schemaVersion: 1,
    origin: REVIEW_ORIGIN,
    publicSurfaceStatus: failed ? "fail" : unknown ? "inconclusive" : "pass",
    submissionReady: false,
    expected: { runtimeVersion: pkg.version, reviewedProfileVersion: release.version, tools: count, resources: 0, prompts: 0 },
    probes: Object.values(responses).map(r => ({ id: r.id, httpStatus: r.status, ...(r.unavailable ? { unavailable: r.unavailable } : {}) })),
    checks,
    unverified: [
      "Authenticated Cloudflare source/topology and bootstrap authority",
      "Authenticated tools/list and exact descriptor parity",
      "Reviewer account and real positive/negative functional cases",
      "Current portal identity, domain verification, demo and declarations",
      "Separate Anthropic catalogue/policy and recipient-disclosure review",
    ],
  };
}

async function main() {
  if (process.argv.length > 2) throw new Error("No arguments accepted; the reviewed host is fixed and no credentials are used.");
  const report = await inspectPublicSurface();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.publicSurfaceStatus === "pass" ? 0 : report.publicSurfaceStatus === "fail" ? 1 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Public preflight could not complete; no readiness claim is made."); process.exitCode = 2; });
}
