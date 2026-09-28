# RFC 0015 Implementation Plan

| Field | Value |
| --- | --- |
| Status | Implemented (2026-09-28) |
| Date | 2026-09-28 |
| Implements | RFC 0015 (agent collaboration system) |

## Ground rules

- **No compatibility with the current room-web data path.** Nobody depends on
  it. Shims exist only to keep CI green between two pull requests and are
  deleted by the PR that lands the replacement.
- **One pull request per slice.** The repository squash-merges, so each PR
  must be green on its own: `pnpm test`, `pnpm build`, `pnpm typecheck`, and
  the moonbit checks CI already runs.
- **Boundary tests stay red lines.** `packages/agent-orchestration/tests/package-boundary.test.ts`
  and `packages/agent-task-loop/tests/room-isolation.test.ts` must pass after
  every slice; a slice that needs to change them explains why in its PR.
- **Publishing.** `@rivus/agent-room` and `@rivus/agent-orchestration` are
  private at 0.0.0; their API breaks need no changeset. `@rivus/agent-task-loop`
  is published (0.11.0): slice 2 moves code into it and ships a changeset.
- **Parallel work in worktrees.** Slices 1 and 2 are independent and can run
  at the same time. Slice 3 starts only after both are on `main`.
- **Every string a person sees goes through `copy.ts`** and its grammar test.
  Every push runs the public-safety scan from `AGENTS.md`.

## Dependency graph

```text
S0 spike ─────┐
              ├──▶ S2 agent-orchestration ──┐
S1 agent-room ┘        (independent)        ├──▶ S3 room-web core ──▶ S4 agents page ──▶ S5 measure ──▶ S6 private rooms
S1 ─────────────────────────────────────────┘
```

Each slice below lists what it touches, the tests that prove it, the
commands that verify it, and the condition for calling it done.

## S0: spike, the three adapters on this machine

No PR. A scratch directory and a table of results that goes into the S2 PR
description. The point is to learn, before writing the connector, which
channels each adapter actually supports.

| Step | What to record |
| --- | --- |
| Install `@agentclientprotocol/sdk@1.5.0`, `@agentclientprotocol/claude-agent-acp@0.81.0`, `@agentclientprotocol/codex-acp@1.13.0` in the scratch directory; confirm `opencode acp` starts | Startup time to `initialize` response, per adapter |
| `initialize` each one; read `agentCapabilities` | `mcpCapabilities.http` present or not; `loadSession`; `promptCapabilities` |
| `session/new` with `cwd` and one `http` MCP server exposing a dummy `echo` tool; if refused, the same server behind a stdio shim | Which transport each adapter accepts |
| `session/prompt` "call echo with hello" | Whether the tool call arrives and the round trip time |
| For claude: `session/new` with `_meta.systemPrompt` set to a sentence the model must repeat | Whether the native system-prompt channel is honored |
| `session/new` while logged out of one adapter | The exact error, so `probe` can classify `needs-login` |

Exit: all three reach `ready`; at least one tool transport works for each;
the claude system-prompt channel is confirmed or the profile falls back to a
first block.

## S1: `@rivus/agent-room`

PR title: `feat(agent-room): broadcast wake, wake depth, speak and pass`.

### Changes

| File | Change |
| --- | --- |
| `src/room/domain/model.ts` | `wakeDepth: number` on `RoomEvent`; `RoomEventKind` loses `companion`; `AdmitRoomEvent` admits at depth 0 |
| `src/room/domain/room.ts` | `post` carries `wakeDepth`; `validateRoomState` checks it is a non-negative integer |
| `src/room/domain/reply-in-serial.ts` | Becomes `speak.ts`: input gains `addressedTo`, `readUpToSeq`, `triggerSeq`; HELD iff another author's event has `seq > readUpToSeq`; the post's depth is the trigger's depth plus one |
| `src/room/domain/complete-silently-in-serial.ts` | Becomes `pass.ts`: advances `seenSeq` to `readUpToSeq`; no HELD, no hold ack |
| `src/agent-session/domain/agent-session.ts` | `hold`, `ackHold`, `heldUpToSeq` removed; `advanceSeen` and `recordPost` stay |
| `src/wake/domain/wake-policy.ts` | `shouldWake({ event, memberId, ceiling })`; `WakePolicy` deleted |
| `src/room/application/room-stream-store.ts`, `room-stream-service.ts`, `src/room/infrastructure/memory-room-stream-store.ts` | `speak` and `pass` replace the two `*InSerial` methods |
| `src/index.ts` | Exports follow. `replyInSerial` and `completeSilentlyInSerial` stay as thin wrappers over `speak` and `pass` for one PR, marked for deletion in S3 |

### Tests, in `packages/agent-room`

- `speak`: two members speaking after the same trigger yield one `posted` and
  one `held` whose `newer` is exactly the other's post.
- `speak` after reading the newer events (`readUpToSeq = head`) is `posted`.
- `speak` ignores the member's own posts when deciding HELD.
- A post's `wakeDepth` is its trigger's plus one; a human admit is 0.
- `pass` moves the cursor to `readUpToSeq` and never returns `held`.
- `shouldWake`: control-plane events wake nobody; the author is not woken;
  an event at the ceiling wakes nobody; everyone else is woken.
- Restoring a room with a missing or negative `wakeDepth` throws.
- `addressedTo` on a member post survives the memory store round trip.

### Verify

```bash
pnpm --filter @rivus/agent-room test
pnpm --filter @rivus/agent-orchestration test   # package-boundary.test.ts
pnpm --filter @rivus/agent-task-loop test       # room-isolation.test.ts
pnpm typecheck && pnpm build
```

Done when the tests above pass and room-web still compiles through the
wrappers.

## S2: `@rivus/agent-orchestration`

PR title: `feat(agent-orchestration): control plane with registry, probe, lease, inbox, harness`.

This slice has a move and a build. Do the move first, in its own commit, so
the diff of the build is readable.

### 2.1 Move the task baton into `agent-task-loop`

| From `agent-orchestration` | To `agent-task-loop/src/orchestration/` |
| --- | --- |
| `domain/run.ts`, `domain/template.ts` | `run.ts`, `template.ts` |
| `contracts/types.ts` (`Run*`, `Seat*`, `TemplateSpec`, `ProcessRunner*`, `SpawnResult`) | `types.ts` |
| `application/orchestration.ts` | `orchestration.ts`, now built on the new `LeaseManager` for `open`, `heartbeat`, `release`, `fence` |
| `infrastructure/execa-runner.ts`, `memory-store.ts`, the run-state half of `file-store.ts` | same names |
| their tests | move with them |

`createTaskOrchestration`, `TaskOccupancyService`, and
`MemoryOrchestratedTaskRuntime` keep their behaviour and their tests.
`package-surface.test.ts` is updated for whatever the package now exports.
Changeset for `@rivus/agent-task-loop`: minor if the export list changes,
patch otherwise. `ProcessRunner` and `SeatBind` stay re-exported from
`agent-orchestration` as type aliases until S3 deletes their last importer
(`local-agent-runner.server.ts`).

### 2.2 Contracts

`contracts/agent.ts` (`Agent`, `AgentBinding`, `AgentRegistry`),
`contracts/lease.ts` (`LeaseRecord`, `FencingToken`, `FencedResult`,
`LeaseStore`), `contracts/connection.ts` (`AgentConnector`, `AgentConnection`,
`AgentProbe`, `SessionUpdate`, `PermissionRequest`, `PermissionOutcome`),
`contracts/harness.ts` (`Harness`, `PermissionPolicy`, `ToolDefinition`,
`ToolCall`, `TurnResult`). Shapes are in RFC 0015.

### 2.3 Lease

`application/lease-manager.ts` takes the acquire, heartbeat, fence and
release logic out of today's `orchestration.ts`; `domain/lock.ts` is
unchanged. `infrastructure/memory-lease-store.ts` and
`infrastructure/file-lease-store.ts` (the lock half of today's
`file-store.ts`).

### 2.4 Connector

`infrastructure/acp-connector.ts` on `@agentclientprotocol/sdk@1.5.0`,
pinned. The process is spawned through the person's login shell
(`zsh -lic '<command>'`) so an alias counts. `connect` performs
`initialize` once and keeps the process; `newSession` passes `cwd`,
`mcpServers`, and the profile's `_meta`; `prompt` resolves with the
`stopReason`; `onUpdate` and `onPermissionRequest` fan out the two inbound
streams; `probe` is `initialize` plus a trial `session/new`, classified as
`missing`, `needs-login`, or `ready` using what S0 recorded.

### 2.5 Profiles

`infrastructure/profiles/{claude,codex,opencode}.ts`. Each maps a `Harness`
to a `newSession` request and a prompt: claude sets `_meta.systemPrompt` and
`_meta.claudeCode.options`; the others put `systemPrompt` in the first block
unless S0 found a native channel. Each writes `workspaceFiles` into `cwd`
before the session opens.

### 2.6 ToolServer

`application/tool-server.ts`: given `ToolDefinition[]` and a token, hosts a
streamable-HTTP MCP server on the loopback address the endpoint provides and
returns the `McpServer` entry for `session/new`. When the agent's
capabilities lack `mcpCapabilities.http`, it returns a `stdio` entry pointing
at `bin/acp-tool-shim.js`, a proxy to the same URL. Built on the official MCP
server SDK; no hand-written JSON-RPC.

### 2.7 AgentRuntime

`application/agent-runtime.ts`: an `Inbox` per key. `wake(key)` sets
`pending` when running, otherwise starts an activation. An activation
acquires the lease, connects or reuses the process, reuses or creates the
session, asks `onActivate` for the `Harness`, applies the profile, hosts the
tools, prompts, runs `afterTurn`, releases, and starts again if `pending`.
A timeout cancels the session and ends the activation as `timeout`.

### Tests, in `packages/agent-orchestration`

- Lease: the existing lock tests, moved to the new names.
- Inbox: a wake during an activation produces exactly one further
  activation; three wakes during an activation still produce one; a wake
  while idle starts at once; `cancel` ends the activation and clears
  `pending`.
- Profile: the claude profile puts the system prompt in `_meta.systemPrompt`
  and nothing in the blocks; the fallback profile puts it in block 0.
- ToolServer: an in-process MCP client calls a registered tool through the
  HTTP endpoint and gets the handler's result; a wrong token is refused.
- AcpConnector against a fake ACP agent built with the SDK over an
  in-memory duplex stream: `initialize`, `newSession` with `mcpServers`,
  `prompt` with a streamed `tool_call_update`, `cancel`.
- Probe: the fake agent in three configurations yields the three statuses.
- Live: `RIVUS_LIVE_ACP=1 pnpm --filter @rivus/agent-orchestration test`
  runs `probe` against the three real adapters; skipped otherwise.

### Verify

```bash
pnpm --filter @rivus/agent-task-loop test       # moved code, surface, isolation
pnpm --filter @rivus/agent-orchestration test
pnpm typecheck && pnpm build
cd packages/agent-task-loop && npm pack --dry-run --registry=https://registry.npmjs.org
```

Done when the tests pass, the S0 table is in the PR, and room-web still
compiles through the two type aliases.

## S3: room-web core loop

PR title: `feat(room-web): rooms run on the control plane`.

### 3.1 Migrations

`0004_wake_depth`, `0005_room_settings` (including the three private-room
columns, unused until S6), `0006_control_plane` (`member_leases`, `turns`),
`0007_drop_workspace`. Before writing them, copy the real library
(`~/.rivus/room-web/v1/rooms.sqlite`) into a scratch directory and keep it
as the migration test fixture, because `0007` drops a table and the runner
must be seen rolling back on failure.

### 3.2 Adapters

`SqliteAgentRegistry` over `agents`; `SqliteLeaseStore` over
`member_leases` with `runFenced` as a per-key promise chain plus a holder
re-read; `SqliteTurnLog` over `turns`. `sqlite-room-unit-of-work.server.ts`
learns `wake_depth` and drops `held_up_to_seq`.

### 3.3 The service

`room-lab-service.server.ts` (741 lines) is replaced by a `RoomService` of
three handlers: `admit` (validate, admit, compute the wake set, apply the
budget, call `runtime.wake` in seat order when `serial`), `onActivate`
(read the inbox after the cursor, build the `Harness`: system prompt, room
facts, inbox lines, the two Room tools, the permission policy), and
`afterTurn` (fenced `pass` when nothing was spoken, then the turn log).
`room-lab-host.server.ts` wires the registry, the lease store, the runtime,
and the tool definitions.

### 3.4 Deletions

`count-off-run.ts`, `held-retry.ts`, `local-agent-runner.server.ts`,
`local-task-delivery.server.ts`, `CountOffStrip.tsx`, `RunStrip.tsx`,
`round.ts`, the `count-off`, `retry` and `task` actions, `busy` and
`runningAgentIds` in the read model, every `room_workspace` code path, the
S1 wrappers and the S2 type aliases, and the copy keys those surfaces used.

### 3.5 Read model and UI

`RoomView` gains `turns` and loses `countOff`, `task`, `busy`. Member status
is derived: lease held plus no tool call is 阅读中, a tool call is 工作中,
otherwise the last turn's outcome. `RoomContext`, `RoomWorkspace`, `RoomHeader`
and `RoomSidebar` drop the count-off and retry affordances. Room settings
(`wake`, `serial`, `cwd`) get the smallest possible surface: fields on the
create form and a settings item in the existing room menu.

### Tests, in `apps/room-web`

- Service with a fake runtime: an admitted human message wakes every seated
  member but the author; `addressed` wakes only the mentioned; the budget
  posts a notice and stops; `serial` issues wakes in seat order one at a
  time; an activation that spoke does not `pass`; one that did not does.
- Migration fixture: 0004–0007 apply to the copied library; a failing 0007
  leaves the library at 0006.
- Read model: status derivation for each `turns.outcome`.
- Routes: existing route tests updated for the new action set; the copy
  grammar test still passes.

### Verify

```bash
pnpm --filter @rivus/room-web test
pnpm --filter @rivus/room-web typecheck
pnpm --filter @rivus/room-web build
pnpm test && pnpm build && pnpm typecheck
```

Then the live check that RFC 0015 makes the acceptance test: three real
members, one question with a peer's post landing mid-turn (expect one HELD
resolved inside the turn), one 报数 (expect the walkthrough's turn count),
one handoff addressed with `@`. Paste the `turns` rows into the PR.

Done when the tests and the live check pass and nothing in the diff still
references a deleted surface.

## S4: agents page and candidate catalog

PR title: `feat(room-web): agents page on probe`.

- `agent-seed.server.ts` seeds the three ACP candidates with their commands;
  `dsh` is no longer seeded.
- 重新扫描 runs `probe` on every row; states are 缺失, 待登录, 可入座, 已入座.
- An add-agent form (id, label, command, role) replaces the `INSERT` in the
  README; the README section goes.
- `room-agent-inventory.server.ts` and the `@rivus/agent-finder-core`
  dependency are removed.
- Tests: the desk view maps each probe status to its state word; the form
  rejects an id that is not `^[a-z][a-z0-9-]*$`; the seed is idempotent.

## S5: measurement

No feature code. With three real members, run the same script three times:
`broadcast`, `addressed`, `serial`. Record from `turns` and the ACP
`usage_update` stream:

| Metric | Per configuration |
| --- | --- |
| Activations per round for a question and for a count-off | |
| Wall time from admit to the last `pass` | |
| Tokens per activation, split into silent and spoken | |
| HELD count | |

The numbers go into a short note appended to RFC 0015 and decide the default
of `serial`. If the default flips, that is a one-line PR.

## S6: private rooms

PR title: `feat(room-web): private rooms between agents`.

- `room_dm` as the third Room tool; finds or creates the child room, seats
  the two agents, admits the first message at `trigger + 1`.
- Round tracking keyed by the root human event across parent and children;
  the budget counts both.
- The sidebar nests children under the parent, titled by members; the
  person can open and speak in them.
- Tests: `room_dm` twice between the same pair reuses the room; a child's
  activations count against the parent round; a non-member is not woken by
  a child event; the private-exchange walkthrough as a service test.

## Cross-cutting checklist, every slice

- [ ] `pnpm test`, `pnpm build`, `pnpm typecheck` green locally before push.
- [ ] Public-safety scan from `AGENTS.md` clean.
- [ ] No new string outside `copy.ts`; grammar test green.
- [ ] Boundary tests untouched, or the PR says why.
- [ ] PR body answers: what changed, why, how tested, what follows.

## Risks and their triggers

| Risk | Trigger | Response |
| --- | --- | --- |
| An adapter accepts no HTTP MCP | S0 | The stdio shim is on the main path for that adapter; nothing else changes |
| The claude system-prompt channel changes between releases | S2 live test fails | Profile falls back to block 0; pin the adapter version |
| Broadcast is too expensive | S5 numbers | Flip `serial` default; consider a `router` wake value as a later RFC |
| Migration 0007 fails on a real library | S3 fixture test | The runner rolls back; fix the migration, never the data by hand |
| `runFenced` under one process is not enough | A second process appears | Out of scope here; the daemon RFC owns it |
| A long-lived session drifts from the record | Any live check | The HELD rule already forces a re-read before speaking; the session is recreated on restart |

## Definition of done for the RFC

All five walkthroughs in RFC 0015 reproduce on this machine with real
adapters, with `turns` rows as evidence; the deletions list is empty in
`rg`; the four RFCs this one supersedes are marked as such in their status
tables.
