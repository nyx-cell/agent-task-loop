# @rivus/agent-room

Shared **posted stream**, per-agent session, and write-point HELD.

This package does not know tasks, occupancy seats, Feishu, or ReviewLoop.
Callers inject the capability port for the slice they use. `rivus-agent` is the first live adapter.

See RFC 0010 Chapter B.

## Domain model

- `Room` is the aggregate root for one ordered conversation stream. It owns
  sequence assignment, external transport idempotency, and bounded reads.
- `RoomEvent` is an entity identified by its sequence inside a Room. Every
  event carries a `wakeDepth`: 0 for an admitted (human) event, the trigger's
  depth plus one for a member post.
- Only externally admitted events carry `transportMessageId`; internal agent
  and control-plane posts use their sequence as identity and are not transport
  deduplication candidates. `messageId` remains the compatibility/display field.
- `AgentSessionAggregate` is a separate aggregate root for one agent runtime's
  seen cursor.
- `speak` and `pass` are the two write points across Room and AgentSession,
  evaluated in one serialized write. `speak` is HELD while any event by another
  author sits past the seq the turn read; `pass` advances the cursor and is
  never HELD.
- `shouldWake` is the broadcast wake rule: control-plane events wake nobody, an
  event never wakes its own author, and an event at or above the room's depth
  ceiling wakes nobody. Everyone else is woken.

See RFC 0015 for the collaboration system and RFC 0012 for the
repository-wide dependency rules.

## Status

Internal package (`private: true`). Not published yet.

- `RoomAdmissionStore` port (`admit` + `head`)
- `RoomStreamStore` port (`readSlice`, `speak`, `pass`) with a memory
  implementation, `createMemoryRoomStreamStore()`
- `admit` is idempotent on transport `message_id` and lands at depth 0
- `head` returns the last posted seq (0 if empty)
- `speak({ body, addressedTo, readUpToSeq, triggerSeq })` posts at the
  trigger's depth plus one or returns HELD with the newer events
- `pass({ readUpToSeq })` moves the cursor without a post
- `replyInSerial` / `completeSilentlyInSerial` survive as thin wrappers over
  `speak` / `pass` for one pull request (apps/room-web); deleted in S3

## Non-mixing

Occupancy `allow(seat)` is not a chat reservation. Room HELD is not `task-start`
exclusion. Do not import `@rivus/agent-orchestration` or `@rivus/agent-task-loop`.
