#!/usr/bin/env node
// Audit cross-repo refs to @frihet/mcp-server tool count + version.
// Source of truth = this repo's package.json + actual registerTool count.
// Run from anywhere; flags any sister-repo file with stale numbers.
//
// Usage:
//   node scripts/audit-mcp-refs.mjs                # check (exit 1 if stale)
//   node scripts/audit-mcp-refs.mjs --fix          # auto-replace stale numbers
//   node scripts/audit-mcp-refs.mjs --json         # machine-readable
//   node scripts/audit-mcp-refs.mjs --repo <name>  # limit to one repo
//   node scripts/audit-mcp-refs.mjs --allow-dirty  # bypass worktree-clean guard
//
// Exit codes:
//   0 = clean (or --fix succeeded)
//   1 = stale refs found
//   2 = invalid --repo argument
//   3 = sister repo dirty (use --allow-dirty to override)
//
// Limitations:
//   - grep-based, not AST. False positives possible — extend SAFE_PATTERNS
//     or add "// mcp-refs:ok" annotation to skip a line.
//   - Sister repos must be cloned at ~/Documents/<repo-name>.
//
// Whitelist: lines matching SAFE_PATTERNS skip the tool-count check.
// Inline: append "// mcp-refs:ok" or "# mcp-refs:ok" to ignore one line.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SELF = resolve(__dirname, '..');
const HOME = homedir();
const ARGS = process.argv.slice(2);
const FIX = ARGS.includes('--fix');
const JSON_OUT = ARGS.includes('--json');
const REPO_FILTER = ARGS.includes('--repo') ? ARGS[ARGS.indexOf('--repo') + 1] : null;
const ALLOW_DIRTY = ARGS.includes('--allow-dirty');

// === SOURCE OF TRUTH ===
const pkg = JSON.parse(readFileSync(join(SELF, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const publicCapabilityContract = JSON.parse(
  readFileSync(
    join(SELF, 'src/__tests__/fixtures/public-capability-contract.json'),
    'utf8',
  ),
);
const REMOTE_GROUPED_TOOL_COUNT =
  publicCapabilityContract.surfaces.remoteGrouped.tools.length;
const REMOTE_GROUPED_RESOURCE_COUNT =
  publicCapabilityContract.surfaces.remoteGrouped.resources.length;

// Real tool count = registerTool calls in src/tools/*.ts minus meta-tools in register-all.ts
const toolDir = join(SELF, 'src/tools');
let total = 0;
let metaCount = 0;
for (const f of readdirSync(toolDir)) {
  if (!f.endsWith('.ts')) continue;
  const txt = readFileSync(join(toolDir, f), 'utf8');
  const matches = (txt.match(/registerTool/g) || []).length;
  if (f === 'register-all.ts') metaCount = matches;
  else total += matches;
}
const TOOL_COUNT = total;

// === TARGETS ===
const REPOS = {
  'frihet-mcp': {
    root: SELF,
    files: [
      'server.json',
      'package.json',
      'glama.json',
      'README.md',
      'CHANGELOG.md',
      'skill/SKILL.md',
      'skills/frihet-mcp/SKILL.md',
      'marketplace/anthropic/connector/manifest.json',
      'src/index.ts',
      'scripts/postinstall.js',
      'workers/api-proxy/worker.js',
      'workers/remote-mcp/src/index.ts',
      'workers/remote-mcp/src/auth-handler.ts',
      'workers/remote-mcp/src/server-meta.ts',
      'workers/remote-mcp/public/releases.json',
    ],
  },
  'Frihet-ERP': {
    root: join(HOME, 'Documents/Frihet-ERP'),
    files: [
      'CLAUDE.md',
      'apps/erp/public/llms.txt',
      'packages/manifest/src/data/product.ts',
      'packages/manifest/src/data/comparisons.ts',
      'packages/manifest/src/emit/schema-org.ts',
      'packages/ui/src/manifestBrowser/data.json',
      'docs/dev/mcp-tools-coverage.md',
    ],
  },
  'Frihet-Saas-Website': {
    root: join(HOME, 'Documents/Frihet-Saas-Website'),
    files: [
      'public/.well-known/llms.txt',
      'public/.well-known/llms-full.txt',
      'public/.well-known/agents.json',
      'src/data/comparisons.json',
      'src/data/schema-org.json',
      'src/i18n/es.json',
      'src/layouts/Base.astro',
    ],
  },
  'frihet-docs': {
    root: join(HOME, 'Documents/frihet-docs'),
    files: [
      'docs/desarrolladores/mcp-server.md',
      'static/.well-known/jsonld',
    ],
  },
};

// Tool-count nouns across 17 langs
const TOOL_NOUNS = [
  'tool', 'tools',
  'herramienta', 'herramientas',
  'outil', 'outils',
  'Werkzeug', 'Werkzeuge',
  'strumento', 'strumenti',
  'ferramenta', 'ferramentas',
  'verktyg',
  'tyokalu', 'tyokalua', 'työkalu', 'työkalua',
  'gereedschap', 'gereedschappen',
  'narzedzie', 'narzedzi', 'narzędzie', 'narzędzi',
  'instrument', 'instrumente',
  'εργαλείο', 'εργαλεία',
  'araç', 'araçlar', 'araclar',
  'eszköz', 'eszközök',
  'ツール',
];
const TOOL_NOUN_RE = TOOL_NOUNS.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
// e.g. "94 tools", "94 herramientas", and "157 MCP tools" (one optional qualifier
// word between the number and the noun — the worker JSON-LD said "151 MCP tools"
// and slipped past the tighter `\d+ tools` pattern, letting the count drift).
const TOOL_COUNT_RE = new RegExp(`\\b(\\d{1,4})[\\s_-]+(?:MCP[\\s_-]+)?(${TOOL_NOUN_RE})\\b`, 'gi');

// Files whose tool-count entries are entirely historical/narrative — skip count checks.
// These files record past release totals as changelog entries (not current-state claims).
// Version checks are still enforced. Extend when adding new changelog-style files.
const HISTORY_FILES = new Set([
  'CHANGELOG.md',
]);

// Lines containing any of these phrases are NOT checked for tool-count drift.
// (different concept than MCP tool count)
const SAFE_PATTERNS = [
  /55\+?\s+(herramientas|tools)/i,                      // Gemini in-app function tools
  /\d+\s+(?:tools?|herramientas)\s+copiloto/i,          // Gemini copiloto tools
  /(?:function[- ]tools?|function[- ]calls?)/i,         // Gemini function tools
  /\bGemini\b/i,                                        // Gemini-related lines
  /\d+\s+(?:tipos? de webhook|webhook events?|tipos webhook)/i, // webhook event types
  /\d+\s+(?:tipos? de evento|event types?)/i,           // event type counts
  /\bnpm\s+install\b/i,                                 // version pin lines
  /node[- ]?modules/i,
  /mcp-refs:ok/i,                                       // inline annotation
  // Historical / changelog / release-note context
  /\bdelta\b/i,
  /\+\d+\s+(tools?|herramientas?)/i,                    // "+N tools" delta
  /Wave\s+\d/i,                                         // wave N references
  /\bnotes?\b\s*[:=]/i,                                 // notes field in JSON/release entries
  /history|hist[oó]rico|previous|earlier|legacy|deprecated|prior|former/i,
  /(?:Banking|POS|Stay|Fiscal|Time|Recurring|Team|Invoices|Expenses|Clients|Products|Quotes|CRM|Deposits|Vendors|Webhooks|Einvoice|Intelligence|EInvoice)\s*\(\d+\s+(tools?|herramientas?)\)/i,
  // ES families (frihet-docs)
  /(?:Facturas?|Gastos?|Clientes?|Productos?|Presupuestos?|Proveedores?|Inteligencia|Anticipos?|Dep[oó]sitos?|CRM|Webhooks?|E[- ]?facturas?|Banca|TPV|Alojamientos?|Fiscal|Tiempo|Recurrentes?|Equipo)\s*\(\d+\s+(tools?|herramientas?)\)/i,
  // Generic: markdown section header with parenthesized count → category breakdown
  /^#{2,5}\s+.*\(\d+\s+(?:tools?|herramientas?)\)/i,
  // Generic: list item with parenthesized count
  /^\s*[*\-+]\s+.*\(\d+\s+(?:tools?|herramientas?)\)\s*[—:]/i,
  // Counts of resources/prompts (separate concept from tools)
  /\d+\s+(resources?|recursos?|prompts?)/i,
];

// Version pattern: catches "v1.5.4", "1.7.0-beta.1", "@frihet/mcp-server@1.6.0", etc.
// Only flagged when line context contains MCP markers.
const VERSION_RE = /v?(\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?)/g;
const MCP_CONTEXT_RE = /(@frihet\/mcp-server|frihet-mcp|servidor\s+mcp|mcp\s+server|mcp\.frihet\.io)/i;

// === server.json version gate (special case) ===
// server.json carries the version as BARE JSON values (root `.version` and
// `.packages[0].version`). The generic line-scan version check requires an MCP
// marker on the SAME line (MCP_CONTEXT_RE), which never matches those bare
// `"version": "x.y.z"` lines — so a desynced server.json passed silently and
// caused the Registry 400 "duplicate version" in release 1.13.1.
//
// This handler parses server.json as JSON and asserts both version fields equal
// the SoT VERSION (from package.json). Returns an array of drift findings in the
// same { kind, found, expected, jsonPath } shape used by the rest of the audit;
// empty array means in-sync. Pure (no I/O) so it's unit-testable in isolation.
export function checkServerJsonVersion(serverJson, expectedVersion) {
  const drifts = [];
  const rootVer = serverJson?.version;
  if (rootVer !== expectedVersion) {
    drifts.push({ kind: 'version', jsonPath: '.version', found: rootVer, expected: expectedVersion });
  }
  const pkgVer = serverJson?.packages?.[0]?.version;
  if (pkgVer !== expectedVersion) {
    drifts.push({ kind: 'version', jsonPath: '.packages[0].version', found: pkgVer, expected: expectedVersion });
  }
  return drifts;
}

/**
 * Validate current release projections that the generic line scanner cannot
 * understand safely: bare JSON versions, "canonical operations" prose, and
 * the three generated runtime profile inventories. Historical changelog rows
 * and the separately reviewed OpenAI submission bundle are deliberately out
 * of scope.
 */
export function checkCurrentReleaseProjections(input, expectedVersion) {
  const drifts = [];
  const contract = input.capabilityContract;
  const canonical = contract?.catalogue?.canonicalOperations;
  const surfaces = Object.fromEntries(
    Object.entries(contract?.surfaces ?? {}).map(([name, surface]) => [
      name,
      {
        tools: surface?.tools?.length,
        resources: surface?.resources?.length,
        prompts: surface?.prompts?.length,
      },
    ]),
  );
  const remote = surfaces.remoteGrouped;

  const stale = (jsonPath, found, expected) => {
    if (found !== expected) {
      drifts.push({
        kind: 'release-projection',
        jsonPath,
        found,
        expected,
      });
    }
  };
  const contains = (jsonPath, text, expected) => {
    if (typeof text !== 'string' || !text.includes(expected)) {
      drifts.push({
        kind: 'release-projection',
        jsonPath,
        found: text,
        expected,
      });
    }
  };
  const skillMetadataVersion = (document) => {
    if (typeof document !== 'string') return undefined;
    const frontmatter = document.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    if (!frontmatter) return undefined;
    let inMetadata = false;
    for (const line of frontmatter.split(/\r?\n/u)) {
      if (line === 'metadata:') {
        inMetadata = true;
        continue;
      }
      if (!inMetadata) continue;
      if (/^\S/u.test(line)) break;
      const version = line.match(/^  version:\s*(\S+)\s*$/u)?.[1];
      if (version) return version;
    }
    return undefined;
  };

  stale('package.json.version', input.packageJson?.version, expectedVersion);
  stale('glama.json.version', input.glamaJson?.version, expectedVersion);
  stale('workers/remote-mcp/public/releases.json.version', input.releasesJson?.version, expectedVersion);
  stale(
    'workers/remote-mcp/public/releases.json.products.mcp_server.version',
    input.releasesJson?.products?.mcp_server?.version,
    expectedVersion,
  );
  stale(
    'workers/remote-mcp/public/releases.json.releases[0].version',
    input.releasesJson?.releases?.[0]?.version,
    expectedVersion,
  );
  stale('marketplace/anthropic/connector/manifest.json.version', input.anthropicManifest?.version, expectedVersion);
  stale(
    'marketplace/anthropic/connector/manifest.json.packages[0].version',
    input.anthropicManifest?.packages?.[0]?.version,
    expectedVersion,
  );

  contains('package.json.description', input.packageJson?.description, `${canonical} canonical operations`);
  contains('glama.json.description.canonical', input.glamaJson?.description, `${canonical} canonical operations`);
  contains('glama.json.description.remote-tools', input.glamaJson?.description, `${remote?.tools} tool names`);
  contains('glama.json.description.remote-resources', input.glamaJson?.description, `${remote?.resources} resources`);
  contains('glama.json.description.remote-prompts', input.glamaJson?.description, `${remote?.prompts} prompts`);
  contains('README.md.canonical', input.readme, `${canonical} canonical operations`);
  const readmeProfileLabels = {
    localFull: 'The local full profile serves',
    remoteGrouped: 'The hosted grouped profile serves',
    openaiFull: 'The separately reviewed OpenAI profile serves',
  };
  for (const [name, counts] of Object.entries(surfaces)) {
    contains(
      `README.md.${name}`,
      input.readme,
      `${readmeProfileLabels[name]} ${counts.tools} tool names, ${counts.resources} resources, and ${counts.prompts} prompts`,
    );
    for (const dimension of ['tools', 'resources', 'prompts']) {
      stale(
        `workers/remote-mcp/public/releases.json.surfaceCounts.${name}.${dimension}`,
        input.releasesJson?.surfaceCounts?.[name]?.[dimension],
        counts[dimension],
      );
    }
  }
  stale('workers/remote-mcp/public/releases.json.mcpToolCount', input.releasesJson?.mcpToolCount, canonical);
  stale('workers/remote-mcp/public/releases.json.releases[0].mcpToolCount', input.releasesJson?.releases?.[0]?.mcpToolCount, canonical);
  stale('workers/remote-mcp/public/releases.json.releases[0].toolNamesCount', input.releasesJson?.releases?.[0]?.toolNamesCount, remote?.tools);
  stale('workers/remote-mcp/public/releases.json.releases[0].resourcesCount', input.releasesJson?.releases?.[0]?.resourcesCount, remote?.resources);
  stale('workers/remote-mcp/public/releases.json.releases[0].promptsCount', input.releasesJson?.releases?.[0]?.promptsCount, remote?.prompts);
  contains(
    'marketplace/anthropic/connector/manifest.json.description',
    input.anthropicManifest?.description,
    `a ${canonical}-operation catalogue; the grouped remote profile exposes ${remote?.tools} tool names, ${remote?.resources} resources, and ${remote?.prompts} prompts`,
  );
  contains('CHANGELOG.md.current-release', input.changelog, `## [${expectedVersion}]`);
  contains('CHANGELOG.md.localFull', input.changelog, `\`localFull\` exposes ${surfaces.localFull?.tools} tool names, ${surfaces.localFull?.resources} resources, and ${surfaces.localFull?.prompts} prompts`);
  contains('CHANGELOG.md.remoteGrouped', input.changelog, `\`remoteGrouped\` exposes ${remote?.tools} tool names, ${remote?.resources} resources, and ${remote?.prompts} prompts`);
  contains('CHANGELOG.md.openaiFull', input.changelog, `\`openaiFull\` remains ${surfaces.openaiFull?.tools} tool names, ${surfaces.openaiFull?.resources} resources, and ${surfaces.openaiFull?.prompts} prompts`);

  for (const [index, skill] of (input.skillDocuments ?? []).entries()) {
    stale(`skill[${index}].metadata.version`, skillMetadataVersion(skill), expectedVersion);
    contains(`skill[${index}].catalogue-heading`, skill, `## MCP catalogue (${canonical} canonical operations)`);
  }

  return drifts;
}

// Run the full audit only when invoked as a CLI. When imported (e.g. by tests)
// the module exposes its pure helpers without executing the audit or exiting.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {

// Validate --repo argument
if (REPO_FILTER && !Object.keys(REPOS).includes(REPO_FILTER)) {
  console.error(`Unknown repo: ${REPO_FILTER}`);
  console.error(`Valid: ${Object.keys(REPOS).join(', ')}`);
  process.exit(2);
}

// Worktree-clean guard for sister repos when --fix is active.
// Skip self-repo guard (caller likely on dev branch in frihet-mcp itself).
function isDirty(root) {
  try {
    const out = execSync('git status --porcelain', { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return out.trim().length > 0;
  } catch {
    return false; // not a git repo → don't block
  }
}

if (FIX && !ALLOW_DIRTY) {
  const dirty = [];
  for (const [name, cfg] of Object.entries(REPOS)) {
    if (REPO_FILTER && name !== REPO_FILTER) continue;
    if (name === 'frihet-mcp') continue; // skip self
    if (existsSync(cfg.root) && isDirty(cfg.root)) dirty.push(name);
  }
  if (dirty.length) {
    console.error(`Refusing --fix: sister repos dirty: ${dirty.join(', ')}`);
    console.error(`Commit/stash there first, or pass --allow-dirty.`);
    process.exit(3);
  }
}

const findings = [];

if (!REPO_FILTER || REPO_FILTER === 'frihet-mcp') {
  const projectionDrifts = checkCurrentReleaseProjections({
    packageJson: pkg,
    glamaJson: JSON.parse(readFileSync(join(SELF, 'glama.json'), 'utf8')),
    releasesJson: JSON.parse(readFileSync(join(SELF, 'workers/remote-mcp/public/releases.json'), 'utf8')),
    anthropicManifest: JSON.parse(readFileSync(join(SELF, 'marketplace/anthropic/connector/manifest.json'), 'utf8')),
    readme: readFileSync(join(SELF, 'README.md'), 'utf8'),
    changelog: readFileSync(join(SELF, 'CHANGELOG.md'), 'utf8'),
    capabilityContract: publicCapabilityContract,
    skillDocuments: [
      readFileSync(join(SELF, 'skill/SKILL.md'), 'utf8'),
      readFileSync(join(SELF, 'skills/frihet-mcp/SKILL.md'), 'utf8'),
    ],
  }, VERSION);
  for (const drift of projectionDrifts) {
    findings.push({
      repo: 'frihet-mcp',
      file: drift.jsonPath.split('.')[0],
      line: drift.jsonPath,
      severity: 'fail',
      ...drift,
      snippet: `${drift.jsonPath} = ${JSON.stringify(drift.found)}`.slice(0, 240),
    });
  }
}

for (const [repoName, cfg] of Object.entries(REPOS)) {
  if (REPO_FILTER && repoName !== REPO_FILTER) continue;
  if (!existsSync(cfg.root)) {
    findings.push({ repo: repoName, severity: 'warn', msg: `repo dir not found: ${cfg.root}` });
    continue;
  }
  for (const rel of cfg.files) {
    const abs = join(cfg.root, rel);
    if (!existsSync(abs)) {
      findings.push({ repo: repoName, file: rel, severity: 'warn', msg: 'file missing' });
      continue;
    }
    const lines = readFileSync(abs, 'utf8').split('\n');

    // History files: skip tool-count checks entirely (entries are historical narrative).
    const isHistoryFile = HISTORY_FILES.has(rel);

    // Special case: server.json carries version as bare JSON values that the
    // generic MCP-context line scan can't see. Parse + assert both fields.
    if (repoName === 'frihet-mcp' && rel === 'server.json') {
      let serverJson;
      try {
        serverJson = JSON.parse(readFileSync(abs, 'utf8'));
      } catch (err) {
        findings.push({ repo: repoName, file: rel, severity: 'fail', kind: 'parse', msg: `invalid JSON: ${err.message}` });
        serverJson = null;
      }
      if (serverJson) {
        for (const drift of checkServerJsonVersion(serverJson, VERSION)) {
          findings.push({
            repo: repoName,
            file: rel,
            line: drift.jsonPath,
            severity: 'fail',
            kind: drift.kind,
            found: drift.found,
            expected: drift.expected,
            snippet: `${drift.jsonPath} = ${JSON.stringify(drift.found)}`,
          });
        }
        if (FIX) {
          let mutated = false;
          if (serverJson.version !== VERSION) { serverJson.version = VERSION; mutated = true; }
          if (serverJson.packages?.[0] && serverJson.packages[0].version !== VERSION) {
            serverJson.packages[0].version = VERSION;
            mutated = true;
          }
          if (mutated) {
            writeFileSync(abs, JSON.stringify(serverJson, null, 2) + '\n');
            findings.push({ repo: repoName, file: rel, severity: 'fixed', msg: 'server.json version fields synced' });
          }
        }
      }
    }

    // Special case: server-meta.ts carries the Worker's FULL_TOOL_COUNT as a bare
    // numeric constant (no tool-noun on the line), invisible to the generic scan.
    // Assert it equals the SoT tool count so the Worker surfaces can't re-drift.
    if (repoName === 'frihet-mcp' && rel === 'workers/remote-mcp/src/server-meta.ts') {
      const src = readFileSync(abs, 'utf8');
      const m = src.match(/FULL_TOOL_COUNT\s*=\s*(\d+)/);
      if (m && parseInt(m[1], 10) !== TOOL_COUNT) {
        findings.push({
          repo: repoName, file: rel, line: 'FULL_TOOL_COUNT', severity: 'fail',
          kind: 'tool-count', found: parseInt(m[1], 10), expected: TOOL_COUNT,
          snippet: `export const FULL_TOOL_COUNT = ${m[1]}`,
        });
        if (FIX) {
          writeFileSync(abs, src.replace(/(FULL_TOOL_COUNT\s*=\s*)\d+/, `$1${TOOL_COUNT}`));
          findings.push({ repo: repoName, file: rel, severity: 'fixed', msg: `FULL_TOOL_COUNT synced to ${TOOL_COUNT}` });
        }
      }
    }

    // Special case: api-proxy worker.js is the AI-discovery surface served at
    // api.frihet.io. It carries three drift vectors invisible to the generic
    // line scan: (a) bare-numeric `tools_count:` fields, (b) the legacy
    // `X-Frihet-API-Key` auth header (live API reads `X-API-Key`), and (c)
    // discovery `openapi:` descriptors pointing at mcp.frihet.io/openapi.json
    // (canonical is api.frihet.io/openapi.json, a live proxy of the publicApi
    // Cloud Function; mcp.frihet.io serves a DERIVED file that can go stale
    // between deploys — pointing discovery at it is what let the spec rot).
    // NOTE: this rule was inverted on 29-jul-2026 together with the redirect
    // removal. The enforcement below is the source of truth for its direction.
    // Counts are asserted against the generated real-SDK profile capture, while
    // canonical operation prose remains pinned to TOOL_COUNT.
    if (repoName === 'frihet-mcp' && rel === 'workers/api-proxy/worker.js') {
      lines.forEach((line, idx) => {
        // (a) bare-numeric tools_count field
        const tc = line.match(/tools_count:\s*(\d+)/);
        if (tc && parseInt(tc[1], 10) !== REMOTE_GROUPED_TOOL_COUNT) {
          findings.push({
            repo: repoName, file: rel, line: idx + 1, severity: 'fail',
            kind: 'tool-count', found: parseInt(tc[1], 10), expected: REMOTE_GROUPED_TOOL_COUNT,
            snippet: line.trim().slice(0, 120),
          });
        }
        const rc = line.match(/resources_count:\s*(\d+)/);
        if (rc && parseInt(rc[1], 10) !== REMOTE_GROUPED_RESOURCE_COUNT) {
          findings.push({
            repo: repoName, file: rel, line: idx + 1, severity: 'fail',
            kind: 'resource-count', found: parseInt(rc[1], 10), expected: REMOTE_GROUPED_RESOURCE_COUNT,
            snippet: line.trim().slice(0, 120),
          });
        }
        // (b) legacy auth header
        if (/X-Frihet-API-Key/.test(line)) {
          findings.push({
            repo: repoName, file: rel, line: idx + 1, severity: 'fail',
            kind: 'legacy-header', found: 'X-Frihet-API-Key', expected: 'X-API-Key',
            snippet: line.trim().slice(0, 120),
          });
        }
        // (c) discovery descriptor naming the WRONG canonical openapi host — the
        // quoted `openapi: "..."` JSON field or the lowercase `canonical:` key.
        //
        // This rule used to point the other way: it required mcp.frihet.io,
        // because api.frihet.io/openapi.json only 302-redirected there. That
        // redirect was itself the bug. mcp.frihet.io served a HAND-COPIED static
        // file that had been stale for six weeks and told every client that
        // POST /v1/invoices/:id/credit-note returns 200 and issues a fiscal
        // document (it returns 201 and creates a draft). The gate was enforcing
        // the drifted copy as canonical.
        //
        // api.frihet.io now proxies the publicApi Cloud Function, which serves
        // the spec bundled with its own deployed code — it cannot describe an
        // API other than the one it is fronting. That is the canonical host, and
        // the mcp.frihet.io copy is a generated artifact of it
        // (scripts/sync-openapi.mjs).
        if (/openapi['"]?\s*:\s*["']https:\/\/mcp\.frihet\.io\/openapi\.json/i.test(line) ||
            /canonical:\s*https:\/\/mcp\.frihet\.io\/openapi\.json/.test(line)) {
          findings.push({
            repo: repoName, file: rel, line: idx + 1, severity: 'fail',
            kind: 'discovery-openapi', found: 'mcp.frihet.io/openapi.json',
            expected: 'api.frihet.io/openapi.json',
            snippet: line.trim().slice(0, 120),
          });
        }
      });
    }

    lines.forEach((line, idx) => {
      // Skip safe-pattern lines for tool-count check
      const safeLine = isHistoryFile || SAFE_PATTERNS.some((re) => re.test(line));

      if (!safeLine) {
        TOOL_COUNT_RE.lastIndex = 0;
        let m;
        while ((m = TOOL_COUNT_RE.exec(line)) !== null) {
          const n = parseInt(m[1], 10);
          if (n === TOOL_COUNT) continue;
          // Heuristic: only flag if number is in MCP context OR it's an obviously MCP-related file.
          // All files inside frihet-mcp repo are MCP-related by definition.
          const mcpFile = repoName === 'frihet-mcp'
            || /llms\.txt|llms-full\.txt|server\.json|releases\.json|mcp[-_]server|skill\/SKILL|jsonld|agents\.json|manifestBrowser|schema-org|comparisons|product\.ts|emit\/schema-org/i.test(rel);
          if (!mcpFile && !MCP_CONTEXT_RE.test(line)) continue;
          findings.push({
            repo: repoName,
            file: rel,
            line: idx + 1,
            severity: 'fail',
            kind: 'tool-count',
            found: n,
            expected: TOOL_COUNT,
            snippet: line.trim().slice(0, 120),
          });
        }
      }

      // Version check — only if line matches MCP context
      if (MCP_CONTEXT_RE.test(line)) {
        VERSION_RE.lastIndex = 0;
        let v;
        while ((v = VERSION_RE.exec(line)) !== null) {
          const ver = v[1];
          // Only flag versions that look like @frihet/mcp-server (semver with optional prerelease, 0.x or 1.x for now)
          if (!/^\d+\.\d+\.\d+/.test(ver)) continue;
          if (ver === VERSION) continue;
          // Skip schema URL versions (e.g., "2025-12-11")
          if (/\d{4}-\d{2}-\d{2}/.test(line) && !line.includes('@frihet/mcp-server')) continue;
          findings.push({
            repo: repoName,
            file: rel,
            line: idx + 1,
            severity: 'fail',
            kind: 'version',
            found: ver,
            expected: VERSION,
            snippet: line.trim().slice(0, 120),
          });
        }
      }
    });

    if (FIX) {
      let txt = readFileSync(abs, 'utf8');
      let mutated = false;
      // Replace tool-count: only on flagged file lines
      const fileFails = findings.filter((f) => f.repo === repoName && f.file === rel && f.kind === 'tool-count');
      for (const fail of fileFails) {
        // Replace "N tools/herramientas" and "N MCP tools" → "TOOL_COUNT $qualifier+noun"
        // ($1 captures the optional "MCP " qualifier + noun so it is preserved).
        const re = new RegExp(`\\b${fail.found}([\\s_-]+(?:MCP[\\s_-]+)?(?:${TOOL_NOUN_RE}))\\b`, 'gi');
        const newTxt = txt.replace(re, `${TOOL_COUNT}$1`);
        if (newTxt !== txt) { txt = newTxt; mutated = true; }
      }
      const verFails = findings.filter((f) => f.repo === repoName && f.file === rel && f.kind === 'version');
      for (const fail of verFails) {
        const re = new RegExp(fail.found.replace(/\./g, '\\.'), 'g');
        const newTxt = txt.replace(re, VERSION);
        if (newTxt !== txt) { txt = newTxt; mutated = true; }
      }
      if (mutated) {
        writeFileSync(abs, txt);
        findings.push({ repo: repoName, file: rel, severity: 'fixed', msg: 'auto-replaced' });
      }
    }
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    sot: { version: VERSION, toolCount: TOOL_COUNT, metaCount },
    findings,
  }, null, 2));
} else {
  console.log(`SoT: @frihet/mcp-server@${VERSION} · ${TOOL_COUNT} tools (+${metaCount} meta)\n`);
  const fails = findings.filter((f) => f.severity === 'fail');
  const warns = findings.filter((f) => f.severity === 'warn');
  const fixed = findings.filter((f) => f.severity === 'fixed');
  if (fails.length === 0 && warns.length === 0 && fixed.length === 0) {
    console.log('OK — all refs match SoT.');
  } else {
    if (fails.length) {
      console.log(`STALE (${fails.length}):`);
      for (const f of fails) {
        console.log(`  ${f.repo}/${f.file}:${f.line} [${f.kind}] found=${f.found} expected=${f.expected}`);
        console.log(`    ${f.snippet}`);
      }
    }
    if (warns.length) {
      console.log(`\nWARN (${warns.length}):`);
      for (const w of warns) console.log(`  ${w.repo}${w.file ? '/' + w.file : ''}: ${w.msg}`);
    }
    if (fixed.length) {
      console.log(`\nFIXED (${fixed.length}):`);
      for (const f of fixed) console.log(`  ${f.repo}/${f.file}: ${f.msg}`);
    }
  }
}

const exitFail = findings.some((f) => f.severity === 'fail');
const unfixableProjectionFail = findings.some(
  (f) => f.severity === 'fail' && f.kind === 'release-projection',
);
process.exit((exitFail && !FIX) || unfixableProjectionFail ? 1 : 0);

} // end if (isMain)
