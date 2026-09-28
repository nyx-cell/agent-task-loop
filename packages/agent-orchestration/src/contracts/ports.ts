import type { LeaseRecord } from './lease';

/**
 * The lease record's old name, kept so `domain/lock.ts` keeps its exact
 * shape. Identical to `LeaseRecord`; the two names meet in the lease stores.
 */
export type LockRecord = LeaseRecord;

export interface Clock {
  now(): number;
}

export interface ProcessIdentity {
  pid: number;
}

export interface ProcessLiveness {
  isAlive(pid: number): boolean;
}

export interface IntervalHandle {
  unref?(): void;
}

export interface IntervalScheduler {
  setInterval(fn: () => void, ms: number): IntervalHandle;
  clearInterval(handle: IntervalHandle): void;
}
