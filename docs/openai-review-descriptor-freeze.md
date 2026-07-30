# OpenAI review descriptor freeze

The ChatGPT connector is frozen while OpenAI review is active. Its approved
surface is exactly 53 business tools plus the three discovery tools
`describe_tool`, `list_tool_groups`, and `search_tools`. It exposes zero MCP
prompts and zero MCP resources.

## What the gate freezes

`src/__tests__/fixtures/openai-review-descriptor.snapshot.json` is the canonical
semantic contract. It is captured through a real MCP `tools/list` request after
the production composition order:

1. grouped exposure with `OPENAI_REVIEWED_TOOL_ALLOWLIST`;
2. the OpenAI profile;
3. `registerAllTools`, `registerAllResources`, and `registerAllPrompts`.

The snapshot stores every field actually emitted for each tool, including its
name, title, description, input schema, output schema, annotations, execution
metadata, and any future security metadata. The gate canonicalizes only JSON
object-key order and `tools/list` ordering. Schema arrays and all semantic values
remain exact.

The same snapshot also freezes the Worker OAuth authorization-server discovery,
protected-resource metadata, resolved OAuth provider package version, and the
`WWW-Authenticate` `resource_metadata` URL. The pure OAuth builder consumes the
same options object spread into the real Worker provider.

Run the fail-closed gate with:

```bash
npm run gate:openai-review-descriptor
```

The repository CI runs this gate on every pull request and every push to
`main`; the freeze is therefore a blocking contract, not an optional local
check.

Run the positive capture and mutation selftests with:

```bash
npm run test:openai-review-descriptor
```

The selftests prove that removal, rename, description drift, annotation drift,
a newly required input, a newly introduced sensitive field, a hidden-tool leak,
prompt/resource registration, OAuth issuer/resource drift, and challenge URL
drift each fail the gate.

## Refresh policy

Do not refresh this snapshot for ordinary implementation changes, dependency
updates, formatting, or to make CI green. There is deliberately no `--update`
mode.

A refresh is allowed only after the owner approves a new OpenAI app review and
the proposed surface is documented in that review. Then:

1. Merge current `origin/main` and obtain explicit approval for the new review
   descriptor.
2. Build and print the candidate without overwriting the canonical fixture:

   ```bash
   npm run build
   node scripts/check-openai-review-descriptor.mjs --print-current > /tmp/openai-review-descriptor.candidate.json
   diff -u src/__tests__/fixtures/openai-review-descriptor.snapshot.json /tmp/openai-review-descriptor.candidate.json
   ```

3. Review every semantic difference. Confirm names, descriptions, schemas,
   annotations, security metadata, tool counts, zero prompts/resources, and all
   OAuth URLs against the newly approved submission.
4. Only after that review, replace the fixture deliberately and inspect the Git
   diff before staging it.
5. Run all positive, negative, boundary, and authentication evaluations:

   ```bash
   npm run build
   npm test
   npm run test:openai-review-descriptor
   npm run gate:openai-review-descriptor
   cd workers/remote-mcp && npm test && npm run typecheck
   ```

6. Run the live read-only smoke against the reviewed Worker. It lists tools and
   calls only the three in-process discovery tools; it performs no ERP mutation:

   ```bash
   FRIHET_API_KEY=fri_xxx node scripts/test-openai-grouped-compose.mjs
   ```

7. Attach the complete local diff and live-smoke evidence to the new review.

Never deploy, publish, bump versions, change live OAuth metadata, or refresh the
snapshot as part of the gate itself.
