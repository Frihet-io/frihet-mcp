#!/usr/bin/env bash
# Guard: the canonical Cloud Functions region is europe-west1. us-central1 is the
# legacy region and 404s (it silently broke /health and the api-proxy before).
# Fail if any us-central1 reference sneaks into source. Annotate a legitimate
# historical mention with "region-gate:ok" on the same line to allow it.
set -euo pipefail
cd "$(dirname "$0")/.."

# Match the actual function hostname prefix ("us-central1-<project>.cloudfunctions.net"),
# not the bare word in prose/comments explaining why we avoid it.
hits=$(grep -rIn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude=no-legacy-region.sh "us-central1-" -- . 2>/dev/null | grep -v "region-gate:ok" || true)

if [ -n "$hits" ]; then
  echo "❌ legacy region us-central1 found (canonical is europe-west1):"
  echo "$hits"
  echo
  echo "Fix: use europe-west1. If a mention is intentional/historical, append '# region-gate:ok'."
  exit 1
fi
echo "✓ no legacy us-central1 references (europe-west1 canonical)"
