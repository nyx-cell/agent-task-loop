import type { DatabaseSync } from 'node:sqlite';
import type { RoomTurnView } from '../read-model';

/** How a turn ended: it spoke, it stayed silent, it ran out of time, or it failed. */
export type TurnOutcome = 'posted' | 'passed' | 'timeout' | 'failed';

/**
 * One row of `turns` (RFC 0015): when a member's turn started, what woke it,
 * and how it ended. The endpoint's own log — the UI reads elapsed time,
 * outcomes and rounds from here; nothing in the record or the control plane
 * depends on it.
 */
export interface TurnRecord {
  id: string;
  roomId: string;
  agentId: string;
  /** The human event that opened the round this turn belongs to. */
  roundSeq: number;
  /** The event that woke this member. */
  triggerSeq: number;
  readUpToSeq: number;
  startedAt: string;
  endedAt?: string;
  outcome?: TurnOutcome;
  /** The seq of the member's post, when the turn ended in one. */
  postedSeq?: number;
  stopReason?: string;
  heldCount?: number;
  error?: string;
}

export class SqliteTurnLog {
  constructor(private readonly db: DatabaseSync) {}

  append(record: TurnRecord): void {
    this.db.prepare(`
      INSERT INTO turns (
        id, room_id, agent_id, round_seq, trigger_seq, read_up_to_seq,
        started_at, ended_at, outcome, posted_seq, stop_reason, held_count, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.roomId,
      record.agentId,
      record.roundSeq,
      record.triggerSeq,
      record.readUpToSeq,
      record.startedAt,
      record.endedAt ?? null,
      record.outcome ?? null,
      record.postedSeq ?? null,
      record.stopReason ?? null,
      record.heldCount ?? 0,
      record.error ?? null,
    );
  }

  /** A room's turns, oldest first. */
  listByRoom(roomId: string): RoomTurnView[] {
    const rows = this.db.prepare(`
      SELECT id, room_id, agent_id, round_seq, trigger_seq, read_up_to_seq,
             started_at, ended_at, outcome, posted_seq, stop_reason, held_count, error
      FROM turns WHERE room_id = ?
      ORDER BY started_at ASC, rowid ASC
    `).all(roomId) as unknown as TurnRow[];
    return rows.map(toRecord);
  }
}

interface TurnRow {
  id: string;
  room_id: string;
  agent_id: string;
  round_seq: number;
  trigger_seq: number;
  read_up_to_seq: number;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  posted_seq: number | null;
  stop_reason: string | null;
  held_count: number;
  error: string | null;
}

function toRecord(row: TurnRow): RoomTurnView {
  return {
    id: row.id,
    agentId: row.agent_id,
    roundSeq: Number(row.round_seq),
    triggerSeq: Number(row.trigger_seq),
    startedAt: row.started_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(row.outcome === null ? {} : { outcome: row.outcome as TurnOutcome }),
    ...(row.posted_seq === null ? {} : { postedSeq: Number(row.posted_seq) }),
    ...(row.stop_reason === null ? {} : { stopReason: row.stop_reason }),
    heldCount: Number(row.held_count),
    ...(row.error === null ? {} : { error: row.error }),
  };
}
