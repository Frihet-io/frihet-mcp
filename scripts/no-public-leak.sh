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
# PLUS the restricted-brand blocklist over src/ and the published type
# declarations (check 6).
#
# NOTE — this exclusion is RETIRED (2026-08-08). It used to read: 'the payroll
# export format value "holded" ... is lawful referential/interop use and is
# intentionally NOT scanned here'. The interop premise died: the backend's
# EXPORT_FORMATS is ['a3','contasol','sage','siltra'] (erp-main@568b0d29d
# functions/src/publicApi/families/payroll.ts:47) and anything else 400s at
# payroll.ts:160-166. So the literal was not interop — it advertised a format
# the platform rejects, AND shipped the brand to npm inside dist/*.d.ts.
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

# 4. No internal doctrine / internal-tooling markers on prose surfaces (July-2026
#    leak class: CLAUDE.md carried the "north star" roadmap + moat doctrine, and
#    AGENTS.md carried internal multi-agent dispatch + LLM-router cost rules).
#    Public-repo CLAUDE.md/AGENTS.md are docs for EXTERNAL contributors, never
#    internal operating docs.
if grep -rinE "north.?star|moat|SOUL\.md|~/\.claude/bin|litellm|sonnet worker|multi-agent dispatch|doctrina|doctrine" \
     --include="*.md" --include="*.ts" --include="*.js" --include="*.toml" . 2>/dev/null | grep -v node_modules | grep -v "/dist/" | grep -v "scripts/no-public-leak.sh"; then
  note "Internal doctrine / internal-tooling marker found — public repo docs are for external contributors only."
fi

# 5. Strategy/secret-named files must never be tracked (recurrence guard).
if git ls-files | grep -inE "strategy|roadmap|secrets?\.md$|decision_spec" ; then
  note "Strategy/secrets-named file tracked in public repo — keep these in a private repo."
fi

# 6. Restricted brands must not reach SOURCE or the PUBLISHED type declarations.
#
#    WHY THIS CHECK EXISTS AND WHY IT IS NOT NARROWER: erp-main's
#    scripts/gate-brand-blocklist.ts records that the "holded" ban has regressed
#    THREE times, each on a surface the previous guard did not watch — the third
#    being `EXPORT_FORMATS` in functions/src/publicApi/families/payroll.ts, the
#    very array this repo mirrors. Here the brand survived in three TypeScript
#    unions (client.ts, client-interface.ts, demo-client.ts) after being removed
#    from the tool enum, and package.json#files publishes `dist` (excluding only
#    __tests__ and *.map), so `npm i @frihet/mcp-server` shipped it in
#    dist/client.d.ts, dist/client-interface.d.ts and dist/demo-client.d.ts.
#    Check 1 above only ever scanned workers/.
#
#    dist/ is scanned when present so a stale build cannot ship what src/ no
#    longer contains; it is skipped when absent (fresh clone, pre-build CI).
RESTRICTED_BRANDS="holded"
if grep -rinE "$RESTRICTED_BRANDS" src/ 2>/dev/null; then
  note "Restricted brand found in src/ — it reaches npm through dist/*.d.ts. Remove the literal."
fi
if [ -d dist ] && grep -rinE "$RESTRICTED_BRANDS" dist --include="*.d.ts" --include="*.js" 2>/dev/null; then
  note "Restricted brand found in a BUILT artifact under dist/ — rebuild after removing it from src/."
fi

if [ "$fail" -eq 0 ]; then
  echo "✓ no-public-leak: clean (no competitor comparison, strategy secret, or internal doctrine on public surface)"
fi
exit $fail
