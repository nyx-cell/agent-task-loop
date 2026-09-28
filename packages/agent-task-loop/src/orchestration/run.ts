import { OrchestrationRunError, OrchestrationSeatError } from '@rivus/agent-orchestration';
import type { ObservedRun, OpenRunInput, RunSnapshot, SeatBinding, SeatState, TemplateSpec } from './types';

/** Aggregate root for one occupied orchestration run. */
export class Run {
  private constructor(private readonly state: RunSnapshot) {}

  static open(input: {
    key: string;
    template: TemplateSpec;
    bind: Record<string, SeatBinding> | undefined;
    context: OpenRunInput['context'];
    holder: { pid: number; id: string };
    at: string;
  }): Run {
    const bind = input.bind ?? {};
    for (const seat of Object.keys(bind)) {
      if (!input.template.seats.includes(seat)) {
        throw new OrchestrationSeatError(input.key, `seat ${seat} is not in template ${input.template.id}`);
      }
    }

    const seats: Record<string, SeatState> = {};
    for (const name of input.template.seats) {
      const bound = bind[name];
      seats[name] = {
        ...(bound?.cmd ? { cmd: bound.cmd } : {}),
        ...(bound?.args ? { args: [...bound.args] } : {}),
        status: 'idle',
      };
    }

    return Run.restore({
      key: input.key,
      template: input.template.id,
      seats,
      allowed: input.template.allow?.start ?? input.template.seats[0]!,
      occupied: true,
      holderPid: input.holder.pid,
      holderId: input.holder.id,
      heartbeatAt: input.at,
      context: {
        ...(input.context?.goal ? { goal: input.context.goal } : {}),
        ...(input.context?.ref ? { ref: { ...input.context.ref } } : {}),
        facts: [],
        mail: [],
      },
    });
  }

  static restore(snapshot: RunSnapshot): Run {
    validateSnapshot(snapshot);
    return new Run(cloneSnapshot(snapshot));
  }

  get key(): string {
    return this.state.key;
  }

  get occupied(): boolean {
    return this.state.occupied;
  }

  allow(seat: string): void {
    this.assertOccupied();
    this.requireSeat(seat);
    this.state.allowed = seat;
  }

  appendFact(seat: string, text: string, at: string): void {
    this.assertOccupied();
    this.requireSeat(seat);
    this.state.context.facts.push({ seat, text, at });
  }

  sendMail(input: { from: string; to: string; body: string; at: string }): void {
    this.assertOccupied();
    this.requireSeat(input.from);
    this.requireSeat(input.to);
    this.state.context.mail.push({ ...input });
  }

  bind(seat: string, bind: SeatBinding): void {
    this.assertOccupied();
    const current = this.requireSeat(seat);
    this.state.seats[seat] = {
      ...current,
      cmd: bind.cmd,
      ...(bind.args ? { args: [...bind.args] } : {}),
    };
  }

  requireAllowedSeat(seat: string): SeatState {
    this.assertOccupied();
    if (this.state.allowed !== seat) {
      throw new OrchestrationSeatError(
        this.key,
        `seat ${seat} is not allowed to spawn (allowed=${this.state.allowed})`,
      );
    }
    const state = this.requireSeat(seat);
    return { ...state, ...(state.args ? { args: [...state.args] } : {}) };
  }

  markSeatRunning(seat: string): void {
    this.assertOccupied();
    this.requireSeat(seat).status = 'running';
  }

  recordSeatPid(seat: string, pid?: number): void {
    this.assertOccupied();
    const state = this.requireSeat(seat);
    if (pid === undefined) delete state.pid;
    else state.pid = pid;
  }

  markSeatExited(seat: string): void {
    this.assertOccupied();
    const state = this.requireSeat(seat);
    state.status = 'exited';
    delete state.pid;
  }

  heartbeat(at: string): void {
    this.assertOccupied();
    this.state.heartbeatAt = at;
  }

  release(at: string): void {
    this.state.occupied = false;
    delete this.state.holderPid;
    delete this.state.holderId;
    this.state.heartbeatAt = at;
  }

  observe(): ObservedRun {
    const seats: ObservedRun['seats'] = {};
    for (const [name, seat] of Object.entries(this.state.seats)) {
      seats[name] = { status: seat.status };
    }
    return {
      key: this.key,
      template: this.state.template,
      allowed: this.state.allowed,
      seats,
      context: {
        ...(this.state.context.goal ? { goal: this.state.context.goal } : {}),
        ...(this.state.context.ref ? { ref: { ...this.state.context.ref } } : {}),
        facts: this.state.context.facts.map((fact) => ({ ...fact })),
        mail: this.state.context.mail.map((mail) => ({ ...mail })),
      },
    };
  }

  snapshot(): RunSnapshot {
    return cloneSnapshot(this.state);
  }

  private requireSeat(seat: string): SeatState {
    const state = this.state.seats[seat];
    if (!state) throw new OrchestrationSeatError(this.key, `unknown seat ${seat}`);
    return state;
  }

  private assertOccupied(): void {
    if (!this.state.occupied) {
      throw new OrchestrationRunError(`run ${this.key} has been released`);
    }
  }
}

function validateSnapshot(snapshot: RunSnapshot): void {
  if (!snapshot.key.trim()) throw new OrchestrationRunError('run key is required');
  const seats = Object.keys(snapshot.seats);
  if (seats.length === 0) throw new OrchestrationRunError(`run ${snapshot.key} has no seats`);
  if (!snapshot.seats[snapshot.allowed]) {
    throw new OrchestrationRunError(`run ${snapshot.key} allows unknown seat ${snapshot.allowed}`);
  }
  if (snapshot.occupied && (snapshot.holderPid === undefined || !snapshot.holderId || !snapshot.heartbeatAt)) {
    throw new OrchestrationRunError(`occupied run ${snapshot.key} has no live holder record`);
  }
}

function cloneSnapshot(snapshot: RunSnapshot): RunSnapshot {
  return {
    ...snapshot,
    seats: Object.fromEntries(
      Object.entries(snapshot.seats).map(([name, seat]) => [
        name,
        { ...seat, ...(seat.args ? { args: [...seat.args] } : {}) },
      ]),
    ),
    context: {
      ...(snapshot.context.goal ? { goal: snapshot.context.goal } : {}),
      ...(snapshot.context.ref ? { ref: { ...snapshot.context.ref } } : {}),
      facts: snapshot.context.facts.map((fact) => ({ ...fact })),
      mail: snapshot.context.mail.map((mail) => ({ ...mail })),
    },
  };
}
