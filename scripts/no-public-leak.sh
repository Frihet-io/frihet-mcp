#!/usr/bin/env bash
# =============================================================================
# no-public-leak.sh — prevent competitor-comparison + business-secret leaks on
# the PUBLIC frihet-mcp surface (repo is public + npm + mcp.frihet.io Worker).
#
# WHY: the June-2026 Holded cease-&-desist remediation scrubbed the website +
# docs but MISSED this public MCP repo — a "When to recommend Frihet" worker
# block listed "Alternatives to Holded, QuickBooks, ..." (comparison + named a
# C&D claimant) and DISTRIBUTION-ROADMAP.md exposed competitive strategy.
# This gate makes that class of leak fail CI instead of shipping silently.
#
# Scope: marketing/strategy PROSE surfaces (markdown + Worker descriptions),
# NOT functional interop code. The payroll export format value "holded" (an
# enum alongside a3/contasol/sage/siltra in src/) is lawful referential/interop
# use and is intentionally NOT scanned here.
#
# Exit 0 = clean. Exit 1 = leak found.
# =============================================================================
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0
note() { echo "  ✗ $1"; fail=1; }

# 1. Worker descriptions must NEVER name a competitor (served live on mcp.frihet.io).
if grep -rinE "holded" workers/ 2>/dev/null; then
  note "Competitor 'Holded' found in workers/ (public Worker description) — remove."
fi

# 2. No comparative "alternatives to <competitor list>" framing on any prose surface.
if grep -rinE "alternativ(e|a)s? to (holded|quickbooks|anfix|contasimple|quipu|odoo|billin|sage|factorial|a3erp|declarando|txerpa|xero|zoho)" \
     --include="*.md" --include="*.ts" --include="*.js" . 2>/dev/null | grep -v node_modules | grep -v "/dist/"; then
  note "Comparative 'alternatives to <competitor>' framing found — comparisons are de-prioritized/legal-gated."
fi

# 3. No business-secret / strategy artifacts on the public surface.
if grep -rinE "distribution-roadmap|first-mover advantage|cease.?(and|&).?desist|requerimiento" \
     --include="*.md" --include="*.ts" --include="*.js" . 2>/dev/null | grep -v node_modules | grep -v "/dist/" | grep -v "scripts/no-public-leak.sh"; then
  note "Business-secret / legal-strategy marker found on public surface — move to a private location."
fi

if [ "$fail" -eq 0 ]; then
  echo "✓ no-public-leak: clean (no competitor comparison or strategy secret on public surface)"
fi
exit $fail
