import { createHash } from 'node:crypto';
import path from 'node:path';

export function safeSegment(id: string): string {
  const readable = id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  const hash = createHash('sha1').update(id).digest('hex').slice(0, 8);
  return `${readable}-${hash}`;
}

export function runDir(baseDir: string, key: string): string {
  return path.join(baseDir, safeSegment(key));
}

export function statePath(baseDir: string, key: string): string {
  return path.join(runDir(baseDir, key), 'state.json');
}
