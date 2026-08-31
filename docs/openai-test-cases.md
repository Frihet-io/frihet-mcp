# OpenAI-reviewed MCP public contract

The ChatGPT connector exposes exactly 33 reviewed business operations with full
model-facing descriptions. It exposes no discovery meta-tools, zero MCP prompts,
and zero MCP resources.

The reviewed profile omits the legacy monthly summary, banking, payroll/HR, accommodation/POS, regulated
filing and e-invoicing, signing credentials, raw invoice documents, direct email,
updates to existing quotes, client-parent deletion, expense deletion, product deletion, vendor deletion, and
webhook administration. Its schemas have no dedicated government-identifier,
banking-identifier, or precise-address fields. Direct MCP behavior is a separate
contract.

The generated provider package contains five positive and three negative test
cases. Positive cases cover business context, invoice reads, draft-invoice
creation, expense creation, and the product catalogue. Negative cases verify
that payroll/HR execution, banking records, and Peppol delivery-receipt or
regulated e-invoice submission tracking do not invoke Frihet.

Load-bearing automated coverage verifies:

- the exact 33 tool names, descriptions, schemas, annotations, and OAuth metadata;
- explicit confirmation and real handler enforcement for all 16 writes;
- truthful numbering, implicit-record, accounting, analytics, notification,
  referral, deletion/cancellation, and conditional webhook effects;
- the absence of direct email, `update_quote`, invoice lifecycle/credit tools,
  raw documents, webhook administration, prompts, and resources;
- closed input/output schemas and sensitive-field minimization/redaction;
- absence of grouped discovery tools from the OpenAI host;
- PKCE validation, atomic one-time OAuth state, canonical resource/audience,
  host isolation, and MCP-only authentication challenges;
- GET and HEAD 404 containment for `/openapi.json` and `/openapi.yaml`;
- reviewed root, server card, legal links, and crawler metadata.

Human provider-review procedures, accounts, credentials, CAPTCHA handling, and
release sequencing are intentionally not public runbook material.
