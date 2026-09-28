import type { RoomEvent } from '@rivus/agent-room';
import type { RoomLabAgentId } from '../domain/agent-registry';
import { copy } from '../copy';
import { newRoomIdentity } from '../infrastructure/room-home.server';
import type { RoomRecordStore, RoomRound } from './ports';

/**
 * The message id prefix of a dm post, and the round it names. The id is the
 * only trace of a private room's opening that survives inside the child's
 * record, so it carries the round's home: every event under it — this restart
 * included — resolves its round, and charges its budget, there (RFC 0015: a
 * round spans the private rooms opened inside it). The record stamps the seq,
 * which is why the parse reads five parts.
 */
export function dmMessageId(round: RoomRound, triggerSeq: number): string {
  return `dm:${round.roomId}:${round.seq}:${triggerSeq}`;
}

/** The round a dm post opened, read back off its message id; not a dm post otherwise. */
export function dmRoundOf(event: RoomEvent): RoomRound | undefined {
  const parts = event.messageId.split(':');
  if (parts[0] !== 'dm' || parts.length !== 5) return undefined;
  const roundSeq = Number(parts[2]);
  const triggerSeq = Number(parts[3]);
  if (!parts[1] || !Number.isSafeInteger(roundSeq) || roundSeq < 0) return undefined;
  if (!Number.isSafeInteger(triggerSeq) || triggerSeq < 0) return undefined;
  return { roomId: parts[1], seq: roundSeq };
}

/**
 * What the private-room gateway needs from the endpoint around it. The host
 * binds it to the catalog, the sqlite store and the per-room services; the
 * tests bind the same seams over one in-memory library.
 */
export interface RoomDmDeps {
  /** The pair's room under the parent, when one exists — the reuse rule. */
  findPrivate(parentRoomId: string, members: readonly RoomLabAgentId[]): { id: string } | undefined;
  /** Opens one, seated with exactly the pair, linked back to the parent. */
  openPrivate(input: {
    id: string;
    title: string;
    parentRoomId: string;
    openedBy: RoomLabAgentId;
    openedAtSeq: number;
    memberIds: readonly RoomLabAgentId[];
    now: string;
  }): { id: string };
  /** The child room's record, for the post. */
  stream(roomId: string): RoomRecordStore;
  /** The child room's dispatcher: the wake set, the round budget, serial. */
  dispatch(roomId: string, event: RoomEvent): void;
  now(): string;
}

/**
 * The `room_dm` write path (RFC 0015 Private rooms): find or open the child
 * room the caller shares with one peer, post the body there at the trigger's
 * depth plus one, addressed to the peer so either wake mode reaches exactly
 * the other member, then let the child's dispatcher wake them. The post does
 * not count as the turn's room_speak — that is the speak tool's own handle.
 */
export class RoomDm {
  constructor(private readonly deps: RoomDmDeps) {}

  async open(input: {
    parentRoomId: string;
    from: RoomLabAgentId;
    to: RoomLabAgentId;
    body: string;
    triggerDepth: number;
    triggerSeq: number;
    roundRoomId: string;
    roundSeq: number;
  }): Promise<{ roomId: string; seq: number }> {
    const pair = [input.from, input.to].sort();
    const round: RoomRound = { roomId: input.roundRoomId, seq: input.roundSeq };
    const found = this.deps.findPrivate(input.parentRoomId, pair);
    const roomId = found?.id ?? this.deps.openPrivate({
      id: newRoomIdentity(),
      title: copy.label.privateRoomTitle(pair[0]!, pair[1]!),
      parentRoomId: input.parentRoomId,
      openedBy: input.from,
      openedAtSeq: input.triggerSeq,
      memberIds: pair,
      now: this.deps.now(),
    }).id;
    const event = await this.deps.stream(roomId).post({
      messageId: dmMessageId(round, input.triggerSeq),
      author: { kind: 'agent', id: input.from },
      body: input.body,
      addressedTo: [input.to],
      wakeDepth: input.triggerDepth + 1,
    });
    this.deps.dispatch(roomId, event);
    return { roomId, seq: event.seq };
  }
}
