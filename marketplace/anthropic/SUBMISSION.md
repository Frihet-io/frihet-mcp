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

Before a hosted-directory submission, resolve financial-execution capabilities
against the directory policy, select the intended server-enforced catalogue,
and validate OAuth and every submitted case in a dedicated reviewer workspace.
Confirmation does not substitute for directory eligibility. See
[hosted directory preparation](../../docs/directory-readiness.md).

The desktop bundle under `connector/` is a separate distribution artifact; it
does not establish the status of the hosted Directory listing.
