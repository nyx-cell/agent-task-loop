import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunStateStore } from './ports';
import type { RunSnapshot } from './types';
import { runDir, statePath } from './node-paths';

/**
 * The run-state half of the old orchestration file store. The lock half left
 * for the control plane's `FileLeaseStore`; a run state file and its lease
 * share the same per-key directory under `baseDir`.
 */
export class FileOrchestrationStore implements RunStateStore {
  constructor(private readonly baseDir: string) {}

  writeState(snapshot: RunSnapshot): void {
    writeJsonAtomically(statePath(this.baseDir, snapshot.key), snapshot);
  }

  readState(key: string): RunSnapshot | undefined {
    return readJson(statePath(this.baseDir, key));
  }

  listKeys(): string[] {
    if (!existsSync(this.baseDir)) return [];
    const keys: string[] = [];
    for (const name of readdirSync(this.baseDir)) {
      const snapshot = readJson<RunSnapshot>(path.join(this.baseDir, name, 'state.json'));
      if (snapshot?.key) keys.push(snapshot.key);
    }
    return keys;
  }
}

function writeJsonAtomically(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), 'utf8');
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
