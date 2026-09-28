import {
  holdsLock,
  isLockFresh,
  OrchestrationConflictError,
  OrchestrationNotFoundError,
  OrchestrationSeatError,
} from '@rivus/agent-orchestration';
import type {
  Clock,
  IntervalScheduler,
  FencingToken,
  LockRecord,
  ProcessIdentity,
  ProcessLiveness,
} from '@rivus/agent-orchestration';
import type { OpenRunInput, ObservedRun, ProcessRunner, RunSnapshot, SeatBind, SpawnResult } from './types';
import type { OrchestrationStore } from './ports';
import { Run } from './run';
import { TemplateRegistry } from './template';

export interface OrchestrationDependencies {
  store: OrchestrationStore;
  clock: Clock;
  identity: ProcessIdentity;
  holderId: string;
  liveness: ProcessLiveness;
  runner: ProcessRunner;
  scheduler: IntervalScheduler;
  staleAfterMs?: number;
  heartbeatIntervalMs?: number;
}

interface HeldRun {
  run: Run;
  lock: LockRecord;
}

export class Orchestration {
  readonly templates = new TemplateRegistry();
  private readonly store: OrchestrationStore;
  private readonly clock: Clock;
  private readonly identity: ProcessIdentity;
  private readonly holderId: string;
  private readonly liveness: ProcessLiveness;
  private readonly runner: ProcessRunner;
  private readonly scheduler: IntervalScheduler;
  private readonly staleAfterMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly envs = new Map<string, Map<string, Record<string, string>>>();

  constructor(dependencies: OrchestrationDependencies) {
    this.store = dependencies.store;
    this.clock = dependencies.clock;
    this.identity = dependencies.identity;
    this.holderId = dependencies.holderId;
    this.liveness = dependencies.liveness;
    this.runner = dependencies.runner;
    this.scheduler = dependencies.scheduler;
    this.staleAfterMs = dependencies.staleAfterMs ?? 120_000;
    this.heartbeatIntervalMs =
      dependencies.heartbeatIntervalMs ?? Math.min(15_000, Math.max(1, Math.floor(this.staleAfterMs / 4)));
  }

  async open(input: OpenRunInput): Promise<RunSnapshot> {
    const template = this.templates.get(input.template);
    const run = Run.open({
      key: input.key,
      template,
      bind: input.bind,
      context: input.context,
      holder: this.holder,
      at: this.isoNow(),
    });
    this.acquire(input.key);
    this.clearEnvs(input.key);
    for (const [seat, bound] of Object.entries(input.bind ?? {})) {
      if (bound.env) this.setEnv(input.key, seat, bound.env);
    }
    const snapshot = run.snapshot();
    this.store.writeState(snapshot);
    return snapshot;
  }

  inspect(key: string): RunSnapshot {
    const snapshot = this.store.readState(key);
    if (!snapshot) throw new OrchestrationNotFoundError(key);
    return snapshot;
  }

  observe(key: string, _seat: string): ObservedRun {
    return Run.restore(this.inspect(key)).observe();
  }

  allow(key: string, seat: string): RunSnapshot {
    const held = this.requireHolder(key);
    held.run.allow(seat);
    return this.touch(held);
  }

  appendFact(key: string, seat: string, text: string): RunSnapshot {
    const held = this.requireHolder(key);
    held.run.appendFact(seat, text, this.isoNow());
    return this.touch(held);
  }

  sendMail(key: string, input: { from: string; to: string; body: string }): RunSnapshot {
    const held = this.requireHolder(key);
    held.run.sendMail({ ...input, at: this.isoNow() });
    return this.touch(held);
  }

  async spawn(
    key: string,
    seat: string,
    input: { cwd: string; extraArgs?: string[]; env?: Record<string, string> },
  ): Promise<SpawnResult> {
    const bound = this.requireHolder(key).run.requireAllowedSeat(seat);
    if (!bound.cmd) throw new OrchestrationSeatError(key, `seat ${seat} has no command bound`);
    const env = {
      ...(this.envs.get(key)?.get(seat) ?? {}),
      ...(input.env ?? {}),
    };
    const args = [...(bound.args ?? []), ...(input.extraArgs ?? [])];

    this.mutateRun(key, (run) => run.markSeatRunning(seat));
    const controller = new AbortController();
    let heartbeatError: unknown;
    const timer = this.scheduler.setInterval(() => {
      try {
        this.heartbeat(key);
      } catch (error) {
        heartbeatError ??= error;
        controller.abort();
      }
    }, this.heartbeatIntervalMs);
    timer.unref?.();

    try {
      const result = await this.runner({
        cmd: bound.cmd,
        args,
        cwd: input.cwd,
        env,
        signal: controller.signal,
        onSpawn: (pid) => this.mutateRun(key, (run) => run.recordSeatPid(seat, pid)),
      });
      if (heartbeatError) throw heartbeatError;
      this.mutateRun(key, (run) => run.markSeatExited(seat));
      return result;
    } catch (error) {
      try {
        this.mutateRun(key, (run) => run.markSeatExited(seat));
      } catch {
        // The new holder owns the run state after this lease is lost.
      }
      throw heartbeatError ?? error;
    } finally {
      this.scheduler.clearInterval(timer);
    }
  }

  heartbeat(key: string): void {
    this.touch(this.requireHolder(key));
  }

  /**
   * Linearize one external write against every holder of this run.
   *
   * A holder that loses its lease during an already-started write may finish
   * that write, but the store keeps the fence until it finishes. A successor
   * holder therefore cannot start a newer write that the old write could later
   * overwrite. A holder that is already stale never enters the operation.
   */
  async fence<T>(
    key: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const held = this.requireHolder(key);
    const token: FencingToken = {
      key,
      holderPid: held.lock.holderPid,
      holderId: held.lock.holderId,
    };
    const result = await this.store.runFenced(token, operation, signal);
    if (!result.executed) {
      throw new OrchestrationConflictError(key, this.store.readLock(key)?.holderPid);
    }
    return result.value;
  }

  release(key: string): void {
    const lock = this.store.readLock(key);
    if (!this.isOwnedLock(lock)) return;
    const snapshot = this.store.readState(key);
    if (!snapshot || snapshot.holderId !== this.holderId) return;
    const run = Run.restore(snapshot);
    run.release(this.isoNow());
    if (!this.store.tryReleaseRun(lock, run.snapshot())) return;
    this.clearEnvs(key);
  }

  listRuns(): RunSnapshot[] {
    return this.store.listKeys().flatMap((key) => {
      const snapshot = this.store.readState(key);
      return snapshot ? [snapshot] : [];
    });
  }

  bind(key: string, seat: string, bind: SeatBind): RunSnapshot {
    const held = this.requireHolder(key);
    held.run.bind(seat, bind);
    if (bind.env) this.setEnv(key, seat, bind.env);
    else this.deleteEnv(key, seat);
    return this.touch(held);
  }

  private get holder(): { pid: number; id: string } {
    return { pid: this.identity.pid, id: this.holderId };
  }

  private acquire(key: string): void {
    const record: LockRecord = {
      key,
      holderPid: this.identity.pid,
      holderId: this.holderId,
      heartbeatAt: this.isoNow(),
    };
    if (this.store.tryCreateLock(key, record)) return;
    const existing = this.store.readLock(key);
    if (!existing) {
      if (this.store.lockExists(key)) throw new OrchestrationConflictError(key);
      if (this.store.tryCreateLock(key, record)) return;
      throw new OrchestrationConflictError(key, this.store.readLock(key)?.holderPid);
    }
    if (isLockFresh(existing, this.clock.now(), this.staleAfterMs, (pid) => this.liveness.isAlive(pid))) {
      throw new OrchestrationConflictError(key, existing.holderPid);
    }
    if (!this.store.tryReplaceLock(key, existing, record)) {
      throw new OrchestrationConflictError(key, this.store.readLock(key)?.holderPid);
    }
  }

  private requireHolder(key: string): HeldRun {
    const snapshot = this.inspect(key);
    if (!snapshot.occupied) throw new OrchestrationNotFoundError(key);
    const lock = this.store.readLock(key);
    if (
      !lock ||
      !holdsLock(lock, this.holder, this.clock.now(), this.staleAfterMs, (pid) => this.liveness.isAlive(pid))
    ) {
      throw new OrchestrationConflictError(key, lock?.holderPid);
    }
    if (snapshot.holderId !== this.holderId) {
      throw new OrchestrationConflictError(key, lock.holderPid);
    }
    return { run: Run.restore(snapshot), lock };
  }

  private mutateRun(key: string, mutate: (run: Run) => void): void {
    const held = this.requireHolder(key);
    mutate(held.run);
    this.touch(held);
  }

  private touch(held: HeldRun): RunSnapshot {
    const heartbeatAt = this.isoNow();
    held.run.heartbeat(heartbeatAt);
    const snapshot = held.run.snapshot();
    const next: LockRecord = { ...held.lock, heartbeatAt };
    if (!this.store.tryCommitRun(held.lock, next, snapshot)) {
      throw new OrchestrationConflictError(held.run.key, this.store.readLock(held.run.key)?.holderPid);
    }
    return snapshot;
  }

  private isOwnedLock(lock: LockRecord | undefined): lock is LockRecord {
    return !!lock && lock.holderPid === this.identity.pid && lock.holderId === this.holderId;
  }

  private clearEnvs(key: string): void {
    this.envs.delete(key);
  }

  private setEnv(key: string, seat: string, env: Record<string, string>): void {
    const bySeat = this.envs.get(key) ?? new Map<string, Record<string, string>>();
    bySeat.set(seat, { ...env });
    this.envs.set(key, bySeat);
  }

  private deleteEnv(key: string, seat: string): void {
    const bySeat = this.envs.get(key);
    if (!bySeat) return;
    bySeat.delete(seat);
    if (bySeat.size === 0) this.envs.delete(key);
  }

  private isoNow(): string {
    return new Date(this.clock.now()).toISOString();
  }
}
