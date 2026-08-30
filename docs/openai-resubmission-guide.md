# OpenAI reviewed-surface contract

Frihet's ChatGPT deployment is deliberately narrower than the full MCP
catalogue. Release `1.16.6` exposes this public contract:

- MCP endpoint: `https://openai-mcp.frihet.io/mcp`;
- OAuth issuer and protected resource: `https://openai-mcp.frihet.io`;
- sole OAuth scope: `frihet:workspace.manage`;
- exactly 33 reviewed business operations with complete descriptions and no
  discovery meta-tools;
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
vendor, and changes internal accounting/future tax-report inputs. Vendor creation
is a separate backend step, so a new vendor may remain if the later expense write
fails. The date
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

The portal publisher selection must be the approved Business identity
`VICTOR BERTHELIUS PATO`. It must match the live connector privacy/support
ownership statement, JSON-LD publisher evidence, and generated submission
description before a draft is submitted. Do not substitute the Individual
identity or rely on the Frihet display name alone as ownership evidence.

## Historical rejection regression matrix

Every issue cited across the three prior review rounds is a release blocker,
not merely portal copy to complete at submission time:

| Prior review issue | Required evidence before resubmission |
| --- | --- |
| Developer or business identity did not match | Select the approved **Business** identity `VICTOR BERTHELIUS PATO`; keep that exact legal name in the generated description and on the live connector support, privacy, JSON-LD, agent, and MCP publisher surfaces. |
| App or trademark ownership could not be confirmed | Keep the public chain explicit: the legal person owns and operates the Frihet trade name, and the live Frihet privacy policy and terms identify the same controller and service provider. Do not rely on logo or display-name similarity. |
| `openWorldHint` values were missing or inconsistent | All 33 tools must carry explicit boolean `readOnlyHint`, `openWorldHint`, and `destructiveHint` values, with tool-specific external-effect explanations enforced by the descriptor and submission gates. |
| Test cases were incorrect or inconsistent | Generate exactly five positive and three negative cases from the frozen descriptor, seed deterministic review data, and execute every case successfully in both ChatGPT web and mobile against the release candidate. Record the expected and observed outcomes. |
| Returned user-data categories were not fully disclosed | Keep recursively closed output schemas, runtime redaction, the dedicated connector privacy notice, and explicit disclosures for internal linking/snapshots, notifications, analytics, referrals, and owner-configured webhook deliveries. |
| The app solicited sensitive personal data | Expose no dedicated government-ID, banking, credential, precise-address, raw-document, or regulated-payload fields. Every reviewed user-entered free-text field must warn against credentials, card data, health data, and official identifiers. |
| Submission metadata was incomplete or invalid | Live-smoke the canonical website, connector support URL, connector privacy URL, and support contact; verify the generated five/three test cases contain concrete expected outcomes before uploading the JSON. |

Do not mark a row complete from local source alone. Public identity, URLs,
OAuth behavior, and test outcomes require release-candidate evidence. Portal
submission remains a separate, explicitly confirmed action.

## Deployment compatibility

The principal-bound MCP session envelope is intentionally not compatible with
raw `mcp-session-id` values issued before this release. Existing clients on the
full MCP host must start a new MCP session after deployment; the Worker rejects
an old raw id instead of trusting an unbound session. The reviewed OpenAI host
must not be submitted until its candidate deployment has exercised this
reconnect path and the coordinated OAuth grant/API-key retirement plan has
removed credentials created before host/profile binding was recorded.

Provider credentials, reviewer accounts, verification material, deployment
commands, and review correspondence remain outside this public repository.
