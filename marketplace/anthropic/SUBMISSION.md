# Anthropic connector surfaces

> **Deployment status: not deployed.** Everything below describes the source on
> `main`. As of 28 September 2026 the live reviewed host still serves an older
> release (1.16.5) without the support/privacy pages, the path-inserted OAuth
> metadata or the reviewed tool set described here. A Claude connection to
> this endpoint only works after the release dependencies in
> [hosted directory preparation](../../docs/directory-readiness.md#release-dependencies)
> are completed: the ERP OAuth provisioning deployment, the Worker topology
> bootstrap and a verified release. The listing is ready only after an
> authenticated connection from Claude has been tested against the deployed
> endpoint.

Frihet ERP uses the public MCP identity `io.frihet/erp`. Two hosted endpoints
exist, and only one of them is intended for the Claude connectors directory.

| Surface | Endpoint | Intended use |
|---|---|---|
| Reviewed connector | `https://openai-mcp.frihet.io/mcp` | Claude connectors directory submission; the same host serves the ChatGPT/Codex plugin |
| Full hosted profile | `https://mcp.frihet.io/mcp` | Custom connectors and direct MCP clients that need the full catalogue |

## Why the directory uses the reviewed connector

The [Anthropic Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy)
section 4.A excludes software that transfers money or executes financial
transactions unless Anthropic permits it in writing. The full hosted profile
registers `refund_sale`, which the Frihet API executes as a POS refund with a
server-side Stripe reversal and a fiscal credit note, plus invoice and quote
email delivery and regulated fiscal submissions. Requiring
`confirm=true` does not change what those operations do, so the full profile
is not submitted.

The reviewed connector registers only the reviewed business tools listed in
`src/openai-profile.ts` (`includeTools`); every other operation is dropped at
registration, not hidden in the listing. It serves no MCP resources, no MCP
prompts and no discovery meta-tools, so no generic tool can dispatch an
excluded operation. `src/__tests__/directory-profile-policy.test.ts` asserts
this on the real MCP wire, including that calling `refund_sale`,
`refund_deposit` or `send_invoice` by name fails without reaching the Frihet
API client, and that every tool carries `title`, `readOnlyHint` and
`destructiveHint` (policy section 5.E).

Obtain the current tools from the authenticated deployed endpoint before
submitting; repository counts alone do not establish what is live.

## OAuth (as implemented on `main`; not yet deployed)

In the source on `main`, the `401` challenge on `/mcp` points its
`resource_metadata` to
`https://openai-mcp.frihet.io/.well-known/oauth-protected-resource/mcp`. That
document names `resource` as the exact connector URL
`https://openai-mcp.frihet.io/mcp`, as
[Claude's connector authentication guide](https://claude.com/docs/connectors/building/authentication)
requires. The authorization server offers Dynamic Client Registration, S256
PKCE and the single scope `frihet:workspace.manage`. The root metadata
document keeps the origin as `resource`. The authorization boundary and the
`/token` rotation guard accept either value for this host only, and the
authorize → token → refresh flow for both values is covered by
`workers/remote-mcp/src/__tests__/reviewed-oauth-e2e.test.ts`. That test uses
the locked provider with in-memory storage; it is not a test against the
deployed service.

## Links for the listing (valid only after deployment)

- Support: `https://openai-mcp.frihet.io/support`
- Privacy notice for the reviewed connector: `https://openai-mcp.frihet.io/privacy`
- Terms: `https://www.frihet.io/es/terms`
- Source: `https://github.com/Frihet-io/frihet-mcp`

Per-tool callability and side-effect facts are available in
`_meta["io.frihet/capability"]` on the full hosted profile. Registration is not
an unconditional statement that a backing API is enabled for every workspace.

Submission credentials, provider allowlists, test accounts, approval state, and
release sequencing are intentionally maintained outside this public repository.

See [hosted directory preparation](../../docs/directory-readiness.md) before a
hosted-directory submission.

The desktop bundle under `connector/` is a separate distribution artifact; it
does not establish the status of the hosted Directory listing.
