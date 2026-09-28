import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProcessRunner, SeatBind, TemplateSpec } from '../../orchestration/types';
import type { Orchestration } from '../../orchestration/orchestration';
import { createMemoryOrchestration } from '../../orchestration/node-factory';
import type {
  TaskDeliveryRuntime,
  TaskDeliveryRuntimeView,
} from '../application/task-delivery-ports';
import type { TaskDeliverySeat } from '../domain/model';

export const TASK_DELIVERY_TEMPLATE: TemplateSpec = {
  id: 'classic-delivery',
  seats: ['impl', 'review'],
  allow: { start: 'impl' },
};

export interface MemoryOrchestratedTaskRuntimeOptions {
  runner: ProcessRunner;
  bindings: Record<TaskDeliverySeat, SeatBind>;
  now?: () => number;
}

/** Memory-backed local adapter for Task occupancy and process execution. */
export class MemoryOrchestratedTaskRuntime implements TaskDeliveryRuntime {
  private orchestration: Orchestration;
  private readonly workspaces = new Map<string, string>();

  constructor(private readonly options: MemoryOrchestratedTaskRuntimeOptions) {
    this.orchestration = this.createOrchestration();
  }

  async open(input: { taskId: string; title: string }): Promise<void> {
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'rivus-room-task-'));
    try {
      await this.orchestration.open({
        key: taskKey(input.taskId),
        template: TASK_DELIVERY_TEMPLATE.id,
        bind: this.options.bindings,
        context: { goal: input.title, ref: { taskId: input.taskId } },
      });
      this.workspaces.set(input.taskId, workDir);
    } catch (error) {
      await rm(workDir, { recursive: true, force: true });
      throw error;
    }
  }

  fence<T>(
    taskId: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.orchestration.fence(taskKey(taskId), operation, signal);
  }

  async run(input: {
    taskId: string;
    seat: TaskDeliverySeat;
    prompt: string;
  }): Promise<{ text: string; latencyMs: number }> {
    const workDir = this.workspaces.get(input.taskId);
    if (!workDir) throw new Error(`Task ${input.taskId} has no active workspace`);
    const startedAt = (this.options.now ?? Date.now)();
    const result = await this.orchestration.spawn(taskKey(input.taskId), input.seat, {
      cwd: workDir,
      extraArgs: [input.prompt],
    });
    if (result.exitCode !== 0) throw new Error(`${input.seat} exited with code ${result.exitCode}`);
    const text = result.stdout.trim();
    if (!text) throw new Error(`${input.seat} returned an empty response`);
    return { text, latencyMs: (this.options.now ?? Date.now)() - startedAt };
  }

  allow(taskId: string, seat: TaskDeliverySeat): void {
    this.orchestration.allow(taskKey(taskId), seat);
  }

  appendFact(taskId: string, seat: TaskDeliverySeat, text: string): void {
    this.orchestration.appendFact(taskKey(taskId), seat, text);
  }

  sendMail(
    taskId: string,
    input: { from: TaskDeliverySeat; to: TaskDeliverySeat; body: string },
  ): void {
    this.orchestration.sendMail(taskKey(taskId), input);
  }

  inspect(taskId: string): TaskDeliveryRuntimeView {
    const run = this.orchestration.inspect(taskKey(taskId));
    return {
      occupied: run.occupied,
      allowedSeat: run.allowed as TaskDeliverySeat,
    };
  }

  async release(taskId: string): Promise<void> {
    const workDir = this.workspaces.get(taskId);
    let releaseError: unknown;
    try {
      this.orchestration.release(taskKey(taskId));
    } catch (error) {
      releaseError = error;
    }
    if (workDir) {
      try {
        await rm(workDir, { recursive: true, force: true });
        this.workspaces.delete(taskId);
      } catch (error) {
        releaseError ??= error;
      }
    }
    if (releaseError) throw releaseError;
  }

  reset(): void {
    if (this.workspaces.size > 0) throw new Error('cannot reset an occupied Task runtime');
    this.orchestration = this.createOrchestration();
  }

  private createOrchestration(): Orchestration {
    const orchestration = createMemoryOrchestration({ runner: this.options.runner });
    orchestration.templates.register(TASK_DELIVERY_TEMPLATE);
    return orchestration;
  }
}

function taskKey(taskId: string): string {
  return `task:${taskId}`;
}
