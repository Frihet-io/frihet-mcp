/**
 * Dual source of truth and fail-closed npm byte verification.
 * A synthetic registry/USTAR archive makes subprocess tests independent of
 * network, local git tags, and future releases. No real repository is rewritten.
 */
import assert from 'node:assert/strict';
import { inspectPublishedArtifact } from '../audit-mcp-refs.mjs';
import { publishedFixture } from './helpers/published-artifact-fixture.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'audit-mcp-refs.mjs');
const PRELOAD = join(HERE, 'helpers/published-fetch-preload.mjs');
const REPO = join(HERE, '..', '..');

/** Synthetic registry fixture; values are not publication evidence. */
const PUBLISHED = '1.17.0';
const PUBLISHED_TOOLS = 157;

const headVersion = () =>
  JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;

function fixture(lines) {
  const root = mkdtempSync(join(tmpdir(), 'mcp-sot-'));
  mkdirSync(join(root, 'apps/erp/public'), { recursive: true });
  writeFileSync(join(root, 'apps/erp/public/llms.txt'), `${lines.join('\n')}\n`);
  return root;
}

const read = (root) => readFileSync(join(root, 'apps/erp/public/llms.txt'), 'utf8');

function audit(root, extra = [], version = PUBLISHED) {
  return spawnSync(
    process.execPath,
    ['--import', PRELOAD, SCRIPT, '--repo', 'Frihet-ERP', '--root', `Frihet-ERP=${root}`, ...extra],
    { encoding: 'utf8', env: { ...process.env, FRIHET_MCP_PUBLISHED_VERSION: version } },
  );
}

describe('published source of truth for sister repos', () => {
  test('the published release is not the HEAD release — otherwise this suite proves nothing', () => {
    assert.notEqual(
      headVersion(),
      PUBLISHED,
      'HEAD matches the published version; re-pin this test against a real divergence'
    );
  });

  test('reports both sources and names where each came from', () => {
    const root = fixture(['- **MCP catalogue:** 999 source-verified tools for @frihet/mcp-server v9.9.9']);
    const run = audit(root);
    assert.match(run.stdout, /SoT \(frihet-mcp, HEAD\): @frihet\/mcp-server@/);
    assert.match(
      run.stdout,
      new RegExp(`SoT \\(sister repos, published\\): @frihet/mcp-server@${PUBLISHED} · ${PUBLISHED_TOOLS} canonical registrations`)
    );
    assert.match(run.stdout, /published version resolved from: FRIHET_MCP_PUBLISHED_VERSION=1\.17\.0/);
    assert.match(run.stdout, /canonical names read from npm dist\/tools\/\*\.js; integrity: sha512-/);
  });

  test('a sister repo is judged against the PUBLISHED version, never HEAD', () => {
    const root = fixture(['Install @frihet/mcp-server v1.16.6 today']);
    const run = audit(root);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /\[version\] found=1\.16\.6 expected=1\.17\.0/);
    assert.doesNotMatch(
      run.stdout,
      new RegExp(`expected=${headVersion().replace(/\./g, '\\.')}`),
      'the sister repo was judged against HEAD — this is the bug this file exists to stop'
    );
  });

  test('--fix writes the published version, not the unpublished HEAD one', () => {
    const root = fixture(['Install @frihet/mcp-server v1.16.6 today']);
    assert.equal(audit(root, ['--fix']).status, 0);
    assert.match(read(root), /v1\.17\.0/);
    assert.doesNotMatch(read(root), new RegExp(headVersion().replace(/\./g, '\\.')));
  });

  test('a count that is already right for the published artifact is left alone', () => {
    // 157 is stale against HEAD (158) and correct against v1.17.0. Under the
    // old single source of truth this line was rewritten; it must not be.
    const line = '- **MCP catalogue:** 157 source-verified tools via @frihet/mcp-server';
    const root = fixture([line]);
    const run = audit(root, ['--fix']);
    assert.equal(run.status, 0);
    assert.equal(read(root).trim(), line);
  });
});

describe('INCONCLUSIVE beats a guess', () => {
  test('an unpublished npm version exits 4 and fixes nothing', () => {
    const line = 'Install @frihet/mcp-server v1.16.6 today';
    const root = fixture([line]);
    const run = audit(root, ['--fix'], '9.9.9');
    assert.equal(run.status, 4);
    assert.match(run.stderr, /INCONCLUSIVE/);
    assert.match(run.stderr, /npm registry answered HTTP 404/);
    assert.equal(read(root).trim(), line, 'INCONCLUSIVE must never write');
  });

  test('a non-semver pin is refused rather than shelled out', () => {
    const root = fixture(['Install @frihet/mcp-server v1.16.6 today']);
    const run = audit(root, [], '1.17.0; rm -rf /tmp/nope');
    assert.equal(run.status, 4);
    assert.match(run.stderr, /is not plain semver/);
  });

  test('the self-check stays offline: --repo frihet-mcp needs no published truth', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--repo', 'frihet-mcp'], {
      encoding: 'utf8',
      env: { ...process.env, FRIHET_MCP_PUBLISHED_VERSION: '' },
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.doesNotMatch(run.stdout, /sister repos, published/);
  });
});

describe('--fix is line-scoped', () => {
  test('a whitelisted line the detector skipped is not rewritten', () => {
    // The detector excludes the parenthesised category form. The old rewriter
    // keyed on the number alone and rewrote it anyway.
    const lines = [
      'MCP server catalogue: 999 tools',
      '- Banking (5 tools) — MCP server',
    ];
    const root = fixture(lines);
    assert.equal(audit(root, ['--fix']).status, 0);
    const after = read(root).split('\n');
    assert.equal(after[0], `MCP server catalogue: ${PUBLISHED_TOOLS} tools`);
    assert.equal(after[1], '- Banking (5 tools) — MCP server', 'whitelisted line was rewritten');
  });

  test('an unrelated occurrence of the same number on another line survives', () => {
    const lines = [
      'MCP server catalogue: 999 tools',
      'Este MCP server tardó 999 segundos en arrancar',
    ];
    const root = fixture(lines);
    assert.equal(audit(root, ['--fix']).status, 0);
    const after = read(root).split('\n');
    assert.equal(after[0], `MCP server catalogue: ${PUBLISHED_TOOLS} tools`);
    assert.equal(after[1], 'Este MCP server tardó 999 segundos en arrancar');
  });
});


describe('npm byte integrity and static registration parsing', () => {
  test('comments and strings do not inflate the canonical count', () => {
    const { metadata, tarball } = publishedFixture({ source: `
      // server.registerTool("fake_comment", {}, () => {});
      const text = 'server.registerTool("fake_string")';
      server.registerTool("real", {}, () => {});
    ` });
    assert.deepEqual(inspectPublishedArtifact(metadata, tarball).toolNames, ['real']);
  });
  test('tarball corruption, identity mismatches and missing integrity fail closed', () => {
    const { metadata, tarball } = publishedFixture();
    const corrupted = Buffer.from(tarball); corrupted[10] ^= 1;
    assert.throws(() => inspectPublishedArtifact(metadata, corrupted), /integrity mismatch/);
    assert.throws(() => inspectPublishedArtifact({ ...metadata, version: '1.17.1' }, tarball), /identity differs/);
    assert.throws(() => inspectPublishedArtifact({ ...metadata, dist: {} }, tarball), /sha512/);
    assert.throws(() => inspectPublishedArtifact(metadata, tarball, '1.17.1'), /different version/);
  });
  test('archive traversal and duplicate entries cannot be accepted', () => {
    for (const path of ['package/../outside.js', 'package/package.json']) {
      const { metadata, tarball } = publishedFixture({ extra: [[path, 'ignored']] });
      assert.throws(() => inspectPublishedArtifact(metadata, tarball), /unsafe path|duplicate entry/);
    }
  });
  test('dynamic names, duplicate names, empty catalogs and invalid JS fail closed', () => {
    for (const source of ['server.registerTool(variable, {});', 'server.registerTool("same", {}); server.registerTool("same", {});', '', 'const = ;']) {
      const { metadata, tarball } = publishedFixture({ source });
      assert.throws(() => inspectPublishedArtifact(metadata, tarball), /dynamic or duplicated|no static|unparseable/);
    }
  });
});
