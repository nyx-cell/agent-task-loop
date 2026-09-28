import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AgentSessionId, RoomId } from '@rivus/agent-room';
import { SqliteRoomStreamStore } from './sqlite-room-unit-of-work.server';
import { SqliteRoomStore } from './sqlite-room-store.server';

const TENANT = 'local';

describe('SqliteRoomUnitOfWork wake depth', () => {
  it("writes each event's wake depth and reads it back after a reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), 'rivus-room-unit-of-work-'));
    const store = SqliteRoomStore.open(root);
    const roomId: RoomId = { tenantId: TENANT, conversationId: 'r_aaaaaaaaaa' };
    store.db.prepare(`
      INSERT INTO rooms (id, title, goal, created_at, updated_at, last_opened_at)
      VALUES ('r_aaaaaaaaaa', '深度房间', NULL, '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z')
    `).run();

    const stream = new SqliteRoomStreamStore(store.db, roomId);
    const codex: AgentSessionId = {
      tenantId: TENANT,
      agentId: 'codex',
      roomId,
      runtimeGenerationId: 'web-v1',
    };
    stream.ensureSession(codex);
    const admitted = await stream.admit({
      roomId,
      messageId: 'human:1',
      author: { kind: 'human', id: 'director' },
      kind: 'human',
      body: '比较三档价格',
      addressedTo: [],
    });
    stream.advanceSeen(codex, admitted.event.seq);
    const reply = await stream.replyInSerial({ session: codex, body: '先看成本' });
    if (reply.outcome !== 'posted') throw new Error('the reply should have posted');
    expect(reply.event.wakeDepth).toBe(admitted.event.wakeDepth + 1);

    // A second connection to the same file, not the process's own: the depths
    // have to come back from the column.
    const reopened = new DatabaseSync(join(root, 'rooms.sqlite'));
    const restored = new SqliteRoomStreamStore(reopened, roomId);
    const slice = await restored.readSlice(roomId, 0, { maxEvents: 100 });
    expect(slice.events.map(event => ({
      seq: event.seq,
      kind: event.kind,
      authorId: event.author.id,
      wakeDepth: event.wakeDepth,
    }))).toEqual([
      { seq: 1, kind: 'human', authorId: 'director', wakeDepth: 0 },
      { seq: 2, kind: 'posted', authorId: 'codex', wakeDepth: 1 },
    ]);
  });
});
