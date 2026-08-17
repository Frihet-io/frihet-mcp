# OpenAI review descriptor freeze

The ChatGPT connector contract is exactly 53 reviewed business operations plus
three read-only discovery operations, with zero MCP prompts and zero MCP
resources.

`src/__tests__/fixtures/openai-review-descriptor.snapshot.json` is the canonical
semantic artifact. It is captured through the production composition path and
stores the complete `tools/list` descriptor plus the reviewed OAuth discovery
contract. CI fails closed on tool, schema, annotation, sensitive-field,
prompt/resource, or OAuth drift. The checker deliberately has no automatic
update mode.

The reviewed profile is subtractive. It removes unsupported projection inputs,
government tax identifiers such as `clientTaxId`, credential fields, and other
sensitive declarations/values from reviewed mode while preserving direct MCP
behavior. Webhook and CRM descriptors follow the current API contract. The
business invoice `documentNumber` exception remains limited to its exact
reviewed invoice input paths.

Any semantic fixture change requires an explicit owner decision and independent
review of the complete candidate difference. Updating the fixture does not
authorize deployment, provider changes, OAuth scope changes, fiscal sends, or a
release. Operational review and release procedures are maintained outside this
public repository.
