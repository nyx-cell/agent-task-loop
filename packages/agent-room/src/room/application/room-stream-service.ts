import type { RoomStreamStore } from './room-stream-store';
import type { RoomUnitOfWork } from './room-unit-of-work';
import type { AgentSessionId } from '../../agent-session/domain/model';
import type {
  AdmitResult,
  AdmitRoomEvent,
  RoomEvent,
  RoomId,
  RoomSeq,
  RoomSlice,
  SliceBudget,
} from '../domain/model';
import { postControlPlane } from '../domain/post-control-plane';
import { pass, type PassCommand, type PassResult } from '../domain/pass';
import { speak, type SpeakCommand, type SpeakResult } from '../domain/speak';

/**
 * S1 shim surface for apps/room-web, kept one pull request (RFC 0015 plan S3).
 * `replyInSerial` and `completeSilentlyInSerial` are thin wrappers over `speak`
 * and `pass`; the endpoint switches to the write points directly in S3 and
 * these, their command and result types, and the held-acknowledge handshake
 * they stand in for are deleted.
 */
export interface RoomReplyCommand {
  session: AgentSessionId;
  body: string;
  origin?: 'agent' | 'control-plane';
  ackHeldUpToSeq?: RoomSeq;
}

export type RoomReplyResult =
  | { outcome: 'posted'; seq: RoomSeq; event: RoomEvent }
  | { outcome: 'held'; heldUpToSeq: RoomSeq; newer: RoomEvent[] };

export interface CompleteSilentlyCommand {
  session: AgentSessionId;
  ackHeldUpToSeq: RoomSeq;
}

export type CompleteSilentlyResult =
  | { outcome: 'silent' }
  | { outcome: 'held'; heldUpToSeq: RoomSeq; newer: RoomEvent[] };

export class RoomStreamService implements RoomStreamStore {
  constructor(
    private readonly unitOfWork: RoomUnitOfWork,
    private readonly now: () => number,
  ) {}

  async admit(input: AdmitRoomEvent): Promise<AdmitResult> {
    return this.unitOfWork.withRoom(input.roomId, room => room.admit(input, this.isoNow()));
  }

  async head(roomId: RoomId): Promise<RoomSeq> {
    return this.unitOfWork.readRoom(roomId, room => room.head);
  }

  async readSlice(roomId: RoomId, afterSeq: RoomSeq, budget: SliceBudget): Promise<RoomSlice> {
    return this.unitOfWork.readRoom(roomId, room => room.readSlice(afterSeq, budget));
  }

  async speak(input: SpeakCommand): Promise<SpeakResult> {
    if (input.origin === 'control-plane') {
      return this.unitOfWork.withRoom(input.session.roomId, room =>
        postControlPlane(room, input.session, input.body, this.isoNow()),
      );
    }
    return this.unitOfWork.withRoomAndSession(input.session, (room, session) =>
      speak(
        room,
        session,
        {
          body: input.body,
          addressedTo: [...input.addressedTo],
          readUpToSeq: input.readUpToSeq,
          triggerSeq: input.triggerSeq,
        },
        this.isoNow(),
      ),
    );
  }

  async pass(input: PassCommand): Promise<PassResult> {
    return this.unitOfWork.withRoomAndSession(input.session, (room, session) =>
      pass(room, session, { readUpToSeq: input.readUpToSeq }),
    );
  }

  /**
   * S1 shim over {@link speak}, deleted in S3. The stored cursor (raised by the
   * ack, which no longer negotiates a held watermark) stands in for the seq the
   * turn read, and the last event read stands in for the wake trigger, because
   * today's endpoint answers from the session watermark alone.
   */
  async replyInSerial(input: RoomReplyCommand): Promise<RoomReplyResult> {
    if (input.origin === 'control-plane') {
      return this.unitOfWork.withRoom(input.session.roomId, room =>
        postControlPlane(room, input.session, input.body, this.isoNow()),
      );
    }
    return this.unitOfWork.withRoomAndSession(input.session, (room, session) => {
      const readUpToSeq = Math.max(session.seenSeq, input.ackHeldUpToSeq ?? 0);
      const result = speak(
        room,
        session,
        { body: input.body, addressedTo: [], readUpToSeq, triggerSeq: readUpToSeq },
        this.isoNow(),
      );
      return toReplyResult(result);
    });
  }

  /**
   * S1 shim over {@link pass}, deleted in S3. It keeps one piece of the old
   * complete-silently behaviour pass itself dropped: a silent completion with
   * unread events by other authors is still reported as held, because the
   * endpoint's retry loop resolves HELD by reading and calling again.
   */
  async completeSilentlyInSerial(
    input: CompleteSilentlyCommand,
  ): Promise<CompleteSilentlyResult> {
    return this.unitOfWork.withRoomAndSession(input.session, (room, session) => {
      const readUpToSeq = Math.max(session.seenSeq, input.ackHeldUpToSeq);
      const newer = room.eventsAfter(readUpToSeq, session.id.agentId);
      if (newer.length > 0) {
        return { outcome: 'held', heldUpToSeq: newer.at(-1)!.seq, newer };
      }
      pass(room, session, { readUpToSeq });
      return { outcome: 'silent' };
    });
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }
}

function toReplyResult(result: SpeakResult): RoomReplyResult {
  if (result.outcome === 'posted') return result;
  return { outcome: 'held', heldUpToSeq: result.newer.at(-1)!.seq, newer: result.newer };
}
