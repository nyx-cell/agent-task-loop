import { z } from 'zod';
import type { RoomEvent, RoomId, RoomSeq, SpeakResult } from '@rivus/agent-room';
import type { AgentSessionId } from '@rivus/agent-room';
import type { ToolDefinition } from '@rivus/agent-orchestration';
import type { RoomLabAgentId } from '../read-model';
import { ROOM_MESSAGE_LIMIT } from '../domain/room-message';
import { HELD_LIMIT } from './ports';

/**
 * One member's open turn, as its Room tools see it. The handle carries the
 * state the tools read and advance: the seq the turn has read up to, whether
 * it already spoke, how many times it was HELD. It lives and dies with the
 * turn — nothing here is stored between turns.
 */
export interface RoomTurnHandle {
  agentId: RoomLabAgentId;
  session: AgentSessionId;
  roomId: RoomId;
  /** The human event that opened the round this turn belongs to. */
  roundSeq: number;
  /** The record head this turn started at; a post's wake depth is its plus one. */
  triggerSeq: RoomSeq;
  readUpToSeq: RoomSeq;
  spoke: boolean;
  heldCount: number;
  /** Set at the HELD limit; the tool answers `held-limit` from then on. */
  closed: boolean;
  postedSeq?: number;
  startedAt: string;
}

/** The speak write point, run inside the turn's lease fence. */
export type SpeakThroughLease = (input: {
  body: string;
  addressedTo: string[];
  readUpToSeq: RoomSeq;
  triggerSeq: RoomSeq;
}) => Promise<SpeakResult>;

/**
 * The one post a turn may make (RFC 0015). HELD is answered to the member,
 * which reads what it missed with `room_read` and calls again — three HELDs
 * close the tool and the turn ends as a pass. Errors are returned, never
 * thrown: the member reads them.
 */
export function roomSpeakTool(
  handle: RoomTurnHandle,
  deps: { speak: SpeakThroughLease; isOpen: () => boolean },
): ToolDefinition {
  return {
    name: 'room_speak',
    description:
      'Post one message into the room record, on behalf of your member. One post per turn.' +
      ' The result is held when another member posted something you have not read yet:' +
      ' read the newer events with room_read, then call room_speak again with a revised message.',
    inputSchema: {
      body: z.string().min(1).max(ROOM_MESSAGE_LIMIT).describe('The message to post, plain text.'),
      addressedTo: z
        .array(z.string())
        .max(20)
        .optional()
        .describe('Member ids this message addresses, without the @.'),
    },
    handler: async input => {
      if (!deps.isOpen()) return { error: 'turn-closed' };
      if (handle.closed) return { error: 'held-limit' };
      if (handle.spoke) return { error: 'already-spoke' };
      const body = typeof input.body === 'string' ? input.body.trim() : '';
      if (!body) return { error: 'body-required' };
      if (body.length > ROOM_MESSAGE_LIMIT) return { error: 'body-too-long' };
      const addressedTo = Array.isArray(input.addressedTo)
        ? input.addressedTo.filter((id): id is string => typeof id === 'string')
        : [];
      const result = await deps.speak({
        body,
        addressedTo,
        readUpToSeq: handle.readUpToSeq,
        triggerSeq: handle.triggerSeq,
      });
      if (result.outcome === 'posted') {
        handle.spoke = true;
        handle.postedSeq = result.seq;
        return { posted: { seq: result.seq } };
      }
      handle.heldCount += 1;
      if (handle.heldCount >= HELD_LIMIT) handle.closed = true;
      return { held: { newer: result.newer.map(toToolEvent) } };
    },
  };
}

/**
 * The read write point for a truncated turn inbox or a HELD: reading advances
 * the seq this turn has read up to, which is what the next room_speak is
 * measured against.
 */
export function roomReadTool(
  handle: RoomTurnHandle,
  deps: {
    read: (input: { afterSeq: number; limit?: number }) => Promise<{
      events: RoomEvent[];
      head: RoomSeq;
    }>;
    isOpen: () => boolean;
  },
): ToolDefinition {
  return {
    name: 'room_read',
    description:
      'Read events from the room record after a sequence number. Use it after a held' +
      ' room_speak result, or when this turn carried only part of the record.',
    inputSchema: {
      afterSeq: z.number().int().min(0).optional().describe('Read events after this seq. Defaults to 0, the start of the record.'),
      limit: z.number().int().min(1).max(200).optional().describe('At most this many events. Defaults to 50.'),
    },
    handler: async input => {
      if (!deps.isOpen()) return { error: 'turn-closed' };
      const afterSeq = typeof input.afterSeq === 'number' ? Math.max(0, Math.floor(input.afterSeq)) : 0;
      const limit = typeof input.limit === 'number' ? Math.min(200, Math.max(1, Math.floor(input.limit))) : undefined;
      const slice = await deps.read({ afterSeq, ...(limit === undefined ? {} : { limit }) });
      const last = slice.events.at(-1)?.seq;
      if (last !== undefined && last > handle.readUpToSeq) handle.readUpToSeq = last;
      return { events: slice.events.map(toToolEvent), head: slice.head };
    },
  };
}

function toToolEvent(event: RoomEvent): {
  seq: RoomSeq;
  from: string;
  to?: string[];
  kind: RoomEvent['kind'];
  body: string;
} {
  return {
    seq: event.seq,
    from: `@${event.author.id}`,
    ...(event.addressedTo.length > 0 ? { to: event.addressedTo } : {}),
    kind: event.kind,
    body: event.body,
  };
}
