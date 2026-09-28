import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type LockRecord,
  leasePath,
  OrchestrationConflictError,
  OrchestrationSeatError,
  OrchestrationTemplateError,
} from '@rivus/agent-orchestration';
import { createMemoryOrchestration, createOrchestration } from '../../src/orchestration/node-factory';
import type { Orchestration } from '../../src/orchestration/orchestration';

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'agent-orch-'));
}

function classic(orch: Orchestration): void {
  orch.templates.register({
    id: 'classic-delivery',
    seats: ['impl', 'review'],
    allow: { start: 'impl' },
  });
}

describe('TemplateRegistry', () => {
  it('rejects a duplicate template id', () => {
    const orch = createOrchestration({ baseDir: tempDir() });
    classic(orch);
    expect(() => classic(orch)).toThrow(OrchestrationTemplateError);
  });

  it('returns a copy from get so callers cannot mutate the registry', () => {
    const orch = createOrchestration({ baseDir: tempDir() });
    classic(orch);
    const spec = orch.templates.get('classic-delivery');
    spec.seats.push('lead');
    expect(orch.templates.get('classic-delivery').seats).toEqual(['impl', 'review']);
  });

  it('rejects a start seat that is not in the roster', () => {
    const orch = createOrchestration({ baseDir: tempDir() });
    expect(() =>
      orch.templates.register({
        id: 'bad',
        seats: ['impl'],
        allow: { start: 'lead' },
      }),
    ).toThrow(/start seat/);
  });
});

describe('Orchestration open / occupy', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  function orch(): Orchestration {
    const dir = tempDir();
    dirs.push(dir);
    const instance = createOrchestration({ baseDir: dir });
    classic(instance);
    return instance;
  }

  it('opens a run and records the registered context', async () => {
    const instance = orch();
    const snapshot = await instance.open({
      key: 'task:T-1',
      template: 'classic-delivery',
      bind: { impl: { cmd: 'grok' }, review: { cmd: 'codex' } },
      context: { goal: 'fix the leak', ref: { taskId: 'T-1' } },
    });

    expect(snapshot.occupied).toBe(true);
    expect(snapshot.allowed).toBe('impl');
    expect(snapshot.seats.impl?.cmd).toBe('grok');
    expect(snapshot.context.goal).toBe('fix the leak');
    expect(snapshot.context.ref).toEqual({ taskId: 'T-1' });
    expect(instance.inspect('task:T-1').key).toBe('task:T-1');
  });

  it('validates the aggregate before acquiring its lock', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const instance = createOrchestration({ baseDir: dir });
    classic(instance);

    await expect(
      instance.open({
        key: 'task:invalid',
        template: 'classic-delivery',
        bind: { lead: { cmd: 'codex' } },
      }),
    ).rejects.toBeInstanceOf(OrchestrationSeatError);
    expect(existsSync(leasePath(dir, 'task:invalid'))).toBe(false);
  });

  it('rejects a second open on the same key while the lock is fresh', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const a = createOrchestration({ baseDir: dir });
    const b = createOrchestration({ baseDir: dir });
    classic(a);
    classic(b);
    await a.open({ key: 'task:T-1', template: 'classic-delivery' });

    await expect(b.open({ key: 'task:T-1', template: 'classic-delivery' })).rejects.toMatchObject({
      name: 'OrchestrationConflictError',
      code: 'orchestration-conflict',
      key: 'task:T-1',
      holderPid: process.pid,
    });
    expect(b.inspect('task:T-1').occupied).toBe(true);
  });

  it('lets a later open take over a stale lock', async () => {
    let now = 1_000;
    const dir = tempDir();
    dirs.push(dir);
    const a = createOrchestration({
      baseDir: dir,
      now: () => now,
      staleAfterMs: 100,
      isProcessAlive: () => false,
    });
    classic(a);
    await a.open({ key: 'task:T-1', template: 'classic-delivery' });

    now = 10_000;
    const b = createOrchestration({
      baseDir: dir,
      now: () => now,
      staleAfterMs: 100,
      isProcessAlive: () => false,
    });
    classic(b);
    const snapshot = await b.open({
      key: 'task:T-1',
      template: 'classic-delivery',
    });
    expect(snapshot.occupied).toBe(true);
  });

  it('distinguishes holders that share one process id', async () => {
    let now = 1_000;
    const dir = tempDir();
    dirs.push(dir);
    const a = createOrchestration({
      baseDir: dir,
      holderId: 'holder-a',
      now: () => now,
      staleAfterMs: 100,
      isProcessAlive: () => true,
    });
    const b = createOrchestration({
      baseDir: dir,
      holderId: 'holder-b',
      now: () => now,
      staleAfterMs: 100,
      isProcessAlive: () => true,
    });
    classic(a);
    classic(b);
    await a.open({ key: 'task:T-1', template: 'classic-delivery' });

    now = 10_000;
    await b.open({ key: 'task:T-1', template: 'classic-delivery' });
    a.release('task:T-1');

    expect(b.inspect('task:T-1')).toMatchObject({
      occupied: true,
      holderId: 'holder-b',
    });
    expect(() => a.allow('task:T-1', 'review')).toThrow(OrchestrationConflictError);
    expect(b.allow('task:T-1', 'review').allowed).toBe('review');
  });

  it('allows a new open after release', async () => {
    const instance = orch();
    await instance.open({ key: 'task:T-1', template: 'classic-delivery' });
    instance.release('task:T-1');
    expect(instance.inspect('task:T-1').occupied).toBe(false);

    const again = await instance.open({
      key: 'task:T-1',
      template: 'classic-delivery',
    });
    expect(again.occupied).toBe(true);
  });

  it('treats an unreadable lock as a conflict, not as stealable', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const instance = createOrchestration({ baseDir: dir });
    classic(instance);
    await instance.open({ key: 'task:T-1', template: 'classic-delivery' });
    writeFileSync(leasePath(dir, 'task:T-1'), '{', 'utf8');

    const other = createOrchestration({ baseDir: dir });
    classic(other);
    await expect(other.open({ key: 'task:T-1', template: 'classic-delivery' })).rejects.toBeInstanceOf(
      OrchestrationConflictError,
    );
  });

  it('clears bound env when the same key is reopened after release', async () => {
    const dir = tempDir();
    dirs.push(dir);
    let spawnedEnv: Record<string, string> | undefined;
    const instance = createOrchestration({
      baseDir: dir,
      runner: async (input) => {
        spawnedEnv = input.env;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    classic(instance);
    await instance.open({
      key: 'task:T-1',
      template: 'classic-delivery',
      bind: { impl: { cmd: 'grok', env: { TOKEN: 'secret' } } },
    });
    instance.release('task:T-1');
    await instance.open({
      key: 'task:T-1',
      template: 'classic-delivery',
      bind: { impl: { cmd: 'grok' } },
    });
    await instance.spawn('task:T-1', 'impl', { cwd: dir });
    expect(spawnedEnv?.TOKEN).toBeUndefined();
  });

  it('does not clear another run env when run keys share a prefix', async () => {
    const dir = tempDir();
    dirs.push(dir);
    let spawnedEnv: Record<string, string> | undefined;
    const instance = createOrchestration({
      baseDir: dir,
      runner: async (input) => {
        spawnedEnv = input.env;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    classic(instance);
    await instance.open({ key: 'a', template: 'classic-delivery' });
    await instance.open({
      key: 'a::b',
      template: 'classic-delivery',
      bind: { impl: { cmd: 'grok', env: { TOKEN: 'keep' } } },
    });

    instance.release('a');
    await instance.spawn('a::b', 'impl', { cwd: dir });
    expect(spawnedEnv?.TOKEN).toBe('keep');
  });

  it('serializes a successor holder behind an in-flight fenced write', async () => {
    let now = 1_000;
    let firstHolderAlive = true;
    const dir = tempDir();
    dirs.push(dir);
    const a = createOrchestration({
      baseDir: dir,
      holderId: 'holder-a',
      now: () => now,
      staleAfterMs: 100,
      isProcessAlive: () => firstHolderAlive,
    });
    const b = createOrchestration({
      baseDir: dir,
      holderId: 'holder-b',
      now: () => now,
      staleAfterMs: 100,
      isProcessAlive: () => true,
    });
    classic(a);
    classic(b);
    await a.open({ key: 'task:T-1', template: 'classic-delivery' });

    const order: string[] = [];
    let finishOld: () => void = () => undefined;
    const oldWrite = a.fence('task:T-1', async () => {
      order.push('old:start');
      await new Promise<void>(resolve => {
        finishOld = resolve;
      });
      order.push('old:end');
    });
    await vi.waitFor(() => expect(order).toEqual(['old:start']));

    now = 10_000;
    firstHolderAlive = false;
    await b.open({ key: 'task:T-1', template: 'classic-delivery' });
    const newWrite = b.fence('task:T-1', async () => {
      order.push('new');
    });
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(order).toEqual(['old:start']);

    finishOld();
    await Promise.all([oldWrite, newWrite]);
    expect(order).toEqual(['old:start', 'old:end', 'new']);
  });

  it('rejects a stale holder before a fenced write starts', async () => {
    let now = 1_000;
    let firstHolderAlive = true;
    const dir = tempDir();
    dirs.push(dir);
    const a = createOrchestration({
      baseDir: dir,
      holderId: 'holder-a',
      now: () => now,
      staleAfterMs: 100,
      isProcessAlive: () => firstHolderAlive,
    });
    const b = createOrchestration({
      baseDir: dir,
      holderId: 'holder-b',
      now: () => now,
      staleAfterMs: 100,
      isProcessAlive: () => true,
    });
    classic(a);
    classic(b);
    await a.open({ key: 'task:T-1', template: 'classic-delivery' });
    now = 10_000;
    firstHolderAlive = false;
    await b.open({ key: 'task:T-1', template: 'classic-delivery' });
    const mutation = vi.fn();

    await expect(a.fence('task:T-1', mutation)).rejects.toBeInstanceOf(
      OrchestrationConflictError,
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  it('redacts commands from observe', async () => {
    const instance = orch();
    await instance.open({
      key: 'task:T-1',
      template: 'classic-delivery',
      bind: { impl: { cmd: 'grok', env: { TOKEN: 'secret' } } },
    });
    const viewed = instance.observe('task:T-1', 'impl');
    expect(viewed.seats.impl).toEqual({ status: 'idle' });
    expect(JSON.stringify(viewed)).not.toContain('secret');
    expect(JSON.stringify(viewed)).not.toContain('grok');
  });
});

describe('Orchestration allow / facts / mail / spawn', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('refuses spawn unless the seat is allowed', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const instance = createOrchestration({
      baseDir: dir,
      runner: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    });
    classic(instance);
    await instance.open({
      key: 'task:T-1',
      template: 'classic-delivery',
      bind: { impl: { cmd: 'grok' }, review: { cmd: 'codex' } },
    });

    await expect(instance.spawn('task:T-1', 'review', { cwd: dir })).rejects.toBeInstanceOf(OrchestrationSeatError);

    instance.allow('task:T-1', 'review');
    const result = await instance.spawn('task:T-1', 'review', { cwd: dir });
    expect(result.exitCode).toBe(0);
    expect(instance.inspect('task:T-1').seats.review?.status).toBe('exited');
  });

  it('appends facts and mail onto the run context', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const instance = createOrchestration({ baseDir: dir });
    classic(instance);
    await instance.open({ key: 'task:T-1', template: 'classic-delivery' });

    instance.appendFact('task:T-1', 'impl', 'implemented the fix');
    instance.sendMail('task:T-1', {
      from: 'impl',
      to: 'review',
      body: 'please look',
    });

    const snapshot = instance.inspect('task:T-1');
    expect(snapshot.context.facts).toHaveLength(1);
    expect(snapshot.context.facts[0]?.text).toBe('implemented the fix');
    expect(snapshot.context.mail).toEqual([
      expect.objectContaining({
        from: 'impl',
        to: 'review',
        body: 'please look',
      }),
    ]);
  });

  it('marks the seat exited when the runner throws', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const instance = createOrchestration({
      baseDir: dir,
      runner: async () => {
        throw new Error('child crashed');
      },
    });
    classic(instance);
    await instance.open({
      key: 'task:T-1',
      template: 'classic-delivery',
      bind: { impl: { cmd: 'grok' } },
    });
    await expect(instance.spawn('task:T-1', 'impl', { cwd: dir })).rejects.toThrow('child crashed');
    expect(instance.inspect('task:T-1').seats.impl?.status).toBe('exited');
  });

  it('refuses mutating APIs unless this process holds a fresh lock', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const instance = createOrchestration({ baseDir: dir });
    classic(instance);
    await instance.open({ key: 'task:T-1', template: 'classic-delivery' });
    writeFileSync(
      leasePath(dir, 'task:T-1'),
      JSON.stringify({
        key: 'task:T-1',
        holderPid: process.pid + 1,
        holderId: 'other-holder',
        heartbeatAt: new Date().toISOString(),
      }),
      'utf8',
    );
    expect(() => instance.allow('task:T-1', 'review')).toThrow(OrchestrationConflictError);
  });

  it('lists opened runs', async () => {
    const instance = createOrchestration({ baseDir: tempDir() });
    classic(instance);
    await instance.open({ key: 'task:A', template: 'classic-delivery' });
    await instance.open({ key: 'task:B', template: 'classic-delivery' });
    expect(
      instance
        .listRuns()
        .map((run) => run.key)
        .sort(),
    ).toEqual(['task:A', 'task:B']);
  });

  it('aborts a spawned process after losing its lease', async () => {
    const dir = tempDir();
    dirs.push(dir);
    let signal: AbortSignal | undefined;
    const a = createOrchestration({
      baseDir: dir,
      holderId: 'holder-a',
      heartbeatIntervalMs: 5,
      isProcessAlive: () => true,
      runner: (input) =>
        new Promise((_resolve, reject) => {
          signal = input.signal;
          input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    const b = createOrchestration({
      baseDir: dir,
      holderId: 'holder-b',
      isProcessAlive: () => false,
    });
    classic(a);
    classic(b);
    await a.open({
      key: 'task:T-1',
      template: 'classic-delivery',
      bind: { impl: { cmd: 'codex' } },
    });

    const spawned = a.spawn('task:T-1', 'impl', { cwd: dir });
    await b.open({ key: 'task:T-1', template: 'classic-delivery' });

    await expect(spawned).rejects.toBeInstanceOf(OrchestrationConflictError);
    expect(signal?.aborted).toBe(true);
    expect(b.inspect('task:T-1')).toMatchObject({
      occupied: true,
      holderId: 'holder-b',
    });
  });
});

describe('OrchestrationConflictError', () => {
  it('is an Error with a stable code', () => {
    const error = new OrchestrationConflictError('task:T-1', 42);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('orchestration-conflict');
  });
});

describe('memory store', () => {
  it('occupies without touching the filesystem', async () => {
    const instance = createMemoryOrchestration();
    classic(instance);
    const snapshot = await instance.open({
      key: 'task:mem',
      template: 'classic-delivery',
    });
    expect(snapshot.occupied).toBe(true);
    await expect(instance.open({ key: 'task:mem', template: 'classic-delivery' })).rejects.toBeInstanceOf(
      OrchestrationConflictError,
    );
  });
});
