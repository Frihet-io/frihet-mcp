# MCP observability contract

Telemetry is optional and fail-open: if it is not configured or its sink is
unavailable, MCP operations continue unchanged.

Production telemetry is limited to an explicit operational allowlist:

- registered tool name;
- duration and success/failure state;
- bounded local error class/code/status;
- random request correlation identifiers;
- fixed protocol/transport version facts.

Tool input/output, business content, raw provider responses, credentials,
customer/user/workspace identity, dynamic paths, arbitrary client labels, and
unkeyed identity fingerprints are not telemetry fields. A handled MCP result
with `isError: true` is recorded as a failure without inspecting its payload.

The implementation does not add a stable pseudonymous workspace identifier.
That would require a separately reviewed keyed design and operational ownership.
Provider configuration and deployment procedures are intentionally maintained
outside this public repository.

These invariants are pinned by the observability, logger, containment, no-leak,
and analytics-tripwire tests in CI.
