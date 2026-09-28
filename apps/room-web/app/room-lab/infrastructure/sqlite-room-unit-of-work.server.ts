import { DatabaseSync } from 'node:sqlite';
import {
  AgentSessionAggregate,
  Room,
  RoomStreamService,
  sessionKey,
  type AgentSession,
  type AgentSessionId,
  type AdmitResult,
  type AdmitRoomEvent,
  type CompleteSilentlyCommand,
  type CompleteSilentlyResult,
  type RoomEvent,
  type RoomId,
  type RoomReplyCommand,
  type RoomReplyResult,
  type RoomSeq,
  type RoomSlice,
  type RoomUnitOfWork,
  type SliceBudget,
} from '@rivus/agent-room';

export class SqliteRoomUnitOfWork implements RoomUnitOfWork {
  private events: RoomEvent[];
  private readonly sessions = new Map<string, AgentSession>();
  private loaded = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly roomId: RoomId,
  ) {
    this.events = [];
  }

  readRoom<T>(id: RoomId, query: (room: Room) => T): T {
    return query(this.loadRoom(id));
  }

  withRoom<T>(id: RoomId, work: (room: Room) => T): T {
    const room = this.loadRoom(id);
    const result = work(room);
    this.events = room.snapshot();
    this.persist();
    return result;
  }

  withRoomAndSession<T>(
    id: AgentSessionId,
    work: (room: Room, session: AgentSessionAggregate) => T,
  ): T {
    const room = this.loadRoom(id.roomId);
    const session = this.loadSession(id);
    const result = work(room, session);
    this.events = room.snapshot();
    this.sessions.set(sessionKey(id), session.snapshot());
    this.persist();
    return result;
  }

  ensureSession(id: AgentSessionId): AgentSession {
    this.hydrate();
    const snapshot = this.loadSession(id).snapshot();
    this.sessions.set(sessionKey(id), snapshot);
    this.persist();
    return snapshot;
  }

  inspectSession(id: AgentSessionId): AgentSession | undefined {
    this.hydrate();
    const snapshot = this.sessions.get(sessionKey(id));
    return snapshot ? cloneSession(snapshot) : undefined;
  }

  advanceSeen(id: AgentSessionId, seq: RoomSeq): AgentSession {
    return this.changeSession(id, session => session.advanceSeen(seq));
  }

  lastEvent(): { body: string; at: string } | undefined {
    this.hydrate();
    const last = this.events.at(-1);
    return last ? { body: last.body, at: last.at } : undefined;
  }

  clear(): void {
    const roomId = this.roomId.conversationId;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM room_events WHERE room_id = ?').run(roomId);
      this.db.prepare('DELETE FROM agent_sessions WHERE room_id = ?').run(roomId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.events = [];
    this.sessions.clear();
    this.loaded = true;
  }

  private loadRoom(id: RoomId): Room {
    this.assertRoom(id);
    this.hydrate();
    return new Room(id, this.events);
  }

  private loadSession(id: AgentSessionId): AgentSessionAggregate {
    this.hydrate();
    const existing = this.sessions.get(sessionKey(id));
    return new AgentSessionAggregate(id, existing ? { seenSeq: existing.seenSeq } : undefined);
  }

  private changeSession(id: AgentSessionId, change: (session: AgentSessionAggregate) => void): AgentSession {
    const session = this.loadSession(id);
    change(session);
    const snapshot = session.snapshot();
    this.sessions.set(sessionKey(id), snapshot);
    this.persist();
    return snapshot;
  }

  private hydrate(): void {
    if (this.loaded) return;
    const roomId = this.roomId.conversationId;
    const eventRows = this.db.prepare(`
      SELECT seq, message_id, transport_message_id, author_kind, author_id, kind, body, addressed_to, origin, wake_depth, at
      FROM room_events WHERE room_id = ? ORDER BY seq ASC
    `).all(roomId) as unknown as EventRow[];
    this.events = eventRows.map(row => toEvent(this.roomId, row));
    const sessionRows = this.db.prepare(`
      SELECT tenant_id, agent_id, room_id, runtime_generation_id, seen_seq
      FROM agent_sessions WHERE room_id = ?
    `).all(roomId) as unknown as SessionRow[];
    for (const row of sessionRows) {
      const session = toSession(row);
      this.sessions.set(sessionKey(session.id), session);
    }
    this.loaded = true;
  }

  private persist(): void {
    const roomId = this.roomId.conversationId;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM room_events WHERE room_id = ?').run(roomId);
      const insertEvent = this.db.prepare(`
        INSERT INTO room_events (
          room_id, seq, message_id, transport_message_id, author_kind, author_id, kind, body, addressed_to, origin, wake_depth, at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const event of this.events) {
        insertEvent.run(
          roomId,
          event.seq,
          event.messageId,
          event.transportMessageId ?? null,
          event.author.kind,
          event.author.id,
          event.kind,
          event.body,
          JSON.stringify(event.addressedTo),
          event.origin,
          event.wakeDepth,
          event.at,
        );
      }
      this.db.prepare('DELETE FROM agent_sessions WHERE room_id = ?').run(roomId);
      // `held_up_to_seq` stays in the schema until migration 0007 (RFC 0015 S3);
      // sessions no longer hold, so it is simply left NULL.
      const insertSession = this.db.prepare(`
        INSERT INTO agent_sessions (
          tenant_id, agent_id, room_id, runtime_generation_id, seen_seq
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const session of this.sessions.values()) {
        insertSession.run(
          session.id.tenantId,
          session.id.agentId,
          session.id.roomId.conversationId,
          session.id.runtimeGenerationId,
          session.seenSeq,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private assertRoom(id: RoomId): void {
    if (id.tenantId !== this.roomId.tenantId || id.conversationId !== this.roomId.conversationId) {
      throw new Error('sqlite room store was opened for a different room');
    }
  }
}

export class SqliteRoomStreamStore {
  private readonly unitOfWork: SqliteRoomUnitOfWork;
  private readonly service: RoomStreamService;

  constructor(db: DatabaseSync, roomId: RoomId, now: () => number = Date.now) {
    this.unitOfWork = new SqliteRoomUnitOfWork(db, roomId);
    this.service = new RoomStreamService(this.unitOfWork, now);
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

  lastEvent(): { body: string; at: string } | undefined {
    return this.unitOfWork.lastEvent();
  }

  clear(): void {
    this.unitOfWork.clear();
  }

  admit(input: AdmitRoomEvent): Promise<AdmitResult> {
    return this.service.admit(input);
  }

  head(roomId: RoomId): Promise<RoomSeq> {
    return this.service.head(roomId);
  }

  readSlice(roomId: RoomId, afterSeq: RoomSeq, budget: SliceBudget): Promise<RoomSlice> {
    return this.service.readSlice(roomId, afterSeq, budget);
  }

  replyInSerial(input: RoomReplyCommand): Promise<RoomReplyResult> {
    return this.service.replyInSerial(input);
  }

  completeSilentlyInSerial(input: CompleteSilentlyCommand): Promise<CompleteSilentlyResult> {
    return this.service.completeSilentlyInSerial(input);
  }
}

interface EventRow {
  seq: number;
  message_id: string;
  transport_message_id: string | null;
  author_kind: RoomEvent['author']['kind'];
  author_id: string;
  kind: RoomEvent['kind'];
  body: string;
  addressed_to: string;
  origin: RoomEvent['origin'];
  wake_depth: number;
  at: string;
}

interface SessionRow {
  tenant_id: string;
  agent_id: string;
  room_id: string;
  runtime_generation_id: string;
  seen_seq: number;
}

function toEvent(roomId: RoomId, row: EventRow): RoomEvent {
  return {
    seq: Number(row.seq),
    roomId,
    messageId: row.message_id,
    ...(row.transport_message_id ? { transportMessageId: row.transport_message_id } : {}),
    author: { kind: row.author_kind, id: row.author_id },
    kind: row.kind,
    body: row.body,
    origin: row.origin,
    addressedTo: JSON.parse(row.addressed_to) as string[],
    wakeDepth: Number(row.wake_depth),
    at: row.at,
  };
}

function toSession(row: SessionRow): AgentSession {
  return {
    id: {
      tenantId: row.tenant_id,
      agentId: row.agent_id,
      roomId: { tenantId: row.tenant_id, conversationId: row.room_id },
      runtimeGenerationId: row.runtime_generation_id,
    },
    seenSeq: Number(row.seen_seq),
  };
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
