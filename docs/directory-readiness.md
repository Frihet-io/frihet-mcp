# Hosted directory preparation

The local package, full hosted MCP, reviewed OpenAI MCP, and provider directory
listings are separate release surfaces. A successful build or a Partner Network
membership does not publish a connector.

## OpenAI public preflight

After a production deployment, run:

```sh
npm run check:openai-public-surface
```

This probes only the fixed reviewed host, without credentials or business tool
calls. It compares the root and discovery metadata against the frozen descriptor,
checks OAuth metadata, owner/support pages, unauthenticated MCP protection, and
GET/HEAD containment of the parallel REST specification. Requests and response
bodies are bounded; redirects are not followed and raw bodies are not recorded.

Exit 0 means the **public surface** matches; exit 1 means an observed mismatch;
exit 2 means it could not be established. A DNS failure is not a 404. The JSON
report always sets `submissionReady` to false because this command cannot prove
authenticated tool behavior, reviewer access, Cloudflare provenance, ownership
selection in the portal, or provider approval. Runtime and reviewed-profile
versions remain separate values.

Run its offline regressions with `npm run test:openai-public-surface`. They are
also part of CI. The Worker suite exercises the production root handler to keep
the full and reviewed discovery surfaces distinct.

## Release dependencies

The existing [topology bootstrap](openai-topology-bootstrap.md) still applies.
Do not mark its receipt established from public metadata or replace its checks
with this preflight. The existing deployment workflow's dry-run mode does not
deploy and a successful dry run is not production evidence.

After an authorized deployment, capture the authenticated descriptor with the
existing `scripts/test-openai-full-compose.mjs`, run the generated positive and
negative cases in the reviewer workspace, and finish the manual fields in
[OpenAI SUBMISSION.md](../marketplace/openai/SUBMISSION.md).

## Claude Directory

The full hosted catalogue must not be submitted with a declaration that it has
no financial execution merely because some tools require confirmation. Audit
the effective financial actions and indirect effects before selecting a
directory surface. The existing narrowed business profile is a possible shared
implementation, not an already-approved Claude listing: provider disclosures,
OAuth access, tool capture, reviewer access, and functional cases still need
their own validation. Do not repoint a provider form at the full endpoint as a
fallback when the reviewed endpoint is unavailable.

## References

- https://developers.openai.com/plugins/deploy/app-review
- https://developers.openai.com/plugins/build/auth
- https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy
