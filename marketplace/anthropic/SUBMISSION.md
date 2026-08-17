# Anthropic connector public contract

Frihet ERP is exposed through the public MCP identity `io.frihet/erp` and the
remote endpoint `https://mcp.frihet.io/mcp`. The grouped remote profile serves
the 157-operation catalogue plus five fiscal aliases and three local discovery
names. It serves seven static resources and ten prompts.

Per-tool callability and side-effect facts are available in
`_meta["io.frihet/capability"]`. Registration is not an unconditional statement
that a backing API is enabled for every workspace.

Submission credentials, provider allowlists, test accounts, approval state, and
release sequencing are intentionally maintained outside this public repository.
