# RFC 0013: Local Room Workspace

| Field | Value |
| --- | --- |
| Status | Draft |
| Date | 2026-09-06 |
| Related | RFC 0010 (Room / occupancy kernels), RFC 0012 (domain layout), RFC 0006 (local run-time state) |
| Partially superseded | The "Addressing" and "Send lifecycle" sections are replaced by RFC 0015's room tools and HELD-resolved-in-turn (implemented 2026-09-28); the rest stands |

## Summary

`apps/room-web` is a local workspace where a person and several local CLI agents
share one named Room, produce a durable draft, and only then enter a constrained
Task. It is not a model status board and not a single in-memory demo.

This RFC freezes the product loop and the application boundaries. Kernel rules
in RFC 0010 stay: Room owns the posted stream and HELD; occupancy owns exclusive
Task seats; they do not implement each other.

## Motivation

The current Remix surface can open, chat once, and pass unit tests while still
failing as a product:

- One hardcoded Room (`local/web-room`) with a sidebar link that is not navigation.
- Conversation, composition, counters, and Task state live in process memory.
- The HTTP action waits for CLI agents, so send, busy, and execution are one lock.
- Restart drops work. The UI already admits this.
- Task model PASS is shown, but there is no human accept / rework action.

## Goals

- Create, list, open, and switch Rooms. Each Room has its own URL and data.
- Persist history, membership, drafts, Task records, and recovery flags so a
  process restart does not silently erase work.
- Admit a human message immediately. Agent execution is a later turn.
- Keep composer usable while agents run. Duplicate submits are idempotent.
- Recover interrupted runs as interrupted. Never auto-replay CLI side effects.
- Distinguish installed, runnable, and seated. Grok is optional.
- Distinguish model review PASS from human acceptance.

## Non-goals

- Hosting this surface on a public URL.
- SQLite inside `@rivus/agent-room` in the first slice (file snapshots are enough).
- Changing HELD, `shouldWake`, or occupancy kernel rules.
- Auto-writing the Room draft from every agent reply.
- Merging PRs without human review.

## Product defaults

These are application decisions, not kernel changes.

### Why a Room exists

A Room is one named collaboration around a topic or deliverable. Membership is
who may speak, not why the Room exists. Users create Rooms by work, not by agent
and not by calendar day.

### Addressing

| Input | Who is addressed | Who runs |
| --- | --- | --- |
| No `@` | All active members | Sequential discussion, seat order |
| `@agent` | That agent | That agent only |
| `@a @b` | Those agents | Sequential in composition order among the mentioned |
| `@all` | All active members | Sequential in seat order |

Unmentioned messages still use the kernel `all-human-messages` wake policy.
The application serializes the actual CLI turns so ordinary chat does not fan
out five parallel drafts and leave four of them HELD.

Agent posts still do not wake peers.

### Shared work

Each Room has one markdown **工作稿**. Chat is the discussion. The draft is the
thing that survives and can be edited. Pinning a message writes or replaces the
draft. Promoting a draft opens Task intake with goal, constraints, deliverable,
and acceptance criteria prefilled.

### Task

Task still requires Codex (`impl`) and Claude (`review`). A model PASS is
`passed` and waits for a human `accept` or `rework` action. Human acceptance is
the only path to a delivered Room result.

### Persistence

Local files under `~/.rivus/room-web/v1/`. Catalog and per-Room snapshots use
atomic write (temp file + rename). In-flight CLI work is stored as interrupted
on a clean load; it is not resumed.

### Send lifecycle

1. Client sends `clientMessageId`.
2. Server admits (idempotent on that id) and enqueues wakes.
3. HTTP returns the admitted snapshot without waiting for CLI.
4. Per-agent queues run turns. A new human message may be admitted while a turn
   is running; it becomes the next round, it does not globally disable the UI.
5. Restart marks leftover in-flight rows interrupted.

## Application map

Keep the work in `apps/room-web` unless a kernel port is missing.

```text
apps/room-web/app/room-lab/
  domain/          RoomCatalog, RoomWorkspace identity, addressing, draft, recovery
  application/     commands: create/open/send/enqueue/accept-task
  infrastructure/  file catalog + stream snapshots, CLI runner, probes
  presentation/    Remix routes and chat UI
```

`Room` and `AgentSession` stay in `@rivus/agent-room`. Task delivery stays in
`@rivus/agent-task-loop`. room-web may persist snapshots of those aggregates; it
must not reimplement HELD or occupancy.

## Implementation slices

Independently reviewable, stacked on the current Room Web branch:

1. Catalog + file persistence + `/room/:id` isolation.
2. Admit/execute split, client idempotency, optimistic alignment.
3. Draft, Task promotion, human accept/rework, interrupted recovery, availability.

Visual language is chosen separately and must not land before the loop works.

## Risks

- File snapshots are not a multi-process store. The local Remix server remains
  single-writer.
- Sequential discussion is slower than one targeted mention. The UI must show
  who is next, not freeze the composer.
- Real CLI probes can fail for auth or quota even when the binary exists. The
  roster must not collapse those states into "online".
