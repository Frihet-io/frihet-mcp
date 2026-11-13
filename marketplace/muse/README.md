# Frihet Muse candidate profile

**Status: `SOURCE_PREPARED`.** This directory contains a repository-owned candidate
inventory for the local Frihet MCP Muse profile. It does not establish submission,
partner approval, an official Meta connector, or an enabled remote Muse service.

Tracking issue: [berthelius/Frihet-ERP#2291](https://github.com/berthelius/Frihet-ERP/issues/2291).

## Verified local scope

The local stdio entry point reads `FRIHET_MUSE_MODE=true` and selects
[`src/muse-profile.ts`](../../src/muse-profile.ts) through
[`localMcpSurfaceComposition`](../../src/server-composition.ts). The existing
composition tests cover full tool-exposure mode (`FRIHET_TOOL_MODE=full`):
18 tool names, no resources, no prompts, invoice and quote draft enforcement,
selected output-redaction cases, and mutually exclusive profiles.

These are local tests with stubbed API responses. They do not verify a live
workspace, the remote Worker, Meta authentication, or a partner submission.
For local package connection requirements, see the [main README](../../README.md).

## Candidate tool inventory

| Area | Tool names |
|---|---|
| Business context | `get_business_context`, `get_monthly_summary`, `get_quarterly_taxes` |
| Invoices | `list_invoices`, `get_invoice`, `search_invoices`, `create_invoice` |
| Expenses | `list_expenses`, `get_expense`, `create_expense` |
| Clients | `list_clients`, `get_client`, `create_client` |
| Products | `list_products`, `get_product` |
| Quotes | `list_quotes`, `get_quote`, `create_quote` |

Read the connected session's schemas, tool descriptions and capability metadata
before invoking tools. Catalogue membership does not establish workspace access
or successful backend execution.

## What the local code enforces

- `create_invoice` and `create_quote` force `status: "draft"`. The Muse profile
  does not force draft status for `create_expense` or `create_client`, and a draft
  can still have numbering, usage or other backend effects. The allowlist contains
  no direct fiscal-submission tool.
- Results pass through `deepRedact` and `redactText` in
  [`src/redaction.ts`](../../src/redaction.ts): named sensitive fields are removed
  from structured data and matching serialized JSON fields from text. This is
  not general anonymization of names, email addresses, addresses or arbitrary prose.
- The shared HTTP client supplies a request `Idempotency-Key` and reuses it for
  its retries. Separate tool invocations can receive separate keys; this does
  not guarantee deduplication of repeated business intent.
- Operational logging does not establish a Muse-specific, tamper-evident audit
  trail with caller identity, workspace and complete parameters.

## Remote integration remains unvalidated

The current remote Worker does not select the Muse profile. The generic endpoint
`https://mcp.frihet.io/mcp` must not be described as an authenticated 18-tool Muse
service on the strength of these local tests. No validated Muse-specific remote
authentication configuration is supplied here, and no Zapier-to-Muse deployment
is asserted.

Before describing a hosted Muse connector as available, validate its exact
endpoint, provider-supported authentication contract, workspace isolation,
`tools/list` output and relevant read/write behavior. Submission, review and
publication remain separate states.

## Inventory format and validation

[`manifest.json`](./manifest.json) is a candidate inventory maintained by Frihet,
not a provider-ready manifest or an official Meta schema. It preserves
`capabilities.tools` for the repository's existing validator and deliberately
omits unvalidated remote transport and authentication settings.

Run the existing local checks:

```bash
npm run build
node --test dist/__tests__/muse-profile.test.js
node scripts/check-marketplace-contracts.mjs
```

The marketplace check verifies JSON parsing and selected repository invariants;
it does not validate an official Muse schema or demonstrate partner acceptance.
