# Claude secret separation at bootstrap

The Claude Function and Worker must receive the same dedicated credential.
Neither runtime receives `FRIHET_OAUTH_API_KEY`. Checking separation belongs to
the authorized bootstrap process, before binding credentials, not to a runtime
that would need both secrets to compare them.

`scripts/check-claude-bootstrap-secrets.mjs` compares the actual OpenAI, Claude
Function and Claude Worker secret bytes using inherited file descriptors. It
requires at least 32 UTF-8 bytes, rejects CR/LF/NUL and mismatched Claude values,
and fails on reuse of the OpenAI value. It does not trim or normalize credentials.
Its maximum accepted value is 4 KiB. Output contains only boolean check results;
no secret, digest, identifier or raw exception is emitted.

The operator supplies descriptors 3, 4 and 5 from the approved secret source:

```sh
node scripts/check-claude-bootstrap-secrets.mjs \
  --openai-fd 3 --claude-function-fd 4 --claude-worker-fd 5
```

Do not paste secrets into command arguments, set shell tracing, or print provider
responses. Prefer inherited pipes or descriptors; no plaintext credential file is
required. The bootstrap owner must already have access to the exact versions;
do not grant the Claude runtime access to OpenAI's secret to run this check.

This utility makes no cloud calls or changes. A pass proves only that those
provided bytes differ/match. Capture the source version references separately
and verify the deployed bindings and isolated IAM before running live QA. The
result is deliberately **not** an ERP release receipt or deployment permission.
Session remediation, QA allowlist and effective ERP ceiling remain separate
prerequisites. Current work exercised synthetic credentials only.
