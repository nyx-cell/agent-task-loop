import type {
  AdmitResult,
  AdmitRoomEvent,
  RoomId,
  RoomSeq,
  RoomSlice,
  SliceBudget,
} from '../domain/model';
import type { PassCommand, PassResult } from '../domain/pass';
import type { SpeakCommand, SpeakResult } from '../domain/speak';

export interface RoomAdmissionStore {
  admit(input: AdmitRoomEvent): Promise<AdmitResult>;
  head(roomId: RoomId): Promise<RoomSeq>;
}

export interface RoomStreamStore extends RoomAdmissionStore {
  readSlice(roomId: RoomId, afterSeq: RoomSeq, budget: SliceBudget): Promise<RoomSlice>;
  speak(input: SpeakCommand): Promise<SpeakResult>;
  pass(input: PassCommand): Promise<PassResult>;
}
