# Public registry contract

Public directories should derive current identity and version from `server.json`
and `package.json`. Capability counts and names are pinned by
`src/__tests__/fixtures/public-capability-contract.json`:

- 157 canonical catalogue operations;
- local full: 162 tool names, 11 resources, 10 prompts;
- grouped remote: 165 tool names, 7 resources, 10 prompts;
- OpenAI reviewed: exactly 33 business tool names with complete descriptions, 0 discovery meta-tools, 0 resources, 0 prompts.

Catalogue membership is not an unconditional availability guarantee. Full
surfaces publish conservative callability and side-effect facts under
`_meta["io.frihet/capability"]`.

Operational directory submissions, credentials, account ownership, approval
state, release sequencing, and provider configuration are intentionally
maintained outside this public repository.
