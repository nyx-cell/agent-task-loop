import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { FencedResult, FencingToken, LeaseRecord, LeaseStore } from '../contracts/lease';
import { sameLock } from '../domain/lock';
import { leasePath } from './node-paths';
import { nodeLiveness } from './node-liveness';

interface GuardOwner {
  pid: number;
  id: string;
}

/** The lock half of the old file store: durable leases with compare-and-swap semantics. */
export class FileLeaseStore implements LeaseStore {
  constructor(private readonly baseDir: string) {}

  tryCreate(key: string, record: LeaseRecord): boolean {
    return this.withLeaseGuard(key, () => {
      const file = leasePath(this.baseDir, key);
      if (existsSync(file)) return false;
      writeJsonAtomically(file, record);
      return true;
    });
  }

  tryReplace(key: string, expected: LeaseRecord, next: LeaseRecord): boolean {
    return this.withLeaseGuard(key, () => {
      const file = leasePath(this.baseDir, key);
      const current = readJson<LeaseRecord>(file);
      if (!current || !sameLock(current, expected) || next.key !== key) return false;
      writeJsonAtomically(file, next);
      return true;
    });
  }

  tryTouch(expected: LeaseRecord, next: LeaseRecord): boolean {
    return this.withLeaseGuard(expected.key, () => {
      const file = leasePath(this.baseDir, expected.key);
      const current = readJson<LeaseRecord>(file);
      if (!current || !sameLock(current, expected) || next.key !== expected.key) return false;
      writeJsonAtomically(file, next);
      return true;
    });
  }

  tryRelease(expected: LeaseRecord): boolean {
    return this.withLeaseGuard(expected.key, () => {
      const file = leasePath(this.baseDir, expected.key);
      const current = readJson<LeaseRecord>(file);
      if (!current || !sameLock(current, expected)) return false;
      unlinkSync(file);
      return true;
    });
  }

  read(key: string): LeaseRecord | undefined {
    return readJson(leasePath(this.baseDir, key));
  }

  async runFenced<T>(
    token: FencingToken,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<FencedResult<T>> {
    const guard = `${leasePath(this.baseDir, token.key)}.mutation-guard`;
    mkdirSync(path.dirname(guard), { recursive: true });
    const owner: GuardOwner = {
      pid: process.pid,
      id: randomBytes(16).toString('hex'),
    };
    while (!tryAcquireGuard(guard, owner)) {
      signal?.throwIfAborted();
      await delay(5, undefined, signal ? { signal } : undefined);
    }
    try {
      const current = readJson<LeaseRecord>(leasePath(this.baseDir, token.key));
      if (!current || !sameHolder(current, token)) {
        return { executed: false };
      }
      return { executed: true, value: await operation() };
    } finally {
      releaseGuard(guard, owner);
    }
  }

  private withLeaseGuard(key: string, operation: () => boolean): boolean {
    const guard = `${leasePath(this.baseDir, key)}.guard`;
    mkdirSync(path.dirname(guard), { recursive: true });
    const owner: GuardOwner = {
      pid: process.pid,
      id: randomBytes(16).toString('hex'),
    };
    if (!tryAcquireGuard(guard, owner)) return false;
    try {
      return operation();
    } finally {
      releaseGuard(guard, owner);
    }
  }
}

function sameHolder(current: LeaseRecord, token: FencingToken): boolean {
  return current.key === token.key &&
    current.holderPid === token.holderPid &&
    current.holderId === token.holderId;
}

function writeJsonAtomically(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), 'utf8');
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function tryAcquireGuard(guard: string, owner: GuardOwner): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidate = `${guard}.${owner.pid}.${owner.id}.tmp`;
    mkdirSync(candidate);
    try {
      writeJsonAtomically(path.join(candidate, 'owner.json'), owner);
      try {
        renameSync(candidate, guard);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      }
    } finally {
      rmSync(candidate, { recursive: true, force: true });
    }
    if (!reclaimAbandonedGuard(guard)) return false;
  }
  return false;
}

function reclaimAbandonedGuard(guard: string): boolean {
  const owner = readJson<GuardOwner>(path.join(guard, 'owner.json'));
  if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && nodeLiveness.isAlive(owner.pid)) {
    return false;
  }
  const abandoned = `${guard}.${process.pid}.${randomBytes(16).toString('hex')}.abandoned`;
  try {
    renameSync(guard, abandoned);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  rmSync(abandoned, { recursive: true, force: true });
  return true;
}

function releaseGuard(guard: string, owner: GuardOwner): void {
  const current = readJson<GuardOwner>(path.join(guard, 'owner.json'));
  if (current?.pid !== owner.pid || current.id !== owner.id) return;
  rmSync(guard, { recursive: true, force: true });
}
