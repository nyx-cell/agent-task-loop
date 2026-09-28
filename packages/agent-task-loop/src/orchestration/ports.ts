import type { RunSnapshot } from './types';

/**
 * Run-state persistence for the Task pipeline's own orchestration. The lease
 * half of the old coupled interface is the control plane's `LeaseStore`,
 * reached through `LeaseManager` (RFC 0015 S2).
 */
export interface RunStateStore {
  writeState(snapshot: RunSnapshot): void;
  readState(key: string): RunSnapshot | undefined;
  listKeys(): string[];
}
