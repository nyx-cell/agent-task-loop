import type { RoomStreamStore } from './room-stream-store';
import type { RoomUnitOfWork } from './room-unit-of-work';
import type { AgentSessionId } from '../../agent-session/domain/model';
import type {
  AdmitResult,
  AdmitRoomEvent,
  RoomId,
  RoomSeq,
  RoomSlice,
  SliceBudget,
} from '../domain/model';
import { postControlPlane } from '../domain/post-control-plane';
import { pass, type PassCommand, type PassResult } from '../domain/pass';
import { speak, type SpeakCommand, type SpeakResult } from '../domain/speak';

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

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }
}
