# Claude admission candidate and rollback

This is an offline source candidate, not a deployment or authorization to open
customer access. The existing `FRIHET_CLAUDE_QA_UIDS` policy field is reused by
the Claude Worker and provisioning Function; no new runtime variable, secret,
scope, IAM role, route, KV namespace or Durable Object is required.

## Exact policy

The existing nonempty JSON array of unique, exact Firebase QA UIDs retains QA
behavior. The versioned form is exactly:

```json
{"version":1,"mode":"qa","qaUids":["synthetic-qa-one","synthetic-qa-two"]}
```

Only `qa` and `customers` are valid modes. Switching the mode to `customers`
admits verified Frihet identities without adding customers to `qaUids`. Both
forms require a nonempty, unique list with the existing Firebase UID contract.
Missing values, malformed JSON, extra object keys, unknown versions or modes,
wrong types, duplicates and invalid UIDs fail closed. There is no wildcard or
implicit opening. Do not put real customer or publisher accounts in the QA list.

Identity comes from a verified Firebase ID token at callback, or from the
provider's authenticated, encrypted grant/token props afterwards. Both modes
require a valid email and literal `emailVerified === true` under the existing
verified-email contract. Request JSON cannot supply these claims. Scope,
issuer, resource, audience, profile and authentication method remain bound to
Claude; Frihet plan and workspace authorization still govern each operation.

## Reversible pause

Rollback from `customers` to `qa` (or the legacy array) pauses non-QA users at
callback, authorization-code exchange, refresh and MCP ingress, including
existing sessions. A valid paused credential receives generic HTTP 503
`temporarily_unavailable`. No response discloses a UID or grant identifier.

For a current, valid code or refresh token, the pause does not reserve a family
lease, consume the code, rotate tokens, revoke the grant or backend key, or alter
the family hash or alarms. Existing family check/status endpoints distinguish
this case from previous/spent refresh replay, expired or revoked families;
those retain invalid-credential revocation and cleanup. Reopening `customers`
allows unexpired credentials to resume. Clients that discard their local tokens
may need to reconnect. A pause is not revocation; expiry and cleanup still apply.

An authenticated owner can disconnect while paused. RFC 7009 revocation retains
client ownership validation. Session DELETE retains authenticated principal,
token-family and signed session-envelope ownership checks before session access.

## Activation and rollback delivery

A later explicitly authorized release must pin the accepted Worker and Function
source plus the exact policy/secret version and previous deployment versions.
Opening and policy rollback must be coordinated across both surfaces. Mixed
modes fail closed for new grants but are not a completed release. The existing
config-only Function lane still requires its scoped source-update path to carry
this parser; changing a secret alone cannot install code.

Source rollback reverts this candidate. Runtime policy rollback restores the
previous QA policy version without destroying grants; runtime code rollback uses
the recorded previous Claude-only Worker and Function deployment versions.
No live rollback receipt is claimed here. Local synthetic tests prove parser,
Firebase claims, pause/resume, replay and owner cleanup behavior; hosted customer
acceptance, cloud isolation, model evaluations and Directory submission remain
separate release evidence. General and OpenAI admission do not read this policy.
