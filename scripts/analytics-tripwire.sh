#!/usr/bin/env bash
# Compatibility entrypoint for the parser-backed analytics emitter gate.
#
# The analyzer permits truthful processor disclosures in prose, but rejects
# executable analytics plumbing and drift from the reviewed network-sink
# inventory. CI invokes the analyzer and its anti-defang tests directly; this
# wrapper remains for local callers and older automation.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
node --test scripts/__tests__/analytics-tripwire.test.mjs
exec node scripts/check-no-analytics-emitters.mjs "$@"
