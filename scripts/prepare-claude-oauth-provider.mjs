import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LOCKED_OAUTH_PROVIDER_VERSION = "0.3.0";
export const LOCKED_OAUTH_PROVIDER_SHA256 = "54384c198541571c7fac691afad31f51f9914debbca9571fa4dcde3af9f1133c";
const LOOPBACK_START = "function isLoopbackUri(uri) {\n\ttry {\n\t\tconst host = new URL(uri).hostname;\n";

/** Claude Code uses localhost with an ephemeral port; keep every other SDK check unchanged. */
export function patchClaudeOAuthProvider(source, sdkVersion) {
  if (sdkVersion !== LOCKED_OAUTH_PROVIDER_VERSION) {
    throw new Error("Claude OAuth provider requires the audited SDK version 0.3.0");
  }
  if (typeof source !== "string" || createHash("sha256").update(source).digest("hex") !== LOCKED_OAUTH_PROVIDER_SHA256) {
    throw new Error("Claude OAuth provider source differs from the audited SDK SHA256");
  }
  if (source.split(LOOPBACK_START).length !== 2) {
    throw new Error("Claude OAuth provider loopback patch target is not unique");
  }
  return source.replace(LOOPBACK_START, `${LOOPBACK_START}\t\tif (host === "localhost") return true;\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const workerDir = new URL("../workers/remote-mcp/", import.meta.url);
  const sdkDir = new URL("node_modules/@cloudflare/workers-oauth-provider/", workerDir);
  const sdkVersion = JSON.parse(readFileSync(new URL("package.json", sdkDir), "utf8")).version;
  const lockedVersion = JSON.parse(readFileSync(new URL("package-lock.json", workerDir), "utf8"))
    .packages["node_modules/@cloudflare/workers-oauth-provider"].version;
  if (lockedVersion !== sdkVersion) throw new Error("Claude OAuth provider installation differs from the lockfile");
  const source = readFileSync(new URL("dist/oauth-provider.js", sdkDir), "utf8");
  const patched = patchClaudeOAuthProvider(source, sdkVersion);
  const output = fileURLToPath(new URL(".wrangler/claude-oauth-provider.js", workerDir));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, patched);
  process.stdout.write(`${JSON.stringify({
    output,
    sdkVersion,
    sourceSha256: LOCKED_OAUTH_PROVIDER_SHA256,
    patchedSha256: createHash("sha256").update(patched).digest("hex"),
  })}\n`);
}
