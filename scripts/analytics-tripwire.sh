#!/usr/bin/env bash
# Analytics tripwire — this repo has NO analytics contract.
#
# CI goes RED if any analytics emitter reference (PostHog / ingest proxy)
# appears in src/ or workers/. Green = zero findings.
#
# grep exit codes: 0 = match found (=> FAIL), 1 = no match (=> PASS),
# >=2 = grep error (=> FAIL loudly, never silently green).
#
# Allowlist: none as of 2026-08-07 (first run found zero benign refs).
# If a benign reference ever needs whitelisting, add an explicit
# --exclude=<filename> below with a comment justifying it.
set -u

set +e
grep -rniE 'posthog|i\.posthog\.com|/ingest/' src workers \
  --exclude-dir=__tests__ \
  --exclude-dir=dist
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo ""
  echo "ERROR: MCP no tiene contrato analytics. Si vas a emitir eventos, registra en Frihet-ERP (surface mcp) y monta snapshot+gate como Frihet-Saas-Website." >&2
  exit 1
elif [ "$status" -eq 1 ]; then
  echo "Analytics tripwire: OK — no emitter references in src/ or workers/."
  exit 0
else
  echo "ERROR: grep failed with status $status (tripwire could not run)." >&2
  exit "$status"
fi
