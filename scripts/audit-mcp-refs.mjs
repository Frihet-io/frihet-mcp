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
    // discovery `openapi:` descriptors pointing at api.frihet.io/openapi.json
    // (canonical is mcp.frihet.io/openapi.json; api.frihet.io only 302-redirects).
    // All three are asserted here against the SoT (TOOL_COUNT from package.json —
    // no second source of truth) so the discovery surface can't re-drift.
    if (repoName === 'frihet-mcp' && rel === 'workers/api-proxy/worker.js') {
      lines.forEach((line, idx) => {
        // (a) bare-numeric tools_count field
        const tc = line.match(/tools_count:\s*(\d+)/);
        if (tc && parseInt(tc[1], 10) !== TOOL_COUNT) {
          findings.push({
            repo: repoName, file: rel, line: idx + 1, severity: 'fail',
            kind: 'tool-count', found: parseInt(tc[1], 10), expected: TOOL_COUNT,
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
        // (c) discovery descriptor naming api.frihet.io as the openapi/canonical
        // spec location — the quoted `openapi: "..."` JSON field OR the yaml-note
        // lowercase `canonical:` key. Both must point at the 200 host
        // mcp.frihet.io; api.frihet.io only 302-redirects. Self-referential
        // plain-text mentions (e.g. `OpenAPI: https://api.frihet.io/openapi.json`
        // in the ai.txt block, or the curl example) carry no quoted `openapi:` /
        // lowercase `canonical:` key and are intentionally NOT flagged.
        if (/openapi['"]?\s*:\s*["']https:\/\/api\.frihet\.io\/openapi\.json/i.test(line) ||
            /canonical:\s*https:\/\/api\.frihet\.io\/openapi\.json/.test(line)) {
          findings.push({
            repo: repoName, file: rel, line: idx + 1, severity: 'fail',
            kind: 'discovery-openapi', found: 'api.frihet.io/openapi.json',
            expected: 'mcp.frihet.io/openapi.json',
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
process.exit(exitFail && !FIX ? 1 : 0);

} // end if (isMain)
