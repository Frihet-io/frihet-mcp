/**
 * Dual source of truth and fail-closed npm byte verification.
 * A synthetic registry/USTAR archive makes subprocess tests independent of
 * network, local git tags, and future releases. No real repository is rewritten.
 */
import assert from 'node:assert/strict';
import { inspectPublishedArtifact, fetchPublishedArtifact, readNpmTarball } from '../audit-mcp-refs.mjs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { publishedFixture } from './helpers/published-artifact-fixture.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
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
  test('an aliased CLI entrypoint still runs the offline self-audit', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-cli-alias-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const alias = join(root, 'audit.mjs');
    symlinkSync(SCRIPT, alias);
    const run = spawnSync(process.execPath, [alias, '--repo', 'frihet-mcp'], {
      encoding: 'utf8',
      env: { ...process.env, FRIHET_MCP_PUBLISHED_VERSION: '' },
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /SoT \(frihet-mcp, HEAD\):/);
    assert.match(run.stdout, /OK — all refs match SoT/);
  });

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

describe('unsupported published registration layouts fail closed', () => {
  test('a registration outside canonical modules cannot yield a partial count', () => {
    for (const path of ['package/dist/tools/sub/banking.js', 'package/dist/server-composition.js', 'package/dist/tools/new.mjs', 'package/dist/tools/new.cjs', 'package/dist/tools/register-all.js']) {
      const { metadata, tarball } = publishedFixture({ extra: [[path, 'server.registerTool("hidden", {}, () => {});']] });
      assert.throws(() => inspectPublishedArtifact(metadata, tarball), /unsupported published registerTool/);
    }
  });
  test('computed, destructured and call-style registrations cannot be ignored', () => {
    for (const registration of [
      'server["registerTool"]("hidden", {});',
      'server[`registerTool`]("hidden", {});',
      'const { registerTool } = server; registerTool("hidden", {});',
      'const { "registerTool": alias } = server; alias("hidden", {});',
      'server.registerTool.call(server, "hidden", {});',
      'server?.registerTool("hidden", {});',
    ]) {
      const { metadata, tarball } = publishedFixture({ source: `server.registerTool("visible", {}); ${registration}` });
      assert.throws(() => inspectPublishedArtifact(metadata, tarball), /unsupported published registerTool/);
    }
  });
  test('known interception shapes are allowed only in the existing adapters', () => {
    const source = 'const bound = server.registerTool.bind(server); server.registerTool = (name, config, handler) => bound(name, config, handler);';
    const valid = publishedFixture({ extra: [['package/dist/capability-truth.js', source]] });
    assert.equal(inspectPublishedArtifact(valid.metadata, valid.tarball).toolCount, 157);
    const relocated = publishedFixture({ extra: [['package/dist/new-adapter.js', source]] });
    assert.throws(() => inspectPublishedArtifact(relocated.metadata, relocated.tarball), /unsupported published registerTool/);
  });
});

describe('registry transport and archive limits', () => {
  test('both requests refuse redirects and carry a timeout signal', async () => {
    const { metadata, tarball } = publishedFixture();
    const urls = [];
    const result = await fetchPublishedArtifact(undefined, { fetchImpl: async (url, options) => {
      urls.push(String(url));
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      return new Response(urls.length === 1 ? JSON.stringify(metadata) : tarball);
    } });
    assert.equal(result.toolCount, 157);
    assert.deepEqual(urls, ['https://registry.npmjs.org/@frihet%2fmcp-server/latest', metadata.dist.tarball]);
  });
  test('a foreign host, package, credential, port, query or fragment is refused before downloading', async () => {
    const fixture = publishedFixture();
    for (const url of [
      'https://example.com/@frihet/mcp-server/-/mcp-server-1.17.0.tgz',
      'https://registry.npmjs.org/another/-/mcp-server-1.17.0.tgz',
      'https://user@registry.npmjs.org/@frihet/mcp-server/-/mcp-server-1.17.0.tgz',
      'https://registry.npmjs.org:444/@frihet/mcp-server/-/mcp-server-1.17.0.tgz',
      `${fixture.metadata.dist.tarball}?secret=1`, `${fixture.metadata.dist.tarball}#fragment`,
    ]) {
      let calls = 0;
      await assert.rejects(fetchPublishedArtifact(undefined, { fetchImpl: async () => {
        calls += 1;
        const metadata = { ...fixture.metadata, dist: { ...fixture.metadata.dist, tarball: url } };
        return new Response(calls === 1 ? JSON.stringify(metadata) : fixture.tarball);
      } }), /outside the expected package/);
      assert.equal(calls, 1);
    }
  });
  test('redirect, HTTP error and body-read failure cannot establish publication', async () => {
    for (const status of [302, 404, 500]) {
      await assert.rejects(fetchPublishedArtifact(undefined, { fetchImpl: async () => new Response('', { status }) }), new RegExp(`HTTP ${status}`));
    }
    await assert.rejects(fetchPublishedArtifact(undefined, { fetchImpl: async () => ({
      ok: true, body: (async function* () { throw new Error('body transfer failed'); })(),
    }) }), /body transfer failed/);
  });
  test('metadata and compressed response byte ceilings are enforced while reading', async () => {
    const { metadata } = publishedFixture();
    for (const metadataOversize of [true, false]) {
      let calls = 0;
      await assert.rejects(fetchPublishedArtifact(undefined, { fetchImpl: async () => {
        calls += 1;
        if (!metadataOversize && calls === 1) return new Response(JSON.stringify(metadata));
        const size = (metadataOversize ? 2 : 8) * 1024 * 1024 + 1;
        return { ok: true, body: (async function* () { yield Buffer.alloc(size); })() };
      } }), /bounded size limit/);
    }
  });
  test('symlinks, PAX entries and excessive decompression are refused', () => {
    for (const type of [50, 120]) {
      const { metadata, tarball } = publishedFixture({ extra: [['package/link', 'target', type]] });
      assert.throws(() => inspectPublishedArtifact(metadata, tarball), /unsupported or duplicate entry/);
    }
    const tarball = gzipSync(Buffer.alloc(48 * 1024 * 1024 + 1));
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    assert.throws(() => readNpmTarball(tarball, integrity), /maxOutputLength|larger than|Cannot create a Buffer/);
    assert.throws(() => readNpmTarball(Buffer.alloc(8 * 1024 * 1024 + 1), integrity), /tarball exceeds size limit/);
  });
  test('invalid archive headers and missing terminators are refused', () => {
    const { tarball } = publishedFixture();
    const original = gunzipSync(tarball);
    const compressed = (bytes) => {
      const tar = gzipSync(bytes);
      return [tar, `sha512-${createHash('sha512').update(tar).digest('base64')}`];
    };
    const corrupt = Buffer.from(original); corrupt[0] ^= 1;
    assert.throws(() => readNpmTarball(...compressed(corrupt)), /header checksum mismatch/);
    assert.throws(() => readNpmTarball(...compressed(original.subarray(0, original.length - 1024))), /complete terminator/);
  });
});

describe('repeated findings are rewritten once per line and value', () => {
  test('a version repeated on the same line does not create an unfixable false failure', () => {
    const root = fixture(['Install @frihet/mcp-server@1.16.6 or @frihet/mcp-server@1.16.6']);
    const run = audit(root, ['--fix']);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal((read(root).match(/1\.17\.0/g) ?? []).length, 2);
    assert.doesNotMatch(run.stdout, /unfixable-version/);
  });
  test('a count repeated on the same line does not create an unfixable false failure', () => {
    const root = fixture(['MCP catalogue: 999 tools, exactly 999 tools']);
    const run = audit(root, ['--fix']);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal((read(root).match(/157 tools/g) ?? []).length, 2);
    assert.doesNotMatch(run.stdout, /unfixable-tool-count/);
  });
  test('a version on an unrelated line survives correction', () => {
    const unrelated = 'A different package used version 1.16.6';
    const root = fixture(['Install @frihet/mcp-server@1.16.6', unrelated]);
    const run = audit(root, ['--fix']);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(read(root).includes(unrelated));
    assert.match(read(root), /@frihet\/mcp-server@1\.17\.0/);
  });
});
