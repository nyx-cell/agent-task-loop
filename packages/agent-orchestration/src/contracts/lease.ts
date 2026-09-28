/** One held lease. A lease is fresh while the holder pid is alive and the heartbeat is within `staleAfterMs`. */
export interface LeaseRecord {
  key: string;
  holderPid: number;
  holderId: string;
  heartbeatAt: string;
}

/**
 * Stable ownership token used to serialize writes to resources outside the
 * lease store. `heartbeatAt` is deliberately excluded: heartbeats may advance
 * while one fenced write is in flight without changing its owner.
 */
export type FencingToken = Pick<LeaseRecord, 'key' | 'holderPid' | 'holderId'>;

export type FencedResult<T> =
  | { executed: true; value: T }
  | { executed: false };

/**
 * Port over durable leases. Key shape for a Room:
 * `room:<roomId>:member:<agentId>`. Every method is a compare-and-swap on the
 * whole record, so a stale holder can neither renew nor release.
 */
export interface LeaseStore {
  tryCreate(key: string, record: LeaseRecord): boolean;
  tryReplace(key: string, expected: LeaseRecord, next: LeaseRecord): boolean;
  tryTouch(expected: LeaseRecord, next: LeaseRecord): boolean;
  tryRelease(expected: LeaseRecord): boolean;
  read(key: string): LeaseRecord | undefined;
  runFenced<T>(token: FencingToken, op: () => Promise<T>, signal?: AbortSignal): Promise<FencedResult<T>>;
}
