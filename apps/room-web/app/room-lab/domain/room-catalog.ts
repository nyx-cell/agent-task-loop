import type { KnownAgentIds, RoomLabAgentId } from './agent-registry';
import {
  RoomCatalogInvariantError,
  assertRoomIdentity,
} from './room-identity';
import { RoomComposition } from './room-composition';

/** How an event decides who is woken: everyone, or only those addressed. */
export type RoomWakeMode = 'broadcast' | 'addressed';

export interface RoomRecord {
  id: string;
  title: string;
  goal?: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  memberIds: RoomLabAgentId[];
  /** The one cost knob that lives in the protocol (RFC 0015). */
  wake: RoomWakeMode;
  /** Run the woken set one member at a time, in seat order. */
  serial: boolean;
  /** Where members work during a turn; undefined means the room's own directory. */
  cwd?: string;
  /** Set on a private room: the room it was opened from (RFC 0015 Private rooms). */
  parentRoomId?: string;
  /** The member whose room_dm opened it; absent for a room a person created. */
  openedBy?: RoomLabAgentId;
  /** The parent event whose activation opened it. */
  openedAtSeq?: number;
}

export class RoomCatalog {
  private rooms: RoomRecord[];
  private lastOpenedId?: string;

  constructor(
    rooms: readonly RoomRecord[] = [],
    lastOpenedId?: string,
    private readonly known?: KnownAgentIds,
  ) {
    // A record from before the settings columns (a legacy catalog.json) has no
    // wake or serial on it; the defaults are the record's, not the caller's.
    this.rooms = rooms.map(room => cloneRecord({
      ...room,
      wake: room.wake ?? 'broadcast',
      serial: room.serial ?? false,
    }));
    this.lastOpenedId = lastOpenedId && this.rooms.some(room => room.id === lastOpenedId)
      ? lastOpenedId
      : this.rooms[0]?.id;
  }

  create(input: {
    id: string;
    title: string;
    goal?: string;
    memberIds?: readonly RoomLabAgentId[];
    wake?: RoomWakeMode;
    serial?: boolean;
    cwd?: string;
    now: string;
  }): RoomRecord {
    const id = assertRoomIdentity(input.id);
    if (this.rooms.some(room => room.id === id)) {
      throw new RoomCatalogInvariantError(`Room already exists: ${id}`);
    }
    const record: RoomRecord = {
      id,
      title: validateTitle(input.title),
      createdAt: input.now,
      updatedAt: input.now,
      lastOpenedAt: input.now,
      memberIds: new RoomComposition(
        input.memberIds ?? this.known?.ids() ?? [],
        this.known,
      ).snapshot(),
      wake: input.wake ?? 'broadcast',
      serial: input.serial ?? false,
      ...(optionalCwd(input.cwd) === undefined ? {} : { cwd: optionalCwd(input.cwd) }),
      ...(optionalGoal(input.goal) === undefined ? {} : { goal: optionalGoal(input.goal) }),
    };
    this.rooms.push(record);
    this.lastOpenedId = id;
    return cloneRecord(record);
  }

  list(): RoomRecord[] {
    return [...this.rooms].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /**
   * The private room one pair of members already shares under a parent, the one
   * a second room_dm reuses (RFC 0015). The pair matches regardless of who
   * opened it, so either member finds the same room.
   */
  findPrivate(parentRoomId: string, memberIds: readonly RoomLabAgentId[]): RoomRecord | undefined {
    const pair = pairKey(memberIds);
    return this.rooms.find(room =>
      room.parentRoomId === parentRoomId
      && room.memberIds.length === 2
      && pairKey(room.memberIds) === pair,
    );
  }

  /**
   * Opens the private room one pair shares under a parent: an ordinary room
   * record plus the three link fields, seated with exactly the two members. It
   * does not take the desk's last-opened slot — the room opens under its
   * parent, not on the desk.
   */
  openPrivate(input: {
    id: string;
    title: string;
    parentRoomId: string;
    openedBy: RoomLabAgentId;
    openedAtSeq: number;
    memberIds: readonly RoomLabAgentId[];
    now: string;
  }): RoomRecord {
    this.get(input.parentRoomId);
    if (new Set(input.memberIds).size !== 2 || input.memberIds.length !== 2) {
      throw new RoomCatalogInvariantError('A private room seats exactly two members');
    }
    const lastOpenedId = this.lastOpenedId;
    const created = this.create({
      id: input.id,
      title: input.title,
      memberIds: input.memberIds,
      now: input.now,
    });
    this.lastOpenedId = lastOpenedId;
    return this.update(created.id, room => {
      room.parentRoomId = input.parentRoomId;
      room.openedBy = input.openedBy;
      room.openedAtSeq = input.openedAtSeq;
    });
  }

  get(id: string): RoomRecord {
    const room = this.rooms.find(candidate => candidate.id === id);
    if (!room) throw new RoomCatalogInvariantError(`Unknown Room: ${id}`);
    return cloneRecord(room);
  }

  lastOpened(): RoomRecord | undefined {
    return this.lastOpenedId ? this.get(this.lastOpenedId) : undefined;
  }

  rename(id: string, title: string, now: string): RoomRecord {
    return this.update(id, room => {
      room.title = validateTitle(title);
      room.updatedAt = now;
    });
  }

  touch(id: string, now: string): RoomRecord {
    return this.update(id, room => {
      room.lastOpenedAt = now;
      this.lastOpenedId = id;
    });
  }

  replaceMembers(id: string, memberIds: readonly RoomLabAgentId[], now: string): RoomRecord {
    return this.update(id, room => {
      room.memberIds = new RoomComposition(memberIds, this.known).snapshot();
      room.updatedAt = now;
    });
  }

  /** Applies the settings fields a room's own surface may change. */
  replaceSettings(
    id: string,
    settings: { wake?: RoomWakeMode; serial?: boolean; cwd?: string },
    now: string,
  ): RoomRecord {
    return this.update(id, room => {
      if (settings.wake !== undefined) room.wake = settings.wake;
      if (settings.serial !== undefined) room.serial = settings.serial;
      if (settings.cwd !== undefined) {
        const cwd = optionalCwd(settings.cwd);
        if (cwd === undefined) delete room.cwd;
        else room.cwd = cwd;
      }
      room.updatedAt = now;
    });
  }

  snapshot(): { rooms: RoomRecord[]; lastOpenedId?: string } {
    return {
      rooms: this.rooms.map(cloneRecord),
      ...(this.lastOpenedId === undefined ? {} : { lastOpenedId: this.lastOpenedId }),
    };
  }

  private update(id: string, change: (room: RoomRecord) => void): RoomRecord {
    const index = this.rooms.findIndex(room => room.id === id);
    if (index < 0) throw new RoomCatalogInvariantError(`Unknown Room: ${id}`);
    const next = cloneRecord(this.rooms[index]!);
    change(next);
    this.rooms[index] = next;
    return cloneRecord(next);
  }
}

export { RoomCatalogInvariantError };

function validateTitle(value: string): string {
  const title = value.trim().replace(/\s+/g, ' ');
  if (!title) throw new RoomCatalogInvariantError('Room title is required');
  if (title.length > 80) throw new RoomCatalogInvariantError('Room title must be at most 80 characters');
  return title;
}

function optionalGoal(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const goal = value.trim();
  if (!goal) return undefined;
  if (goal.length > 400) throw new RoomCatalogInvariantError('Room goal must be at most 400 characters');
  return goal;
}

/** An empty settings field clears the room's own value. */
function optionalCwd(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cwd = value.trim();
  if (!cwd) return undefined;
  if (cwd.length > 400) throw new RoomCatalogInvariantError('Room cwd must be at most 400 characters');
  return cwd;
}

function cloneRecord(room: RoomRecord): RoomRecord {
  return {
    ...room,
    memberIds: [...room.memberIds],
  };
}

/** A pair as one comparable word, order-free: the same two members, one room. */
function pairKey(memberIds: readonly RoomLabAgentId[]): string {
  return [...memberIds].sort().join('\n');
}
