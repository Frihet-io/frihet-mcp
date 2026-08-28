# OpenAI reviewed-surface contract

Frihet's ChatGPT deployment is deliberately narrower than the full MCP
catalogue. Release `1.16.6` exposes this public contract:

- MCP endpoint: `https://openai-mcp.frihet.io/mcp`;
- OAuth issuer and protected resource: `https://openai-mcp.frihet.io`;
- sole OAuth scope: `frihet:workspace.manage`;
- 33 reviewed business operations plus 3 read-only discovery operations
  (`list_tool_groups`, `search_tools`, and `describe_tool`), 36 total;
- 0 prompts and 0 resources;
- literal `confirm=true` required and enforced for all 16 business writes;
- closed input objects and recursively closed, non-empty output objects;
- reviewed government-identifier, credential, banking-identifier, and precise-
  address fields removed, with runtime output and telemetry redaction;
- `/openapi.json` and `/openapi.yaml` return 404 on the reviewed host.

The connector does not offer direct email delivery. It also excludes the legacy
monthly summary, raw
documents, invoice lifecycle and credit operations, updates to existing quotes,
client-parent deletion, expense deletion and linked-file erasure, product
deletion, vendor deletion, webhook
administration, payroll/HR, banking, accommodation/POS, signing credentials,
regulated e-invoicing, filing, and export workflows.

Webhook administration being absent does not mean that every write is closed-
world. Ten confirmed operations can deliver full business events to active
endpoints that the workspace owner configured elsewhere. Those deliveries are
outside the reviewed MCP response schema and can include the complete
underlying record, including fields the connector does not expose to ChatGPT.
Logging a call,
meeting, or email can emit `client.updated`; logging a task does not update the
parent client. Creating an invoice or expense can also notify eligible
workspace admins/accountants in-app and through Novu and can award first-use
referral credits. Invoice creation may send minimized activation/usage analytics
to PostHog's EU-hosted analytics service.

Creating an invoice or quote always creates a draft, reserves a document number,
advances the workspace numbering counter, and may create/link a client. Creating
an expense requires an explicit date and deductible choice, may create/link a
vendor, and changes internal accounting/future tax-report inputs. The date
determines its accounting/reporting period; the reviewed schema cannot mark it
paid or choose a separate cash-basis payment period. Expense updates cannot
change the amount or linked supplier identity. Nothing in this surface
files or amends a tax return.

Selected client contacts and client notes can be permanently deleted after
explicit confirmation. A clean draft quote with no delivery, response,
attachment, or conversion evidence can also be deleted; a protected draft is
refused, and deleting a non-draft quote cancels it.

The canonical evidence is
`src/__tests__/fixtures/openai-review-descriptor.snapshot.json`; the provider
form is generated as `marketplace/openai/chatgpt-app-submission.json`. Verify
both with:

```bash
npm run gate:openai-review-descriptor
npm run gate:openai-submission
npm run gate:public-capability-truth
npm run gate:agent-onboarding
bash scripts/analytics-tripwire.sh
```

Provider credentials, reviewer accounts, verification material, deployment
commands, and review correspondence remain outside this public repository.
