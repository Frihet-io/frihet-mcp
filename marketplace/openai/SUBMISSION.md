# OpenAI-reviewed public contract

Release `1.16.6` is the frozen candidate for this separately reviewed MCP
surface:

- portal Identity `Business — Frihet` and Plugin Author `Frihet`, matching
  the Frihet trade name; the live website, connector privacy/support,
  submission-description, terms, and JSON-LD surfaces must preserve the legal
  ownership chain to controller and operator `VICTOR BERTHELIUS PATO`;
- endpoint `https://openai-mcp.frihet.io/mcp`;
- OAuth issuer/resource `https://openai-mcp.frihet.io` and sole scope
  `frihet:workspace.manage`;
- exactly 33 reviewed business operations with complete descriptions and no
  discovery meta-tools;
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

The candidate may be released only through the independent OpenAI-specific
workflow, bound to one exact current `origin/main` source, the workflow and
successful CI at that source, exact configuration/assets, and an exact
dry-run/deploy bundle digest. It does not inherit authority from npm, a GitHub
Release, a tag, or the default/full Worker. The Full release is separately on
HOLD until Frihet implements and independently reviews a dedicated,
server-derived Full OAuth lifecycle authority and separate credential. This
document describes the candidate contract; it does not claim that either
deployment or the provider submission has occurred.

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
cannot mark the expense paid or file anything. If no exact vendor match exists,
vendor creation is a separate backend step, so that new vendor can remain even
if the subsequent expense write fails. Expense updates cannot change
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

Before the portal action, live-smoke the dedicated privacy and support pages and
their ownership statement, then select the exact Identity and Plugin Author
above. Do not select or search for a `Business — VICTOR BERTHELIUS PATO` label:
that portal option does not exist in the verified 2026-09-04 draft. A different
Identity/author, an Individual identity, or a draft whose public owner
evidence is not yet live is not eligible for submission.

Enter the manual portal fields exactly as follows after those URLs are live:

- Identity: `Business — Frihet`;
- Plugin Author: `Frihet`;
- website: `https://www.frihet.io`;
- connector support: `https://openai-mcp.frihet.io/support`;
- privacy policy: `https://openai-mcp.frihet.io/privacy`;
- terms: `https://www.frihet.io/es/terms`;
- support email: `ayuda@frihet.io`.

The upload schema cannot populate these ownership, URL, or contact fields, so
schema validation of `chatgpt-app-submission.json` is not evidence that the
portal values are complete.

Use the checked-in 512 px PNG assets for the portal previews; do not export or
resize them during submission:

- light-mode directory/composer: `marketplace/openai/frihet-composer.png`;
- dark-mode directory: `marketplace/openai/frihet-directory-dark.png`;
- dark-mode composer: `marketplace/openai/frihet-composer-dark.png`.

All three use the same 184 px-radius Frihet mark on a transparent 512 px canvas,
so the light and dark previews have identical geometry.
