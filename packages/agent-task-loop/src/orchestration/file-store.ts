import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  FencedResult,
  FencingToken,
  LockRecord,
} from '@rivus/agent-orchestration';
import { nodeLiveness, sameLock } from '@rivus/agent-orchestration';
import type { OrchestrationStore } from './ports';
import type { RunSnapshot } from './types';
import { lockPath, runDir, statePath } from './node-paths';

interface GuardOwner {
  pid: number;
  id: string;
}

export class FileOrchestrationStore implements OrchestrationStore {
  constructor(private readonly baseDir: string) {}

  tryCreateLock(key: string, record: LockRecord): boolean {
    return this.withLockGuard(key, () => {
      const file = lockPath(this.baseDir, key);
      if (existsSync(file)) return false;
      writeJsonAtomically(file, record);
      return true;
    });
  }

  tryReplaceLock(key: string, expected: LockRecord, next: LockRecord): boolean {
    return this.withLockGuard(key, () => {
      const file = lockPath(this.baseDir, key);
      const current = readJson<LockRecord>(file);
      if (!current || !sameLock(current, expected) || next.key !== key) return false;
      writeJsonAtomically(file, next);
      return true;
    });
  }

  tryCommitRun(expected: LockRecord, next: LockRecord, snapshot: RunSnapshot): boolean {
    return this.withLockGuard(expected.key, () => {
      const file = lockPath(this.baseDir, expected.key);
      const current = readJson<LockRecord>(file);
      if (!current || !sameLock(current, expected) || next.key !== expected.key || snapshot.key !== expected.key) {
        return false;
      }
      writeJsonAtomically(statePath(this.baseDir, snapshot.key), snapshot);
      writeJsonAtomically(file, next);
      return true;
    });
  }

  tryReleaseRun(expected: LockRecord, snapshot: RunSnapshot): boolean {
    return this.withLockGuard(expected.key, () => {
      const file = lockPath(this.baseDir, expected.key);
      const current = readJson<LockRecord>(file);
      if (!current || !sameLock(current, expected) || snapshot.key !== expected.key) return false;
      writeJsonAtomically(statePath(this.baseDir, snapshot.key), snapshot);
      unlinkSync(file);
      return true;
    });
  }

  lockExists(key: string): boolean {
    return existsSync(lockPath(this.baseDir, key));
  }

  readLock(key: string): LockRecord | undefined {
    return readJson(lockPath(this.baseDir, key));
  }

  writeState(snapshot: RunSnapshot): void {
    writeJsonAtomically(statePath(this.baseDir, snapshot.key), snapshot);
  }

  readState(key: string): RunSnapshot | undefined {
    return readJson(statePath(this.baseDir, key));
  }

  listKeys(): string[] {
    if (!existsSync(this.baseDir)) return [];
    const keys: string[] = [];
    for (const name of readdirSync(this.baseDir)) {
      const snapshot = readJson<RunSnapshot>(path.join(this.baseDir, name, 'state.json'));
      if (snapshot?.key) keys.push(snapshot.key);
    }
    return keys;
  }

  async runFenced<T>(
    token: FencingToken,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<FencedResult<T>> {
    const guard = `${lockPath(this.baseDir, token.key)}.mutation-guard`;
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
      const current = readJson<LockRecord>(lockPath(this.baseDir, token.key));
      if (!current || !sameHolder(current, token)) {
        return { executed: false };
      }
      return { executed: true, value: await operation() };
    } finally {
      releaseGuard(guard, owner);
    }
  }

  private withLockGuard(key: string, operation: () => boolean): boolean {
    const guard = `${lockPath(this.baseDir, key)}.guard`;
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

function sameHolder(current: LockRecord, token: FencingToken): boolean {
  return current.key === token.key &&
    current.holderPid === token.holderPid &&
    current.holderId === token.holderId;
}

export function removeRunDir(baseDir: string, key: string): void {
  rmSync(runDir(baseDir, key), { recursive: true, force: true });
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
