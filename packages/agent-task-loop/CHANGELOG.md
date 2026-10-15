# @rivus/agent-task-loop

## 0.12.0

### Minor Changes

- [#150](https://github.com/PerfectPan/agent-task-loop/pull/150) [`14d6ab7`](https://github.com/PerfectPan/agent-task-loop/commit/14d6ab788f46a7da9280d600082ad94cfce3ac73) Thanks [@nyx-cell](https://github.com/nyx-cell)! - Detect installed agents with `@rivus/agent-kit` 0.11.0 instead of the MoonBit scanner, and require Node.js 22.13 or newer (the kit's Node adapters).
  
  The kit supports 7 agents with built-in probe recipes: claude-code, codex, cursor, gemini-cli, grok, opencode, pi. `agent-finder-cli` keeps the other 20 catalog entries through its own probe recipes (`openhands`, `cline`, `codebuddy`, `command-code`, `kiro-cli`, `antigravity`, `roo-code`, `github-copilot`, `amp`, `openclaw`, `neovate`, `qoder`, `zencoder`, `kimi-code-cli`, `windsurf`, `vscode-copilot`, `codex-desktop`, `aider`, `hermes`, `trae`), so `scan`, `provider list`, `provider inspect` and `doctor` list 27 agents: the previous 26 plus the kit's `grok`.
  
  Differences accepted in the parity comparison, for the same probe inputs:
  
  - Report order changes: the kit's built-in agents come first (opencode, claude-code, codex, cursor, pi, gemini-cli, grok), then the legacy recipes; the MoonBit scanner used catalog file order.
  - The conservative "provider metadata" warnings on opencode and pi no longer appear; the kit's recipes for them carry no warnings, while the 20 legacy recipes keep theirs verbatim.
  - Cursor: `~/.cursor` is now checked as a configuration path, `cursor-agent` as a command name, and the recipe adds two caveats about not following `CURSOR_CONFIG_DIR`/`XDG_CONFIG_HOME` and not probing the command name `agent`.
  - opencode also checks `~/.config/opencode/opencode.jsonc` as an MCP configuration path.
  - Each installation carries the new `auth` (file-based login state) and `problems` (checks that could not complete) fields; `agent-finder scan --json` prints that installation array instead of the old `schema_version: "0.1"` report.
  - `agent-task-loop init` detects claude-code and codex with `versionProbe: false`, so it never executes an agent command; an agent is configured when its command is found on `PATH`, where discovery previously also required a successful `--version` run.

- [#151](https://github.com/PerfectPan/agent-task-loop/pull/151) [`60fb524`](https://github.com/PerfectPan/agent-task-loop/commit/60fb524d8f5f86f841375ed03a5f012889a2302e) Thanks [@nyx-cell](https://github.com/nyx-cell)! - Discover sessions and read transcripts with `@rivus/agent-kit` 0.11.0 (`/sessions` + `/transcript`) instead of the deleted internal `@rivus/agent-sessions` package. Resume command strings stay application-side: `packages/agent-finder-cli/src/sessions/resume.ts` and `packages/agent-task-loop/src/session/resume.ts` are the single sources (`codex resume <id>`, `claude --resume <id>`).
  
  Differences accepted in the parity comparison against the old package, for the same on-disk fixtures:
  
  - The session list covers more sessions: Codex `archived_sessions/` is scanned, `CODEX_HOME` and `CLAUDE_CONFIG_DIR` are honored, and grok sessions are included. The old scanner only walked `~/.codex/sessions` and `~/.claude/projects`.
  - Claude subagent transcripts (`<session>/subagents/agent-*.jsonl`) are no longer listed as independent sessions; their turns appear inside the parent session's transcript instead.
  - `agent-finder sessions list --json` prints kit session heads (`ref`, `lastActiveAt` epoch ms, `sizeBytes`, `firstPrompt`, …) instead of the old `Session` shape, and `--agent claude` is accepted as an alias of `claude-code`. `sessions inspect --json` prints the transcript as kit transcript events.
  - Timestamps: `updatedAt` (file mtime, ISO) becomes `lastActiveAt` (the last record time read from the file's head and tail, epoch ms).
  - A Codex rollout records each turn twice (the CLI's `event_msg` copy and the model's `response_item` copy). The preview renders each turn once, attributed to the `response_item`; the old parser rendered both copies. A regression test pins the single count.
  - The task-loop TUI preview and the sessions browser read transcript events (`user`/`assistant`/`reasoning`/`tool_call`); tool calls render as `⚙ tool` regardless of which agent emitted them.

- [#130](https://github.com/PerfectPan/agent-task-loop/pull/130) [`68a1d1c`](https://github.com/PerfectPan/agent-task-loop/commit/68a1d1ce35b688a6b9a16fb16a77d2399925b69a) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Upgrade the runtime dependencies to Zod 4, Ink 6 with React 19, and citty 0.2. User-visible changes:
  
  - A value after a boolean flag is rejected: `cleanup --force false` used to turn `--force` off, but citty 0.2 never reads a value for a boolean flag and would turn it on. Turn a flag off with `--no-force` or `--force=false`. Every command also rejects other positional arguments it does not take.
  - `--max-rounds` on `start` and `reject` now takes effect; it used to be ignored in favour of the default of 5 unless written `--maxRounds`.
  - `-v` prints the version, and `--help` output uses citty 0.2's layout.
  - A failing command prints only its error message instead of the whole error object.
  - Validation errors from `create`, `source add` and config loading use Zod 4's wording, for example `Invalid --priority: Too big: expected number to be <=9`.

- [#152](https://github.com/PerfectPan/agent-task-loop/pull/152) [`a7be2e7`](https://github.com/PerfectPan/agent-task-loop/commit/a7be2e7bbd1edceadccffbbd8a38bf484aa34fb6) Thanks [@nyx-cell](https://github.com/nyx-cell)! - Occupy Tasks with `@rivus/agent-kit-collab` 0.11.0's `/lease` (`createLeaseManager` + a scoped `manager.acquire`) instead of `@rivus/agent-orchestration`'s `LeaseManager` and `FileLeaseStore`. `effect@4.0.1` is an exact dependency. The old orchestration facade (`src/orchestration/orchestration.ts`, `node-factory.ts`, `task-orchestration.ts`) is deleted; the run baton (`Run`, the `classic-delivery` template, the run-state stores, the seat policy) stays application-side and the seat lifecycle is wired to the kit lease handle. The occupancy key stays `task:<taskId>`.
  
  Differences accepted in the old/new comparison, recorded in the lease tests:
  
  - The lease heartbeat is the kit's managed fiber (15 s renewals, 120 s TTL, each renewal a compare-and-swap); the old per-mutation lease CAS and per-spawn heartbeat timer are gone, and run-state writes check the observed loss instead.
  - The lease record is the kit's schema (`<key>.lease.json` with a schema version and a tombstone on release). Old `lease.lock` files are not migrated; an existing holder keeps running and a later run re-acquires, which continues the fencing generation.
  - A lease lost mid-run now surfaces as `TaskLeaseLostError` (taken over, released, missing or expired) instead of the old `OrchestrationConflictError` from the heartbeat; a refused fenced write still reports the orchestration conflict. A second start of the same Task keeps the old message: `Task <id> already has an active orchestration (pid <pid>)`.
  - An unreadable or newer-schema lease record is refused without being overwritten (repository failure) where the old store treated it as absent and conflicted.

- [#134](https://github.com/PerfectPan/agent-task-loop/pull/134) [`778fe6f`](https://github.com/PerfectPan/agent-task-loop/commit/778fe6facbf4d7ddee26536c6f846f99d7b5b10c) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Require Node.js 22 or newer; Node.js 20 is no longer supported. The CLIs move to Ink 7, and `@rivus/agent-task-loop` also to execa 10; both need Node.js 22.

- [#142](https://github.com/PerfectPan/agent-task-loop/pull/142) [`f5a6a3e`](https://github.com/PerfectPan/agent-task-loop/commit/f5a6a3e861568a4bdf4a72688f59d65e846a2bef) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Support the Rivus 0.17 plugin SDK with the optional `@rivus/agent` peer range `>=0.17.0 <0.18.0`. Plugin projects must upgrade Core to the supported minor; CLI-only installations still do not require Rivus Core.

### Patch Changes

- [#134](https://github.com/PerfectPan/agent-task-loop/pull/134) [`778fe6f`](https://github.com/PerfectPan/agent-task-loop/commit/778fe6facbf4d7ddee26536c6f846f99d7b5b10c) Thanks [@PerfectPan](https://github.com/PerfectPan)! - A failing command also prints the message of each error that caused it, the unexpected-argument error mentions boolean flags only when the stray value is `true` or `false`, and the `./rivus-plugin` tools report a field missing from their input as `is required`, for example `Invalid task-create title: is required`, instead of `has an invalid type`.

- [#149](https://github.com/PerfectPan/agent-task-loop/pull/149) [`5cd6419`](https://github.com/PerfectPan/agent-task-loop/commit/5cd6419fc230f4058c84606b90be8ba4dd7a87fe) Thanks [@nyx-cell](https://github.com/nyx-cell)! - Build the published JavaScript with Vite+ (`vp pack`). The published file set changes from fixed chunks to hashed chunks plus a separate `task-provider` declaration file; imports and exports are unchanged.

- [#138](https://github.com/PerfectPan/agent-task-loop/pull/138) [`f34f632`](https://github.com/PerfectPan/agent-task-loop/commit/f34f63230f8dacad29d6b18365137c9eddea26c0) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Fix the published TUIs (`agent-task-loop tui` and `agent-finder sessions browse`) crashing on start with `ReferenceError: React is not defined`: the build now compiles JSX with the automatic runtime.

## 0.11.1

### Patch Changes

- f2d016a: Take over the run baton from `@rivus/agent-orchestration` (RFC 0015 S2): the
  `Run` aggregate, template registry, seat types and the execa process runner
  now live in this package's internal `orchestration` module. The public
  entrypoints (`task-delivery`, `task-management`, `rivus-plugin`, the CLI) are
  unchanged; the package keeps leasing through `@rivus/agent-orchestration`,
  which re-exports `ProcessRunner` and `SeatBind` as deprecated type aliases
  until slice 3 removes the last room-web importer.

## 0.11.0

### Minor Changes

- 766b5f3: Start occupies `@rivus/agent-orchestration` (`task:<id>`) before the review loop. A second concurrent start loses with a stable conflict and does not claim the task backend.
- ed9045a: Expose the Task Delivery bounded context with its aggregate, independent review
  gate, fenced repository writes, and orchestration-backed local runtime.
- f42e6c1: Expose the task-management boundary as `@rivus/agent-task-loop/task-management`:
  the task provider factory, the `TaskRecord` / `TaskStatus` vocabulary and the
  status ordering, so a UI such as room-web can read the real task backends
  without importing the CLI entry point.

### Patch Changes

- 29a7b22: Resolve GitHub Issues tokens more reliably in subprocesses and clarify rate-limit errors.

## 0.10.0

### Minor Changes

- af94276: Add an external Rivus Task Manager Plugin with a least-authority Agent Profile,
  four bounded task Tools, redacted public DTOs, shared task-start orchestration,
  and a clean-consumer package verification gate.

### Patch Changes

- 0fe70cc: Add an `agent-task-loop create` command for scriptable task creation, with required flags, interactive prompting in TTYs, source selection, validation, and JSON output.
- de36605: Fix `complete`/auto-publish failing outright with "paths are ignored by one of your .gitignore files" once a target repo's own `.gitignore` covers `.agent-task-loop/` (as this repo's now does, per the prior fix in #83). `GitPublishService.commitAll` used a pathspec exclusion (`-- . ':!.agent-task-loop'`), which git treats as an error when the excluded path is _already_ gitignored. Switched to `git add -A` followed by `git reset -- .agent-task-loop`, which is a no-op whether the path was ignored, untracked, or absent — and still keeps the directory out of the commit either way.
- 68e39c6: Fix `complete`/auto-publish committing agent-task-loop's own `.agent-task-loop/` runtime bookkeeping directory (session logs) into the task's commit. `GitPublishService.commitAll` used `git add -A`, which only skips a path when the _target_ repo's own `.gitignore` covers it — since agent-task-loop runs against arbitrary repos, a repo without that rule got its run logs (which embed local absolute paths) committed and pushed. `commitAll` now excludes `.agent-task-loop/` via an explicit pathspec regardless of the target repo's `.gitignore`.

## 0.9.0

### Minor Changes

- 933d3ad: Fix a batch of GitHub-only correctness, robustness and UX issues found by a full audit:

  - **prLink no longer = the issue URL.** `mapIssue` used to stamp the issue's `html_url` into `prLink`, which (a) showed the issue link in the TUI "PR" field and (b) made `DeliveryCheckService` treat every GitHub task as already-published, skipping the real working-tree/new-commit check. The real PR link now comes only from the run-time store.
  - **GitHub setup is no longer a trap.** `source add` / `init` now scaffold the matching `projects[<repo>]` / `repositories[<owner>/<repo>]` entries (keyed exactly as the run path expects), the shipped `config.example.json` is correctly keyed, and `assertRuntimeConfig` fails fast with an actionable error when a GitHub source has no matching project/repository or a `localPath`/`workspaceRoot` is unset — instead of a cryptic per-task "unknown project" mid-run.
  - **Cleanup keeps the task's outcome.** `updateCleanupState` now clears only transient run-time fields and preserves `status`, `prLink`, publish info and session history — so a finished GitHub task keeps showing its PR + transcript and never resurrects to 待处理 (an earlier fix over-cleared and wiped them).
  - **Agent reassignment persists on GitHub.** `updateTaskAssignment` now rewrites the issue's `agent:<name>` label (was a no-op, so the new agent never saw the task).
  - **`complete` is more robust:** refuses to publish when the workspace is on the default branch (parity with auto-publish), and a missing PR-description process-summary is now a warning rather than a hard failure that left a dangling open PR with the task stuck pre-已完成.
  - **Clearer push failures:** a non-fast-forward push is reported with actionable guidance instead of a raw git error.
  - **TUI:** the session/transcript index refreshes on a stale miss (sessions created after startup are now found instead of "Transcript not found"), and scrollable panes add slack so long transcripts/detail can always be scrolled to the bottom.
  - **Hygiene:** the run-time state store now prunes orphaned entries (180-day TTL), and `listTasks` warns instead of silently truncating when a repo exceeds the 1000-issue page cap.

  Known design limits (not changed): intermediate statuses are machine-local (cross-machine reads fall back to the issue's open/closed), and terminal mouse/drag selection of wrapped URLs is a terminal-takeover limitation.

## 0.8.0

### Minor Changes

- 672626d: Close the GitHub-Issues task source to full parity with Feishu so the loop runs end-to-end (publish → execute → review → complete → cleanup, plus reject/watch/resume) on a GitHub-only setup.

  GitHub issues are binary (open/closed ⇒ 待处理 / 已完成), so every intermediate lifecycle status (执行中 / 待复核 / 待发布 / 待验收 / 修复中 / 已失败) is owned by the loop and persisted in the run-time state store, then overlaid on reads:

  - `status` is mirrored in the local store: `updateReviewState` carries it; `StatefulTaskProvider` injects the implied 执行中 on claim, 待验收 on succeed (matching Feishu, not 已完成), and 已失败 on fail. So `complete` (gates on 待验收/待发布), `reject`, `cleanup`, `watch` and `start` recovery read the correct status across separate commands.
  - **`listPendingTasks` now filters on the overlaid status**, not the backend's raw open/closed. Previously an in-flight or finished GitHub task (issue still open) was re-offered as pending and could be re-claimed.
  - **`updateCleanupState` preserves the lifecycle `status`** while dropping transient run-time fields, so a finished task never resurrects to 待处理 after cleanup (Feishu keeps Status across cleanup; we mirror that).
  - **The GitHub issue closes on the terminal 已完成 transition** (via `updateReviewState`), so the binary backend itself records completion even if the run-time store is later cleared. `markTaskSucceeded` (待验收) no longer closes the issue.
  - `listTasks` paginates (`state=all`, 100/page, up to 1000) for read parity with Feishu's full list.

  Adds unit coverage for each behaviour plus two end-to-end tests over the real provider stack (`StatefulTaskProvider` + file-backed store + an in-memory fake GitHub API): a full execute→review→publish→complete→cleanup walk asserting status parity and no resurrection, and the real `CompleteService` publishing a 待发布 GitHub task and closing its issue. Cross-machine remains a non-goal. Feishu is unaffected.

## 0.7.1

### Patch Changes

- 2f85be4: CompositeTaskProvider reads are now fault-tolerant: a source that fails to read (e.g. a Feishu Base whose lark-cli auth is missing the `base:record:read` scope) is **skipped with a warning** instead of failing the whole read. Previously `listTasks`/`listPendingTasks` used `Promise.all`, so one unhealthy source blanked the entire board (the TUI showed "No tasks" and hid healthy GitHub tasks); `getTaskById` likewise threw if an earlier source errored. Now healthy sources always come through and the failing source is reported on stderr.

## 0.7.0

### Minor Changes

- f49477c: Add a `source` command to manage task sources without hand-editing the config (RFC 0007). `agent-task-loop source list` shows configured sources and the default; `source add --type github|feishu …` merges a source into the existing config (a second GitHub repo appends to `repositories[]`); `source remove <id>` drops one (keeping ≥1). Flags drive non-interactive use; a TTY prompts for missing values and prefills owner/repo from `gh repo view`. `init` now points at `source add` when a config already exists.

## 0.6.0

### Minor Changes

- 3254593: GitHub-Issues-only task source + JSON config (RFC 0005). `feishu` is now optional — configure at least one of `feishu` / `githubIssues`. Config is JSON-only and resolved from `--config` → `AGENT_TASK_LOOP_CONFIG` → `~/.agent-task-loop/config.json` (no more per-directory `task.config.*` discovery or `.ts`/`.js` config). The GitHub token falls back to `gh auth token`. `init` lets you pick the source(s); the TUI can publish a task as a linked GitHub issue and refine the description with AI (`Ctrl+R`, requires a `claude` agent).

  `githubIssues` also supports **multiple repositories** via a `repositories[]` array — each becomes its own `github:<owner>/<repo>` task source (selectable in the TUI). To avoid adopting every issue in a repo, only issues that opt in are treated as tasks: those carrying the `<!-- task-id -->` marker (created through this tool) or an `agent:<name>` label (hand-off).

  The TUI shows a compact per-row source tag (repo short name) and adds a `s` source-filter popup (multi-select, with a `src:` header chip) for focusing on specific repos; the `/` text filter now also matches source/repository.

  Closes #24.

- 8a18edc: Provider-unaware run-time state store (RFC 0006). The loop's run-time state — session ids, runner pid/heartbeat, workspace path, review/acceptance rounds, publish result, claim info — is now persisted in a local store (`~/.agent-task-loop/state/<source>/<recordId>.json`) by a `StatefulTaskProvider` decorator that wraps the provider tree. Writes mirror the run-time subset locally then delegate unchanged; reads overlay it (local authoritative for the subset, backend as fallback). Feishu writes are untouched (still authoritative, still in the Base); GitHub — and any future low-fidelity source — keeps `resume`/`watch`/TUI session preview working instead of losing run-time state. The providers never see the store. Writes are atomic and best-effort; `cleanup` clears per-task state.

## 0.5.3

### Patch Changes

- 480e372: Internal refactor: the TUI's session discovery and transcript parsing now delegate to the shared `@rivus/agent-sessions` core (bundled into the published package), replacing the package-local copy. Preview output is unchanged — the transcript is mapped back through `toLines()` and the existing TUI tests are green.

## 0.5.2

### Patch Changes

- a81cd65: Fix latent type errors surfaced by the new CI typecheck gate:

  - `watch`: return `0` (not `undefined`) for `nextOffset` when a log read fails, so the next poll resumes from a valid offset.
  - `workspace`: narrow `existingWorkspacePath` before returning it.
  - `schema`: type the field-detail list as `ExistingField[]` so `id`/`options` lookups are sound.
  - `review-loop`: include `acceptanceFeedback` in the reviewer dependency's input type.

## 0.5.1

### Patch Changes

- Updated dependencies [c7a99de]
  - @rivus/agent-finder-core@0.1.2

## 0.5.0

### Minor Changes

- 2c8078b: feat(task): integration-layer multi-source task backends

  Position the tool as an integration layer over your existing trackers rather
  than a system of record. Each task's source of truth stays its own backend;
  the CLI and TUI read from many and route writes back to the owning source.

  - Every `TaskRecord`/`TaskRef` carries a `source`; a `SourceProvider` interface
    declares each leaf backend's id. Feishu Base reports `source: 'feishu'`.
  - `CompositeTaskProvider` reads/merges from all configured sources and routes
    writes (and creates) back to the backend that owns each task, with a default
    source for unrouted creates. No global store, no cross-source sync.
  - New `GitHubIssuesTaskProvider`: read + create tasks backed by GitHub Issues
    (task-id marker, `agent:`/`P{n}` labels, PRs skipped), with lifecycle changes
    synced back as issue comments / close. Enabled via an optional `githubIssues`
    config block (`owner`/`repo`/`token`/`defaultAgent`).
  - TUI multi-source affordances: a per-row source tag and a `来源` detail field
    for secondary backends, plus a capability-aware Source selector in the create
    form (shown only when more than one create-capable source is configured).

- 2c8078b: feat(tui): interactive task + agent-session dashboard

  Rebuild the `tui` command into a full-screen three-pane dashboard (task list ·
  detail · live session preview) on a layered, fully-tested architecture:

  - Pure, React-free logic (sort/filter/viewport/format/truncate/layout/heartbeat/
    session-history parsing) with exhaustive unit tests.
  - Provider-agnostic data layer (`SessionProvider` + fs-backed implementation)
    and an injected clock, so the whole UI is deterministic under test.
  - Performance: manual list windowing, memoized rows, and signature-gated
    polling to avoid re-render/flicker.
  - CJK-aware truncation, semantic status colors, focus-aware borders, a help
    overlay, and live filtering.
  - Runs full-screen on the alternate screen buffer by default.
  - Create tasks without leaving the dashboard (`n`), with required-field
    validation; the footer shows an `[n] new` hint when creation is available.
  - An in-app workflow diagram overlay (`w`) drawn as one connected diagram with
    the rework loop arc.
  - Per-round transcript drill-in: each agent round resolves its own session and
    renders a chat-style transcript, with markers for which rounds are viewable
    on this machine.

## 0.4.0

### Minor Changes

- b13bd1b: Add `--json` flag to `sync`, `schema`, `cleanup`, and `complete` commands for machine-readable output.

## 0.3.0

### Minor Changes

- 4efb151: Add `--json` flag to `sync`, `schema`, `cleanup`, and `complete` commands for machine-readable output.

## 0.2.0

### Minor Changes

- d06ddb2: Add global config fallback and `init` command.

  - `task.config.json` is now a supported project config format alongside TypeScript/JavaScript configs.
  - Config resolution falls back to `~/.agent-task-loop/config.json` when no project config is found.
  - New `init` command detects `lark-cli` (and offers to install it), discovers available coding agents via `@rivus/agent-finder-core`, prompts for Feishu credentials, and writes the global config.
  - "No config found" error now mentions `agent-task-loop init`.

## 0.1.1

### Patch Changes

- 4272fb1: Replace tsup with rslib for all packages. Eliminate scripts/sync-moonbit-js.mjs by embedding MoonBit FFI sync into an rslib plugin. Add shared @rivus/rslib-config package.

## 0.1.0

### Minor Changes

- 5d9d80b: Initial public release of the Agent Task Loop CLI.
