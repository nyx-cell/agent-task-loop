import { describe, expect, it } from 'vitest';
import { OrchestrationSeatError } from '@rivus/agent-orchestration';
import { Run } from '../../src/orchestration/run';

function openRun(): Run {
  return Run.open({
    key: 'task:T-1',
    template: { id: 'delivery', seats: ['impl', 'review'], allow: { start: 'impl' } },
    bind: { impl: { cmd: 'codex', args: ['exec'] } },
    context: { goal: 'ship' },
    holder: { pid: 10, id: 'holder-a' },
    at: '2026-08-29T00:00:00.000Z',
  });
}

describe('Run aggregate', () => {
  it('owns seat state and rejects unknown seats', () => {
    const run = openRun();
    run.markSeatRunning('impl');
    run.recordSeatPid('impl', 42);
    expect(run.snapshot().seats.impl).toMatchObject({ status: 'running', pid: 42 });
    expect(() => run.allow('missing')).toThrow(OrchestrationSeatError);
  });

  it('does not expose mutable aggregate state through snapshots', () => {
    const run = openRun();
    const snapshot = run.snapshot();
    snapshot.seats.impl!.status = 'exited';
    snapshot.context.facts.push({ seat: 'impl', text: 'forged', at: 'now' });
    expect(run.snapshot().seats.impl!.status).toBe('idle');
    expect(run.snapshot().context.facts).toEqual([]);
  });

  it('copies mail commands before storing them', () => {
    const run = openRun();
    const mail = {
      from: 'impl',
      to: 'review',
      body: 'original',
      at: '2026-08-29T00:02:00.000Z',
    };
    run.sendMail(mail);
    mail.body = 'forged';
    expect(run.snapshot().context.mail[0]!.body).toBe('original');
  });

  it('records facts, mail, turn changes, and release through behavior', () => {
    const run = openRun();
    run.appendFact('impl', 'tests pass', '2026-08-29T00:01:00.000Z');
    run.sendMail({
      from: 'impl',
      to: 'review',
      body: 'please review',
      at: '2026-08-29T00:02:00.000Z',
    });
    run.allow('review');
    run.release('2026-08-29T00:03:00.000Z');

    expect(run.snapshot()).toMatchObject({ occupied: false, allowed: 'review' });
    expect(run.snapshot().context.facts).toHaveLength(1);
    expect(run.snapshot().context.mail).toHaveLength(1);
  });

  it('keeps a released run terminal after hydration', () => {
    const snapshot = openRun().snapshot();
    const released = Run.restore({
      ...snapshot,
      occupied: false,
      holderPid: undefined,
      holderId: undefined,
    });
    expect(() => released.allow('review')).toThrow(/released/);
    expect(() => released.heartbeat('2026-08-29T00:04:00.000Z')).toThrow(/released/);
  });

  it('rejects an invalid persisted allowed seat', () => {
    const snapshot = openRun().snapshot();
    expect(() => Run.restore({ ...snapshot, allowed: 'missing' })).toThrow(/unknown seat/);
  });
});
