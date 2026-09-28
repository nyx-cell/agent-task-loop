export type { AgentSession, AgentSessionId } from './agent-session/domain/model';
export { sessionKey } from './agent-session/domain/model';
export { AgentSessionAggregate } from './agent-session/domain/agent-session';
export {
  AGENT_SESSION_VALIDATION_CODE,
  AgentSessionValidationError,
} from './agent-session/domain/errors';

export type { RoomAdmissionStore, RoomStreamStore } from './room/application/room-stream-store';
// S1 shim surface for apps/room-web: `replyInSerial` and `completeSilentlyInSerial`
// survive as thin wrappers over `speak` and `pass` on RoomStreamService and
// MemoryRoomStreamStore for one pull request. Deleted in S3 together with these
// command and result types (RFC 0015 implementation plan, S1 Changes).
export {
  RoomStreamService,
  type RoomReplyCommand,
  type RoomReplyResult,
  type CompleteSilentlyCommand,
  type CompleteSilentlyResult,
} from './room/application/room-stream-service';
export type { RoomUnitOfWork } from './room/application/room-unit-of-work';

export {
  ROOM_VALIDATION_CODE,
  RoomValidationError,
} from './room/domain/errors';

export type {
  AgentId,
  AdmitResult,
  AdmitRoomEvent,
  ConversationId,
  RoomAuthor,
  RoomEvent,
  RoomEventKind,
  RoomId,
  RoomOrigin,
  RoomSeq,
  RoomSlice,
  RuntimeGenerationId,
  SliceBudget,
  TenantId,
  TransportMessageId,
} from './room/domain/model';
export { roomKey } from './room/domain/model';

export { Room } from './room/domain/room';

export { speak, type SpeakCommand, type SpeakResult } from './room/domain/speak';
export { pass, type PassCommand, type PassResult } from './room/domain/pass';

export {
  MemoryRoomStreamStore,
  createMemoryRoomStreamStore,
  type MemoryRoomStreamStoreOptions,
} from './room/infrastructure/memory-room-stream-store';

export { shouldWake } from './wake/domain/wake-policy';
