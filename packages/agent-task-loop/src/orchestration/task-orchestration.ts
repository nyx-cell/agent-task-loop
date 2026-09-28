import { createOrchestration, type CreateOrchestrationOptions } from './node-factory';
import type { Orchestration } from './orchestration';
import type { TemplateSpec } from './types';

export const CLASSIC_DELIVERY_TEMPLATE: TemplateSpec = {
  id: 'classic-delivery',
  seats: ['impl', 'review'],
  allow: { start: 'impl' },
};

export function createTaskOrchestration(options: CreateOrchestrationOptions = {}): Orchestration {
  const orchestration = createOrchestration(options);
  orchestration.templates.register(CLASSIC_DELIVERY_TEMPLATE);
  return orchestration;
}

export function taskOrchestrationKey(taskId: string): string {
  return `task:${taskId}`;
}
