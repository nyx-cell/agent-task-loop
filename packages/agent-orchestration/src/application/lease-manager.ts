import { OrchestrationConflictError } from '../contracts/errors';
import type { FencingToken, LeaseRecord, LeaseStore } from '../contracts/lease';
import type { Clock, ProcessIdentity, ProcessLiveness } from '../contracts/ports';
import { holdsLock, isLockFresh } from '../domain/lock';

export interface LeaseManagerDependencies {
  store: LeaseStore;
  clock: Clock;
  identity: ProcessIdentity;
  holderId: string;
  liveness: ProcessLiveness;
  staleAfterMs?: number;
}

/**
 * The lease half of the old orchestration facade (RFC 0015 S2): acquire,
 * heartbeat, fence, release. A lease is fresh while the holder pid is alive
 * and the heartbeat is within `staleAfterMs`; every renewal is a
 * compare-and-swap on the whole record.
 */
export class LeaseManager {
  private readonly store: LeaseStore;
  private readonly clock: Clock;
  private readonly identity: ProcessIdentity;
  private readonly holderId: string;
  private readonly liveness: ProcessLiveness;
  private readonly staleAfterMs: number;

  constructor(dependencies: LeaseManagerDependencies) {
    this.store = dependencies.store;
    this.clock = dependencies.clock;
    this.identity = dependencies.identity;
    this.holderId = dependencies.holderId;
    this.liveness = dependencies.liveness;
    this.staleAfterMs = dependencies.staleAfterMs ?? 120_000;
  }

  /** Take the lease, stealing it only when the current holder is stale. */
  acquire(key: string): LeaseRecord {
    const record: LeaseRecord = {
      key,
      holderPid: this.identity.pid,
      holderId: this.holderId,
      heartbeatAt: this.isoNow(),
    };
    if (this.store.tryCreate(key, record)) return record;
    const existing = this.store.read(key);
    if (!existing) {
      // The record vanished or is unreadable; one retry settles the race.
      if (this.store.tryCreate(key, record)) return record;
      throw new OrchestrationConflictError(key, this.store.read(key)?.holderPid);
    }
    if (isLockFresh(existing, this.clock.now(), this.staleAfterMs, (pid) => this.liveness.isAlive(pid))) {
      throw new OrchestrationConflictError(key, existing.holderPid);
    }
    if (!this.store.tryReplace(key, existing, record)) {
      throw new OrchestrationConflictError(key, this.store.read(key)?.holderPid);
    }
    return record;
  }

  /** Renew the lease with a compare-and-swap on the whole record. */
  heartbeat(key: string): LeaseRecord {
    const current = this.requireHeld(key);
    const next: LeaseRecord = { ...current, heartbeatAt: this.isoNow() };
    if (!this.store.tryTouch(current, next)) {
      throw new OrchestrationConflictError(key, this.store.read(key)?.holderPid);
    }
    return next;
  }

  /** Release when this process still owns the record; a no-op otherwise. */
  release(key: string): void {
    const current = this.store.read(key);
    if (!this.isOwned(current)) return;
    this.store.tryRelease(current);
  }

  /**
   * Linearize one external write against every holder of this key.
   *
   * A holder that loses its lease during an already-started write may finish
   * that write, but the store keeps the fence until it finishes. A successor
   * holder therefore cannot start a newer write that the old write could
   * later overwrite. A holder that is already stale never enters the
   * operation.
   */
  async fence<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const held = this.requireHeld(key);
    const token: FencingToken = {
      key,
      holderPid: held.holderPid,
      holderId: held.holderId,
    };
    const result = await this.store.runFenced(token, operation, signal);
    if (!result.executed) {
      throw new OrchestrationConflictError(key, this.store.read(key)?.holderPid);
    }
    return result.value;
  }

  read(key: string): LeaseRecord | undefined {
    return this.store.read(key);
  }

  /** Throws unless this process holds a fresh lease on the key. */
  requireHeld(key: string): LeaseRecord {
    const current = this.store.read(key);
    if (
      !current ||
      !holdsLock(
        current,
        { pid: this.identity.pid, id: this.holderId },
        this.clock.now(),
        this.staleAfterMs,
        (pid) => this.liveness.isAlive(pid),
      )
    ) {
      throw new OrchestrationConflictError(key, current?.holderPid);
    }
    return current;
  }

  private isOwned(record: LeaseRecord | undefined): record is LeaseRecord {
    return !!record && record.holderPid === this.identity.pid && record.holderId === this.holderId;
  }

  private isoNow(): string {
    return new Date(this.clock.now()).toISOString();
  }
}
