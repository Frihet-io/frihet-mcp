/**
 * Hand-written tool/operation counts in live public surfaces must equal a
 * number derived from the generated public capability contract. Lines about
 * other, separately frozen profiles (OpenAI, Claude, Muse, ...) are exempt.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const contract = JSON.parse(read('src/__tests__/fixtures/public-capability-contract.json'));

const allowed = new Set([
  contract.catalogue.canonicalOperations,
  contract.surfaces.localFull.tools.length,
  contract.surfaces.remoteGrouped.tools.length,
]);

const SURFACES = [
  'README.md',
  'glama.json',
  'REGISTRY-SUBMISSION-CHECKLIST.md',
  '.antigravity-plugin/README.md',
  '.cursor-plugin/marketplace.json',
  'marketplace/README.md',
  'marketplace/llms-install.md',
  'marketplace/antigravity/README.md',
  'marketplace/awesome-mcp-servers-PR.md',
  'marketplace/cursor/SUBMISSION.md',
  'marketplace/muse/README.md',
  'marketplace/anthropic/connector/manifest.json',
  'docs/tool-exposure-modes.md',
  'docs/tool-availability-metadata-design-note.md',
];
const COUNT = /(?<![\w.])(\d{2,3})[\s-]+(?:canonical\s+)?(?:catalogue\s+)?(?:business\s+)?(tools?(?:\s+names)?|operations?|ops)\b/gi;
const OTHER_PROFILE = /OpenAI|Claude|Anthropic|Muse|Vercel|Genkit|Google|ChatGPT|curated/i;

test('every hand-written tool count equals a contract-derived number', () => {
  const bad = [];
  for (const file of SURFACES) {
    read(file).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(COUNT)) {
        const near = line.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80);
        if (OTHER_PROFILE.test(near)) continue; // a different, separately frozen profile
        if (!allowed.has(Number(m[1]))) bad.push(`${file}:${i + 1} "${m[0]}"`);
      }
    });
  }
  assert.deepEqual(bad, [], `counts outside {${[...allowed]}} (public-capability-contract.json)`);
});
