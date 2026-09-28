import type { ProcessRunner } from './types';

export interface LockRecord {
  key: string;
  holderPid: number;
  holderId: string;
  heartbeatAt: string;
}

/**
 * Stable ownership token used to serialize writes to resources outside the
 * orchestration store. `heartbeatAt` is deliberately excluded: heartbeats may
 * advance while one fenced write is in flight without changing its owner.
 */
export type FencingToken = Pick<LockRecord, 'key' | 'holderPid' | 'holderId'>;

export type FencedResult<T> =
  | { executed: true; value: T }
  | { executed: false };

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

export type { ProcessRunner };
