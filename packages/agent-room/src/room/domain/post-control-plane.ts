import { sessionKey, type AgentSessionId } from '../../agent-session/domain/model';
import { RoomValidationError } from './errors';
import { sameRoomId } from './model';
import type { SpeakResult } from './speak';
import { Room } from './room';

/** Posts host control-plane state without creating or advancing an AgentSession. */
export function postControlPlane(
  room: Room,
  actor: AgentSessionId,
  body: string,
  at: string,
): Extract<SpeakResult, { outcome: 'posted' }> {
  if (!sameRoomId(room.id, actor.roomId) || actor.tenantId !== room.id.tenantId) {
    throw new RoomValidationError('control-plane actor belongs to a different room');
  }
  const event = room.post(
    {
      messageId: `control:${sessionKey(actor)}:${room.head + 1}`,
      author: { kind: 'control-plane', id: actor.agentId },
      kind: 'control-plane',
      body,
      origin: 'control-plane',
      addressedTo: [],
      wakeDepth: 0,
    },
    at,
  );
  return { outcome: 'posted', seq: event.seq, event };
}
