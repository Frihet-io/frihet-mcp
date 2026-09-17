# Operational pin review — local review completed

Base PR: #182 at 8a036512d509d8395048aee75c2a35c528b80781. Main: 4113a9be4657e4424f99429c99cfb0efb76be418.

The existing PR seals `.github/workflows/ci.yml` after adding `fetch-tags: true`; CI run 35169723276 still failed eight tests because v1.17.0 was absent. This patch restores CI byte-for-byte to main, removing that branch-only change. No checkout permissions, steps, expressions or external settings change.

The audit no longer treats a git tag as proof of the installable package. It fetches npm version metadata and the tarball only from the expected registry package path, refuses redirects, bounds response sizes and time, verifies sha512 before decompressing, reads regular ustar entries in memory, rejects unsupported types, duplicates and unsafe paths, verifies package identity, and parses literal canonical registration calls from published dist JavaScript using the repository's existing TypeScript dependency. It never imports package code, installs the package, runs lifecycle hooks, or extracts archive files to disk.

`FRIHET_MCP_PUBLISHED_VERSION` now requests that exact version from npm; it does not make an offline tag into publication proof. The chosen source and integrity are printed. Missing/unverifiable bytes retain exit 4 and no writes. The self-only audit stays offline. No real repository has been passed to `--fix`.

Tests intercept network in their child processes with a synthetic registry/archive. They need neither real npm access nor release tags. Artifact tests additionally reject corrupt bytes, mismatched identity, traversal, duplicates, dynamic registrations and invalid syntax, while proving comments and strings do not inflate the count.

Changes requiring pin review:

- Restore CI's operational hash and literal assertion to the already reviewed main value.
- Review `scripts/audit-mcp-refs.mjs` and then update its operational hash and literal assertion.
- The package scripts hash stays at #182's value: no package script changed in this recovery.
- Two new test-only helper modules contain the synthetic archive and fetch interception. No new production sink or lifecycle entrypoint.

Do not interpret updated hash consistency as independent approval or as permission to publish. The parent agent coordinates that review and every remote write.

## Local review record

The coordinating agent independently read the auditor at sha256 `d2302bb7036e4dc7933705350f54f89b9a616a7a21bd50a924b0877ec563b6ca`, both test helpers and the suite, and authorized only the two documented operational hashes and their literal assertions. CI hash `ea74b270c7fe75bfdff4de3b79a7337cac1ac71afb0f3a367ea535703fe79b27` matches main. Package scripts and all other hash pins are unchanged by this recovery.

This records local cross-review, not external reviewer acceptance, merge authorization, successful remote CI or release approval. Those remain with the coordinating agent.
