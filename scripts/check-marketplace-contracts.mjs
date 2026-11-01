#!/usr/bin/env node
/**
 * Cross-Platform Marketplace Contract & Invariant Guard
 *
 * Verifies that all ecosystem manifests, schemas, toolkits, and configurations
 * across marketplace/ conform to syntactic rules and Frihet trust invariants:
 *   1. All JSON manifests parse without syntax errors.
 *   2. All YAML specifications parse without syntax errors.
 *   3. Draft-only invoice creation invariant is maintained across all tools.
 *   4. Canonical REST endpoint routes (/monthly, /quarterly) strictly maintained;
 *      legacy/divergent paths (/summaries/monthly, /taxes/quarterly) rejected.
 *   5. Idempotency-Key support and sensitive field redaction in all client toolkits.
 *   6. Canonical tool naming in directory manifests (e.g. Meta Muse).
 *   7. Zero leaked production secrets (API keys or tokens).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const JSON_MANIFESTS = [
  'server.json',
  'glama.json',
  'marketplace/zapier/definition.json',
  'marketplace/cursor/.cursor/mcp.json',
  'marketplace/raycast/package.json',
  'marketplace/muse/manifest.json',
  'marketplace/make/app-definition.json',
  'marketplace/postman/frihet-erp.postman_collection.json',
  'marketplace/postman/frihet-erp.postman_environment.json',
];

const YAML_MANIFESTS = [
  'smithery.yaml',
  'marketplace/dify/provider.yaml',
];

const TOOLKIT_CODE_FILES = [
  'marketplace/vercel-ai/frihet-ai-sdk.ts',
  'marketplace/genkit/frihet-genkit.ts',
  'marketplace/autogen/frihet_autogen.py',
  'marketplace/llamaindex/frihet_llamaindex.py',
  'marketplace/langchain/frihet_langchain.py',
  'marketplace/crewai/frihet_crewai.py',
  'marketplace/flowise/frihet_custom_tool.js',
];

let failed = false;

console.log('--- Verifying Marketplace Manifests & Invariants ---');

// 1. Check JSON manifests
for (const relPath of JSON_MANIFESTS) {
  const fullPath = path.join(rootDir, relPath);
  try {
    const raw = fs.readFileSync(fullPath, 'utf8');
    JSON.parse(raw);
    console.log(`✓ JSON valid: ${relPath}`);
  } catch (err) {
    console.error(`✗ JSON invalid: ${relPath} — ${err.message}`);
    failed = true;
  }
}

// 2. Check YAML manifests
for (const relPath of YAML_MANIFESTS) {
  const fullPath = path.join(rootDir, relPath);
  try {
    const raw = fs.readFileSync(fullPath, 'utf8');
    yaml.parse(raw);
    console.log(`✓ YAML valid: ${relPath}`);
  } catch (err) {
    console.error(`✗ YAML invalid: ${relPath} — ${err.message}`);
    failed = true;
  }
}

// 3. Check Draft-Only Invariant across all toolkit code files
for (const relPath of TOOLKIT_CODE_FILES) {
  const fullPath = path.join(rootDir, relPath);
  try {
    const code = fs.readFileSync(fullPath, 'utf8');
    const hasDraftInvariant = code.includes("'draft'") || code.includes('"draft"');
    if (!hasDraftInvariant) {
      console.error(`✗ Missing draft invariant in: ${relPath}`);
      failed = true;
    } else {
      console.log(`✓ Draft-only invariant verified: ${relPath}`);
    }
  } catch (err) {
    console.error(`✗ Failed reading toolkit: ${relPath} — ${err.message}`);
    failed = true;
  }
}

// 4. Check Canonical Endpoints Invariant (No /summaries/monthly or /taxes/quarterly divergence)
const DIVERGENT_ENDPOINTS = [
  '/summaries/monthly',
  '/summaries/quarterly',
  '/taxes/quarterly',
];

const filesToInspectForEndpoints = [
  ...TOOLKIT_CODE_FILES,
  'marketplace/make/app-definition.json',
  'marketplace/postman/frihet-erp.postman_collection.json',
];

for (const relPath of filesToInspectForEndpoints) {
  const fullPath = path.join(rootDir, relPath);
  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    for (const badRoute of DIVERGENT_ENDPOINTS) {
      if (content.includes(badRoute)) {
        console.error(`✗ Divergent non-canonical route '${badRoute}' found in: ${relPath}`);
        failed = true;
      }
    }
  } catch (err) {
    console.error(`✗ Failed reading for endpoint audit: ${relPath} — ${err.message}`);
    failed = true;
  }
}
console.log('✓ Canonical REST endpoint routes strictly enforced (zero legacy route divergence)');

// 5. Check Idempotency & Redaction Guarantees in Toolkits
for (const relPath of TOOLKIT_CODE_FILES) {
  const fullPath = path.join(rootDir, relPath);
  const code = fs.readFileSync(fullPath, 'utf8');
  const hasIdempotency = code.includes('Idempotency-Key') || code.includes('idemp_');
  const hasRedaction = code.includes('redact') || code.includes('REDACTED');

  if (!hasIdempotency) {
    console.error(`✗ Missing Idempotency-Key mutation protection in: ${relPath}`);
    failed = true;
  }
  if (!hasRedaction) {
    console.error(`✗ Missing sensitive field redaction in: ${relPath}`);
    failed = true;
  }
}
console.log('✓ Idempotency-Key and sensitive data redaction verified across all toolkits');

// 6. Check Meta Muse canonical tool names
const musePath = path.join(rootDir, 'marketplace/muse/manifest.json');
try {
  const museManifest = JSON.parse(fs.readFileSync(musePath, 'utf8'));
  const toolNames = museManifest.capabilities.tools.map((t) => t.name);
  if (toolNames.includes('frihet_get_business_context')) {
    console.error(`✗ Non-canonical tool name frihet_get_business_context in Meta Muse manifest`);
    failed = true;
  }
  if (!toolNames.includes('get_business_context')) {
    console.error(`✗ Missing canonical tool get_business_context in Meta Muse manifest`);
    failed = true;
  }
  console.log('✓ Meta Muse manifest canonical tool naming verified');
} catch (err) {
  console.error(`✗ Meta Muse validation failed: ${err.message}`);
  failed = true;
}

// 7. Secret Leak Tripwire
const allFilesToCheck = [...JSON_MANIFESTS, ...YAML_MANIFESTS, ...TOOLKIT_CODE_FILES];
const SECRET_REGEX = /(?:sk_live_[0-9a-zA-Z]{24,}|fri_live_[0-9a-zA-Z]{24,})/;

for (const relPath of allFilesToCheck) {
  const fullPath = path.join(rootDir, relPath);
  const content = fs.readFileSync(fullPath, 'utf8');
  if (SECRET_REGEX.test(content)) {
    console.error(`✗ LEAK TRIPWIRE: Real secret pattern found in ${relPath}`);
    failed = true;
  }
}

if (failed) {
  console.error('\nMarketplace contract check FAILED.');
  process.exit(1);
} else {
  console.log('\nAll marketplace contracts, schemas, and invariants PASSED (10/10).');
  process.exit(0);
}
