import { OrchestrationTemplateError } from '@rivus/agent-orchestration';
import type { TemplateSpec } from './types';

export class TemplateRegistry {
  private readonly templates = new Map<string, TemplateSpec>();

  register(spec: TemplateSpec): void {
    if (!spec.id.trim()) {
      throw new OrchestrationTemplateError('template id is required');
    }
    if (this.templates.has(spec.id)) {
      throw new OrchestrationTemplateError(`template ${spec.id} is already registered`);
    }
    if (spec.seats.length === 0) {
      throw new OrchestrationTemplateError(`template ${spec.id} needs at least one seat`);
    }
    const unique = new Set(spec.seats);
    if (unique.size !== spec.seats.length) {
      throw new OrchestrationTemplateError(`template ${spec.id} has duplicate seats`);
    }
    if (spec.allow?.start && !unique.has(spec.allow.start)) {
      throw new OrchestrationTemplateError(
        `template ${spec.id} start seat ${spec.allow.start} is not in seats`,
      );
    }
    this.templates.set(spec.id, copyTemplate(spec));
  }

  get(id: string): TemplateSpec {
    const spec = this.templates.get(id);
    if (!spec) {
      throw new OrchestrationTemplateError(`unknown template ${id}`);
    }
    return copyTemplate(spec);
  }

  list(): TemplateSpec[] {
    return [...this.templates.values()].map(copyTemplate);
  }
}

function copyTemplate(spec: TemplateSpec): TemplateSpec {
  return {
    id: spec.id,
    seats: [...spec.seats],
    ...(spec.allow ? { allow: { ...spec.allow } } : {}),
  };
}
