import { describe, expect, it } from 'vitest';
import { SqliteRoomStore } from './sqlite-room-store.server';
import { SqliteTurnLog, type TurnRecord } from './sqlite-turn-log.server';

const ROOM = 'r_aaaaaaaaaa';

function turn(input: Partial<TurnRecord> & { id: string }): TurnRecord {
  return {
    roomId: ROOM,
    agentId: 'codex',
    roundSeq: 1,
    triggerSeq: 1,
    readUpToSeq: 2,
    startedAt: '2026-09-28T10:00:00.000Z',
    heldCount: 0,
    ...input,
  };
}

function insertRoom(store: SqliteRoomStore, roomId = ROOM): void {
  store.db.prepare(`
    INSERT INTO rooms (id, title, goal, created_at, updated_at, last_opened_at)
    VALUES (?, '测试房间', NULL, '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z')
  `).run(roomId);
}

describe('SqliteTurnLog', () => {
  it('appends a turn and reads it back whole', () => {
    const store = SqliteRoomStore.memory();
    insertRoom(store);
    const log = new SqliteTurnLog(store.db);

    log.append(turn({
      id: 'turn:1',
      endedAt: '2026-09-28T10:04:00.000Z',
      outcome: 'posted',
      postedSeq: 5,
      stopReason: 'end_turn',
      heldCount: 1,
    }));

    // The read model drops the room and the read watermark: the room is the
    // query's own key, and the cursor lives in agent_sessions.
    expect(log.listByRoom(ROOM)).toEqual([{
      id: 'turn:1',
      agentId: 'codex',
      roundSeq: 1,
      triggerSeq: 1,
      startedAt: '2026-09-28T10:00:00.000Z',
      endedAt: '2026-09-28T10:04:00.000Z',
      outcome: 'posted',
      postedSeq: 5,
      stopReason: 'end_turn',
      heldCount: 1,
    }]);
  });

  it('stores a turn that is still running or ended silently with the optional columns empty', () => {
    const store = SqliteRoomStore.memory();
    insertRoom(store);
    const log = new SqliteTurnLog(store.db);

    log.append(turn({ id: 'turn:open' }));

    // The row is there with its defaults; the record read back carries none of
    // the optional fields.
    expect(log.listByRoom(ROOM)).toEqual([{
      id: 'turn:open',
      agentId: 'codex',
      roundSeq: 1,
      triggerSeq: 1,
      startedAt: '2026-09-28T10:00:00.000Z',
      heldCount: 0,
    }]);
    expect(store.db.prepare('SELECT ended_at, outcome, posted_seq, held_count FROM turns WHERE id = ?')
      .get('turn:open'))
      .toEqual({ ended_at: null, outcome: null, posted_seq: null, held_count: 0 });
  });

  it('reads only the room asked about, oldest first', () => {
    const store = SqliteRoomStore.memory();
    insertRoom(store);
    insertRoom(store, 'r_bbbbbbbbbb');
    const log = new SqliteTurnLog(store.db);
    log.append(turn({ id: 'turn:later', agentId: 'codex', startedAt: '2026-09-28T10:05:00.000Z' }));
    log.append(turn({ id: 'turn:earlier', agentId: 'claude', startedAt: '2026-09-28T10:01:00.000Z' }));
    log.append(turn({ id: 'turn:other-room', roomId: 'r_bbbbbbbbbb', startedAt: '2026-09-28T09:00:00.000Z' }));

    expect(log.listByRoom(ROOM).map(row => row.id)).toEqual(['turn:earlier', 'turn:later']);
    expect(log.listByRoom('r_bbbbbbbbbb').map(row => row.id)).toEqual(['turn:other-room']);
    expect(log.listByRoom('r_noperoom')).toEqual([]);
  });

  it("takes a room's turns with it when the room goes", () => {
    const store = SqliteRoomStore.memory();
    insertRoom(store);
    const log = new SqliteTurnLog(store.db);
    log.append(turn({ id: 'turn:1' }));

    store.db.prepare('DELETE FROM rooms WHERE id = ?').run(ROOM);

    expect(log.listByRoom(ROOM)).toEqual([]);
  });

  it('refuses a turn for a room that does not exist', () => {
    const store = SqliteRoomStore.memory();
    const log = new SqliteTurnLog(store.db);

    expect(() => log.append(turn({ id: 'turn:orphan' }))).toThrow();
    expect(log.listByRoom(ROOM)).toEqual([]);
  });
});
