#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { readSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MAX_SECRET_BYTES = 4096;
const digest = (value) => createHash("sha256").update(value).digest();

/** Check the actual bootstrap bytes, not environment names or caller-provided hashes.
 * This is a local preflight only: it neither grants release authority nor proves
 * which secret versions are bound to deployed services. Never log its inputs.
 */
export function checkClaudeBootstrapSecrets(openai, claudeFunction, claudeWorker) {
  for (const value of [openai, claudeFunction, claudeWorker]) {
    if (!Buffer.isBuffer(value) || value.length < 32 || value.length > MAX_SECRET_BYTES
      || !Buffer.from(value.toString("utf8"), "utf8").equals(value)
      || /[\r\n\0]/u.test(value.toString("utf8"))) {
      throw new Error("INVALID_SECRET_BYTES");
    }
  }
  if (!timingSafeEqual(digest(claudeFunction), digest(claudeWorker))) {
    throw new Error("CLAUDE_RUNTIME_SECRET_MISMATCH");
  }
  if (timingSafeEqual(digest(openai), digest(claudeFunction))) {
    throw new Error("CLAUDE_OPENAI_SECRET_REUSE");
  }
  return { distinctFromOpenAI: true, claudeFunctionMatchesWorker: true };
}

function readSecret(fd) {
  const value = Buffer.alloc(MAX_SECRET_BYTES + 1);
  let size = 0;
  while (size < value.length) {
    const read = readSync(fd, value, size, value.length - size, null);
    if (read === 0) break;
    size += read;
  }
  return value.subarray(0, size);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const buffers = [];
  try {
    // Secret values never belong in CLI arguments, environment variables or logs.
    const args = process.argv.slice(2);
    const names = ["--openai-fd", "--claude-function-fd", "--claude-worker-fd"];
    if (args.length !== 6 || names.some((name, i) => args[i * 2] !== name)
      || [args[1], args[3], args[5]].some((fd) => !/^[0-9]+$/u.test(fd))) {
      throw new Error("INVALID_FD_ARGUMENTS");
    }
    const fds = [args[1], args[3], args[5]].map(Number);
    if (fds.some((fd) => !Number.isSafeInteger(fd) || fd < 3) || new Set(fds).size !== 3) {
      throw new Error("INVALID_FD_ARGUMENTS");
    }
    for (const fd of fds) buffers.push(readSecret(fd));
    const result = checkClaudeBootstrapSecrets(...buffers);
    process.stdout.write(`${JSON.stringify({ check: "claude-bootstrap-secret-separation", ...result, deployedBindingsVerified: false })}\n`);
  } catch {
    // Includes malformed inputs and system read errors; never print input/error objects.
    process.stderr.write("Claude bootstrap secret check failed; verify separate credentials and exact Claude runtime bytes.\n");
    process.exitCode = 1;
  } finally {
    for (const buffer of buffers) buffer.fill(0);
  }
}
