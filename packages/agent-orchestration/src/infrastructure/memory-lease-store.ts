import type { FencedResult, FencingToken, LeaseRecord, LeaseStore } from '../contracts/lease';
import { sameLock } from '../domain/lock';

export class MemoryLeaseStore implements LeaseStore {
  private readonly records = new Map<string, LeaseRecord>();
  private readonly fenceTails = new Map<string, Promise<void>>();

  tryCreate(key: string, record: LeaseRecord): boolean {
    if (this.records.has(key)) {
      return false;
    }
    this.records.set(key, { ...record });
    return true;
  }

  tryReplace(key: string, expected: LeaseRecord, next: LeaseRecord): boolean {
    const current = this.records.get(key);
    if (!current || !sameLock(current, expected)) {
      return false;
    }
    this.records.set(key, { ...next });
    return true;
  }

  tryTouch(expected: LeaseRecord, next: LeaseRecord): boolean {
    const current = this.records.get(expected.key);
    if (!current || !sameLock(current, expected) || next.key !== expected.key) {
      return false;
    }
    this.records.set(next.key, { ...next });
    return true;
  }

  tryRelease(expected: LeaseRecord): boolean {
    const current = this.records.get(expected.key);
    if (!current || !sameLock(current, expected)) {
      return false;
    }
    this.records.delete(expected.key);
    return true;
  }

  read(key: string): LeaseRecord | undefined {
    const record = this.records.get(key);
    return record ? { ...record } : undefined;
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
      const current = this.records.get(token.key);
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
