import type { KnownAgentIds, } from '../domain/agent-registry';
import type { RoomWakeMode } from '../domain/room-catalog';
import type { RoomLabAction } from '../read-model';
import { RoomInputError } from './room-service.server';

/** `known` is the registry: an id that is not a row is not an agent. */
export function parseRoomAction(value: unknown, known: KnownAgentIds): RoomLabAction {
  if (!value || typeof value !== 'object' || !('action' in value)) {
    throw new RoomInputError('Room action is invalid');
  }
  const isRoomLabAgentId = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && known.has(candidate);
  const isWake = (candidate: unknown): candidate is RoomWakeMode =>
    candidate === 'broadcast' || candidate === 'addressed';
  const input = value as Record<string, unknown>;
  switch (input.action) {
    case 'message':
      if (typeof input.body === 'string') {
        return {
          action: 'message',
          body: input.body,
          ...(typeof input.clientMessageId === 'string'
            ? { clientMessageId: input.clientMessageId }
            : {}),
        };
      }
      break;
    case 'compose':
      if (
        Array.isArray(input.agentIds) &&
        input.agentIds.every(isRoomLabAgentId)
      ) {
        return { action: 'compose', agentIds: input.agentIds };
      }
      break;
    case 'settings': {
      const settings = settingsOf(input, isWake);
      if (settings) return { action: 'settings', ...settings };
      break;
    }
    case 'create':
      if (typeof input.title === 'string') {
        return {
          action: 'create',
          title: input.title,
          ...(typeof input.goal === 'string' ? { goal: input.goal } : {}),
          ...(Array.isArray(input.agentIds) && input.agentIds.every(isRoomLabAgentId)
            ? { agentIds: input.agentIds }
            : {}),
          ...settingsOf(input, isWake),
        };
      }
      break;
    case 'reset':
      return { action: 'reset' };
  }
  throw new RoomInputError('Room action payload is invalid');
}

/** The settings fields present on the payload; absent fields stay absent. */
function settingsOf(
  input: Record<string, unknown>,
  isWake: (candidate: unknown) => candidate is RoomWakeMode,
): { wake?: RoomWakeMode; serial?: boolean; cwd?: string } | undefined {
  const settings: { wake?: RoomWakeMode; serial?: boolean; cwd?: string } = {};
  if (isWake(input.wake)) settings.wake = input.wake;
  if (typeof input.serial === 'boolean') settings.serial = input.serial;
  if (typeof input.cwd === 'string') settings.cwd = input.cwd;
  return Object.keys(settings).length > 0 ? settings : undefined;
}
