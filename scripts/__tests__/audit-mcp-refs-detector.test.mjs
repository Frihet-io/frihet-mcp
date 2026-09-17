/**
 * Detector coverage tests for audit-mcp-refs (tool-count drift).
 *
 * A drift gate is worth exactly what its detector matches. This one silently
 * missed three whole classes of stale count claim, each reproduced verbatim
 * below from the repositories it is supposed to watch:
 *
 *   1. QUALIFIER WORDS between the number and the noun. The pattern allowed a
 *      single literal "MCP" qualifier, so `apps/erp/public/llms.txt` carried
 *      "157 source-verified tools" in four places, drifting unseen on a public
 *      AI-discovery surface the gate already had in its file list.
 *   2. NON-ASCII NOUN ENDINGS. The trailing `\b` is ASCII-only without the `u`
 *      flag, so `araç`, `εργαλεία` and `ツール` could never match even though
 *      all three were already listed in TOOL_NOUNS. They were dead entries.
 *   3. MISSING NOUNS. Danish `værktøjer` and Norwegian `verktøy` were absent.
 *
 * Classes 2 and 3 are why the "31 tools" claim in the ERP integrations card
 * survived in 12 of 34 locale files: the gate could only ever have seen 22 of
 * them. The historical strings below are the real pre-fix values, read from
 * `a701c3b49^` (the parent of the commit that removed the count).
 *
 * The negative controls matter as much as the positives: widening a count
 * detector is how a gate starts crying wolf and gets switched off.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'audit-mcp-refs.mjs');

import {
  TOOL_NOUNS,
  TOOL_COUNT_RE,
  MCP_CONTEXT_RE,
  SAFE_PATTERNS,
  REPOS,
  isGlob,
  expandGlob,
} from '../audit-mcp-refs.mjs';

/** Fresh lastIndex every call — TOOL_COUNT_RE is a /g regex and stateful. */
const matches = (line) => {
  TOOL_COUNT_RE.lastIndex = 0;
  return TOOL_COUNT_RE.test(line);
};

/** The number the fix would rewrite, i.e. capture group 1. */
const captured = (line) => {
  TOOL_COUNT_RE.lastIndex = 0;
  const m = TOOL_COUNT_RE.exec(line);
  return m && m[1];
};

/**
 * Real pre-#1968 `mcpServerDetail` values, one per locale, verbatim from
 * `git show a701c3b49^:apps/erp/locales/<lang>.ts`. Every one of these is a
 * stale "31" claim that the gate must see.
 */
const HISTORICAL_LOCALE_VALUES = {
  da: "mcpServerDetail: '31 værktøjer, npm @frihet/mcp-server',",
  de: "mcpServerDetail: '31 Tools, npm @frihet/mcp-server',",
  el: "mcpServerDetail: '31 εργαλεία, npm @frihet/mcp-server',",
  en: "mcpServerDetail: '31 tools, npm @frihet/mcp-server',",
  es: "mcpServerDetail: '31 tools, npm @frihet/mcp-server',",
  fi: "mcpServerDetail: '31 työkalua, npm @frihet/mcp-server',",
  fr: "mcpServerDetail: '31 tools, npm @frihet/mcp-server',",
  hu: "mcpServerDetail: '31 eszköz, npm @frihet/mcp-server',",
  it: "mcpServerDetail: '31 strumenti, npm @frihet/mcp-server',",
  ja: "mcpServerDetail: '31ツール、npm @frihet/mcp-server',",
  nl: "mcpServerDetail: '31 tools, npm @frihet/mcp-server',",
  no: "mcpServerDetail: '31 verktøy, npm @frihet/mcp-server',",
  pl: "mcpServerDetail: '31 narzędzi, npm @frihet/mcp-server',",
  'pt-br': "mcpServerDetail: '31 ferramentas, npm @frihet/mcp-server',",
  ro: "mcpServerDetail: '31 de instrumente, npm @frihet/mcp-server',",
  sv: "mcpServerDetail: '31 verktyg, npm @frihet/mcp-server',",
  tr: "mcpServerDetail: '31 araç, npm @frihet/mcp-server',",
};

/** Verbatim stale claims from files already in the audit's watch list. */
const QUALIFIED_CLAIMS = [
  '- **MCP catalogue:** 157 source-verified tools.',
  '- **MCP tools:** 157 source-verified tools via the remote MCP endpoint',
  '- Remote MCP server — 157 source-verified tools',
  '| MCP server | 157 source-verified tools, remote | Not available |',
  '  "en": "MCP server for AI agents with 157 business tools",',
];

describe('tool-count detector — every shipped locale', () => {
  for (const [lang, line] of Object.entries(HISTORICAL_LOCALE_VALUES)) {
    test(`${lang}: the stale count is detected`, () => {
      assert.equal(
        matches(line),
        true,
        `locale ${lang} evades the detector: ${line}`
      );
      assert.equal(captured(line), '31', `wrong number captured for ${lang}`);
    });
  }

  test('all 17 locales are covered — no silent partial net', () => {
    const evading = Object.entries(HISTORICAL_LOCALE_VALUES)
      .filter(([, line]) => !matches(line))
      .map(([lang]) => lang);
    assert.deepEqual(evading, [], `locales evading the detector: ${evading}`);
  });
});

describe('tool-count detector — qualifier words', () => {
  for (const line of QUALIFIED_CLAIMS) {
    test(`detected: ${line.trim().slice(0, 52)}`, () => {
      assert.equal(matches(line), true, `qualified claim evades: ${line}`);
      assert.equal(captured(line), '157');
    });
  }

  test('the original single-qualifier form still works', () => {
    assert.equal(matches('157 MCP tools'), true);
    assert.equal(captured('157 MCP tools'), '157');
  });
});

describe('non-ASCII nouns are reachable, not dead entries', () => {
  for (const noun of ['araç', 'εργαλεία', 'ツール', 'työkalua', 'narzędzi', 'eszköz']) {
    test(`${noun} is listed AND matchable`, () => {
      assert.ok(TOOL_NOUNS.includes(noun), `${noun} missing from TOOL_NOUNS`);
      assert.equal(
        matches(`31 ${noun},`),
        true,
        `${noun} is listed but unreachable by the pattern`
      );
    });
  }

  test('CJK counts carry no separator', () => {
    assert.equal(matches('31ツール'), true);
  });
});

describe('anti-defang: the noun list cannot be silently trimmed', () => {
  test('every shipped locale language has at least one noun', () => {
    for (const noun of [
      'tools', 'herramientas', 'outils', 'Werkzeuge', 'strumenti',
      'ferramentas', 'verktyg', 'työkalua', 'gereedschappen', 'narzędzi',
      'instrumente', 'εργαλεία', 'araç', 'eszköz', 'ツール',
      'værktøjer', 'verktøy',
    ]) {
      assert.ok(TOOL_NOUNS.includes(noun), `TOOL_NOUNS lost ${noun}`);
    }
  });
});

describe('watch-list patterns', () => {
  test('the ERP locale fan-out is watched by pattern, not by a 34-path list', () => {
    const erp = REPOS['Frihet-ERP'].files;
    const locale = erp.filter((entry) => entry.startsWith('apps/erp/locales/'));
    assert.equal(locale.length, 1, 'locale coverage should be a single pattern');
    assert.ok(isGlob(locale[0]), `${locale[0]} is not a pattern`);
  });

  test('a pattern that matches nothing expands to empty, never to "clean"', () => {
    // The caller turns [] into a `warn` finding. That is the whole point: a
    // renamed directory must not silently switch this coverage off, which is
    // indistinguishable from a passing repo in the output.
    assert.deepEqual(expandGlob(process.cwd(), 'no/such/dir/**/*.ts'), []);
  });

  test('expansion finds real files and stays inside the pattern', () => {
    const found = expandGlob(process.cwd(), 'scripts/__tests__/*.test.mjs');
    assert.ok(found.length > 0, 'pattern matched no test files');
    assert.ok(
      found.every((f) => f.startsWith('scripts/__tests__/') && f.endsWith('.test.mjs')),
      'expansion escaped the pattern'
    );
    assert.ok(found.every((f) => !f.includes('\\')), 'paths must be POSIX-separated');
  });

  test('a single * does not cross directory boundaries', () => {
    const shallow = expandGlob(process.cwd(), 'scripts/*.mjs');
    assert.ok(shallow.length > 0);
    assert.ok(
      shallow.every((f) => f.split('/').length === 2),
      'single * leaked into subdirectories'
    );
  });
});

describe('--root override', () => {
  /** Runs the real CLI against a hermetic fixture repo. */
  // Synthetic npm responses keep this CLI test independent of tags and network.
  const runAudit = (args) =>
    spawnSync(process.execPath, ['--import', join(dirname(SCRIPT), '__tests__/helpers/published-fetch-preload.mjs'), SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, FRIHET_MCP_PUBLISHED_VERSION: '1.17.0' },
    });

  const fixtureRepo = () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-refs-root-'));
    mkdirSync(join(root, 'apps/erp/locales/es'), { recursive: true });
    writeFileSync(
      join(root, 'apps/erp/locales/es/settings.ts'),
      "        mcpServerDetail: '31 tools, npm @frihet/mcp-server',\n"
    );
    return root;
  };

  test('reads the relocated repo and reports the stale count', () => {
    const root = fixtureRepo();
    const run = runAudit(['--repo', 'Frihet-ERP', '--root', `Frihet-ERP=${root}`]);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /apps\/erp\/locales\/es\/settings\.ts:1 \[tool-count\] found=31/);
  });

  test('the override is echoed — relocated inputs are never silent', () => {
    const root = fixtureRepo();
    const run = runAudit(['--repo', 'Frihet-ERP', '--root', `Frihet-ERP=${root}`]);
    assert.match(run.stdout, new RegExp(`root override: Frihet-ERP -> ${root}`));
  });

  test('a malformed or unknown override is refused, not ignored', () => {
    assert.equal(runAudit(['--root', 'Frihet-ERP']).status, 2);
    assert.equal(runAudit(['--root', 'Frihet-ERP=']).status, 2);
    assert.equal(runAudit(['--root', '=/tmp']).status, 2);
    assert.equal(runAudit(['--root', 'not-a-repo=/tmp']).status, 2);
  });
});

describe('negative controls — the detector must not cry wolf', () => {
  test('a count with no tool noun is ignored', () => {
    assert.equal(matches("webhooksDetail: '14 eventos, HMAC-SHA256',"), false);
    assert.equal(matches('phonePlaceholder: +31 6 12345678'), false);
  });

  test('narrative stub counts are excluded by MCP context, not by the pattern', () => {
    // These live in docs/dev/mcp-tools-coverage.md and describe historical
    // sprint planning, not the current surface. The file is not an
    // "obviously MCP" filename, so the line-level MCP context gate is what
    // keeps them out. Pin that reasoning: if the context gate ever stops
    // applying to this file, these lines start failing CI for no reason.
    const narrative = [
      '> **V2.1-C update (2026-05-07):** 9 stub tools added across 2 new domains',
      '4. **`validate_einvoice` endpoint unblock** — All 4 e-invoice tools return stubs.',
    ];
    for (const line of narrative) {
      assert.equal(
        MCP_CONTEXT_RE.test(line),
        false,
        `narrative line gained MCP context and will now be flagged: ${line}`
      );
    }
  });

  test('resource and prompt counts stay a separate concept', () => {
    const line = '11 resources and 10 prompts';
    assert.ok(
      SAFE_PATTERNS.some((re) => re.test(line)),
      'resource/prompt counts must remain whitelisted'
    );
  });
});
