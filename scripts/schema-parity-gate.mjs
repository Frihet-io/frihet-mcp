#!/usr/bin/env node
/**
 * gate:schema-parity — CI entry point for the MCP ⇄ backend output-contract gate.
 *
 * Replays checked-in REAL backend response bodies through a real FrihetClient and
 * the real registered tool handlers, then validates each tool's structuredContent
 * against the outputSchema that tool declares. Offline: node:http on 127.0.0.1,
 * no credentials, no network.
 *
 * Exit codes:
 *   0  no drift (the PASS line names how many tools were scanned and how many
 *      are UNCOVERED — a subset scan never claims a whole-surface invariant)
 *   1  drift: a schema rejects a real response, an envelope leaked, a declared
 *      key is a phantom, a fixture is unroutable, or coverage fell below the floor
 *
 * Usage: npm run gate:schema-parity
 */

import { runSchemaParityGate, formatReport } from "../dist/__tests__/schema-parity.gate.js";

const report = await runSchemaParityGate();
console.log(formatReport(report));
process.exit(report.failures.length === 0 ? 0 : 1);
