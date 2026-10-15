# @rivus/agent-finder-cli

## 0.3.0

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

- [#134](https://github.com/PerfectPan/agent-task-loop/pull/134) [`778fe6f`](https://github.com/PerfectPan/agent-task-loop/commit/778fe6facbf4d7ddee26536c6f846f99d7b5b10c) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Require Node.js 22 or newer; Node.js 20 is no longer supported. The CLIs move to Ink 7, and `@rivus/agent-task-loop` also to execa 10; both need Node.js 22.

### Patch Changes

- [#130](https://github.com/PerfectPan/agent-task-loop/pull/130) [`68a1d1c`](https://github.com/PerfectPan/agent-task-loop/commit/68a1d1ce35b688a6b9a16fb16a77d2399925b69a) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Upgrade the runtime dependencies to Ink 6 with React 19 and citty 0.2. `-v` prints the version, `--help` output uses citty 0.2's layout, and a value after a boolean flag is no longer read as the flag's value (`--json false` turns JSON output on; use `--no-json`).

- [#125](https://github.com/PerfectPan/agent-task-loop/pull/125) [`c006fce`](https://github.com/PerfectPan/agent-task-loop/commit/c006fce5411fab9ed5e4d57bff87eacede40195d) Thanks [@PerfectPan](https://github.com/PerfectPan)! - License `@rivus/agent-finder-cli` under MIT instead of GPL-3.0-only. The package now ships its own `LICENSE` file with the MIT text; the session browser code it bundles from the workspace library `@rivus/agent-sessions` is MIT as well.

- [#139](https://github.com/PerfectPan/agent-task-loop/pull/139) [`24fc8aa`](https://github.com/PerfectPan/agent-task-loop/commit/24fc8aad430e0538da31aaba8a4b0e63014823d0) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Ship `dist/cli.d.ts`, the declaration file the package's `types` export points at, and stop shipping the declarations of its tests and Vitest config.

- [#140](https://github.com/PerfectPan/agent-task-loop/pull/140) [`735a25a`](https://github.com/PerfectPan/agent-task-loop/commit/735a25ac5dc346742a5f2bc3f3e7583ebb2b946c) Thanks [@PerfectPan](https://github.com/PerfectPan)! - `agent-finder -v` and `agent-finder provider -h` print the package's version instead of a hard-coded 0.1.0.

- [#149](https://github.com/PerfectPan/agent-task-loop/pull/149) [`5cd6419`](https://github.com/PerfectPan/agent-task-loop/commit/5cd6419fc230f4058c84606b90be8ba4dd7a87fe) Thanks [@nyx-cell](https://github.com/nyx-cell)! - Build the published JavaScript with Vite+ (`vp pack`). The bundle changes form, not behavior.

- [#138](https://github.com/PerfectPan/agent-task-loop/pull/138) [`f34f632`](https://github.com/PerfectPan/agent-task-loop/commit/f34f63230f8dacad29d6b18365137c9eddea26c0) Thanks [@PerfectPan](https://github.com/PerfectPan)! - Fix the published TUIs (`agent-task-loop tui` and `agent-finder sessions browse`) crashing on start with `ReferenceError: React is not defined`: the build now compiles JSX with the automatic runtime.

## 0.2.0

### Minor Changes

- 480e372: Add a `sessions` command to browse and inspect local coding-agent sessions across Codex and Claude (backed by the shared `@rivus/agent-sessions` core):

  - `agent-finder sessions browse` — interactive two-pane TUI: session list + transcript preview, ↑/↓ navigation, `q` to quit.
  - `agent-finder sessions list [--agent <a>] [--filter <s>] [--json]` — aligned, color-coded table; `--json` emits a stable `{ schema_version, sessions }` payload.
  - `agent-finder sessions inspect <id> [--json]` — session metadata + transcript.

- 69d83c9: Add session resume support (print-only): `agent-finder sessions resume <id>` prints the verified command to resume a session in its agent (`codex resume <id>` / `claude --resume <id>`), `sessions inspect` shows it (and includes `resumeCommand` in `--json`), and the `sessions browse` TUI shows a resume hint for the selected session. The command is printed, never executed.

## 0.1.3

### Patch Changes

- 5c3c6b0: Redesign all human CLI output (#23) onto a small shared presentation layer:

  - `scan`: aligned, color-coded table with a status glyph, a new version column, and a status summary footer (the per-status counts were previously computed but never printed).
  - `provider list`: aligned ID/Name/Adapter table (was tab-separated).
  - `provider inspect`: bold title with aligned, dimmed key labels.
  - `doctor`: bold total plus glyph/color-coded status counts.

  Color is emitted only on an interactive TTY and suppressed under `NO_COLOR`; `scan --json` output is unchanged.

## 0.1.2

### Patch Changes

- Updated dependencies [c7a99de]
  - @rivus/agent-finder-core@0.1.2

## 0.1.1

### Patch Changes

- 4272fb1: Replace tsup with rslib for all packages. Eliminate scripts/sync-moonbit-js.mjs by embedding MoonBit FFI sync into an rslib plugin. Add shared @rivus/rslib-config package.
- Updated dependencies [4272fb1]
  - @rivus/agent-finder-core@0.1.1

## 0.1.0

### Minor Changes

- 22de691: Add the initial agent finder packages with a MoonBit discovery core, JavaScript wrapper, and CLI.

### Patch Changes

- Updated dependencies [22de691]
  - @rivus/agent-finder-core@0.1.0
