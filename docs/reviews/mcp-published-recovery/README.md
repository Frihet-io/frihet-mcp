# MCP published-reference recovery

PR #182 was still red because its tests depended on a local release tag that `fetch-tags: true` did not provide on the runner. The recovery removes that test dependency and restores CI to the exact reviewed main workflow. It does not add a fetch step or expand CI authority.

The more consequential correction is the source of truth. A git tag alone does not establish what npm serves. The audit now downloads npm metadata and its tarball, verifies sha512 and package identity, reads the archive in memory and parses canonical registration names from emitted JavaScript. It executes no package code or lifecycle hook. An explicit version pin still uses npm and is printed; unverifiable bytes retain exit 4 and prevent writes. Self-only checks remain offline. The existing line-scoped rewrite behavior is retained, and `--fix` was used only on disposable test fixtures.

## Evidence

- npm latest: **1.17.0**, no `gitHead` in metadata, **157 canonical static registrations** in the integrity-verified archive.
- Main package: **1.18.0**, **158 canonical operations** in the separately checked source contract.
- A fresh rebuild of tag `v1.17.0` at `64934a5aa3377534756a87692f48d42c4bd58e4f` using TypeScript 5.9.3 matches **all 57 shipped JavaScript files byte-for-byte**. This is an observed comparison for this artifact, not an assumption that all tags equal npm releases.
- Root build and tests: **1023/1023 passed**. Worker typecheck and tests: **112/112 passed**. Targeted publication and detector tests: **56/56 passed**, using synthetic offline registry responses.
- Analytics source and built-artifact gates: **22/22 tests passed**, both inventories consistent after the documented local review.
- Conformance baseline, OpenAI descriptor/submission/schema, onboarding, public capability projection, self reference audit and public-leak gate passed locally.

`validation.json` records metadata and checks. `npm-tag-byte-comparison.json` records per-file hashes. `pin-review.md` records the bounded operational pin review. `proposed-pr-body.md` is a replacement description for the coordinator to publish after checking the final head.

## The remaining red drift is real

Main run [35168915019](https://github.com/Frihet-io/frihet-mcp/actions/runs/35168915019) reports `UNPUBLISHED_VERSION`: the repository prepares 1.18.0 while npm and the MCP Registry serve 1.17.0. The same finding appears before #181 in [35095192647](https://github.com/Frihet-io/frihet-mcp/actions/runs/35095192647). The detector is not broken by #181 and this patch does not make an unpublished release public.

The canonical release workflow also has an explicit Full OAuth lifecycle hold in `workers/remote-mcp/full-oauth-release-contract.json`. A production release requires a separately credentialed, independently reviewed Full authority. This recovery does not change that hold, use an alternative publish path or claim that publication is complete.

## Handoff

No remote write, merge, registry publication or deployment was performed by this worker. Original MCP, website, ERP and docs checkouts were not rewritten. The coordinator owns independent final-head review, the PR body correction and any later push/merge. Local hash consistency records the reviewed bytes; it is not equivalent to external acceptance or release authorization.
