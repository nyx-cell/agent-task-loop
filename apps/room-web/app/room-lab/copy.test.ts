import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copy } from './copy';

/**
 * The grammar of each copy group, kept mechanical so a colloquial status word
 * ("说完了") or a sentence in a label cannot come back unnoticed.
 */
const strings = (group: Record<string, unknown>) =>
  Object.entries(group).map(([key, value]) => [key, typeof value === 'function'
    ? (value as (...args: never[]) => string)(...(['codex', 2] as never[]))
    : String(value)] as const);

describe('copy grammar', () => {
  it('status words are short noun phrases with no punctuation or spoken particles', () => {
    for (const [key, text] of strings(copy.status)) {
      expect(text.length, key).toBeLessThanOrEqual(5);
      expect(text, key).not.toMatch(/[。，！？…、]/);
      expect(text, key).not.toMatch(/[了没吗吧呢啦]/);
    }
  });

  it('status words share the shapes 已X · 未X · X中 · 待X · X失败, or are a bare state', () => {
    const shapes = /^(已.+|未.+|.+中|.*待.+|.+失败|失败|超时|在场|等待)$/;
    for (const [key, text] of strings(copy.status)) expect(text, key).toMatch(shapes);
  });

  it('actions are short verb phrases without sentence punctuation', () => {
    for (const [key, text] of strings(copy.action)) {
      expect(text.length, key).toBeLessThanOrEqual(12);
      expect(text, key).not.toMatch(/[。！？]/);
    }
  });

  it('labels never end in a full stop', () => {
    for (const [key, text] of strings(copy.label)) expect(text, key).not.toMatch(/。$/);
  });

  it('explanations that end in 。 are complete sentences, and spoken particles stay out of all groups', () => {
    for (const [key, text] of strings(copy.say)) {
      if (text.endsWith('。')) expect(text.length, key).toBeGreaterThan(6);
      expect(text, key).not.toMatch(/(说完了|没跑起来|答上了|没答上|叫到|先停下)/);
    }
  });

  it('labels keyed by a domain state cover every state', () => {
    for (const [key, text] of strings(copy.availability)) expect(text, key).not.toMatch(/。$/);
  });

  it('the two ends of one turn do not read the same word', () => {
    expect(copy.status.posted).not.toBe(copy.status.passed);
  });
});

/**
 * Agent rows and the seeded system prompt are Chinese too, but they are data a
 * person can edit in the desk or in sqlite, not words this app chose.
 */
const DATA_NOT_COPY = ['infrastructure/agent-seed.server.ts', 'infrastructure/migrations'];

const sources = (dir: string, found: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (DATA_NOT_COPY.some(skip => path.includes(skip))) continue;
    if (entry.isDirectory()) sources(path, found);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.|copy\.ts$|\/testing\//.test(path)) found.push(path);
  }
  return found;
};

/** Comments carry Chinese on purpose; only what ships to a screen counts. */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('copy lives in one place', () => {
  it('no Chinese literal on the room surface outside this dictionary', () => {
    const strays: string[] = [];
    // The board and task routes are a separate, unlinked surface with copy of
    // their own; this dictionary covers the room.
    const roomRoutes = sources('app/routes').filter(file => file.includes('/room'));
    for (const file of [...sources('app/room-lab'), 'app/root.tsx', ...roomRoutes]) {
      withoutComments(readFileSync(file, 'utf8')).split('\n').forEach((line, index) => {
        if (/[一-鿿]/.test(line)) strays.push(`${file}:${index + 1} ${line.trim()}`);
      });
    }
    expect(strays).toEqual([]);
  });
});
