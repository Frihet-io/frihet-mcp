# OpenAI-reviewed public contract

The ChatGPT/OpenAI deployment is a separately reviewed MCP surface:

- 53 reviewed business operations;
- 3 read-only discovery operations;
- 0 prompts;
- 0 resources;
- sensitive reviewed fields are stripped or redacted by the frozen profile.

The exact tools/list descriptor is pinned by
`src/__tests__/fixtures/openai-review-descriptor.snapshot.json` and
`npm run gate:openai-review-descriptor`. Do not infer OpenAI capability from the
full 157-operation catalogue.

Operational submission steps, reviewer credentials, challenge values, provider
configuration, and test accounts are intentionally not stored in this public
repository.
