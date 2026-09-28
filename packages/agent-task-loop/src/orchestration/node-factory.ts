import { randomUUID } from 'node:crypto';
import {
  nodeClock,
  nodeIdentity,
  nodeLiveness,
  nodeScheduler,
  type ProcessIdentity,
  type ProcessLiveness,
} from '@rivus/agent-orchestration';
import type { ProcessRunner } from './types';
import type { OrchestrationStore } from './ports';
import { Orchestration } from './orchestration';
import { FileOrchestrationStore } from './file-store';
import { MemoryOrchestrationStore } from './memory-store';
import { defaultBaseDir } from './node-paths';
import { execaProcessRunner } from './execa-runner';

export interface CreateOrchestrationOptions {
  baseDir?: string;
  store?: OrchestrationStore;
  now?: () => number;
  pid?: number;
  holderId?: string;
  staleAfterMs?: number;
  heartbeatIntervalMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  runner?: ProcessRunner;
}

export function createOrchestration(options: CreateOrchestrationOptions = {}): Orchestration {
  const identity: ProcessIdentity = options.pid === undefined ? nodeIdentity() : { pid: options.pid };
  const liveness: ProcessLiveness = options.isProcessAlive ? { isAlive: options.isProcessAlive } : nodeLiveness;
  return new Orchestration({
    store: options.store ?? new FileOrchestrationStore(options.baseDir ?? defaultBaseDir()),
    clock: options.now ? { now: options.now } : nodeClock,
    identity,
    holderId: options.holderId ?? randomUUID(),
    liveness,
    runner: options.runner ?? execaProcessRunner,
    scheduler: nodeScheduler,
    staleAfterMs: options.staleAfterMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
  });
}

export function createMemoryOrchestration(
  options: Omit<CreateOrchestrationOptions, 'baseDir' | 'store'> = {},
): Orchestration {
  return createOrchestration({
    ...options,
    store: new MemoryOrchestrationStore(),
  });
}
