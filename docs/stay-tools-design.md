# Frihet Stay — MCP contract history

This file records the public outcome of the original Stay/PMS design work. It
is not an implementation or deployment runbook.

The canonical MCP catalogue currently includes five Stay operations:

- `list_reservations`
- `get_reservation`
- `create_reservation`
- `list_properties`
- `sync_channel`

Catalogue membership does not guarantee that a backing endpoint is enabled for
every workspace. Read `io.frihet/capability` from `tools/list` before calling:
the current public contract marks `create_reservation` and `sync_channel` as
deferred, while the read operations remain API-dependent.

Current input/output schemas and action annotations are defined in
`src/tools/stay.ts` and pinned by the generated public-capability contract. New
Stay operations require their own reviewed issue and are not specified here.
