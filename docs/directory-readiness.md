# Hosted directory preparation

The local package, full hosted MCP, reviewed OpenAI MCP, and provider directory
listings are separate release surfaces. A successful build does not publish a
connector.

## OpenAI public preflight

After a production deployment, run:

```sh
npm run check:openai-public-surface
```

This probes only the fixed reviewed host, without credentials or business tool
calls. It validates the root, discovery, and manifest metadata against the same
reviewed-host shape and cross-checks the root against the discovery response so
the two cannot drift apart, checks OAuth metadata (the root protected-resource
document and the path-inserted one the 401 challenge points to), owner/support pages,
unauthenticated MCP protection, and GET/HEAD containment of the parallel REST
specification. Requests and response bodies are bounded; redirects are not
followed and raw bodies are not recorded.

Exit 0 means the **public surface** matches; exit 1 means an observed mismatch;
exit 2 means it could not be established. A DNS failure is not a 404. The JSON
report always sets `submissionReady` to false because this command cannot prove
authenticated tool behavior, infrastructure provenance, or provider approval.
Runtime and reviewed-profile versions remain separate values.

Run its offline regressions with `npm run test:openai-public-surface`. They are
also part of CI. The Worker suite statically asserts that the reviewed host's
root is served by the same pre-routing interception as its discovery metadata
(index.ts cannot be imported under the node test runner), and separately
exercises the full host's root handler, including its fail-closed refusal when
the reviewed profile is set.

## Release dependencies

The [topology bootstrap](openai-topology-bootstrap.md) still applies. Do not
mark its receipt established from public metadata or replace its checks with
this preflight. The deployment workflow's dry-run mode does not deploy, and a
successful dry run is not production evidence. OAuth sign-in on the reviewed
host also depends on the separately deployed Frihet API-key provisioning
endpoint and the `FRIHET_OAUTH_API_KEY` Worker secret; without the secret the
callback answers 503, and without the endpoint it answers 502.

After an authorized deployment, capture the authenticated descriptor with
`scripts/test-openai-full-compose.mjs`, run the positive and negative cases in
the reviewer workspace, and finish the manual fields in
[OpenAI SUBMISSION.md](../marketplace/openai/SUBMISSION.md).

## Claude Directory

The Claude listing uses the reviewed connector at
`https://openai-mcp.frihet.io/mcp`, not the full hosted catalogue; see
[Anthropic SUBMISSION.md](../marketplace/anthropic/SUBMISSION.md) for the
policy reasoning. The reviewed host's support and privacy pages name both
assistant providers (OpenAI for ChatGPT and Codex, Anthropic for Claude) as
recipients of tool inputs and results. Its 401 challenge points to
`/.well-known/oauth-protected-resource/mcp`, whose `resource` equals the
connector URL, as Claude requires; the root document keeps the origin and
both values are accepted by the authorization boundary.

Before submitting, connect Claude to the deployed endpoint as a custom
connector with the reviewer workspace, confirm OAuth, capture the tool list,
and run the listed prompts. Do not repoint the form at the full endpoint as a
fallback when the reviewed endpoint is unavailable.

## References

- https://developers.openai.com/plugins/deploy/app-review
- https://developers.openai.com/plugins/build/auth
- https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy
- https://claude.com/docs/connectors/building/authentication
