import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export function defaultBaseDir(): string {
  return path.join(os.homedir(), '.agent-orchestration', 'runs');
}

export function safeSegment(id: string): string {
  const readable = id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  const hash = createHash('sha1').update(id).digest('hex').slice(0, 8);
  return `${readable}-${hash}`;
}

export function runDir(baseDir: string, key: string): string {
  return path.join(baseDir, safeSegment(key));
}

export function lockPath(baseDir: string, key: string): string {
  return path.join(runDir(baseDir, key), 'occupy.lock');
}

export function statePath(baseDir: string, key: string): string {
  return path.join(runDir(baseDir, key), 'state.json');
}
