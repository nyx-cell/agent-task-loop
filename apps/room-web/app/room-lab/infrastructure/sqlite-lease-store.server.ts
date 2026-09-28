import type { DatabaseSync } from 'node:sqlite';
import type { FencedResult, FencingToken, LeaseRecord, LeaseStore } from '@rivus/agent-orchestration';

/**
 * `member_leases` implementing the control plane's `LeaseStore` port
 * (RFC 0015): one row per running activation, and every method a
 * compare-and-swap on the whole record, so a stale holder can neither renew nor
 * release. Freshness stays the caller's judgement — the store only ever swaps
 * exact records, which is how a stale lease is taken over.
 *
 * `runFenced` is what the RFC asks of sqlite in one process: a per-key promise
 * chain plus one re-read of the holder before the operation is entered. A
 * holder that lost its lease while awaiting its prompt gets
 * `{ executed: false }` and its write never lands.
 */
export class SqliteLeaseStore implements LeaseStore {
  private readonly fenceTails = new Map<string, Promise<void>>();

  constructor(private readonly db: DatabaseSync) {}

  tryCreate(key: string, record: LeaseRecord): boolean {
    return this.write(`
      INSERT INTO member_leases (key, holder_pid, holder_id, heartbeat_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO NOTHING
    `, key, record.holderPid, record.holderId, record.heartbeatAt) === 1;
  }

  tryReplace(key: string, expected: LeaseRecord, next: LeaseRecord): boolean {
    if (expected.key !== key || next.key !== key) return false;
    return this.write(`
      UPDATE member_leases SET holder_pid = ?, holder_id = ?, heartbeat_at = ?
      WHERE key = ? AND holder_pid = ? AND holder_id = ? AND heartbeat_at = ?
    `, next.holderPid, next.holderId, next.heartbeatAt,
      key, expected.holderPid, expected.holderId, expected.heartbeatAt) === 1;
  }

  tryTouch(expected: LeaseRecord, next: LeaseRecord): boolean {
    if (next.key !== expected.key) return false;
    return this.write(`
      UPDATE member_leases SET holder_pid = ?, holder_id = ?, heartbeat_at = ?
      WHERE key = ? AND holder_pid = ? AND holder_id = ? AND heartbeat_at = ?
    `, next.holderPid, next.holderId, next.heartbeatAt,
      expected.key, expected.holderPid, expected.holderId, expected.heartbeatAt) === 1;
  }

  tryRelease(expected: LeaseRecord): boolean {
    return this.write(`
      DELETE FROM member_leases
      WHERE key = ? AND holder_pid = ? AND holder_id = ? AND heartbeat_at = ?
    `, expected.key, expected.holderPid, expected.holderId, expected.heartbeatAt) === 1;
  }

  read(key: string): LeaseRecord | undefined {
    const row = this.db.prepare(`
      SELECT key, holder_pid, holder_id, heartbeat_at
      FROM member_leases WHERE key = ?
    `).get(key) as unknown as LeaseRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  async runFenced<T>(
    token: FencingToken,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<FencedResult<T>> {
    // One fenced write at a time per key, in the order they arrived.
    const previous = this.fenceTails.get(token.key) ?? Promise.resolve();
    let unlock: () => void = () => undefined;
    const slot = new Promise<void>(resolve => {
      unlock = resolve;
    });
    const tail = previous.then(() => slot);
    this.fenceTails.set(token.key, tail);
    try {
      await previous;
      signal?.throwIfAborted();
      // The re-read that makes it fenced: whatever the record said when the
      // token was minted, only the row still naming this holder enters.
      const current = this.read(token.key);
      if (
        !current ||
        current.holderPid !== token.holderPid ||
        current.holderId !== token.holderId
      ) {
        return { executed: false };
      }
      return { executed: true, value: await operation() };
    } finally {
      unlock();
      if (this.fenceTails.get(token.key) === tail) {
        this.fenceTails.delete(token.key);
      }
    }
  }

  private write(sql: string, ...parameters: readonly SqlParameterValue[]): number {
    return Number(this.db.prepare(sql).run(...parameters).changes);
  }
}

/** What node:sqlite binds. */
type SqlParameterValue = null | number | bigint | string | Uint8Array;

interface LeaseRow {
  key: string;
  holder_pid: number;
  holder_id: string;
  heartbeat_at: string;
}

function toRecord(row: LeaseRow): LeaseRecord {
  return {
    key: row.key,
    holderPid: Number(row.holder_pid),
    holderId: row.holder_id,
    heartbeatAt: row.heartbeat_at,
  };
}
