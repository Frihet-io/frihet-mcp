# ERP source-only prerequisite for Claude

The Claude deployment guard additionally accepts the closed ERP lane
`claude-publicapi-source-20261016`. It authenticates the production workflow run
and immutable receipt artifact through GitHub, checks the approved spec at that
control commit, and separately authenticates the historical source build proof.
All six rebuilt source/JavaScript/map members must match the committed digests.
The source route contract must match the MCP fixture, with the Claude check wired
in `publicApi`. Config/IAM drift, secret-binding changes, other runtime recipes,
fork/PR producers and self-signed local receipt substitutions fail closed.

Supply `FRIHET_ERP_ROOT` and `FRIHET_ERP_RELEASE_RECEIPT` as before. This lane also
needs authenticated GitHub reads, through `GH_TOKEN`, `GITHUB_TOKEN` or the local
`gh` login. The GitHub token never reaches the signed storage download. Temporary
evidence is removed; errors do not include provider bodies or signed URLs.

This verifies deployment provenance, not current hosted acceptance or the absence
of a later ERP release. Use the latest receipt that deployed `publicApi` and verify
the live backend before continuing the pilot. QA allowlisting, secret separation,
isolated infrastructure, session remediation and real OAuth/MCP acceptance remain
independent prerequisites. The source-only mode and placeholder KV still refuse
deployment. No general/OpenAI runtime or deploy path is changed by this verifier.
