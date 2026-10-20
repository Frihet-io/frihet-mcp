# Claude consultation plugin behavior checks

Synthetic records only. The suite advertises the nine consultation tools and
never starts the real MCP server. Tool schemas are extracted from the candidate
SDK fixture, including six business lists and three discovery tools. This does
not prove a hosted catalogue, OAuth login, populated-data acceptance or that
every tool has been exercised. No unavailable detail or write tool is mocked.

Four cases cover verified and unknown balances, missing fiscal treatment in a
chat proposal, a prior unknown write and incomplete monthly pagination. Fixed
list/search responses are bounded scenarios, not emulation of every filter.
Discovery describes only the six business lists; negative graders reject any
attempt to create or send, even though this catalogue does not offer those tools.
Missing fields remain unknown; an accumulated amount paid without a payment
date does not establish collection in the reviewed month.

Run from the repository root:

```bash
claude plugin eval plugins/claude/frihet-erp --runs 3 --ablation none --concurrency 1 --mocks record --allow-tools 'mcp__plugin_frihet-erp_frihet__*' --trust-plugin --no-publish --output-dir /tmp/frihet-claude-plugin-evals
```

The command trusts this authored plugin/suite and grants only the simulated MCP
tools. Do not add --allow-real-servers or --mocks off. Three repeated runs check these bounded scenarios, not production reliability.
The plugin bundles its MCP, so the no-plugin arm has no equivalent connector;
do not use that unequal baseline to claim an improvement in model behavior.
Reports stay local. To refresh schemas, extract the nine named tools from
`tools.grouped` in src/__tests__/fixtures/claude-candidate-contract.json and review
the corresponding discovery fixtures. The package unit tests validate schema
equality; they do not execute this model-behavior suite.
