# Claude plugin behavior checks

Synthetic records only. The suite uses mocked Frihet tools and never starts the
real MCP server. Tool schemas are extracted from the local candidate SDK fixture;
this is not proof of a hosted catalogue or OAuth login. Four cases cover remaining
receivables, missing fiscal treatment, a prior unknown write and incomplete monthly
pagination. Negative tool graders prevent creation and sending in these cases.

Run from the repository root:

```bash
claude plugin eval plugins/claude/frihet-erp --runs 3 --ablation none --concurrency 1 --mocks record --allow-tools 'mcp__plugin_frihet-erp_frihet__*' --trust-plugin --no-publish --output-dir /tmp/frihet-claude-plugin-evals
```

The command trusts this authored plugin/suite and grants only the simulated MCP
tools. Do not add --allow-real-servers or --mocks off. Three repeated runs check these bounded scenarios, not production reliability.
The plugin bundles its MCP, so the no-plugin arm has no equivalent connector;
do not use that unequal baseline to claim an improvement in model behavior. Reports stay local. To refresh schemas, extract the named
tools from src/__tests__/fixtures/claude-candidate-contract.json and review them.
