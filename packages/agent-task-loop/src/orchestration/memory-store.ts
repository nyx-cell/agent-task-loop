import type { RunStateStore } from './ports';
import type { RunSnapshot } from './types';

/** In-memory run state. The lease lives in the control plane's LeaseStore. */
export class MemoryOrchestrationStore implements RunStateStore {
  private readonly states = new Map<string, RunSnapshot>();

  writeState(snapshot: RunSnapshot): void {
    this.states.set(snapshot.key, structuredClone(snapshot));
  }

  readState(key: string): RunSnapshot | undefined {
    const snapshot = this.states.get(key);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  listKeys(): string[] {
    return [...this.states.keys()];
  }
}
