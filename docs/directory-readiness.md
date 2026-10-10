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

## Hosted verification limits

Public metadata cannot establish authenticated tool behavior, infrastructure
provenance or provider approval. A deployment dry run is not production
evidence. Hosted authorization also depends on the separately deployed ERP
provisioning contract; local SDK composition does not exercise that lifecycle.

## Claude Directory

The existing [full MCP service](https://mcp.frihet.io/) and
[GitHub MCP Registry entry](https://github.com/mcp/io.frihet/erp) are separate
live distribution surfaces. Full-host discovery has been queried; fresh OAuth
login and every backing operation are not established by that observation.

A **local Claude candidate** now selects 136 of the 158 source operations,
with four fiscal aliases, two corrected prompts, five local resources (one
shared static resource for remote composition), and optional grouped discovery.
The 22 canonical exclusions and all resource/prompt reasons are recorded in
[Anthropic SUBMISSION.md](../marketplace/anthropic/SUBMISSION.md#excluded-operations-and-reasons).
The two-argument full/OpenAI composition and frozen 33-tool OpenAI descriptor
remain compatible; the OpenAI hosted profile is separate from this candidate.

Run `npm run gate:claude-candidate`, `npm run gate:public-capability-truth`,
`npm run gate:agent-onboarding` and `npm run gate:openai-review-descriptor` to
verify the source candidate and compatibility. This is local functionality,
not publication. A local stdio package alone is not a hosted Directory listing.

The current source provisioning contract supports only the OpenAI candidate
binding. The Claude selection has no enabled Worker flag or established hosted
endpoint. This source limitation does not establish whether fresh OAuth on the
existing full service works. Local checks do not establish hosted authorization,
live backing API behavior, provider review or publication.

## References

- https://developers.openai.com/plugins/deploy/app-review
- https://developers.openai.com/plugins/build/auth
- https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy
- https://claude.com/docs/connectors/building/authentication
