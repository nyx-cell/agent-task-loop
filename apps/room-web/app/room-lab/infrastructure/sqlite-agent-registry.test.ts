import { describe, expect, it } from 'vitest';
import type { Agent } from '@rivus/agent-orchestration';
import { SqliteAgentRegistry } from './sqlite-agent-registry.server';
import { SqliteRoomStore } from './sqlite-room-store.server';

function agent(input: { id: string; label: string; command: string; systemPrompt?: string; timeoutMs?: number }): Agent {
  return {
    id: input.id,
    label: input.label,
    binding: { command: input.command },
    systemPrompt: input.systemPrompt ?? '',
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  };
}

/** The endpoint's own columns, read straight off the row the port cannot see. */
function endpointColumns(store: SqliteRoomStore, id: string): { role: string; color: number; position: number; created_at: string } {
  const row = store.db.prepare('SELECT role, color, position, created_at FROM agents WHERE id = ?')
    .get(id) as unknown as { role: string; color: number; position: number; created_at: string };
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

describe('SqliteAgentRegistry', () => {
  it('lists the seeded rows as port agents, ordered by position', async () => {
    const registry = new SqliteAgentRegistry(SqliteRoomStore.memory().db);

    const agents = await registry.list();

    expect(agents.map(row => row.id)).toEqual(['claude', 'codex', 'opencode']);
    // The port's shape and nothing else: no role, colour or position on it.
    expect(Object.keys(agents[0]!).sort()).toEqual(['binding', 'id', 'label', 'systemPrompt']);
    expect(agents[0]).toMatchObject({
      id: 'claude',
      label: 'Claude',
      binding: { command: 'claude-agent-acp' },
      systemPrompt: expect.any(String),
    });
  });

  it('gets one agent by id, and undefined for an id with no row', async () => {
    const registry = new SqliteAgentRegistry(SqliteRoomStore.memory().db);

    const codex = await registry.get('codex');
    expect(codex?.id).toBe('codex');
    expect(await registry.get('nobody')).toBeUndefined();
  });

  it('saves over an existing row and leaves the endpoint columns standing', async () => {
    const store = SqliteRoomStore.memory();
    const registry = new SqliteAgentRegistry(store.db);
    const before = endpointColumns(store, 'codex');

    await registry.save(agent({
      id: 'codex',
      label: 'Codex 改',
      command: 'codex-acp',
      systemPrompt: '先给结论。',
      timeoutMs: 600_000,
    }));

    // What the port sees moved…
    const saved = await registry.get('codex');
    expect(saved).toEqual({
      id: 'codex',
      label: 'Codex 改',
      binding: { command: 'codex-acp' },
      systemPrompt: '先给结论。',
      timeoutMs: 600_000,
    });
    // …and what only the endpoint sees did not.
    expect(endpointColumns(store, 'codex')).toEqual(before);
  });

  it('saves a new agent with neutral values for the columns the port cannot see', async () => {
    const store = SqliteRoomStore.memory();
    const registry = new SqliteAgentRegistry(store.db);
    const seated = store.db.prepare('SELECT MAX(position) AS position FROM agents')
      .get() as unknown as { position: number };

    await registry.save(agent({ id: 'gemini', label: 'Gemini', command: 'gemini-acp', systemPrompt: '' }));

    const row = endpointColumns(store, 'gemini');
    expect(row.role).toBe('成员');
    expect(row.color).toBeGreaterThanOrEqual(1);
    expect(row.color).toBeLessThanOrEqual(5);
    expect(row.position).toBe(seated.position + 1);
    expect(row.created_at).toBeTruthy();
    const saved = await registry.get('gemini');
    expect(saved).toEqual({
      id: 'gemini',
      label: 'Gemini',
      binding: { command: 'gemini-acp' },
      systemPrompt: '',
    });
  });

  it('round-trips the timeout through its column, NULL when there is none', async () => {
    const store = SqliteRoomStore.memory();
    const registry = new SqliteAgentRegistry(store.db);

    await registry.save(agent({ id: 'codex', label: 'Codex', command: 'codex-acp', timeoutMs: 300_000 }));
    expect(store.db.prepare('SELECT timeout_ms FROM agents WHERE id = ?').get('codex'))
      .toEqual({ timeout_ms: 300_000 });
    expect((await registry.get('codex'))?.timeoutMs).toBe(300_000);

    await registry.save(agent({ id: 'codex', label: 'Codex', command: 'codex-acp' }));
    expect(store.db.prepare('SELECT timeout_ms FROM agents WHERE id = ?').get('codex'))
      .toEqual({ timeout_ms: null });
    expect((await registry.get('codex'))?.timeoutMs).toBeUndefined();
  });

  it('removes the row, and the id stops resolving', async () => {
    const store = SqliteRoomStore.memory();
    const registry = new SqliteAgentRegistry(store.db);

    await registry.remove('opencode');

    expect(await registry.get('opencode')).toBeUndefined();
    expect((await registry.list()).map(row => row.id)).toEqual(['claude', 'codex']);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM agents').get())
      .toEqual({ n: 2 });
  });
});
