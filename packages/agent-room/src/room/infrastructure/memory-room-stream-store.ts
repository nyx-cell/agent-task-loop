import { AgentSessionAggregate } from '../../agent-session/domain/agent-session';
import type { AgentSession, AgentSessionId } from '../../agent-session/domain/model';
import type { RoomStreamStore } from '../application/room-stream-store';
import { RoomStreamService } from '../application/room-stream-service';
import type {
  CompleteSilentlyCommand,
  CompleteSilentlyResult,
  RoomReplyCommand,
  RoomReplyResult,
} from '../application/room-stream-service';
import type { RoomUnitOfWork } from '../application/room-unit-of-work';
import type {
  AdmitResult,
  AdmitRoomEvent,
  RoomId,
  RoomEvent,
  RoomSeq,
  RoomSlice,
  SliceBudget,
} from '../domain/model';
import type { PassCommand, PassResult } from '../domain/pass';
import type { SpeakCommand, SpeakResult } from '../domain/speak';
import { Room } from '../domain/room';

export interface MemoryRoomStreamStoreOptions {
  now?: () => number;
  beforeCommit?: () => void;
}

export class MemoryRoomStreamStore implements RoomStreamStore {
  private readonly unitOfWork: MemoryRoomUnitOfWork;
  private readonly service: RoomStreamService;

  constructor(options: MemoryRoomStreamStoreOptions = {}) {
    this.unitOfWork = new MemoryRoomUnitOfWork(options.beforeCommit);
    this.service = new RoomStreamService(this.unitOfWork, options.now ?? Date.now);
  }

  ensureSession(id: AgentSessionId): AgentSession {
    return this.unitOfWork.ensureSession(id);
  }

  inspectSession(id: AgentSessionId): AgentSession | undefined {
    return this.unitOfWork.inspectSession(id);
  }

  advanceSeen(id: AgentSessionId, seq: RoomSeq): AgentSession {
    return this.unitOfWork.advanceSeen(id, seq);
  }

  async admit(input: AdmitRoomEvent): Promise<AdmitResult> {
    return this.service.admit(input);
  }

  async head(roomId: RoomId): Promise<RoomSeq> {
    return this.service.head(roomId);
  }

  async readSlice(roomId: RoomId, afterSeq: RoomSeq, budget: SliceBudget): Promise<RoomSlice> {
    return this.service.readSlice(roomId, afterSeq, budget);
  }

  async speak(input: SpeakCommand): Promise<SpeakResult> {
    return this.service.speak(input);
  }

  async pass(input: PassCommand): Promise<PassResult> {
    return this.service.pass(input);
  }

  /** S1 shim over {@link MemoryRoomStreamStore.speak} for apps/room-web; deleted in S3. */
  async replyInSerial(input: RoomReplyCommand): Promise<RoomReplyResult> {
    return this.service.replyInSerial(input);
  }

  /** S1 shim over {@link MemoryRoomStreamStore.pass} for apps/room-web; deleted in S3. */
  async completeSilentlyInSerial(
    input: CompleteSilentlyCommand,
  ): Promise<CompleteSilentlyResult> {
    return this.service.completeSilentlyInSerial(input);
  }
}

export function createMemoryRoomStreamStore(
  options: MemoryRoomStreamStoreOptions = {},
): RoomStreamStore {
  return new MemoryRoomStreamStore(options);
}

export class MemoryRoomUnitOfWork implements RoomUnitOfWork {
  private readonly rooms = new Map<string, RoomEvent[]>();
  private readonly sessions = new Map<string, AgentSession>();

  constructor(private readonly beforeCommit?: () => void) {}

  readRoom<T>(id: RoomId, query: (room: Room) => T): T {
    return query(this.loadRoom(id));
  }

  withRoom<T>(id: RoomId, work: (room: Room) => T): T {
    const room = this.loadRoom(id);
    const result = work(room);
    this.beforeCommit?.();
    this.rooms.set(roomStorageKey(id), room.snapshot());
    return result;
  }

  withRoomAndSession<T>(
    id: AgentSessionId,
    work: (room: Room, session: AgentSessionAggregate) => T,
  ): T {
    const room = this.loadRoom(id.roomId);
    const session = this.loadSession(id);
    const result = work(room, session);
    const roomSnapshot = room.snapshot();
    const sessionSnapshot = session.snapshot();
    this.beforeCommit?.();
    this.rooms.set(roomStorageKey(id.roomId), roomSnapshot);
    this.sessions.set(sessionStorageKey(id), sessionSnapshot);
    return result;
  }

  ensureSession(id: AgentSessionId): AgentSession {
    const session = this.loadSession(id);
    const snapshot = session.snapshot();
    this.sessions.set(sessionStorageKey(id), snapshot);
    return snapshot;
  }

  inspectSession(id: AgentSessionId): AgentSession | undefined {
    const snapshot = this.sessions.get(sessionStorageKey(id));
    return snapshot ? cloneSession(snapshot) : undefined;
  }

  advanceSeen(id: AgentSessionId, seq: RoomSeq): AgentSession {
    return this.changeSession(id, session => session.advanceSeen(seq));
  }

  private loadRoom(id: RoomId): Room {
    return new Room(id, this.rooms.get(roomStorageKey(id)) ?? []);
  }

  private loadSession(id: AgentSessionId): AgentSessionAggregate {
    const existing = this.sessions.get(sessionStorageKey(id));
    return new AgentSessionAggregate(id, existing ? { seenSeq: existing.seenSeq } : undefined);
  }

  private changeSession(id: AgentSessionId, change: (session: AgentSessionAggregate) => void): AgentSession {
    const session = this.loadSession(id);
    change(session);
    const snapshot = session.snapshot();
    this.sessions.set(sessionStorageKey(id), snapshot);
    return snapshot;
  }
}

function roomStorageKey(id: RoomId): string {
  return JSON.stringify([id.tenantId, id.conversationId]);
}

function sessionStorageKey(id: AgentSessionId): string {
  return JSON.stringify([
    id.tenantId,
    id.agentId,
    id.roomId.tenantId,
    id.roomId.conversationId,
    id.runtimeGenerationId,
  ]);
}

function cloneSession(session: AgentSession): AgentSession {
  return {
    id: {
      ...session.id,
      roomId: { ...session.id.roomId },
    },
    seenSeq: session.seenSeq,
  };
}
