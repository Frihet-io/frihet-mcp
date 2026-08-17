# OpenAI-reviewed MCP public contract

The ChatGPT connector exposes exactly 53 reviewed business operations plus the
three read-only discovery operations `list_tool_groups`, `search_tools`, and
`describe_tool`. It exposes zero MCP prompts and zero MCP resources.

The reviewed profile is intentionally narrower than the full MCP catalogue. It
omits banking, payroll/HR, lodging/POS, regulated filing/export workflows,
government identifiers, signing credentials, and webhook secrets. Sensitive
fields are removed from reviewed input/output descriptors and runtime output;
direct MCP behavior is a separate contract.

Load-bearing automated coverage verifies:

- exact tool names, descriptions, schemas, annotations, and OAuth metadata;
- hidden-tool, prompt, and resource exclusion;
- sensitive input/output minimization;
- external-action annotation truth;
- grouped discovery confinement to the reviewed allowlist;
- malformed scoped OpenAPI input/output failing closed.

Human provider-review procedures, accounts, mutation scenarios, credentials,
and release sequencing are intentionally not public runbook material.
