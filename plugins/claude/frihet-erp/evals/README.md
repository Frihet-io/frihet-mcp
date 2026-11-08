# Claude operational plugin behavior checks

Synthetic records only. Six scenarios exercise receivables, incomplete monthly
pagination, missing fiscal treatment, a prior unknown invoice write, an explicitly
authorized expense creation and an ambiguous bank reconciliation. They check
useful completed work as well as boundaries: approval already supplied must not
cause a loop, an uncertain write must not duplicate, and a review must not write.

This model suite uses a bounded subset of the operational catalogue, with exact
schemas extracted from the SDK candidate. It never starts the real MCP server.
Fixed lists/search responses are scenario fixtures, not emulation of all filters
or all tools. Detail lookup uses the requested fixture ID or tool name. Missing
fields remain unknown, and a paid amount without a payment date does not prove
collection in the reviewed month. These scenarios do not establish hosted OAuth,
API acceptance, full catalogue coverage, or a measured model result until run.

Run from the repository root:

```bash
claude plugin eval plugins/claude/frihet-erp --runs 3 --ablation none --concurrency 1 --mocks record --allow-tools 'mcp__plugin_frihet-erp_frihet__*' --trust-plugin --no-publish --output-dir /tmp/frihet-claude-plugin-evals
```

Use the authorized Claude account and its existing plan. Do not add
`--allow-real-servers` or `--mocks off`. Reports stay local. The bundled connector
makes the no-plugin arm unequal; do not infer an improvement from that baseline.
Refresh `_tools.json` and detail fixtures from the exact candidate descriptors.
Package unit tests check schema parity only; they do not execute this model suite.
