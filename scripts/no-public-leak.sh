#!/usr/bin/env bash
# =============================================================================
# no-public-leak.sh — prevent competitor-comparison, internal-strategy, and
# operational submission material from entering this public repo/package.
#
# Scope: marketing/strategy prose surfaces plus public functional payroll
# contracts. Unsupported provider labels must not survive in client, schema,
# demo, or tool source after the ERP contract removes them.
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

# 1b. Payroll contract source must match the ERP's accepted format enum. Keep
# this explicit list load-bearing: a stale label in any runtime/interface/schema
# copy is a public phantom operation even if the tool description is clean.
functional_payroll_contracts=(
  src/client.ts
  src/client-interface.ts
  src/demo-client.ts
  src/tools/payroll.ts
  src/tools/shared.ts
)
if grep -inE "holded" "${functional_payroll_contracts[@]}" 2>/dev/null; then
  note "Unsupported payroll provider label found in a public functional contract."
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

# 4. Public-repo contributor docs must not carry internal doctrine, private
# operating methods, or internal tooling/cost configuration.
if grep -rinE "north.?star|moat|SOUL\.md|~/\.claude/bin|litellm|sonnet worker|multi-agent dispatch|doctrina|doctrine" \
     --include="*.md" --include="*.ts" --include="*.js" --include="*.toml" . 2>/dev/null | grep -v node_modules | grep -v "/dist/" | grep -v "scripts/no-public-leak.sh"; then
  note "Internal doctrine / internal-tooling marker found — public repo docs are for external contributors only."
fi

# 5. Strategy/secret-named files must never be tracked (recurrence guard).
if git ls-files | grep -inE "strategy|roadmap|secrets?\.md$|decision_spec" ; then
  note "Strategy/secrets-named file tracked in public repo — keep these in a private repo."
fi

# 6. Marketplace directories are public metadata, never an operational
# submission runbook. Keep credentials, provider mutations, test-account setup,
# approval sequencing, and private review narratives out of the tracked tree.
public_marketplace_docs=(
  USAGE_EXAMPLES.md
  marketplace
  docs/observability.md
  docs/openai-test-cases.md
  docs/openai-review-descriptor-freeze.md
  docs/openai-resubmission-guide.md
  docs/RELEASE_NOTES_1.13.0.md
  docs/stay-tools-design.md
  REGISTRY-SUBMISSION-CHECKLIST.md
)
if grep -rinE "DO NOT SUBMIT|OPENAI_TOKEN_GOES_HERE|wrangler (deploy|secret put)|test account at https|submit (first|last)|submission order|awaiting .* final OK|rejection was caused|gh release create|re-triggers crawls|approval needed|night sprint|wave [0-9]+ candidate|--print-current|FRIHET_API_KEY=.*node scripts/test-openai" \
     "${public_marketplace_docs[@]}" 2>/dev/null; then
  note "Operational marketplace/submission intelligence found in public docs."
fi

if [ "$fail" -eq 0 ]; then
  echo "✓ no-public-leak: clean (no competitor comparison, strategy secret, internal doctrine, or submission runbook)"
fi
exit $fail
