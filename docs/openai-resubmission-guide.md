# OpenAI reviewed-surface contract

The OpenAI deployment is intentionally narrower than the full Frihet MCP
catalogue. Its public runtime contract is:

- 53 reviewed business operations plus 3 read-only discovery operations;
- 0 prompts and 0 resources;
- explicit reviewed-tool allowlisting;
- sensitive reviewed inputs stripped before the backend call;
- sensitive outputs and telemetry redacted;
- a frozen descriptor that fails closed on unreviewed schema, annotation,
  OAuth, prompt, resource, or tool drift.

Review evidence and the deliberate refresh policy live in
`docs/openai-review-descriptor-freeze.md`. Run
`npm run gate:openai-review-descriptor` to verify the committed contract.

Provider credentials, verification material, test accounts, deployment commands,
review correspondence, and resubmission procedures are intentionally maintained
outside this public repository.
