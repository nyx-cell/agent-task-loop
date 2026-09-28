# RFC 0010: Agentic Task Team Runtime

| Field | Value |
| --- | --- |
| Status | Draft |
| Date | 2026-08-25 |
| Supercedes | Unnumbered Room draft on this PR (`0010-host-room-session-and-run.md`) |
| Related implementation | PR 95 (`rfcs/0011-agent-orchestration.md` + `@rivus/agent-orchestration`), PR 96 (ATL `open` before start) |
| Partially superseded | Chapter B's wake policy and the `wake-on-peer-posts` knob are replaced by RFC 0015's broadcast `shouldWake` with wake depth (implemented 2026-09-28); the rest stands |

## Summary

ATL's **team harness** is two kernels in this monorepo, plus one task caller and one live adapter:

1. **Occupancy** — one occupied run, seat roster, `allow` turn for spawn, facts/mail blackboard (`@rivus/agent-orchestration`).
2. **Room** — one shared posted stream, per-agent session, write-point HELD (`@rivus/agent-room`).
3. **Task loop** — `@rivus/agent-task-loop` calls occupancy before start; it does not own Room seq; RFC 0009 tools do not read or write Room.
4. **Live adapter** — `rivus-agent` injects the Room store for Feishu; it does not own seq rules.

They are one product. They are not one package and not one implementation PR.

## Numbering

PR 91 already shipped a different file named RFC 0010 (`0010-local-desktop-console.md`) for the **desktop UI adapter**. That RFC should be renumbered **0012**. Desktop is a projection, not this kernel.

This document is the team-runtime RFC that PR 95 already cited as `rfcs/0010-agentic-task-team-runtime.md`. RFC 0011 remains the occupancy kernel API. Room has no separate RFC number after this change.

## Goals

- One parent design so occupancy and Room cannot be mistaken for each other.
- Occupancy owns exclusive execution seats. Room owns the public posted world.
- Task Backend stays the system of record for Task fields. Occupancy lock is not a Task Backend column.
- Core packages are pure: ports + memory (and optional sqlite) adapters; no Feishu in domain files.
- `rivus-agent` is the first real agent used to prove Room on a live channel.

## Non-Goals

- Merging PRs 95, 96, and Room implementation into one diff.
- Putting `Team` / `Lead` types in the occupancy kernel.
- Chat-turn claims (`allow(seat)` must not mean "I reserved the next chat line").
- Storing TaskRecord, workspace, runnerPid, or External Worker identity in Room.
- A `task-claim` tool. Task-start exclusion is occupancy `open`, already designed in RFC 0011 / PR 96.
- Moving either kernel into `rivus-agent`.
- Desktop console (PR 91 / 92) as part of this kernel.
- Kanban, calendar, private todos, Cumora CLI as the model surface.

## Non-mixing rules

| Mechanism | Owns | Must not be used for |
| --- | --- | --- |
| Occupancy `open` / heartbeat / release | One occupied run key (e.g. `task:{taskId}`) | Room seq, chat turns |
| Occupancy `allow(seat)` + `spawn` | Who may start the next worker process | Who may `room.reply` |
| Occupancy facts / mail | Run-scoped blackboard | Public posted world |
| Room stream `seq` | Already-posted public events | Task status, worker pid |
| Room HELD | Stale reply at the write point | `task-start` mutual exclusion |
| RFC 0009 tools | Task Backend via Task Manager | Room membership or seq |

If two agents race `task-start`, occupancy `open` decides. If two agents race a chat reply, Room HELD decides. Do not implement one with the other.

---

## Chapter A — Occupancy

Source of API truth: RFC 0011 and PR 95 (`packages/agent-orchestration`).

The kernel owns **one occupied run**:

- `templates.register / get / list`
- `open({ key, template, bind?, context? })` — exclusive occupy (lock file in v1; sqlite is an adapter)
- `inspect` / `observe`
- `allow(key, seat)`
- `appendFact` / `sendMail`
- `spawn(key, seat, { cwd })` — only if `allowed === seat`
- `fence(key, mutation, signal?)` — serialize an external write under the current holder token
- `heartbeat` / `release` / `listRuns`

Conflict: `orchestration-conflict`. Stale lock (dead pid or heartbeat older than `staleAfterMs`) may be taken over.

The kernel does not import `@rivus/agent-task-loop`. It does not interpret `context.ref` (a task id is opaque). Template `classic-delivery` (`impl`, `review`) is registered by ATL, not by the kernel.

**PR 96** is the first ATL wiring, not a second kernel: `TaskStartService.startTask` calls `open('task:' + taskId)` before liveness / ReviewLoop, and `release` in `finally`. Two concurrent starts: one wins `open`; the other never claims the Task Backend. Every Task lifecycle write in an occupied run enters `fence` first. A stale holder cannot begin a write; when a holder is replaced during an already-started write, the successor waits for that write before starting its own, so a predecessor cannot overwrite newer Task state with a late completion.

Later: ReviewLoop may call `spawn` instead of `execa`. Occupancy still must not become Room.

---

## Chapter B — Room

Source of detailed write-point rules: the remainder of this section (folded from the Room draft). Implementation package: `packages/agent-room`.

### Layers

```text
Room          = TenantId + ConversationId
                shared posted stream (monotonic seq), membership, wake policy
AgentSession  = TenantId + AgentId + RoomId + RuntimeGenerationId
                seen cursor, private transcript, conversation memory, one Active Run
Run           = one accepted turn, hung off AgentSession
Endpoint      = a projection (Feishu, TUI, webhook); does not own Room
Task*         = RFC 0009; not a Room field
```

See ≠ wake. `@` is addressing. Unmentioned human messages follow membership wake policy (`mention-only` | `all-human-messages`). Companion agent posts enter the stream and **default do not wake**. `wake-on-peer-posts` is a reserved knob, default off.

Chat turns do not use claims. Exclusive **deliverable** claims are a later RFC, after this train. They are not occupancy `allow(seat)` and not Room HELD.

### Store port (pure)

```ts
interface RoomStreamStore {
  admit(input: AdmitRoomEvent): Promise<AdmitResult>;
  readSlice(roomId: RoomId, afterSeq: RoomSeq, budget: SliceBudget): Promise<RoomSlice>;
  replyInSerial(input: RoomReplyCommand): Promise<RoomReplyResult>;
  head(roomId: RoomId): Promise<RoomSeq>;
}
```

- Domain files: no `node:fs`, no Feishu SDK.
- `createMemoryRoomStreamStore()` is the default for tests.
- `createSqliteRoomStreamStore()` is an adapter, not the core.
- `admit` is idempotent on transport `message_id`.
- `replyInSerial` is one critical section: read seen, compute `newer` (including human posts, `author ≠ self`), HELD or append `head+1`.
- Hold ack is one-shot, bound to `heldUpToSeq`. Preemptive ack is ignored.
- `origin: "control-plane"` takes a seq, does not run chat HELD, does not `advanceSeen`.

`packages/agent-task-loop` must not depend on Room domain types.

### Write-point HELD (normative)

Two sessions reply in parallel: exactly one `posted`; the other `held` and is shown newer posts. After any `held` or `posted` in a Run, the adapter must not wrap leftover `finalText` as a world post (`invocationCount == 0` is required for compatibility wrap).

Room stream is authoritative for "what was posted". Session transcript is "what I already thought". On conflict, Room wins for the next post.

---

## Chapter C — ATL as caller

RFC 0009 stands: four tools, redacted DTOs, no ambient Shell/fs/Endpoint/Memory.

ATL:

- **May** call occupancy `open` / `release` around start (PR 96).
- **Must** route Task lifecycle writes from `start`, `run`, and rejection rework through the occupancy mutation fence.
- **Must not** import Room types into TaskRecord, ReviewLoop status, or plugin DTOs.
- **Must not** treat occupancy facts/mail as the Feishu/group world.

Task-start TOCTOU is occupancy's job, not Room's, and not a new `task-claim` tool.

---

## Chapter D — `rivus-agent` as live adapter

`rivus-agent` injects one `RoomStreamStore` into all member endpoints.

It owns: Feishu intake, CardKit projection, outbound `message_id` registry (echo never allocates a new seq), mapping `botOpenId` → deployed `AgentId`.

It does not own: seq assignment, HELD predicate, membership wake evaluation.

Human-visible agent body on Feishu is only `kind: "posted"` Outbox projection. Progress / cancel / HELD cards are not world facts. Progress card and posted body are the same IM message.

Live proof (after Room 1c exists): two bots, one room seq, two sessions, HELD, echo does not bump seq. Missing credentials is a blocked live test, not a mocked pass.

---

## Package layout

```text
this repo
  packages/agent-orchestration   occupancy kernel (PR 95)
  packages/agent-room            Room / Session / store port (this RFC, ch. B)
  packages/agent-task-loop       task caller (RFC 0009 + PR 96)

rivus-agent
  injects RoomStreamStore
  Feishu adapter + live canary
```

`agent-orchestration` does not import `agent-task-loop` or `agent-room`.
`agent-room` does not import `agent-task-loop` or `agent-orchestration`.
`agent-task-loop` may import occupancy; it must not import Room domain types.

---

## Key Decisions

1. One parent RFC for the team harness; occupancy and Room stay separate packages.
2. Occupancy = exclusive run/seat. Room = public posted stream. Do not implement either with the other.
3. ATL is a caller of occupancy. Task Backend remains authoritative for Task fields.
4. Room core lives in this repo (`packages/agent-room`). `rivus-agent` is the live agent adapter.
5. Chat turns are HELD, not claimed. Occupancy `allow` is for spawn, not for chat.
6. Occupancy facts/mail are run-scoped. They are not Room seq.
7. No `task-claim` tool. Concurrent `task-start` is `open('task:'+id)` (PR 96).
8. Desktop console (PR 91/92) is out of this RFC; renumber that RFC to 0012.
9. See ≠ wake. Companion posts enter the stream; default no wake.
10. Core is runtime-agnostic. Memory tests prove the kernel; sqlite and Feishu are adapters.

---

## Implementation PRs (do not squash)

This repo:

| PR | What |
| --- | --- |
| **95** | Occupancy kernel package (RFC 0011 API) |
| **96** | ATL `open` before start |
| **Room 1a** | `packages/agent-room` port + memory `admit` |
| **Room 1b** | AgentSession seen / hold |
| **Room 1c** | `replyInSerial` HELD + `readSlice` (+ optional sqlite) |
| **Room 2** | Wake evaluator `mention-only` / `all-human-messages` |
| **4** | Prove RFC 0009 plugin still isolated from Room |

`rivus-agent` (after 1c is consumable):

| PR | What |
| --- | --- |
| **1d** | Inject store; Feishu echo registry; live S0–S7 |
| **3** | Adapter context assembly reads `readSlice` |

Do not merge 95+96+Room into one GitHub PR. 95 has no Room types; 96 must not wait for Room; Room must not take a dependency on occupancy.

### After this train

- Exclusive **deliverable** claim RFC (not chat, not `task-start`).
- Feishu chat-level Room (thread becomes topic).
- `wake-on-peer-posts` knob, default off.

### Not this train

- `task-start` CAS inside the Task Backend (superseded by occupancy `open` for ATL).
- Moving kernels into `rivus-agent`.
- Desktop console.

## Alternatives

**Keep three independent RFCs with no parent.** Rejected: occupancy `allow` and Room HELD will be cargo-culted onto the wrong object.

**One implementation PR for 95+96+Room.** Rejected: different packages, different proof, Room is still design-only.

**Put Room inside `agent-orchestration`.** Rejected: blackboard mail is not a posted stream; spawn lock is not HELD. A single package would invite `allow` on chat.

**Put occupancy inside Room.** Rejected: `task-start` exclusion must work with zero Feishu/Room.

## Risks

| Risk | Mitigation |
| --- | --- |
| Callers use `allow(seat)` as chat reservation | Parent rule table; Room tests never call occupancy |
| Callers use HELD as task-start lock | PR 96 owns that path; Room 1c tests have no TaskRecord |
| Two RFC 0010 files merge | Rename desktop RFC on PR 91 to 0012 before merge |
| `agent-room` and `agent-orchestration` quietly import each other | Package-boundary tests, same as PR 95 |

## References

- RFC 0009 — Task Manager Plugin
- RFC 0011 / PR 95 — occupancy kernel
- PR 96 — ATL occupy-before-start
- PR 91 / 92 — desktop console (renumber to 0012)
- `rivus-agent` Feishu runtime — live adapter only
- Cumora public prior art for HELD-at-write (do not copy product or fail-open Redis)
