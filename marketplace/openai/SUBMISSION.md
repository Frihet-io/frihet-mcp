# OpenAI-reviewed public contract

Release `1.16.6` is submitted as a separately reviewed MCP surface:

- endpoint `https://openai-mcp.frihet.io/mcp`;
- OAuth issuer/resource `https://openai-mcp.frihet.io` and sole scope
  `frihet:workspace.manage`;
- 33 reviewed business operations plus 3 read-only discovery operations
  (36 total);
- 0 prompts and 0 resources;
- literal `confirm=true` enforced for all 16 business writes;
- closed input schemas and recursively closed, non-empty output schemas;
- no dedicated government-identifier, banking-identifier, precise-address,
  credential, or regulated-payload fields;
- selected client contacts and client notes can be permanently deleted after
  explicit confirmation; a clean draft quote with no delivery, response,
  attachment, or conversion evidence can also be deleted, a protected draft is
  refused, and deleting a non-draft quote cancels it;
- no direct email, legacy monthly summary, raw document retrieval, update to an existing quote, invoice
  lifecycle/credit action, client-parent deletion, expense deletion, product deletion, vendor deletion, webhook
  administration, regulated filing, payroll/HR, banking, or accommodation/POS;
- GET and HEAD `/openapi.json` and `/openapi.yaml` return 404.

Ten confirmed writes can deliver full events to active endpoints previously
configured by the workspace owner. These deliveries sit outside the reviewed
MCP response schema and can include the complete underlying record, including
fields not exposed to ChatGPT. Creating an invoice or expense may also
notify eligible workspace members through in-app/Novu notifications and may
award first-use referral credits; invoice creation may send minimized usage
analytics to PostHog's EU-hosted analytics service. A call, meeting, or email CRM
activity can emit `client.updated`, while a task activity does not update the
parent client. Expense creation requires an explicit date and deductible choice;
the date determines its accounting/future tax-report period, but this surface
cannot mark the expense paid or file anything. Expense updates cannot change
the amount or linked supplier identity.

The exact `tools/list` descriptor is pinned in
`src/__tests__/fixtures/openai-review-descriptor.snapshot.json`. The uploadable
provider form is generated, never hand-maintained:

```bash
npm run generate:openai-submission
npm run gate:openai-review-descriptor
npm run gate:openai-submission
```

Do not infer this capability set from the full MCP catalogue. Operational
submission steps, reviewer credentials, CAPTCHA handling, provider
configuration, and test accounts are intentionally not stored here.
