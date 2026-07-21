#!/usr/bin/env node
// Only show on interactive install, not CI
if (process.env.CI || process.env.FRIHET_QUIET) process.exit(0);

// Version is read from package.json at runtime — never hardcode it here.
// A hardcoded literal drifts behind the published version (the shipped 1.16.3
// banner still said "v1.5.2"); the audit:mcp-refs gate also scans this file to
// block any re-introduced literal.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let version = '';
try {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  version = 'v' + JSON.parse(readFileSync(pkgPath, 'utf8')).version;
} catch {
  version = '';
}

const WIDTH = 62;
const pad = (s) => s + ' '.repeat(Math.max(0, WIDTH - s.length));
const lines = [
  pad(`  @frihet/mcp-server ${version} installed`),
  pad(''),
  pad('  Docs:   https://docs.frihet.io/desarrolladores/mcp-server'),
  pad('  GitHub: https://github.com/Frihet-io/frihet-mcp'),
  pad(''),
  pad('  Star us if you find it useful!'),
];
const border = '═'.repeat(WIDTH);
console.log(`
  ╔${border}╗
${lines.map((l) => `  ║${l}║`).join('\n')}
  ╚${border}╝
`);
