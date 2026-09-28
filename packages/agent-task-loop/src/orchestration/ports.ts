import type { FencedResult, FencingToken, LockRecord } from '@rivus/agent-orchestration';
import type { RunSnapshot } from './types';

/**
 * Store contract for the Task run baton taken over from
 * `@rivus/agent-orchestration` (RFC 0015 S2). Coupled lock-and-state commits
 * (`tryCommitRun` / `tryReleaseRun`) are reduced to run-state-only writes once
 * this orchestration is rebuilt on the control plane's `LeaseManager`.
 */
export interface OrchestrationStore {
  tryCreateLock(key: string, record: LockRecord): boolean;
  tryReplaceLock(key: string, expected: LockRecord, next: LockRecord): boolean;
  tryCommitRun(expected: LockRecord, next: LockRecord, snapshot: RunSnapshot): boolean;
  tryReleaseRun(expected: LockRecord, snapshot: RunSnapshot): boolean;
  lockExists(key: string): boolean;
  readLock(key: string): LockRecord | undefined;
  writeState(snapshot: RunSnapshot): void;
  readState(key: string): RunSnapshot | undefined;
  listKeys(): string[];
  runFenced<T>(
    token: FencingToken,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<FencedResult<T>>;
}
