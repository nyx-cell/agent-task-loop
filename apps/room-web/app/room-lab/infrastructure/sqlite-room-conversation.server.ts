import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentSession, RoomEvent, RoomId } from '@rivus/agent-room';
import { StoredRoomConversation } from './stored-room-conversation.server';
import { SqliteRoomStreamStore } from './sqlite-room-unit-of-work.server';

export class SqliteRoomConversation extends StoredRoomConversation {
  constructor(
    private readonly db: DatabaseSync,
    roomId: RoomId,
    agentIds: readonly string[] = [],
  ) {
    super(roomId, new SqliteRoomStreamStore(db, roomId), agentIds);
  }

  override reset(): void {
    if (this.store instanceof SqliteRoomStreamStore) this.store.clear();
    this.store = new SqliteRoomStreamStore(this.db, this.roomId);
    this.ensureSessions();
  }

  importLegacy(directory: string): void {
    const events = readJson<RoomEvent[]>(join(directory, 'events.json'), []);
    const sessions = readJson<AgentSession[]>(join(directory, 'sessions.json'), []);
    if (events.length === 0 && sessions.length === 0) {
      this.ensureSessions();
      return;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const roomId = this.roomId.conversationId;
      this.db.prepare('DELETE FROM room_events WHERE room_id = ?').run(roomId);
      this.db.prepare('DELETE FROM agent_sessions WHERE room_id = ?').run(roomId);
      const insertEvent = this.db.prepare(`
        INSERT INTO room_events (
          room_id, seq, message_id, transport_message_id, author_kind, author_id, kind, body, addressed_to, origin, at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const event of events) {
        insertEvent.run(
          roomId,
          event.seq,
          event.messageId,
          event.transportMessageId ?? null,
          event.author.kind,
          event.author.id,
          event.kind,
          event.body,
          JSON.stringify(event.addressedTo ?? []),
          event.origin ?? 'endpoint',
          event.at,
        );
      }
      const insertSession = this.db.prepare(`
        INSERT INTO agent_sessions (
          tenant_id, agent_id, room_id, runtime_generation_id, seen_seq
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const session of sessions) {
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
    this.store = new SqliteRoomStreamStore(this.db, this.roomId);
    this.ensureSessions();
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}
