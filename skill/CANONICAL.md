# Skill canonicity

`skill/` is the source of truth for the Frihet Claude Code skill. It is consumed by:

- `scripts/audit-mcp-refs.mjs` (tool-count consistency audit — references `skill/SKILL.md`)
- `marketplace/cursor/SUBMISSION.md` (Cursor plugin submission bundles this directory)

The Claude Code **plugin** (`.claude-plugin/plugin.json`) ships a mirror copy at
`skills/frihet-mcp/`. The plugin loader scans `skills/`, not `skill/`, so the copy is
required rather than a rename.

**Keep both in sync:** any edit to `skill/SKILL.md` or `skill/references/*` must be copied
to `skills/frihet-mcp/`. Verify with `diff -r skill skills/frihet-mcp`.
