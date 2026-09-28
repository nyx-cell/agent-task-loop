---
'@rivus/agent-task-loop': patch
---

Take over the run baton from `@rivus/agent-orchestration` (RFC 0015 S2): the
`Run` aggregate, template registry, seat types and the execa process runner
now live in this package's internal `orchestration` module. The public
entrypoints (`task-delivery`, `task-management`, `rivus-plugin`, the CLI) are
unchanged; the package keeps leasing through `@rivus/agent-orchestration`,
which re-exports `ProcessRunner` and `SeatBind` as deprecated type aliases
until slice 3 removes the last room-web importer.
