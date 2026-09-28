import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { leasePath, type LeaseRecord, type LeaseStore } from '../src/index';
import { LeaseManager } from '../src/application/lease-manager';
import { FileLeaseStore } from '../src/infrastructure/file-lease-store';
import { MemoryLeaseStore } from '../src/infrastructure/memory-lease-store';

const stores: { name: string; store: () => LeaseStore }[] = [
  { name: 'MemoryLeaseStore', store: () => new MemoryLeaseStore() },
  { name: 'FileLeaseStore', store: () => new FileLeaseStore(tempDir()) },
];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-lease-'));
  dirs.push(dir);
  return dir;
}

function record(key: string, holderPid = 1, holderId = 'holder-a', at = 1_000): LeaseRecord {
  return { key, holderPid, holderId, heartbeatAt: new Date(at).toISOString() };
}

describe.each(stores)('$name', ({ store }) => {
  it('creates, replaces and reads with compare-and-swap semantics', () => {
    const leases = store();
    const expected = record('room:r1:member:claude');
    const nextA = { ...expected, holderPid: 2, holderId: 'holder-b' };
    const nextB = { ...expected, holderPid: 3, holderId: 'holder-c' };

    expect(leases.tryCreate(expected.key, expected)).toBe(true);
    expect(leases.tryCreate(expected.key, record(expected.key, 9, 'other'))).toBe(false);
    expect(leases.tryReplace(expected.key, expected, nextA)).toBe(true);
    expect(leases.tryReplace(expected.key, expected, nextB)).toBe(false);
    expect(leases.read(expected.key)).toEqual(nextA);
  });

  it('touches and releases only through the whole expected record', () => {
    const leases = store();
    const expected = record('room:r1:member:claude');
    leases.tryCreate(expected.key, expected);

    const staleHeartbeat = { ...expected, heartbeatAt: new Date(500).toISOString() };
    expect(leases.tryTouch(staleHeartbeat, { ...staleHeartbeat, heartbeatAt: new Date(600).toISOString() })).toBe(
      false,
    );
    const renewed = { ...expected, heartbeatAt: new Date(1_500).toISOString() };
    expect(leases.tryTouch(expected, renewed)).toBe(true);

    expect(leases.tryRelease(expected)).toBe(false);
    expect(leases.read(expected.key)).toEqual(renewed);
    expect(leases.tryRelease(renewed)).toBe(true);
    expect(leases.read(expected.key)).toBeUndefined();
  });

  it('serializes fenced writes per key and refuses a stale holder', async () => {
    const leases = store();
    const holder = record('room:r1:member:claude');
    leases.tryCreate(holder.key, holder);

    const order: string[] = [];
    let finishOld: () => void = () => undefined;
    const oldWrite = leases.runFenced(holder, async () => {
      order.push('old:start');
      await new Promise<void>((resolve) => {
        finishOld = resolve;
      });
      order.push('old:end');
    });
    await vi.waitFor(() => expect(order).toEqual(['old:start']));

    const successor = record(holder.key, 2, 'holder-b');
    leases.tryReplace(holder.key, holder, successor);
    const newWrite = leases.runFenced(successor, async () => {
      order.push('new');
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(order).toEqual(['old:start']);

    finishOld();
    await Promise.all([oldWrite, newWrite]);
    expect(order).toEqual(['old:start', 'old:end', 'new']);
  });

  it('returns executed: false when the token no longer matches', async () => {
    const leases = store();
    const holder = record('room:r1:member:claude');
    leases.tryCreate(holder.key, holder);
    const mutation = vi.fn();
    const stale: LeaseRecord = { ...holder, holderPid: 99, holderId: 'gone' };
    await expect(leases.runFenced(stale, mutation)).resolves.toEqual({ executed: false });
    expect(mutation).not.toHaveBeenCalled();
  });
});

describe('FileLeaseStore layout', () => {
  it('keeps the lease under the per-key run directory', async () => {
    const dir = tempDir();
    const leases = new FileLeaseStore(dir);
    const holder = record('room:r1:member:claude');
    leases.tryCreate(holder.key, holder);
    expect(leasePath(dir, holder.key)).toContain('lease.lock');
  });

  it('recovers a lease guard left behind by a crashed process', () => {
    const dir = tempDir();
    const leases = new FileLeaseStore(dir);
    const expected = record('room:r1:member:claude');
    const next = { ...expected, holderPid: 2, holderId: 'holder-b' };
    expect(leases.tryCreate(expected.key, expected)).toBe(true);
    mkdirSync(`${leasePath(dir, expected.key)}.guard`);

    expect(leases.tryReplace(expected.key, expected, next)).toBe(true);
    expect(leases.read(expected.key)).toEqual(next);
  });

  it('treats an unreadable lease as absent, so acquire conflicts instead of stealing', async () => {
    const dir = tempDir();
    const leases = new FileLeaseStore(dir);
    const holder = record('room:r1:member:claude', 1, 'holder-a', Date.now());
    leases.tryCreate(holder.key, holder);
    writeFileSync(leasePath(dir, holder.key), '{', 'utf8');
    expect(leases.read(holder.key)).toBeUndefined();
    expect(leases.tryCreate(holder.key, holder)).toBe(false);
  });
});

describe('LeaseManager', () => {
  function manager(options: {
    baseDir?: string;
    holderId?: string;
    now?: () => number;
    staleAfterMs?: number;
    isProcessAlive?: (pid: number) => boolean;
  }): LeaseManager {
    return new LeaseManager({
      store: new FileLeaseStore(options.baseDir ?? tempDir()),
      clock: options.now ? { now: options.now } : { now: () => 1_000 },
      identity: { pid: 4242 },
      holderId: options.holderId ?? 'holder-a',
      liveness: { isAlive: options.isProcessAlive ?? (() => true) },
      staleAfterMs: options.staleAfterMs,
    });
  }

  it('refuses a second acquire while the lease is fresh', () => {
    const dir = tempDir();
    const first = manager({ baseDir: dir, holderId: 'holder-a' });
    const second = manager({ baseDir: dir, holderId: 'holder-b' });
    first.acquire('room:r1:member:claude');
    expect(() => second.acquire('room:r1:member:claude')).toThrowError(
      expect.objectContaining({ code: 'orchestration-conflict', holderPid: 4242 }),
    );
  });

  it('lets a successor take over a stale lease', () => {
    let now = 1_000;
    const dir = tempDir();
    const first = manager({
      baseDir: dir,
      holderId: 'holder-a',
      now: () => now,
      staleAfterMs: 100,
      isProcessAlive: () => false,
    });
    const second = manager({
      baseDir: dir,
      holderId: 'holder-b',
      now: () => now,
      staleAfterMs: 100,
      isProcessAlive: () => false,
    });
    first.acquire('room:r1:member:claude');
    now = 10_000;
    const stolen = second.acquire('room:r1:member:claude');
    expect(stolen.holderId).toBe('holder-b');
    expect(first.read('room:r1:member:claude')).toEqual(stolen);
  });

  it('renews with a compare-and-swap and conflicts once the lease is lost', () => {
    let now = 1_000;
    const dir = tempDir();
    const first = manager({ baseDir: dir, holderId: 'holder-a', now: () => now, staleAfterMs: 100 });
    const second = manager({ baseDir: dir, holderId: 'holder-b', now: () => now, staleAfterMs: 100 });
    first.acquire('room:r1:member:claude');
    const renewed = first.heartbeat('room:r1:member:claude');
    expect(Date.parse(renewed.heartbeatAt)).toBeGreaterThan(0);

    now = 10_000;
    second.acquire('room:r1:member:claude');
    expect(() => first.heartbeat('room:r1:member:claude')).toThrowError(
      expect.objectContaining({ code: 'orchestration-conflict' }),
    );
    expect(() => first.requireHeld('room:r1:member:claude')).toThrowError(
      expect.objectContaining({ code: 'orchestration-conflict' }),
    );
  });

  it('releases only its own lease', () => {
    const dir = tempDir();
    const first = manager({ baseDir: dir, holderId: 'holder-a' });
    const second = manager({ baseDir: dir, holderId: 'holder-b' });
    first.acquire('room:r1:member:claude');
    second.release('room:r1:member:claude');
    expect(first.read('room:r1:member:claude')).toBeDefined();
    first.release('room:r1:member:claude');
    expect(first.read('room:r1:member:claude')).toBeUndefined();
  });

  it('rejects a stale holder before a fenced write starts', async () => {
    let now = 1_000;
    const dir = tempDir();
    const first = manager({
      baseDir: dir,
      holderId: 'holder-a',
      now: () => now,
      staleAfterMs: 100,
      isProcessAlive: () => true,
    });
    const second = manager({
      baseDir: dir,
      holderId: 'holder-b',
      now: () => now,
      staleAfterMs: 100,
      isProcessAlive: () => true,
    });
    first.acquire('room:r1:member:claude');
    now = 10_000;
    second.acquire('room:r1:member:claude');
    const mutation = vi.fn();
    await expect(first.fence('room:r1:member:claude', mutation)).rejects.toThrowError(
      expect.objectContaining({ code: 'orchestration-conflict' }),
    );
    expect(mutation).not.toHaveBeenCalled();
  });
});
