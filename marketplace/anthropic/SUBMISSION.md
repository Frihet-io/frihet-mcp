# Anthropic connector surfaces

Frihet ERP uses the public MCP identity `io.frihet/erp` and the default remote
endpoint `https://mcp.frihet.io/mcp`. That is the full hosted profile, not proof
of a Claude Directory submission or approval. Obtain its current tools,
resources, and prompts from the authenticated deployed endpoint; repository
counts alone do not establish what is live.

Per-tool callability and side-effect facts are available in
`_meta["io.frihet/capability"]`. Registration is not an unconditional statement
that a backing API is enabled for every workspace.

Submission credentials, provider allowlists, test accounts, approval state, and
release sequencing are intentionally maintained outside this public repository.

See [hosted directory preparation](../../docs/directory-readiness.md) before a
hosted-directory submission.

The desktop bundle under `connector/` is a separate distribution artifact; it
does not establish the status of the hosted Directory listing.
