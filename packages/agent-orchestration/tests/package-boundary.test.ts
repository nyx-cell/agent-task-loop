import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = path.resolve(import.meta.dirname, '../src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('package boundary', () => {
  it('does not import agent-task-loop, Room, or task/feishu types', () => {
    const banned = [
      '@rivus/agent-task-loop',
      '@rivus/agent-room',
      'TaskRecord',
      '待处理',
      '待复核',
      'ReviewLoop',
      'feishu',
      'RoomStreamStore',
      'replyInSerial',
    ];
    for (const file of walk(srcRoot)) {
      const text = readFileSync(file, 'utf8');
      for (const token of banned) {
        expect(text, `${path.basename(file)} mentions ${token}`).not.toContain(token);
      }
    }
  });

  it('keeps contracts and domain free of Node and execa', () => {
    const banned = ['node:', 'execa', 'process.', 'homedir', 'node:fs', 'node:os'];
    for (const dir of ['contracts', 'domain']) {
      const files = walk(path.join(srcRoot, dir));
      expect(files.length, dir).toBeGreaterThan(0);
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const token of banned) {
          expect(text, `${path.relative(srcRoot, file)} mentions ${token}`).not.toContain(token);
        }
      }
    }
  });

  it('keeps application free of filesystem and execa', () => {
    const dir = path.join(srcRoot, 'application');
    // RFC 0015 S2 commit one empties this directory by moving the task baton
    // to agent-task-loop; commit two refills it with the lease manager, the
    // agent runtime and the tool server.
    if (!existsSync(dir) || walk(dir).length === 0) return;
    const banned = ['node:fs', 'node:os', 'execa', 'homedir'];
    const files = walk(dir);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const token of banned) {
        expect(text, `${path.basename(file)} mentions ${token}`).not.toContain(token);
      }
    }
  });
});
