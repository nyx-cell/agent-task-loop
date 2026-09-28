import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { RoomLabAgentId } from '../domain/agent-registry';
import type { RoomWakeMode } from '../domain/room-catalog';

/** Where the sqlite library and every room's work directory live on this machine. */
export function defaultRoomHome(): string {
  return process.env.RIVUS_ROOM_HOME?.trim() || join(homedir(), '.rivus', 'room-web', 'v1');
}

/** Where per-room work directories live when a room sets no cwd of its own. */
export function defaultWorkRoot(): string {
  return join(defaultRoomHome(), 'work');
}

/** One fresh room id, the desk's and a private room's alike. */
export function newRoomIdentity(): string {
  return `r_${randomBytes(5).toString('hex')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function createRoomRecordInput(input: {
  title: string;
  goal?: string;
  memberIds?: readonly RoomLabAgentId[];
  wake?: RoomWakeMode;
  serial?: boolean;
  cwd?: string;
}) {
  return {
    id: newRoomIdentity(),
    title: input.title,
    now: nowIso(),
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.memberIds === undefined ? {} : { memberIds: input.memberIds }),
    ...(input.wake === undefined ? {} : { wake: input.wake }),
    ...(input.serial === undefined ? {} : { serial: input.serial }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  };
}
