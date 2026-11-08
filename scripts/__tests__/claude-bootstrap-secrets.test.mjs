import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkClaudeBootstrapSecrets } from "../check-claude-bootstrap-secrets.mjs";

const old = Buffer.from("synthetic-openai-service-value-0000000000");
const next = Buffer.from("synthetic-claude-service-value-1111111111");

test("bootstrap compares actual bytes without needing an OpenAI binding in Claude", () => {
  assert.deepEqual(checkClaudeBootstrapSecrets(old, next, Buffer.from(next)), {
    distinctFromOpenAI: true, claudeFunctionMatchesWorker: true,
  });
  assert.throws(() => checkClaudeBootstrapSecrets(old, old, old), /SECRET_REUSE/u);
  assert.throws(() => checkClaudeBootstrapSecrets(old, next, Buffer.from(`${next}x`)), /SECRET_MISMATCH/u);
  for (const invalid of [Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(4097, 65),
    Buffer.from(`${next}\n`), Buffer.from(`${next}\r`), Buffer.from(`${next}\0`),
    Buffer.concat([Buffer.from(next), Buffer.from([0xff])])]) {
    for (const index of [0, 1, 2]) {
      const inputs = [old, next, next]; inputs[index] = invalid;
      assert.throws(() => checkClaudeBootstrapSecrets(...inputs), /INVALID_SECRET_BYTES/u);
    }
  }
});

test("CLI uses inherited descriptors and emits neither credentials nor their hashes", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-bootstrap-test-"));
  const command = fileURLToPath(new URL("../check-claude-bootstrap-secrets.mjs", import.meta.url));
  function run(values) {
    const fds = values.map((value, i) => {
      const path = join(dir, `${i}.fixture`);
      writeFileSync(path, value, { mode: 0o600 });
      return openSync(path, "r");
    });
    try {
      return spawnSync(process.execPath, [command, "--openai-fd", "3", "--claude-function-fd", "4", "--claude-worker-fd", "5"], {
        stdio: ["ignore", "pipe", "pipe", ...fds], encoding: "utf8",
      });
    } finally { fds.forEach(closeSync); }
  }
  try {
    const passed = run([old, next, next]);
    assert.equal(passed.status, 0);
    assert.deepEqual(JSON.parse(passed.stdout), { check: "claude-bootstrap-secret-separation",
      distinctFromOpenAI: true, claudeFunctionMatchesWorker: true, deployedBindingsVerified: false });
    assert.equal(passed.stderr, "");
    for (const values of [[old, old, old], [old, next, old], [old, Buffer.from(`${next}\n`), next]]) {
      const failed = run(values);
      assert.equal(failed.status, 1);
      assert.equal(failed.stdout, "");
      assert.match(failed.stderr, /^Claude bootstrap secret check failed;/u);
      for (const value of [old, next]) assert.ok(!`${failed.stdout}${failed.stderr}`.includes(value.toString()));
    }
    const missing = spawnSync(process.execPath, [command], { encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
