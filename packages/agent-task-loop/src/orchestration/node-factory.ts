import { randomUUID } from 'node:crypto';
import {
  defaultBaseDir,
  nodeClock,
  nodeIdentity,
  nodeLiveness,
  nodeScheduler,
  type Clock,
  type ProcessIdentity,
  type ProcessLiveness,
} from '@rivus/agent-orchestration';
import { LeaseManager } from '@rivus/agent-orchestration';
import { FileLeaseStore, type LeaseStore } from '@rivus/agent-orchestration';
import type { ProcessRunner } from './types';
import type { RunStateStore } from './ports';
import { Orchestration } from './orchestration';
import { FileOrchestrationStore } from './file-store';
import { MemoryOrchestrationStore } from './memory-store';
import { MemoryLeaseStore } from '@rivus/agent-orchestration';
import { execaProcessRunner } from './execa-runner';

export interface CreateOrchestrationOptions {
  baseDir?: string;
  store?: RunStateStore;
  leaseStore?: LeaseStore;
  now?: () => number;
  pid?: number;
  holderId?: string;
  staleAfterMs?: number;
  heartbeatIntervalMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  runner?: ProcessRunner;
}

export function createOrchestration(options: CreateOrchestrationOptions = {}): Orchestration {
  const clock: Clock = options.now ? { now: options.now } : nodeClock;
  const identity: ProcessIdentity = options.pid === undefined ? nodeIdentity() : { pid: options.pid };
  const liveness: ProcessLiveness = options.isProcessAlive ? { isAlive: options.isProcessAlive } : nodeLiveness;
  const holderId = options.holderId ?? randomUUID();
  const baseDir = options.baseDir ?? defaultBaseDir();
  const lease = new LeaseManager({
    store: options.leaseStore ?? new FileLeaseStore(baseDir),
    clock,
    identity,
    holderId,
    liveness,
    staleAfterMs: options.staleAfterMs,
  });
  return new Orchestration({
    state: options.store ?? new FileOrchestrationStore(baseDir),
    lease,
    clock,
    identity,
    holderId,
    runner: options.runner ?? execaProcessRunner,
    scheduler: nodeScheduler,
    heartbeatIntervalMs:
      options.heartbeatIntervalMs ?? Math.min(15_000, Math.max(1, Math.floor((options.staleAfterMs ?? 120_000) / 4))),
  });
}

export function createMemoryOrchestration(
  options: Omit<CreateOrchestrationOptions, 'baseDir' | 'store' | 'leaseStore'> = {},
): Orchestration {
  return createOrchestration({
    ...options,
    store: new MemoryOrchestrationStore(),
    leaseStore: new MemoryLeaseStore(),
  });
}
