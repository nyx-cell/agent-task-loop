import { describe, expect, it, vi } from 'vitest';
import { LeaseManager, type LeaseRecord } from '@rivus/agent-orchestration';
import { SqliteLeaseStore } from './sqlite-lease-store.server';
import { SqliteRoomStore } from './sqlite-room-store.server';

const KEY = 'room:r_aaaaaaaaaa:member:codex';

function record(holderPid = 1, holderId = 'holder-a', heartbeatAt = '2026-09-28T00:00:00.000Z'): LeaseRecord {
  return { key: KEY, holderPid, holderId, heartbeatAt };
}

function manager(leases: SqliteLeaseStore, holderId: string, now: number): LeaseManager {
  return new LeaseManager({
    store: leases,
    clock: { now: () => now },
    identity: { pid: 4242 },
    holderId,
    liveness: { isAlive: () => true },
    staleAfterMs: 1_000,
  });
}

describe('SqliteLeaseStore', () => {
  it('creates a lease once and refuses the second create', () => {
    const leases = new SqliteLeaseStore(SqliteRoomStore.memory().db);

    expect(leases.tryCreate(KEY, record())).toBe(true);
    expect(leases.read(KEY)).toEqual(record());
    expect(leases.tryCreate(KEY, record(2, 'holder-b'))).toBe(false);
    expect(leases.read(KEY)).toEqual(record());
  });

  it('replaces only on the exact current record', () => {
    const leases = new SqliteLeaseStore(SqliteRoomStore.memory().db);
    const holder = record();
    leases.tryCreate(KEY, holder);

    // A different heartbeat than the stored one is not the current record.
    expect(leases.tryReplace(KEY, { ...holder, heartbeatAt: '2026-09-28T00:00:01.000Z' }, record(2, 'holder-b')))
      .toBe(false);
    expect(leases.read(KEY)).toEqual(holder);

    expect(leases.tryReplace(KEY, holder, record(2, 'holder-b'))).toBe(true);
    expect(leases.read(KEY)).toEqual(record(2, 'holder-b'));
  });

  it('touches and releases only the current holder', () => {
    const leases = new SqliteLeaseStore(SqliteRoomStore.memory().db);
    const holder = record();
    leases.tryCreate(KEY, holder);

    expect(leases.tryTouch(record(9, 'someone-else'), record(9, 'someone-else', '2026-09-28T00:00:02.000Z')))
      .toBe(false);
    expect(leases.tryRelease(record(9, 'someone-else'))).toBe(false);
    expect(leases.read(KEY)).toEqual(holder);

    const renewed = record(1, 'holder-a', '2026-09-28T00:00:03.000Z');
    expect(leases.tryTouch(holder, renewed)).toBe(true);
    expect(leases.read(KEY)).toEqual(renewed);

    expect(leases.tryRelease(record(1, 'holder-a', 'wrong-beat'))).toBe(false);
    expect(leases.tryRelease(renewed)).toBe(true);
    expect(leases.read(KEY)).toBeUndefined();
  });

  it('reads a key nobody holds as undefined', () => {
    const leases = new SqliteLeaseStore(SqliteRoomStore.memory().db);

    expect(leases.read(KEY)).toBeUndefined();
  });

  it('lets a stale lease be taken over, and still conflicts while it is fresh', () => {
    const leases = new SqliteLeaseStore(SqliteRoomStore.memory().db);
    const startedAt = 1_000_000;
    const first = manager(leases, 'holder-a', startedAt);
    first.acquire(KEY);

    // Sixty seconds later the heartbeat is past `staleAfterMs`, so the next
    // holder takes the key instead of conflicting with it.
    const second = manager(leases, 'holder-b', startedAt + 60_000);
    expect(second.acquire(KEY)).toEqual({
      key: KEY,
      holderPid: 4242,
      holderId: 'holder-b',
      heartbeatAt: new Date(startedAt + 60_000).toISOString(),
    });
    expect(leases.read(KEY)?.holderId).toBe('holder-b');

    // And a lease that is minutes old cannot be taken again.
    expect(() => manager(leases, 'holder-c', startedAt + 60_001).acquire(KEY)).toThrow();
  });

  it('runs a fenced write when the holder still owns the key', async () => {
    const leases = new SqliteLeaseStore(SqliteRoomStore.memory().db);
    const holder = record();
    leases.tryCreate(KEY, holder);
    const operation = vi.fn(async () => 'written');

    await expect(leases.runFenced({ key: KEY, holderPid: 1, holderId: 'holder-a' }, operation))
      .resolves.toEqual({ executed: true, value: 'written' });
    expect(operation).toHaveBeenCalledOnce();
  });

  it('refuses a fenced write once the lease has moved on', async () => {
    const leases = new SqliteLeaseStore(SqliteRoomStore.memory().db);
    const holder = record();
    leases.tryCreate(KEY, holder);
    leases.tryReplace(KEY, holder, record(2, 'holder-b'));
    const operation = vi.fn(async () => 'written');

    await expect(leases.runFenced({ key: KEY, holderPid: 1, holderId: 'holder-a' }, operation))
      .resolves.toEqual({ executed: false });
    expect(operation).not.toHaveBeenCalled();
  });

  it('runs one fenced write at a time per key, in arrival order', async () => {
    const leases = new SqliteLeaseStore(SqliteRoomStore.memory().db);
    const holder = record();
    leases.tryCreate(KEY, holder);
    const order: string[] = [];
    let releaseOld: () => void = () => undefined;
    const oldWork = new Promise<void>(resolve => {
      releaseOld = resolve;
    });

    const oldWrite = leases.runFenced(
      { key: KEY, holderPid: 1, holderId: 'holder-a' },
      async () => {
        order.push('old:start');
        await oldWork;
        order.push('old:end');
      },
    );
    // Wait until the old write has passed the re-read and is inside the operation.
    await vi.waitFor(() => expect(order).toEqual(['old:start']));

    // The lease changes hands while the old write is still in flight; the next
    // fenced write waits for the chain, then re-reads the holder before it runs.
    const successor = record(2, 'holder-b');
    leases.tryReplace(KEY, holder, successor);
    const newWrite = leases.runFenced(
      { key: KEY, holderPid: successor.holderPid, holderId: successor.holderId },
      async () => {
        order.push('new');
      },
    );

    await new Promise(resolve => setTimeout(resolve, 15));
    expect(order).toEqual(['old:start']);

    releaseOld();
    await Promise.all([oldWrite, newWrite]);
    expect(order).toEqual(['old:start', 'old:end', 'new']);
  });

  it('keeps the fence while the lease is heartbeated under it', async () => {
    const leases = new SqliteLeaseStore(SqliteRoomStore.memory().db);
    const holder = record();
    leases.tryCreate(KEY, holder);
    const token = { key: KEY, holderPid: 1, holderId: 'holder-a' };
    const order: string[] = [];
    let releaseHeartbeat: () => void = () => undefined;
    const heartbeatGate = new Promise<void>(resolve => {
      releaseHeartbeat = resolve;
    });

    const first = leases.runFenced(token, async () => {
      order.push('first:start');
      await heartbeatGate;
      // The heartbeat advances the record mid-write; the fencing token does not
      // carry `heartbeatAt`, so the queued write by the same holder still enters.
      expect(leases.tryTouch(holder, record(1, 'holder-a', '2026-09-28T00:00:09.000Z'))).toBe(true);
      order.push('first:end');
    });
    const second = leases.runFenced(token, async () => {
      order.push('second');
    });

    releaseHeartbeat();
    const results = await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(results.every(result => result.executed)).toBe(true);
  });

  it('rejects when the signal is already aborted', async () => {
    const leases = new SqliteLeaseStore(SqliteRoomStore.memory().db);
    leases.tryCreate(KEY, record());
    const controller = new AbortController();
    controller.abort();

    await expect(
      leases.runFenced({ key: KEY, holderPid: 1, holderId: 'holder-a' }, async () => 'written', controller.signal),
    ).rejects.toThrow();
  });
});
