import { describe, expect, it } from 'vitest';
import type { ProcessRunner } from '../src/orchestration/types';
import {
  MemoryOrchestratedTaskRuntime,
  MemoryTaskDeliveryRepository,
  TaskDelivery,
  TaskDeliveryApplication,
  TaskDeliveryTransitionError,
  TaskDeliveryValidationError,
  parseTaskReviewVerdict,
  type TaskDeliveryEvent,
  type TaskDeliveryRuntime,
  type TaskDeliverySeat,
} from '../src/task-delivery';

describe('TaskDelivery aggregate', () => {
  it('guards the implementation-review-rework transitions', () => {
    const task = TaskDelivery.start({ taskId: 'WEB-001', title: 'Prove Room value', maxRounds: 2 });

    task.recordImplementation('first answer');
    task.recordReview('CHANGES_REQUESTED', 'VERDICT: CHANGES_REQUESTED\nAdd evidence.');
    expect(task.snapshot()).toMatchObject({ status: 'changes-requested', round: 1 });

    task.beginRework();
    task.recordImplementation('answer with evidence');
    task.recordReview('PASS', 'VERDICT: PASS\nEvidence is sufficient.');
    expect(task.snapshot()).toMatchObject({ status: 'passed', round: 2, verdict: 'PASS' });
    expect(() => task.fail('late failure')).toThrow(TaskDeliveryTransitionError);
  });

  it('accepts only an exact PASS first line', () => {
    expect(parseTaskReviewVerdict('VERDICT: PASS\nLooks good')).toBe('PASS');
    expect(parseTaskReviewVerdict('Looks good\nVERDICT: PASS')).toBe('CHANGES_REQUESTED');
    expect(parseTaskReviewVerdict('VERDICT: PASS with caveats')).toBe('CHANGES_REQUESTED');
  });

  it('rejects an invalid runtime verdict without corrupting aggregate state', () => {
    const task = TaskDelivery.start({ taskId: 'WEB-INVALID', title: 'Guard verdicts', maxRounds: 1 });
    task.recordImplementation('answer');

    expect(() => task.recordReview('UNKNOWN' as never, 'review'))
      .toThrow(TaskDeliveryValidationError);
    expect(task.snapshot()).toMatchObject({ status: 'reviewing', verdict: undefined });
  });
});

describe('TaskDeliveryApplication', () => {
  it('owns the two-seat review loop and releases occupancy after PASS', async () => {
    const runtime = new FakeRuntime([
      'first answer',
      'VERDICT: CHANGES_REQUESTED\nAdd evidence.',
      'answer with evidence',
      'VERDICT: PASS\nEvidence is sufficient.',
    ]);
    const repository = new MemoryTaskDeliveryRepository();
    const events: TaskDeliveryEvent[] = [];
    const application = new TaskDeliveryApplication({
      repository,
      runtime,
      eventSink: { publish: async event => void events.push(event) },
    });

    const result = await application.start({
      taskId: 'WEB-001',
      title: 'Prove Room value',
      maxRounds: 2,
    });

    expect(result).toMatchObject({
      status: 'passed',
      round: 2,
      verdict: 'PASS',
      occupied: false,
      allowedSeat: 'review',
    });
    expect(runtime.calls.map(call => call.seat)).toEqual(['impl', 'review', 'impl', 'review']);
    expect(runtime.mail).toHaveLength(1);
    expect(events.filter(event => event.type === 'seat-output')).toHaveLength(4);
  });

  it('does not let a failed projection change the Task verdict', async () => {
    const runtime = new FakeRuntime(['answer', 'VERDICT: PASS\nApproved.']);
    const application = new TaskDeliveryApplication({
      repository: new MemoryTaskDeliveryRepository(),
      runtime,
      eventSink: { publish: async () => { throw new Error('Room unavailable'); } },
    });

    await expect(application.start({ taskId: 'WEB-002', title: 'Independent Task', maxRounds: 1 }))
      .resolves.toMatchObject({ status: 'passed', occupied: false });
  });

  it('does not let a failed update observer change the Task verdict', async () => {
    const runtime = new FakeRuntime(['answer', 'VERDICT: PASS\nApproved.']);
    const repository = new MemoryTaskDeliveryRepository();
    const application = new TaskDeliveryApplication({
      repository,
      runtime,
      onUpdate: () => { throw new Error('read model unavailable'); },
    });

    await expect(application.start({ taskId: 'WEB-UPDATE', title: 'Observer failure', maxRounds: 1 }))
      .resolves.toMatchObject({ status: 'passed', occupied: false });
    expect(repository.get('WEB-UPDATE')).toMatchObject({ status: 'passed', verdict: 'PASS' });
  });

  it('acquires occupancy before creating and never overwrites a concurrent aggregate', async () => {
    let releaseImplementation!: () => void;
    let implementationStarted!: () => void;
    const implementationGate = new Promise<void>(resolve => {
      releaseImplementation = resolve;
    });
    const started = new Promise<void>(resolve => {
      implementationStarted = resolve;
    });
    const runner: ProcessRunner = async input => {
      if (input.cmd === 'impl') {
        implementationStarted();
        await implementationGate;
        return { stdout: 'first result', stderr: '', exitCode: 0 };
      }
      return { stdout: 'VERDICT: PASS\nApproved.', stderr: '', exitCode: 0 };
    };
    const repository = new MemoryTaskDeliveryRepository();
    const runtime = new MemoryOrchestratedTaskRuntime({
      runner,
      bindings: {
        impl: { cmd: 'impl' },
        review: { cmd: 'review' },
      },
    });
    const application = new TaskDeliveryApplication({ repository, runtime });

    const first = application.start({ taskId: ' WEB-003 ', title: ' first ', maxRounds: 1 });
    await started;
    await expect(application.start({ taskId: 'WEB-003', title: 'second', maxRounds: 1 }))
      .rejects.toThrow(/already occupied/);
    expect(repository.get('WEB-003')).toMatchObject({ title: 'first', status: 'executing' });

    releaseImplementation();
    await expect(first).resolves.toMatchObject({ title: 'first', status: 'passed' });
  });

  it('reports cleanup failure without changing a completed Task verdict', async () => {
    const events: TaskDeliveryEvent[] = [];
    const application = new TaskDeliveryApplication({
      repository: new MemoryTaskDeliveryRepository(),
      runtime: new ReleaseFailingRuntime(['answer', 'VERDICT: PASS\nApproved.']),
      eventSink: { publish: async event => void events.push(event) },
    });

    await expect(application.start({ taskId: 'WEB-004', title: 'stable result', maxRounds: 1 }))
      .resolves.toMatchObject({ status: 'passed', occupied: false });
    expect(events.at(-1)).toMatchObject({
      type: 'cleanup-failed',
      task: { status: 'passed' },
      reason: 'workspace cleanup failed',
    });
  });
});

class FakeRuntime implements TaskDeliveryRuntime {
  readonly calls: Array<{ seat: TaskDeliverySeat; prompt: string }> = [];
  readonly mail: string[] = [];
  private occupied = false;
  private allowedSeat: TaskDeliverySeat = 'impl';

  constructor(private readonly outputs: string[]) {}

  async open(): Promise<void> {
    this.occupied = true;
    this.allowedSeat = 'impl';
  }

  async fence<T>(_taskId: string, operation: () => Promise<T>): Promise<T> {
    if (!this.occupied) throw new Error('task is not occupied');
    return operation();
  }

  async run(input: { seat: TaskDeliverySeat; prompt: string }): Promise<{ text: string; latencyMs: number }> {
    if (!this.occupied || input.seat !== this.allowedSeat) throw new Error('seat is not allowed');
    this.calls.push({ seat: input.seat, prompt: input.prompt });
    return { text: this.outputs.shift() ?? '', latencyMs: 1 };
  }

  allow(_taskId: string, seat: TaskDeliverySeat): void {
    this.allowedSeat = seat;
  }

  appendFact(): void {}

  sendMail(_taskId: string, input: { body: string }): void {
    this.mail.push(input.body);
  }

  inspect() {
    return { occupied: this.occupied, allowedSeat: this.allowedSeat };
  }

  async release(): Promise<void> {
    this.occupied = false;
  }
}

class ReleaseFailingRuntime extends FakeRuntime {
  override async release(): Promise<void> {
    await super.release();
    throw new Error('workspace cleanup failed');
  }
}
