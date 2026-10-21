#!/usr/bin/env node
/**
 * Single-identity Claude protocol pilot. Default: no network, no credentials.
 * --consultation exercises only the historical nine-tool read-only surface.
 * The product lifecycle checks one narrow synthetic CRUD flow; neither mode
 * establishes acceptance of the complete operational catalogue.
 * Build first. Hosted execution requires the existing full deployment guard,
 * a matching public release, and a fresh real Firebase ID token on a private FD.
 * This command never signs in, retries a write, or certifies two-account/client
 * acceptance. The owner must reconcile backend credentials independently.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream, lstatSync, openSync, closeSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import Ajv from "ajv";
import { rejectRedirectResponse } from "../dist/fetch-no-redirect.js";
import { assertClaudeConsultationSurface } from "./check-claude-hosted-release.mjs";

export const ORIGIN = "https://claude-mcp.frihet.io";
export const RESOURCE = `${ORIGIN}/mcp`;
export const FIREBASE_PROJECT = "gen-lang-client-0335716041";
export const SCOPES = Object.freeze(["openid", "email", "frihet:workspace.manage"]);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE = new URL("../src/__tests__/fixtures/claude-candidate-contract.json", import.meta.url);
const FIXTURE_SHA256 = "feab19a4128734a06d8d9561b10f3909719460a70fae6288dad888f1969da988";
const SERVED_FIXTURE = new URL("../src/__tests__/fixtures/claude-consultation-route-contract.json", import.meta.url);
export const CONSULTATION_LISTS = Object.freeze(["list_clients", "list_expenses", "list_invoices", "list_products", "list_quotes", "list_vendors"]);
export const CONSULTATION_DENIED = Object.freeze(["create_product", "update_product", "delete_product", "get_client", "create_invoice", "send_invoice", "verifactu_resubmit", "frihet_modelo_303_summary"]);
const CONSULTATION_ROWS = ["deployment_guard", "public_release", "firebase_input", "oauth", "userinfo", "callback_replay", "code_replay", "mcp_catalogs", "static_resource", "consultation_reads", "consultation_denials", "consultation_population", "refresh", "revoke", "reconnect", "refresh_replay"];
const MAX_BODY = 4 * 1024 * 1024;
const MAX_TOKEN = 16 * 1024;
const ROWS = ["deployment_guard", "public_release", "firebase_input", "oauth", "userinfo", "callback_replay", "code_replay", "mcp_catalogs", "static_resource", "foreign_product_exact_id_denied", "product_crud", "product_cleanup", "refresh", "revoke", "reconnect", "refresh_replay"];
const UNEXERCISED = Object.freeze([
  "second_identity_and_cross_workspace_isolation", "cross_principal_session_envelope",
  "verified_non_allowlisted_identity", "wrong_resource_redirect_and_verifier_matrix",
  "foreign_profile_token_rejection", "independent_backend_key_and_correlation_cleanup",
  "actual_claude_client_journey",
]);

class PilotFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireThat(condition, code) { if (!condition) throw new PilotFailure(code); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function sameScopes(value) {
  const scopes = typeof value === "string" ? value.split(" ") : value;
  return Array.isArray(scopes) && isDeepStrictEqual([...scopes].sort(), [...SCOPES].sort());
}
function opaque(value, max = 8192) { return typeof value === "string" && value.length > 0 && value.length <= max && !/[\s\x00-\x1f\x7f]/u.test(value); }

/** Reuse the existing redirect rejection; additionally bound headers/body/time. */
export function boundedTransport({ fetchImpl = globalThis.fetch, timeoutMs = 15_000, maxBytes = MAX_BODY } = {}) {
  return async (path, { method = "GET", headers = {}, body, rpcId } = {}) => {
    const target = new URL(path, ORIGIN);
    requireThat(target.origin === ORIGIN && !target.username && !target.password && !target.hash
      && ["/health", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/openid-configuration", "/register", "/authorize", "/callback", "/token", "/userinfo", "/mcp"].includes(target.pathname), "TARGET_REFUSED");
    const controller = new AbortController();
    let timer, reader, response;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new PilotFailure("TIMEOUT")); }, timeoutMs);
    });
    try {
      return await Promise.race([deadline, (async () => {
        response = await fetchImpl(target.href, {
          method, headers: { Accept: "application/json, text/event-stream, text/html", ...headers },
          ...(body === undefined ? {} : { body }), redirect: "manual", credentials: "omit", signal: controller.signal,
        });
        await rejectRedirectResponse(response);
        const length = response.headers.get("content-length");
        requireThat(length === null || (/^\d+$/u.test(length) && Number(length) <= maxBytes), "BODY_LIMIT");
        let text = "", bytes = 0, selected;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const sse = (response.headers.get("content-type") ?? "").includes("text/event-stream");
        if (response.body) {
          reader = response.body.getReader();
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            requireThat(bytes <= maxBytes, "BODY_LIMIT");
            text += decoder.decode(chunk.value, { stream: true });
            if (sse && rpcId !== undefined) {
              selected = selectSse(text, rpcId);
              if (selected) break; // POST SSE may remain open after its result.
            }
          }
          if (!selected) text += decoder.decode();
        }
        let data = selected;
        if (!data && sse && rpcId !== undefined) data = selectSse(`${text}\n\n`, rpcId);
        if (!sse) { try { data = JSON.parse(text); } catch { /* HTML/empty responses are intentional. */ } }
        return { status: response.status, headers: response.headers, text: sse ? "" : text, data };
      })()]);
    } catch (error) {
      if (error instanceof PilotFailure) throw error;
      throw new PilotFailure(response && [301, 302, 303, 307, 308].includes(response.status) ? "REDIRECT_REFUSED" : "NETWORK_UNAVAILABLE");
    } finally {
      clearTimeout(timer); controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      else if (response?.body) void response.body.cancel().catch(() => {});
    }
  };
}

function selectSse(text, id) {
  const blocks = text.split(/\r?\n\r?\n/u).slice(0, -1);
  requireThat(blocks.length <= 100, "MCP_EVENT_LIMIT");
  let selected;
  for (const block of blocks) {
    const payload = block.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!payload) continue;
    let message;
    try { message = JSON.parse(payload); } catch { throw new PilotFailure("MCP_WIRE_INVALID"); }
    if (message.id === id) { requireThat(!selected, "MCP_WIRE_INVALID"); selected = message; }
  }
  return selected;
}

/** The full existing guard is mandatory; --source-only is never used here. */
function verifyDeploymentAdmission() {
  try {
    execFileSync(process.execPath, [resolve(ROOT, "scripts/check-claude-hosted-release.mjs")], {
      cwd: ROOT, stdio: "ignore", timeout: 180_000,
    });
  } catch { throw new PilotFailure("DEPLOYMENT_GUARD_FAILED"); }
}

export function readPrivateToken(fd = 0, timeoutMs = 15_000) {
  requireThat(Number.isSafeInteger(fd) && fd >= 0, "TOKEN_FD_INVALID");
  return new Promise((resolveToken, reject) => {
    let stream, timer, size = 0;
    const chunks = [];
    const finish = (error) => {
      clearTimeout(timer);
      if (error) { stream?.destroy(); reject(new PilotFailure(error)); }
      else resolveToken(Buffer.concat(chunks).toString("utf8").trim());
    };
    try {
      stream = createReadStream(null, { fd, autoClose: false, highWaterMark: MAX_TOKEN + 1 });
      timer = setTimeout(() => finish("TOKEN_INPUT_TIMEOUT"), timeoutMs);
      stream.on("data", chunk => { size += chunk.length; if (size > MAX_TOKEN) finish("TOKEN_INPUT_LIMIT"); else chunks.push(chunk); });
      stream.once("error", () => finish("TOKEN_INPUT_FAILED"));
      stream.once("end", () => finish());
    } catch { finish("TOKEN_INPUT_FAILED"); }
  });
}

export function validateFirebaseInput(token, expectedUidHash, nowMs) {
  requireThat(typeof token === "string" && token.length <= MAX_TOKEN && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token), "FIREBASE_INPUT_INVALID");
  let header, claims;
  try {
    const [first, second] = token.split(".");
    header = JSON.parse(Buffer.from(first, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(second, "base64url").toString("utf8"));
  } catch { throw new PilotFailure("FIREBASE_INPUT_INVALID"); }
  const now = nowMs / 1000;
  // Local parsing is only a freshness/target guard. The hosted callback verifies
  // the Firebase signature; UserInfo then independently binds the principal.
  requireThat(header.alg === "RS256" && opaque(header.kid, 256)
    && claims.aud === FIREBASE_PROJECT && claims.iss === `https://securetoken.google.com/${FIREBASE_PROJECT}`
    && opaque(claims.sub, 128) && sha256(claims.sub) === expectedUidHash && claims.email_verified === true
    && Number.isSafeInteger(claims.exp) && Number.isSafeInteger(claims.iat)
    && claims.iat <= now + 60 && claims.iat >= now - 300 && claims.exp >= now + 60
    && claims.exp > claims.iat && claims.exp - claims.iat <= 3600, "FIREBASE_IDENTITY_OR_FRESHNESS_MISMATCH");
  return claims.sub;
}

/** Atomic 0600 checkpoints; never overwrite another file or follow a symlink. */
export function privateReceiptWriter(path) {
  requireThat(isAbsolute(path), "RECEIPT_PATH_INVALID");
  const parent = dirname(path);
  requireThat(realpathSync(parent) === parent, "RECEIPT_PARENT_INVALID");
  const dir = lstatSync(parent);
  requireThat(dir.isDirectory() && (dir.mode & 0o022) === 0 && dir.uid === process.getuid(), "RECEIPT_PARENT_INVALID");
  let previous;
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    closeSync(fd); previous = lstatSync(path);
  } catch { throw new PilotFailure("RECEIPT_ALREADY_EXISTS_OR_UNSAFE"); }
  return receipt => {
    const current = lstatSync(path);
    requireThat(current.isFile() && current.nlink === 1 && (current.mode & 0o777) === 0o600
      && current.ino === previous.ino && current.dev === previous.dev, "RECEIPT_CHANGED_EXTERNALLY");
    const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path); previous = lstatSync(path);
    } finally { try { unlinkSync(temporary); } catch { /* Already renamed or not created. */ } }
  };
}

async function publicPreflight(send, expectedSha) {
  const probes = [
    ["/health", 200], ["/.well-known/oauth-authorization-server", 200],
    ["/.well-known/oauth-protected-resource", 200], ["/.well-known/oauth-protected-resource/mcp", 200],
    ["/.well-known/openid-configuration", 200], ["/mcp", 401], ["/userinfo", 401],
  ];
  const results = [];
  for (const [path, expected] of probes) {
    const response = await send(path);
    requireThat(response.status === expected, "PUBLIC_HTTP_MISMATCH"); results.push(response.data);
  }
  const [health, authorization, root, mcp, oidc] = results;
  requireThat(health?.status === "ok" && health.accessProfile === "claude" && health.releaseSha === expectedSha, "RELEASE_MISMATCH");
  requireThat(authorization?.issuer === ORIGIN && authorization.authorization_endpoint === `${ORIGIN}/authorize`
    && authorization.token_endpoint === `${ORIGIN}/token` && authorization.registration_endpoint === `${ORIGIN}/register`
    && authorization.revocation_endpoint === `${ORIGIN}/token` && sameScopes(authorization.scopes_supported)
    && isDeepStrictEqual(authorization.code_challenge_methods_supported, ["S256"]), "AUTH_METADATA_MISMATCH");
  requireThat(root?.resource === RESOURCE && mcp?.resource === RESOURCE
    && isDeepStrictEqual(root.authorization_servers, [ORIGIN]) && isDeepStrictEqual(mcp.authorization_servers, [ORIGIN])
    && sameScopes(root.scopes_supported) && sameScopes(mcp.scopes_supported), "RESOURCE_METADATA_MISMATCH");
  requireThat(oidc?.issuer === ORIGIN && oidc.userinfo_endpoint === `${ORIGIN}/userinfo`, "OIDC_METADATA_MISMATCH");
}

function readContract() {
  const bytes = readFileSync(FIXTURE);
  requireThat(sha256(bytes) === FIXTURE_SHA256, "CANDIDATE_FIXTURE_MISMATCH");
  return JSON.parse(bytes.toString("utf8"));
}

/** Injectable transport/input/clock make every safety path testable offline. */
export async function runAcceptance(options = {}, {
  send = boundedTransport(), readToken = readPrivateToken, verifyAdmission = verifyDeploymentAdmission,
  persist, clock = Date.now, entropy = size => randomBytes(size), contractLoader = readContract,
  afterProductCreated,
} = {}) {
  const runId = entropy(16).toString("hex");
  const label = options.label ?? "synthetic_qa";
  const labelValid = typeof label === "string" && /^[a-z][a-z0-9_-]{0,39}$/u.test(label);
  const receipt = {
    schemaVersion: 1, kind: "frihet-claude-single-identity-pilot", runId,
    mode: options.hosted ? "hosted" : "dry_run", label: labelValid ? label : "invalid_label",
    acceptanceMode: options.consultation ? "consultation" : "historical_product_lifecycle",
    startedAt: new Date(clock()).toISOString(), status: "dry_run",
    hostedAcceptanceVerified: false, submissionReady: false, independentBackendCleanupVerified: false,
    checks: Object.fromEntries((options.consultation ? CONSULTATION_ROWS : ROWS).map(row => [row, "not_exercised"])),
    unexercised: [...UNEXERCISED], grants: [], productLedger: [],
  };
  if (!options.hosted) { persist?.(receipt); return receipt; }
  if (typeof persist !== "function") {
    receipt.status = "fail"; receipt.failure = "HOSTED_PRIVATE_RECEIPT_REQUIRED"; return receipt;
  }
  const grants = [], credentials = new Set();
  let current = "deployment_guard", token, contract, validator, session, productOwned = false, cleanupAttempted = false;
  const remember = (...values) => { for (const value of values) if (typeof value === "string" && value) credentials.add(value); };
  const save = () => persist(receipt);
  const pass = row => { receipt.checks[row] = "pass"; save(); };
  const jsonRequest = (path, body) => send(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const formRequest = body => send("/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  const bearer = access => ({ Authorization: `Bearer ${access}` });
  const expectInvalidGrant = response => requireThat(response.status === 400 && response.data?.error === "invalid_grant"
    && !Object.hasOwn(response.data, "access_token") && !Object.hasOwn(response.data, "refresh_token"), "INVALID_GRANT_NOT_ENFORCED");
  const validateTokens = response => {
    const data = response.data;
    requireThat(response.status === 200 && opaque(data?.access_token) && opaque(data.refresh_token)
      && data.token_type?.toLowerCase() === "bearer" && sameScopes(data.scope) && data.resource === RESOURCE
      && Number.isSafeInteger(data.expires_in) && data.expires_in > 0 && data.expires_in <= 86400, "TOKEN_RESPONSE_INVALID");
    return { access: data.access_token, refresh: data.refresh_token };
  };
  async function tokenRequest(grant, body) {
    const response = await formRequest(body);
    // Even an invalid/replayed response may have issued credentials. Keep every
    // one only in memory so cleanup and reflection checks cannot miss it.
    for (const [field, issued] of [["access_token", grant.accessTokens], ["refresh_token", grant.refreshTokens]]) {
      const value = response.data?.[field];
      if (typeof value === "string" && value) { issued.add(value); remember(value); }
    }
    if (opaque(response.data?.refresh_token)) grant.cleanupRefresh = response.data.refresh_token;
    return response;
  }
  async function userinfo(grant) {
    const result = await send("/userinfo", { headers: bearer(grant.access) });
    requireThat(result.status === 200 && sha256(String(result.data?.sub)) === options.expectedUidHash
      && result.data.email_verified === true && /(?:^|,)\s*no-store(?:,|$)/iu.test(result.headers.get("cache-control") ?? ""), "USERINFO_IDENTITY_MISMATCH");
  }
  async function grantNew() {
    const redirectUri = `http://127.0.0.1:49153/frihet-qa/${runId}/callback`;
    const registered = await jsonRequest("/register", { redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: `Frihet synthetic QA ${runId}` });
    requireThat(registered.status === 201 && opaque(registered.data?.client_id, 512), "REGISTRATION_INVALID");
    const grant = { clientId: registered.data.client_id, accessTokens: new Set(), refreshTokens: new Set(), revocationAttempted: false };
    remember(grant.clientId);
    const ledger = { clientIdSha256: sha256(grant.clientId), phase: "registered", cleanup: "not_established" };
    grant.ledger = ledger; grants.push(grant); receipt.grants.push(ledger); save();
    const state = entropy(32).toString("base64url"), verifier = entropy(48).toString("base64url");
    remember(state, verifier);
    const query = new URLSearchParams({ response_type: "code", client_id: grant.clientId, redirect_uri: redirectUri,
      scope: SCOPES.join(" "), state, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256", resource: RESOURCE });
    const authorized = await send(`/authorize?${query}`);
    requireThat(authorized.status === 200, "AUTHORIZE_REJECTED");
    const match = authorized.text.match(/<script\b(?=[^>]*\bid=["']server-data["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>([^<]*)<\/script>/u);
    let server;
    try { server = JSON.parse(match?.[1] ?? ""); } catch { throw new PilotFailure("AUTHORIZE_STATE_INVALID"); }
    requireThat(opaque(server.stateKey, 512) && server.clientId === grant.clientId && server.firebaseProjectId === FIREBASE_PROJECT, "AUTHORIZE_STATE_INVALID");
    remember(server.stateKey);
    ledger.phase = "callback_pending"; save();
    const completed = await jsonRequest("/callback", { stateKey: server.stateKey, idToken: token, locale: "es" });
    requireThat(completed.status === 200 && typeof completed.data?.redirectTo === "string" && completed.data.redirectTo.length < 8192, "CALLBACK_REJECTED");
    let target;
    try { target = new URL(completed.data.redirectTo); } catch { throw new PilotFailure("CALLBACK_TARGET_INVALID"); }
    const returned = new URL(redirectUri);
    requireThat(target.origin === returned.origin && target.pathname === returned.pathname && !target.username && !target.password && !target.hash
      && target.searchParams.getAll("state").length === 1 && target.searchParams.get("state") === state
      && target.searchParams.getAll("code").length === 1 && opaque(target.searchParams.get("code"), 4096)
      && [...target.searchParams.keys()].every(key => ["code", "state"].includes(key)), "CALLBACK_TARGET_INVALID");
    remember(target.searchParams.get("code"));
    ledger.phase = "code_exchange_pending"; save();
    const redemption = { grant_type: "authorization_code", client_id: grant.clientId, code: target.searchParams.get("code"),
      redirect_uri: redirectUri, code_verifier: verifier, resource: RESOURCE };
    Object.assign(grant, validateTokens(await tokenRequest(grant, redemption))); ledger.phase = "active"; save();
    return { grant, stateKey: server.stateKey, redemption };
  }
  async function refresh(grant) {
    const old = grant.refresh;
    Object.assign(grant, validateTokens(await tokenRequest(grant, { grant_type: "refresh_token", client_id: grant.clientId, refresh_token: old, resource: RESOURCE })));
    requireThat(grant.refresh !== old, "REFRESH_DID_NOT_ROTATE"); return old;
  }
  async function revoke(grant) {
    requireThat(!grant.revocationAttempted, "REVOCATION_ALREADY_ATTEMPTED");
    // Write intent before sending: a lost response must never cause a retry.
    grant.revocationAttempted = true; grant.ledger.phase = "revocation_pending";
    grant.ledger.cleanup = "reconciliation_required"; save();
    try {
      const response = await tokenRequest(grant, { token: grant.cleanupRefresh, token_type_hint: "refresh_token", client_id: grant.clientId });
      requireThat(response.status === 200, "REVOCATION_REJECTED");
      await deadAccess(grant); await deadRefresh(grant);
      grant.ledger.phase = "revoked"; grant.ledger.cleanup = "http_revoked_backend_unverified"; save();
    } catch (error) {
      grant.ledger.phase = "reconciliation_required"; grant.ledger.cleanup = "reconciliation_required"; save();
      throw error;
    }
  }
  async function deadAccess(grant) {
    for (const access of grant.accessTokens) {
      requireThat((await send("/userinfo", { headers: bearer(access) })).status === 401, "REVOKED_ACCESS_STILL_USABLE");
      const mcp = await send("/mcp", { method: "POST", headers: { ...bearer(access), "Content-Type": "application/json",
        ...(session?.grant === grant && session.id ? { "Mcp-Session-Id": session.id, "MCP-Protocol-Version": session.protocol } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: "revoked-probe", method: "tools/list", params: {} }), rpcId: "revoked-probe" });
      requireThat(mcp.status === 401, "REVOKED_MCP_ACCESS_STILL_USABLE");
    }
  }
  async function deadRefresh(grant) {
    for (const refreshToken of grant.refreshTokens) {
      expectInvalidGrant(await tokenRequest(grant, { grant_type: "refresh_token", client_id: grant.clientId, refresh_token: refreshToken, resource: RESOURCE }));
    }
  }
  let rpcSequence = 0;
  async function rpc(method, params, notification = false) {
    const id = notification ? undefined : ++rpcSequence;
    const response = await send("/mcp", {
      method: "POST", headers: { ...bearer(session.grant.access), "Content-Type": "application/json",
        ...(session.id ? { "Mcp-Session-Id": session.id } : {}), ...(session.protocol ? { "MCP-Protocol-Version": session.protocol } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) }), rpcId: id,
    });
    if (notification) { requireThat([200, 202, 204].includes(response.status), "MCP_NOTIFICATION_REJECTED"); return; }
    requireThat(response.status === 200 && response.data?.jsonrpc === "2.0" && response.data.id === id
      && !Object.hasOwn(response.data, "error") && Object.hasOwn(response.data, "result"), "MCP_RPC_REJECTED");
    if (method === "initialize") {
      const sid = response.headers.get("mcp-session-id");
      requireThat(typeof sid === "string" && /^v1\.[A-Za-z0-9_-]{16,128}\.[a-f0-9]{64}$/u.test(sid), "MCP_SESSION_INVALID");
      requireThat(["2025-03-26", "2025-06-18", "2025-11-25"].includes(response.data.result?.protocolVersion), "MCP_PROTOCOL_INVALID");
      session.id = sid; session.protocol = response.data.result.protocolVersion;
      session.capabilities = response.data.result.capabilities;
      remember(sid);
      receipt.sessionSha256 = sha256(sid);
    }
    return response.data.result;
  }
  async function tool(name, args, allowNotFound = false) {
    const descriptor = contract.tools.grouped.find(item => item.name === name);
    requireThat(descriptor && validator.validate(descriptor.inputSchema, args), "TOOL_INPUT_INVALID");
    const result = await rpc("tools/call", { name, arguments: args });
    // Only the shared mapper's exact boolean survives the Claude privacy
    // boundary. Generic prose, structured records, competing flags and unknown
    // outcomes prove nothing; 403 never proves deletion of an owned product.
    if (allowNotFound && result?.isError === true && !Object.hasOwn(result, "structuredContent")
      && Array.isArray(result.content) && result.content.length === 1 && result.content[0]?.type === "text"
      && typeof result.content[0].text === "string") {
      const meta = result._meta;
      if (meta && typeof meta === "object" && !Array.isArray(meta) && Object.keys(meta).length === 1
        && (meta["io.frihet/resourceNotFound"] === true
          || (allowNotFound === "foreign" && meta["io.frihet/accessDenied"] === true))) return null;
    }
    requireThat(result?.isError !== true && validator.validate(descriptor.outputSchema, result?.structuredContent), "TOOL_RESULT_INVALID_OR_UNCERTAIN");
    return result.structuredContent;
  }
  function ownProduct(product, id) {
    const ledger = receipt.productLedger[0];
    return product && safeProductId(product.id) && product.name === ledger.marker && product.unitPrice === 0
      && (id === undefined || product.id === id);
  }
  function safeProductId(id) {
    return typeof id === "string" && /^[A-Za-z0-9_-]{1,256}$/u.test(id)
      && ![...credentials].some(credential => id.includes(credential));
  }
  async function cleanupProduct() {
    const ledger = receipt.productLedger[0];
    if (!productOwned || cleanupAttempted || !session) return;
    cleanupAttempted = true; ledger.phase = "cleanup_readback_pending"; save();
    requireThat(ownProduct(await tool("get_product", { id: ledger.id }), ledger.id), "CLEANUP_OWNERSHIP_NOT_PROVEN");
    ledger.phase = "delete_pending"; save();
    const result = await tool("delete_product", { id: ledger.id });
    requireThat(result.success === true && result.id === ledger.id, "DELETE_NOT_CONFIRMED");
    ledger.phase = "delete_readback_pending"; save();
    requireThat(await tool("get_product", { id: ledger.id }, true) === null, "DELETED_PRODUCT_STILL_PRESENT");
    ledger.phase = "deleted_and_not_found"; productOwned = false; pass("product_cleanup");
  }
  async function consultationReads() {
    receipt.consultation = { succeededTools: [], collections: [], excludedCalls: [],
      populatedCompleteLists: false, filtersAndPaginationWithDataVerified: false };
    const groups = await tool("list_tool_groups", {});
    requireThat(isDeepStrictEqual(stable(groups), stable(contract.groups)), "CONSULTATION_DISCOVERY_MISMATCH");
    receipt.consultation.succeededTools.push("list_tool_groups"); save();
    const search = await tool("search_tools", { limit: 10 });
    requireThat(search?.count === 6 && Array.isArray(search.tools)
      && isDeepStrictEqual(search.tools.map(item => item.name).sort(), [...CONSULTATION_LISTS])
      && search.tools.every(item => item.readOnly === true), "CONSULTATION_DISCOVERY_MISMATCH");
    receipt.consultation.succeededTools.push("search_tools"); save();
    const description = await tool("describe_tool", { name: "list_invoices" });
    requireThat(description?.name === "list_invoices" && description.readOnly === true, "CONSULTATION_DISCOVERY_MISMATCH");
    receipt.consultation.succeededTools.push("describe_tool"); save();
    // One bounded page per domain. Never label a truncated/empty result as a
    // populated complete QA list; no record contents enter the receipt.
    for (const name of CONSULTATION_LISTS) {
      const page = await tool(name, { limit: 10, offset: 0 });
      requireThat(Array.isArray(page?.data) && Number.isSafeInteger(page.total) && page.total >= 0
        && page.limit === 10 && page.offset === 0 && page.data.length <= 10 && page.total >= page.data.length
        && page.data.every(item => safeProductId(item?.id))
        && new Set(page.data.map(item => item.id)).size === page.data.length, "CONSULTATION_PAGE_INVALID");
      receipt.consultation.succeededTools.push(name);
      receipt.consultation.collections.push({ name, returned: page.data.length, total: page.total,
        populated: page.data.length > 0, complete: page.data.length === page.total && page.nextCursor === undefined });
      save();
    }
    requireThat(isDeepStrictEqual([...receipt.consultation.succeededTools].sort(), contract.tools.grouped.map(item => item.name).sort()), "CONSULTATION_TOOL_COVERAGE_INCOMPLETE");
    receipt.consultation.populatedCompleteLists = receipt.consultation.collections.every(item => item.populated && item.complete);
  }
  async function consultationDenials() {
    for (const name of CONSULTATION_DENIED) {
      const result = await rpc("tools/call", { name, arguments: {} });
      requireThat(result?.isError === true && !Object.hasOwn(result, "structuredContent")
        && Array.isArray(result.content) && result.content.length === 1 && result.content[0]?.type === "text"
        && [`MCP error -32602: Tool ${name} not found`, `Tool ${name} not found`].includes(result.content[0].text), "EXCLUDED_TOOL_NOT_PROVEN_ABSENT");
      receipt.consultation.excludedCalls.push(name); save();
    }
  }
  try {
    requireThat(labelValid, "QA_LABEL_INVALID");
    requireThat(/^[a-f0-9]{40}$/u.test(options.expectedSha ?? "") && /^[a-f0-9]{64}$/u.test(options.expectedUidHash ?? ""), "EXPECTED_BINDING_REQUIRED");
    requireThat((options.foreignProductId === undefined && options.foreignMarker === undefined)
      || (typeof options.foreignProductId === "string" && /^[A-Za-z0-9_-]{1,256}$/u.test(options.foreignProductId)
        && /^FRIHET-QA-[a-f0-9]{32}$/u.test(options.foreignMarker ?? "")), "FOREIGN_SYNTHETIC_BINDING_REQUIRED");
    requireThat(!options.consultation || (options.foreignProductId === undefined && !afterProductCreated), "CONSULTATION_CANNOT_RUN_PRODUCT_LIFECYCLE");
    receipt.releaseSha = options.expectedSha; receipt.uidSha256 = options.expectedUidHash; receipt.status = "running"; save();
    await verifyAdmission(); pass(current);
    current = "public_release"; await publicPreflight(send, options.expectedSha); pass(current);
    current = "mcp_catalogs"; contract = contractLoader(); validator = new Ajv({ strict: false, validateFormats: false });
    if (options.consultation) {
      try { assertClaudeConsultationSurface(contract, JSON.parse(readFileSync(SERVED_FIXTURE, "utf8"))); }
      catch { throw new PilotFailure("CONSULTATION_CONTRACT_REQUIRED"); }
    } else requireThat(["create_product", "get_product", "update_product", "delete_product"].every(name => contract.tools.grouped.some(item => item.name === name)), "LEGACY_PRODUCT_PILOT_UNAVAILABLE_FOR_CURRENT_CATALOG");
    current = "firebase_input"; token = await readToken(options.tokenFd ?? 0);
    const uid = validateFirebaseInput(token, options.expectedUidHash, clock()); remember(token, uid); pass(current);
    current = "oauth"; const primary = await grantNew(); pass(current);
    current = "userinfo"; await userinfo(primary.grant); pass(current);
    current = "callback_replay";
    requireThat((await jsonRequest("/callback", { stateKey: primary.stateKey, idToken: token, locale: "es" })).status === 400, "CALLBACK_REPLAY_ACCEPTED"); pass(current);
    current = "refresh"; await refresh(primary.grant); await userinfo(primary.grant); pass(current);
    current = "mcp_catalogs"; session = { grant: primary.grant };
    await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "frihet-synthetic-qa", version: "1.0.0" } });
    await rpc("notifications/initialized", undefined, true);
    if (options.consultation) requireThat(session.capabilities && typeof session.capabilities === "object"
      && session.capabilities.prompts === undefined, "CONSULTATION_PROMPT_CAPABILITY_MISMATCH");
    const tools = await rpc("tools/list", {}), resources = await rpc("resources/list", {});
    // Zero prompt registrations mean no prompts capability in the real SDK.
    // Do not swallow -32601 or other errors from an advertised capability.
    const prompts = options.consultation ? { prompts: [] } : await rpc("prompts/list", {});
    const ordered = (values, key) => [...values].sort((a, b) => a[key].localeCompare(b[key]));
    requireThat(Array.isArray(tools.tools) && Array.isArray(resources.resources) && Array.isArray(prompts.prompts)
      && tools.nextCursor === undefined && resources.nextCursor === undefined && prompts.nextCursor === undefined
      && isDeepStrictEqual(stable(ordered(tools.tools, "name")), stable(ordered(contract.tools.grouped, "name")))
      && isDeepStrictEqual(stable(ordered(resources.resources, "uri")), stable(ordered(contract.resources.remote, "uri")))
      && isDeepStrictEqual(stable(ordered(prompts.prompts, "name")), stable(ordered(contract.prompts, "name"))), "MCP_CATALOG_MISMATCH");
    receipt.catalog = { tools: tools.tools.length, resources: resources.resources.length, prompts: prompts.prompts.length,
      sha256: sha256(JSON.stringify(stable({ tools: ordered(tools.tools, "name"), resources: ordered(resources.resources, "uri"), prompts: ordered(prompts.prompts, "name") }))) }; pass(current);
    current = "static_resource";
    requireThat(isDeepStrictEqual(stable(await rpc("resources/read", { uri: "frihet://config/currencies" })), stable(contract.currencies)), "STATIC_RESOURCE_MISMATCH");
    for (const { name, result } of contract.promptContent) requireThat(isDeepStrictEqual(stable(await rpc("prompts/get", { name })), stable(result)), "PROMPT_CONTENT_MISMATCH");
    pass(current);
    if (options.consultation) {
      current = "consultation_reads"; await consultationReads(); pass(current);
      current = "consultation_denials"; await consultationDenials(); pass(current);
    } else {
      if (options.foreignProductId !== undefined) {
        current = "foreign_product_exact_id_denied";
        requireThat(await tool("get_product", { id: options.foreignProductId }, "foreign") === null, "FOREIGN_PRODUCT_ACCESSIBLE_OR_DENIAL_UNPROVEN");
        receipt.foreignProduct = { idSha256: sha256(options.foreignProductId), markerSha256: sha256(options.foreignMarker) }; pass(current);
      }
      current = "product_crud";
      const ledger = { marker: `FRIHET-QA-${runId}`, id: null, phase: "create_pending" }; receipt.productLedger.push(ledger); save();
      const product = await tool("create_product", { name: ledger.marker, unitPrice: 0, description: `Synthetic Claude acceptance ${runId}; remove after test` });
      requireThat(safeProductId(product.id), "PRODUCT_ID_INVALID_OR_REFLECTED");
      ledger.unverifiedReturnedIdSha256 = sha256(product.id); save();
      requireThat(ownProduct(product), "CREATED_PRODUCT_IDENTITY_MISMATCH");
      requireThat(ownProduct(await tool("get_product", { id: product.id }), product.id), "PRODUCT_READBACK_MISMATCH");
      ledger.id = product.id; delete ledger.unverifiedReturnedIdSha256; ledger.phase = "created"; productOwned = true; save();
      if (afterProductCreated) {
        ledger.phase = "awaiting_owner_counterpart"; save();
        // Only synthetic identifiers cross the hook; all credentials stay here.
        await afterProductCreated(Object.freeze({ id: ledger.id, marker: ledger.marker }));
        ledger.phase = "counterpart_hook_returned"; save();
      }
      const description = `Synthetic Claude acceptance ${runId} updated`;
      const updated = await tool("update_product", { id: ledger.id, description });
      requireThat(ownProduct(updated, ledger.id) && updated.description === description, "PRODUCT_UPDATE_MISMATCH");
      const readback = await tool("get_product", { id: ledger.id });
      requireThat(ownProduct(readback, ledger.id) && readback.description === description, "PRODUCT_UPDATE_READBACK_MISMATCH"); pass(current);
      current = "product_cleanup"; await cleanupProduct();
    }
    current = "revoke"; await revoke(primary.grant); pass(current);
    // A spent-code replay revokes its family; isolate it from business probes.
    current = "code_replay"; const codeReplay = await grantNew(); await userinfo(codeReplay.grant);
    expectInvalidGrant(await tokenRequest(codeReplay.grant, codeReplay.redemption));
    await deadAccess(codeReplay.grant); await deadRefresh(codeReplay.grant);
    codeReplay.grant.ledger.phase = "replay_invalidated"; codeReplay.grant.ledger.cleanup = "http_invalidated_backend_unverified"; pass(current);
    current = "reconnect"; const negative = await grantNew(); await userinfo(negative.grant); pass(current);
    current = "refresh_replay"; const oldRefresh = await refresh(negative.grant); await userinfo(negative.grant);
    expectInvalidGrant(await tokenRequest(negative.grant, { grant_type: "refresh_token", client_id: negative.grant.clientId, refresh_token: oldRefresh, resource: RESOURCE }));
    await deadAccess(negative.grant); await deadRefresh(negative.grant);
    negative.grant.ledger.phase = "replay_invalidated"; negative.grant.ledger.cleanup = "http_invalidated_backend_unverified"; pass(current);
    if (options.consultation) {
      current = "consultation_population";
      requireThat(receipt.consultation.populatedCompleteLists, "CONSULTATION_DATA_EMPTY_OR_INCOMPLETE"); pass(current);
    }
    receipt.status = options.consultation ? "consultation_protocol_pass" : "single_identity_protocol_pass";
  } catch (error) {
    receipt.status = error instanceof PilotFailure && ["TIMEOUT", "NETWORK_UNAVAILABLE"].includes(error.code) ? "inconclusive" : "fail";
    receipt.failure = error instanceof PilotFailure ? error.code : "UNEXPECTED_FAILURE";
    receipt.failedAt = current; receipt.checks[current] = "fail";
  } finally {
    try { await cleanupProduct(); }
    catch (error) { receipt.status = "fail"; receipt.cleanupFailure = error instanceof PilotFailure ? error.code : "CLEANUP_FAILED"; }
    for (const grant of grants) {
      if (!grant.cleanupRefresh || grant.revocationAttempted || ["revoked", "replay_invalidated"].includes(grant.ledger.phase)) continue;
      try { await revoke(grant); }
      catch { receipt.status = "fail"; grant.ledger.cleanup = "reconciliation_required"; }
    }
    for (const grant of grants) {
      grant.accessTokens.clear(); grant.refreshTokens.clear();
      grant.access = undefined; grant.refresh = undefined; grant.cleanupRefresh = undefined;
    }
    credentials.clear();
    token = undefined;
    receipt.finishedAt = new Date(clock()).toISOString();
    save();
  }
  return receipt;
}

export function parseArguments(args) {
  const options = {};
  const names = { "--expected-sha": "expectedSha", "--expected-uid-sha256": "expectedUidHash", "--label": "label", "--token-fd": "tokenFd", "--firebase-token-fd": "tokenFd", "--output": "output", "--foreign-product-id": "foreignProductId", "--foreign-marker": "foreignMarker" };
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === "--hosted" || argument === "--dry-run") {
      requireThat(options.hosted === undefined, "DUPLICATE_MODE"); options.hosted = argument === "--hosted";
    } else if (argument === "--consultation") {
      requireThat(options.consultation === undefined, "DUPLICATE_ACCEPTANCE_MODE"); options.consultation = true;
    } else {
      const name = Object.hasOwn(names, argument) ? names[argument] : undefined;
      requireThat(name && options[name] === undefined && typeof args[i + 1] === "string" && !args[i + 1].startsWith("--"), "ARGUMENT_INVALID");
      options[name] = args[++i];
    }
  }
  if (options.tokenFd !== undefined) {
    requireThat(/^\d+$/u.test(options.tokenFd) && Number.isSafeInteger(Number(options.tokenFd)), "TOKEN_FD_INVALID"); options.tokenFd = Number(options.tokenFd);
  }
  requireThat(!options.hosted || options.output, "HOSTED_PRIVATE_RECEIPT_REQUIRED");
  return options;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const persist = options.output ? privateReceiptWriter(options.output) : () => {};
    const result = await runAcceptance(options, { persist });
    process.stdout.write(`${JSON.stringify({ status: result.status, hostedAcceptanceVerified: false, submissionReady: false, privateReceiptWritten: Boolean(options.output) })}\n`);
    process.exitCode = ["dry_run", "single_identity_protocol_pass", "consultation_protocol_pass"].includes(result.status) ? 0 : result.status === "inconclusive" ? 2 : 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "fail", failure: error instanceof PilotFailure ? error.code : "PILOT_SETUP_FAILED" })}\n`); process.exitCode = 1;
  }
}
