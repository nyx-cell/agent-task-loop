import { AgentSessionAggregate } from '../../agent-session/domain/agent-session';
import { sessionKey, type AgentSessionId } from '../../agent-session/domain/model';
import { RoomValidationError } from './errors';
import { sameRoomId } from './model';
import { Room } from './room';
import type { AgentId, RoomEvent, RoomSeq } from './model';

export interface SpeakCommand {
  session: AgentSessionId;
  body: string;
  addressedTo: AgentId[];
  /** The seq the turn actually read up to, not the stored cursor. */
  readUpToSeq: RoomSeq;
  /** The event that woke this member; the post's wakeDepth is its depth plus one. */
  triggerSeq: RoomSeq;
  origin?: 'agent' | 'control-plane';
}

export type SpeakResult =
  | { outcome: 'posted'; seq: RoomSeq; event: RoomEvent }
  | { outcome: 'held'; newer: RoomEvent[] };

export type SpeakInput = Pick<
  SpeakCommand,
  'body' | 'addressedTo' | 'readUpToSeq' | 'triggerSeq'
>;

/**
 * Domain service for the speak write point. HELD when any event by another
 * author sits past what the turn read; otherwise the post is appended at the
 * trigger's depth plus one and the member's cursor moves to the new seq. HELD
 * changes no state: the member reads the newer events and calls again inside
 * the same turn.
 */
export function speak(
  room: Room,
  session: AgentSessionAggregate,
  input: SpeakInput,
  at: string,
): SpeakResult {
  const sessionId = session.id;
  if (!sameRoomId(room.id, sessionId.roomId)) {
    throw new RoomValidationError('agent session belongs to a different room');
  }
  if (sessionId.tenantId !== room.id.tenantId) {
    throw new RoomValidationError('agent session tenant does not match the room tenant');
  }
  assertSeq(input.readUpToSeq, 'read up to sequence');

  const newer = room.eventsAfter(input.readUpToSeq, sessionId.agentId);
  if (newer.length > 0) {
    return { outcome: 'held', newer };
  }
  const trigger = eventAt(room, input.triggerSeq);

  const event = room.post(
    {
      messageId: `posted:${sessionKey(sessionId)}:${room.head + 1}`,
      author: { kind: 'agent', id: sessionId.agentId },
      kind: 'posted',
      body: input.body,
      origin: 'endpoint',
      addressedTo: [...input.addressedTo],
      wakeDepth: trigger.wakeDepth + 1,
    },
    at,
  );
  session.recordPost(event.seq);
  return { outcome: 'posted', seq: event.seq, event };
}

function eventAt(room: Room, seq: RoomSeq): RoomEvent {
  assertSeq(seq, 'trigger sequence');
  // Restored streams are contiguous from 1, so the event at seq exists exactly
  // when seq is inside the record.
  if (seq < 1 || seq > room.head) {
    throw new RoomValidationError('speak trigger does not exist in the room');
  }
  return room.eventsAfter(seq - 1)[0]!;
}

function assertSeq(seq: RoomSeq, label: string): void {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new RoomValidationError(`${label} must be a non-negative integer`);
  }
}
