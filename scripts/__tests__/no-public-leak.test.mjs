import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scanner = fileURLToPath(new URL('../no-public-leak.sh', import.meta.url));

function scanTrackedFile(content) {
  const directory = mkdtempSync(path.join(tmpdir(), 'frihet-secret-tripwire-'));
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    writeFileSync(path.join(directory, 'credential.txt'), content);
    execFileSync('git', ['-C', directory, 'add', 'credential.txt']);
    return spawnSync('bash', [scanner], { cwd: directory, encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [name, secret] of [
  ['classic PAT', ['ghp', '_', 'A'.repeat(36)].join('')],
  ['fine-grained PAT', ['github', '_pat_', 'B'.repeat(82)].join('')],
  ['private key', ['BEGIN', 'OPENSSH', 'PRIVATE', 'KEY'].join(' ')],
]) {
  test(`credential tripwire rejects ${name} without printing its value`, () => {
    const result = scanTrackedFile(`credential=${secret}\n`);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1);
    assert.match(output, /credential\.txt/);
    assert.match(output, /High-entropy secret or private key pattern/);
    assert.equal(output.includes(secret), false, 'detected credential must stay out of logs');
    assert.equal(output.includes('credential='), false, 'matching line must stay out of logs');
  });
}

test('credential tripwire accepts a clean tracked file', () => {
  const result = scanTrackedFile('public documentation\n');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no-public-leak: clean/);
});
