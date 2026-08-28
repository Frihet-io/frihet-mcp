# OpenAI review contract v4

The ChatGPT connector exposes exactly 33 reviewed business operations plus 3
read-only discovery operations, with zero MCP prompts and zero MCP resources.

`src/__tests__/fixtures/openai-review-descriptor.snapshot.json` is the canonical
review artifact. It is captured through the production composition path and
contains the complete `tools/list` descriptor together with the OAuth discovery
contract. The checker canonicalizes only JSON object-key order and tool order;
schema arrays and semantic values remain exact.

Contract v4 combines an exact reviewed snapshot with fail-closed invariants:

- all action annotations are explicit booleans and every business write requires
  a literal, handler-enforced `confirm=true`;
- every reviewed input is closed, and every output object is recursively closed
  with `additionalProperties:false` and at least one declared property;
- `create_invoice` and `create_quote` force draft status, hide lifecycle status,
  reserve a number, advance the numbering counter, and disclose possible client
  creation;
- `create_expense` requires an explicit date and deductible choice, and cannot
  accept `paidDate`, mark a payment, or choose a separate cash-basis payment
  period;
- `update_expense` cannot change supplier identity without a matching internal
  identity re-resolution; date and deductible changes disclose their accounting
  and future tax-report effects;
- `get_monthly_summary`, `update_quote`, direct email, invoice lifecycle/credit operations, raw invoice
  PDFs, client-parent deletion, expense deletion, product deletion, vendor deletion, and webhook administration
  cannot enter the reviewed surface;
- `delete_quote` truthfully distinguishes permanent draft deletion from non-
  draft cancellation and discloses its possible webhook event;
- ten conditionally/open-world writes disclose existing owner-configured webhook
  delivery; CRM activity distinguishes call/meeting/email from task behavior;
- discovery advertises only `invoicing`, `expenses`, `crm`, `intelligence`, and
  `catalog`;
- dedicated government identifiers, banking identifiers, precise addresses,
  credentials, opaque documents, prompts, resources, and non-reviewed tools fail
  closed;
- OAuth issuer/resource/scope, provider version, PKCE S256, one-time state,
  protected-resource metadata, and the MCP-only `WWW-Authenticate` challenge are
  pinned;
- the reviewed host serves no OpenAPI document: GET and HEAD requests to
  `/openapi.json` and `/openapi.yaml` return 404.

The profile is subtractive. Capabilities omitted here remain available only to
direct MCP clients under the full-server contract.

Run the contract checks with:

```bash
npm run test:openai-review-descriptor
npm run gate:openai-review-descriptor
npm run gate:openai-submission
npm run gate:public-capability-truth
```

## Refresh policy

Do not refresh the snapshot for formatting, dependency churn, or merely to make
CI green. A deliberate reviewed-surface change requires:

1. Capture the candidate through the real MCP composition path.
2. Inspect every tool, schema, description, annotation, prompt/resource count,
   and OAuth difference.
3. Verify the generated submission JSON has identical tool names and portal
   annotations.
4. Replace the fixture only after that review.
5. Run the root and Worker suites, descriptor/submission gates, OpenAPI 404
   containment checks, and a live read-only smoke after deployment.

The gate never deploys, publishes, changes OAuth configuration, or submits to a
provider. Credentials, reviewer accounts, and provider operations remain
outside this public repository.
