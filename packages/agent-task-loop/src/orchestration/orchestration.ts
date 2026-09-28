import {
  OrchestrationConflictError,
  OrchestrationNotFoundError,
  OrchestrationSeatError,
} from '@rivus/agent-orchestration';
import type { LeaseManager } from '@rivus/agent-orchestration';
import type {
  Clock,
  IntervalScheduler,
  LockRecord,
  ProcessIdentity,
} from '@rivus/agent-orchestration';
import type { OpenRunInput, ObservedRun, ProcessRunner, RunSnapshot, SeatBind, SpawnResult } from './types';
import type { RunStateStore } from './ports';
import { Run } from './run';
import { TemplateRegistry } from './template';

export interface OrchestrationDependencies {
  state: RunStateStore;
  lease: LeaseManager;
  clock: Clock;
  identity: ProcessIdentity;
  holderId: string;
  runner: ProcessRunner;
  scheduler: IntervalScheduler;
  heartbeatIntervalMs?: number;
}

interface HeldRun {
  run: Run;
  lock: LockRecord;
}

/**
 * The Task pipeline's run baton, taken over from the control plane in RFC 0015
 * S2. Seat turn-taking is this package's own concern; the lease behind every
 * `open`, `heartbeat`, `fence` and `release` is the control plane's
 * `LeaseManager`.
 */
export class Orchestration {
  readonly templates = new TemplateRegistry();
  private readonly state: RunStateStore;
  private readonly lease: LeaseManager;
  private readonly clock: Clock;
  private readonly identity: ProcessIdentity;
  private readonly holderId: string;
  private readonly runner: ProcessRunner;
  private readonly scheduler: IntervalScheduler;
  private readonly heartbeatIntervalMs: number;
  private readonly envs = new Map<string, Map<string, Record<string, string>>>();

  constructor(dependencies: OrchestrationDependencies) {
    this.state = dependencies.state;
    this.lease = dependencies.lease;
    this.clock = dependencies.clock;
    this.identity = dependencies.identity;
    this.holderId = dependencies.holderId;
    this.runner = dependencies.runner;
    this.scheduler = dependencies.scheduler;
    this.heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? 15_000;
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
    this.lease.acquire(input.key);
    this.clearEnvs(input.key);
    for (const [seat, bound] of Object.entries(input.bind ?? {})) {
      if (bound.env) this.setEnv(input.key, seat, bound.env);
    }
    const snapshot = run.snapshot();
    this.state.writeState(snapshot);
    return snapshot;
  }

  inspect(key: string): RunSnapshot {
    const snapshot = this.state.readState(key);
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

  async fence<T>(
    key: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.lease.fence(key, operation, signal);
  }

  release(key: string): void {
    const lock = this.lease.read(key);
    if (!lock || lock.holderPid !== this.identity.pid || lock.holderId !== this.holderId) return;
    const snapshot = this.state.readState(key);
    if (!snapshot || snapshot.holderId !== this.holderId) return;
    const run = Run.restore(snapshot);
    run.release(this.isoNow());
    // The released state lands before the lease goes, so a successor holder
    // can never see our stale write after it took over.
    this.state.writeState(run.snapshot());
    this.lease.release(key);
  }

  listRuns(): RunSnapshot[] {
    return this.state.listKeys().flatMap((key) => {
      const snapshot = this.state.readState(key);
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

  private requireHolder(key: string): HeldRun {
    const snapshot = this.inspect(key);
    if (!snapshot.occupied) throw new OrchestrationNotFoundError(key);
    const lock = this.lease.requireHeld(key);
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
    // The lease CAS is the commit point: once it lands this process still
    // holds the key, so the state write follows; when it fails the write
    // never happens.
    this.lease.heartbeat(held.run.key);
    this.state.writeState(snapshot);
    return snapshot;
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
