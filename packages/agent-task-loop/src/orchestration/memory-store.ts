import { sameLock } from '@rivus/agent-orchestration';
import type {
  FencedResult,
  FencingToken,
  LockRecord,
} from '@rivus/agent-orchestration';
import type { OrchestrationStore } from './ports';
import type { RunSnapshot } from './types';

export class MemoryOrchestrationStore implements OrchestrationStore {
  private readonly locks = new Map<string, LockRecord>();
  private readonly states = new Map<string, RunSnapshot>();
  private readonly fenceTails = new Map<string, Promise<void>>();

  tryCreateLock(key: string, record: LockRecord): boolean {
    if (this.locks.has(key)) {
      return false;
    }
    this.locks.set(key, { ...record });
    return true;
  }

  tryReplaceLock(key: string, expected: LockRecord, next: LockRecord): boolean {
    const current = this.locks.get(key);
    if (!current || !sameLock(current, expected)) {
      return false;
    }
    this.locks.set(key, { ...next });
    return true;
  }

  tryCommitRun(expected: LockRecord, next: LockRecord, snapshot: RunSnapshot): boolean {
    const current = this.locks.get(expected.key);
    if (!current || !sameLock(current, expected) || next.key !== expected.key || snapshot.key !== expected.key) {
      return false;
    }
    this.states.set(snapshot.key, structuredClone(snapshot));
    this.locks.set(next.key, { ...next });
    return true;
  }

  tryReleaseRun(expected: LockRecord, snapshot: RunSnapshot): boolean {
    const current = this.locks.get(expected.key);
    if (!current || !sameLock(current, expected) || snapshot.key !== expected.key) {
      return false;
    }
    this.states.set(snapshot.key, structuredClone(snapshot));
    this.locks.delete(expected.key);
    return true;
  }

  lockExists(key: string): boolean {
    return this.locks.has(key);
  }

  readLock(key: string): LockRecord | undefined {
    const lock = this.locks.get(key);
    return lock ? { ...lock } : undefined;
  }

  writeState(snapshot: RunSnapshot): void {
    this.states.set(snapshot.key, structuredClone(snapshot));
  }

  readState(key: string): RunSnapshot | undefined {
    const snapshot = this.states.get(key);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  listKeys(): string[] {
    return [...this.states.keys()];
  }

  async runFenced<T>(
    token: FencingToken,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<FencedResult<T>> {
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
      const current = this.locks.get(token.key);
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
}
