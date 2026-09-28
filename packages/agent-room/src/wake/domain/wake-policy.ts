import type { AgentId, RoomEvent } from '../../room/domain/model';

/**
 * Domain service: the broadcast wake rule. A control-plane event wakes nobody,
 * an event never wakes its own author, and a member at or above the room's
 * depth ceiling stops being woken. Everyone else is woken. Seeing a room event
 * and waking for it are separate decisions; filtering by `addressedTo` stays
 * with the endpoint's room setting, not here.
 */
export function shouldWake(input: {
  event: RoomEvent;
  memberId: AgentId;
  ceiling: number;
}): boolean {
  const { event, memberId, ceiling } = input;
  if (event.kind === 'control-plane') return false;
  if (event.author.id === memberId) return false;
  return event.wakeDepth < ceiling;
}
