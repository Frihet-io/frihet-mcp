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
the two cannot drift apart, checks OAuth metadata, owner/support pages,
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

## References

- https://developers.openai.com/plugins/deploy/app-review
- https://developers.openai.com/plugins/build/auth
