import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from '../src/contracts/harness';
import { claudeProfile, codexProfile, fallbackProfile, opencodeProfile } from '../src/infrastructure/profiles';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function harness(overrides: Partial<Harness> = {}): Harness {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'profile-harness-'));
  dirs.push(cwd);
  return {
    cwd,
    systemPrompt: 'You are @codex, member 2 of 3.',
    blocks: [{ type: 'text', text: '[seq 7] @claude: hello' }],
    tools: [],
    permissions: () => ({ outcome: 'cancelled' }),
    ...overrides,
  };
}

describe('claude profile', () => {
  it('puts the system prompt in _meta.systemPrompt and nothing in the blocks', () => {
    const profile = claudeProfile();
    const turn = harness();
    const request = profile.newSession(turn);

    expect(request.meta).toEqual({
      systemPrompt: turn.systemPrompt,
      claudeCode: { options: {} },
    });
    expect(profile.promptBlocks(turn)).toEqual(turn.blocks);
  });

  it('forwards claudeCode options and skips the system prompt when absent', () => {
    const profile = claudeProfile({ claudeCodeOptions: { disallowedTools: ['WebSearch'] } });
    const turn = harness({ systemPrompt: undefined });
    const request = profile.newSession(turn);
    expect(request.meta).toEqual({ claudeCode: { options: { disallowedTools: ['WebSearch'] } } });
  });
});

describe('fallback profiles', () => {
  it('codex and opencode put the system prompt in block 0', () => {
    for (const profile of [codexProfile(), opencodeProfile()]) {
      const turn = harness();
      const blocks = profile.promptBlocks(turn);
      expect(blocks[0]).toEqual({ type: 'text', text: turn.systemPrompt });
      expect(blocks.slice(1)).toEqual(turn.blocks);
      expect(profile.newSession(turn).meta).toBeUndefined();
    }
  });

  it('fallbackProfile leaves the blocks untouched without a system prompt', () => {
    const profile = fallbackProfile('unknown-agent');
    const turn = harness({ systemPrompt: undefined });
    expect(profile.promptBlocks(turn)).toEqual(turn.blocks);
  });
});

describe('workspaceFiles', () => {
  it('each profile drops the files into cwd before the session opens', () => {
    for (const profile of [claudeProfile(), codexProfile(), opencodeProfile(), fallbackProfile('x')]) {
      const turn = harness({
        workspaceFiles: { 'AGENTS.md': 'be brief', '.claude/settings.json': '{"a":1}' },
      });
      profile.prepareWorkspace?.(turn);
      expect(readFileSync(path.join(turn.cwd, 'AGENTS.md'), 'utf8')).toBe('be brief');
      expect(readFileSync(path.join(turn.cwd, '.claude/settings.json'), 'utf8')).toBe('{"a":1}');
    }
  });
});
