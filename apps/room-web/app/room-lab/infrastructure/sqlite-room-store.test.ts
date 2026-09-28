import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { RoomId } from '@rivus/agent-room';
import { SqliteRoomStore } from './sqlite-room-store.server';
import { RoomLabHost } from '../application/room-lab-host.server';
import { DEFAULT_AGENT_SYSTEM_PROMPT } from './migrations/0003_agent_system_prompt.seed';

const TENANT = 'local';

/** Every row answers its probe ready, so the tests never start an ACP process. */
const probeReadyBinding = {
  probe: () => Promise.resolve({ status: 'ready' as const, capabilities: {} }),
};

function roomIdOf(id: string): RoomId {
  return { tenantId: TENANT, conversationId: id };
}

/** Admits one human message the way the route does, without a live turn. */
async function admitHuman(store: SqliteRoomStore, roomId: string, messageId: string, body: string) {
  const stream = store.stream(roomId);
  return stream.admit({
    roomId: roomIdOf(roomId),
    messageId,
    author: { kind: 'human', id: 'director' },
    kind: 'human',
    body,
    addressedTo: [],
  });
}

describe('sqlite Room persistence', () => {
  it('keeps rooms and messages after a new host is opened', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rivus-room-web-'));
    const store = SqliteRoomStore.open(root);
    const host = new RoomLabHost(store, probeReadyBinding);
    const created = await host.create({ title: 'Q3 定价方案', memberIds: ['codex'] });
    await admitHuman(store, created.roomId, 'web:persist-1', '先比较三档价格');

    const restored = new RoomLabHost(SqliteRoomStore.open(root), probeReadyBinding);
    const snapshot = await restored.snapshot(created.roomId);
    expect(snapshot.title).toBe('Q3 定价方案');
    expect(snapshot.events[0]).toMatchObject({
      body: '先比较三档价格',
      messageId: 'web:persist-1',
    });
    expect(snapshot.catalog.map(room => room.title)).toEqual(['Q3 定价方案']);
    expect(snapshot.settings).toEqual({ wake: 'broadcast', serial: false });
    expect(existsSync(join(root, 'rooms.sqlite'))).toBe(true);
  });

  it('keeps a room\'s wake, serial and cwd settings across a reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rivus-room-web-'));
    const host = new RoomLabHost(SqliteRoomStore.open(root), probeReadyBinding);
    const created = await host.create({ title: '串行房', memberIds: ['codex'] });
    host.act(created.roomId, { action: 'settings', wake: 'addressed', serial: true, cwd: '/tmp/room-work' });

    const reopened = new RoomLabHost(SqliteRoomStore.open(root), probeReadyBinding);
    const snapshot = await reopened.snapshot(created.roomId);
    expect(snapshot.settings).toEqual({ wake: 'addressed', serial: true, cwd: '/tmp/room-work' });

    // An empty cwd field clears the room's own directory again.
    await reopened.act(created.roomId, { action: 'settings', cwd: '' });
    expect((await reopened.snapshot(created.roomId)).settings.cwd).toBeUndefined();
  });

  it('keeps catalog order by creation time after a later room is opened', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rivus-room-web-'));
    const host = new RoomLabHost(SqliteRoomStore.open(root), probeReadyBinding);
    const first = await host.create({ title: 'Q3 定价方案', memberIds: ['codex'] });
    const second = await host.create({ title: 'README 改写', memberIds: ['codex'] });
    const snapshot = await host.snapshot(first.roomId);
    expect(host.list().map(room => room.id)).toEqual([first.roomId, second.roomId]);
    expect(snapshot.catalog.map(room => room.title)).toEqual(['Q3 定价方案', 'README 改写']);
  });

  it('does not rewrite lastOpened when snapshotting the same room', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rivus-room-web-'));
    const host = new RoomLabHost(SqliteRoomStore.open(root), probeReadyBinding);
    const created = await host.create({ title: '同一房间', memberIds: ['codex'] });
    const first = host.lastOpened()?.lastOpenedAt;
    await host.snapshot(created.roomId);
    expect(host.lastOpened()?.lastOpenedAt).toBe(first);
  });

  it('persists a system prompt and carries it onto the next turn\'s harness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rivus-room-web-'));
    const store = SqliteRoomStore.open(root);
    const host = new RoomLabHost(store, probeReadyBinding);
    const created = await host.create({ title: 'Q3 定价方案', memberIds: ['codex'] });
    host.saveSystemPrompt('codex', '  SENTINEL_SYS_PROMPT  ');
    const restored = new RoomLabHost(SqliteRoomStore.open(root), probeReadyBinding);
    expect(restored.agents.get('codex')?.systemPrompt).toBe('SENTINEL_SYS_PROMPT');
    restored.saveSystemPrompt('codex', '   ');
    // The row stays; it just carries nothing to prepend.
    expect(restored.agents.get('codex')?.systemPrompt).toBe('');

    // The prompt is the member's own metadata: the harness takes it onto the
    // native channel, and an empty row leaves the slot unset.
    restored.saveSystemPrompt('codex', 'SENTINEL_SYS_PROMPT');
    await admitHuman(store, created.roomId, 'web:sys-1', '比较三档价格');
    const workHome = mkdtempSync(join(tmpdir(), 'rivus-room-work-'));
    process.env.RIVUS_ROOM_HOME = workHome;
    try {
      const harness = await restored.open(created.roomId).activate('codex');
      expect(harness.systemPrompt).toBe('SENTINEL_SYS_PROMPT');
    } finally {
      delete process.env.RIVUS_ROOM_HOME;
    }
    expect(DEFAULT_AGENT_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it('re-reads the agents table when the desk is rescanned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rivus-room-web-'));
    const host = new RoomLabHost(SqliteRoomStore.open(root), probeReadyBinding);
    expect(host.agents.get('claude')?.command).toBe('claude-agent-acp');

    // Someone edits the row with sqlite3 while the server is running: a second
    // connection to the same file, not this host's own.
    const editor = new DatabaseSync(join(root, 'rooms.sqlite'));
    editor.prepare('UPDATE agents SET command = ?, label = ? WHERE id = ?')
      .run('claude-agent-acp --other', 'Claude 2', 'claude');
    editor.close();
    expect(host.agents.get('claude')?.command).toBe('claude-agent-acp');

    const inventory = await host.refreshInventory();

    expect(host.agents.get('claude')?.command).toBe('claude-agent-acp --other');
    expect(inventory.find(agent => agent.id === 'claude')).toMatchObject({
      label: 'Claude 2',
      command: 'claude-agent-acp --other',
    });
  });

  it('reads an added row on the next scan and seats it like any other', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rivus-room-web-'));
    const store = SqliteRoomStore.open(root);
    const host = new RoomLabHost(store, probeReadyBinding);
    await host.addAgent({ id: 'gemini', label: 'Gemini', role: '调研', command: 'gemini-acp' });

    // The new row is the next seat at the end of the desk, on a drawn hue.
    expect(host.agents.get('gemini')).toMatchObject({ role: '调研', command: 'gemini-acp' });
    const added = store.db.prepare('SELECT color, position, system_prompt FROM agents WHERE id = ?')
      .get('gemini') as unknown as { color: number; position: number; system_prompt: string };
    expect(added.color).toBeGreaterThanOrEqual(1);
    expect(added.color).toBeLessThanOrEqual(5);
    expect(added.position).toBe(3);
    expect(added.system_prompt).toBe('');

    const desk = await host.agentDesk();
    expect(desk.agents.find(agent => agent.id === 'gemini')).toMatchObject({
      label: 'Gemini',
      availability: 'ready',
      command: 'gemini-acp',
    });
  });

  it('refuses an add-agent row whose id is off the mention grammar or already seated', async () => {
    const host = new RoomLabHost(SqliteRoomStore.open(mkdtempSync(join(tmpdir(), 'rivus-room-web-'))), probeReadyBinding);
    await expect(host.addAgent({ id: 'Gemini', label: 'x', command: 'gemini-acp' }))
      .rejects.toThrow(/must match/);
    await expect(host.addAgent({ id: '1gemini', label: 'x', command: 'gemini-acp' }))
      .rejects.toThrow(/must match/);
    await expect(host.addAgent({ id: 'gemini_x', label: 'x', command: 'gemini-acp' }))
      .rejects.toThrow(/must match/);
    await expect(host.addAgent({ id: 'claude', label: 'x', command: 'gemini-acp' }))
      .rejects.toThrow(/already exists/);
    await expect(host.addAgent({ id: 'gemini', label: ' ', command: 'gemini-acp' }))
      .rejects.toThrow(/needs a label/);
    await expect(host.addAgent({ id: 'gemini', label: 'Gemini', command: ' ' }))
      .rejects.toThrow(/needs a command/);
  });

  it('lists which rooms an agent is seated in', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rivus-room-web-'));
    const host = new RoomLabHost(SqliteRoomStore.open(root), probeReadyBinding);
    const created = await host.create({ title: 'Q3 定价方案', memberIds: ['codex'] });
    const desk = await host.agentDesk();
    expect(desk.agents.find(agent => agent.id === 'codex')?.seatedIn).toEqual([
      { id: created.roomId, title: 'Q3 定价方案' },
    ]);
    expect(desk.agents.find(agent => agent.id === 'claude')?.seatedIn).toEqual([]);
    // A ready probe plus a seat is 已入座, not 可入座.
    expect(desk.agents.find(agent => agent.id === 'codex')?.availability).toBe('seated');
    expect(desk.agents.find(agent => agent.id === 'claude')?.availability).toBe('ready');
  });

  it('keeps a room\'s stored crew when one of its agents has no row', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rivus-room-web-'));
    const host = new RoomLabHost(SqliteRoomStore.open(root), probeReadyBinding);
    const crew = await host.create({ title: '两人房', memberIds: ['codex', 'claude'] });
    const other = await host.create({ title: '另一间', memberIds: ['codex'] });

    // A row removed outside this process: `room_members` has no foreign key to
    // `agents`, so the seating is left behind and only the catalog filters it.
    const db = new DatabaseSync(join(root, 'rooms.sqlite'));
    db.prepare('DELETE FROM agents WHERE id = ?').run('claude');
    db.close();

    // Switching rooms is enough to write the catalog back. `other` was created
    // last, so it is already the last opened; opening `crew` is the switch.
    const reopened = new RoomLabHost(SqliteRoomStore.open(root), probeReadyBinding);
    expect(reopened.lastOpened()?.id).toBe(other.roomId);
    await reopened.snapshot(crew.roomId);

    const check = new DatabaseSync(join(root, 'rooms.sqlite'));
    const seated = check.prepare(
      'SELECT agent_id FROM room_members WHERE room_id = ? ORDER BY seat_order',
    ).all(crew.roomId) as unknown as { agent_id: string }[];
    check.close();

    expect(seated.map(row => row.agent_id)).toEqual(['codex', 'claude']);
  });

  it('seats a room again once the missing agent row comes back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rivus-room-web-'));
    const host = new RoomLabHost(SqliteRoomStore.open(root), probeReadyBinding);
    const crew = await host.create({ title: '两人房', memberIds: ['codex', 'claude'] });

    const db = new DatabaseSync(join(root, 'rooms.sqlite'));
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get('claude') as unknown as Record<string, unknown>;
    db.prepare('DELETE FROM agents WHERE id = ?').run('claude');
    db.close();

    const without = new RoomLabHost(SqliteRoomStore.open(root), probeReadyBinding);
    expect((await without.snapshot(crew.roomId)).activeAgentIds).toEqual(['codex']);

    const restore = new DatabaseSync(join(root, 'rooms.sqlite'));
    restore.prepare(`
      INSERT INTO agents (id, label, role, command, color, position, created_at, system_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id as string, row.label as string, row.role as string, row.command as string,
      row.color as number, row.position as number, row.created_at as string,
      row.system_prompt as string,
    );
    restore.close();

    const back = new RoomLabHost(SqliteRoomStore.open(root), probeReadyBinding);
    expect((await back.snapshot(crew.roomId)).activeAgentIds).toEqual(['codex', 'claude']);
  });

  it('sets connection pragmas when opening a library', () => {
    // Pragmas are per-connection; migration SQL cannot set them, so opening
    // must.
    const store = SqliteRoomStore.open(mkdtempSync(join(tmpdir(), 'rivus-room-web-')));
    expect(store.db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    expect(store.db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
  });

  it('imports a legacy JSON catalog into sqlite once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rivus-room-web-'));
    mkdirSync(join(root, 'rooms', 'r_aaaaaaaaaa'), { recursive: true });
    writeFileSync(join(root, 'catalog.json'), JSON.stringify({
      version: 1,
      rooms: [{
        id: 'r_aaaaaaaaaa',
        title: 'Q3 定价方案',
        createdAt: '2026-09-06T01:00:00.000Z',
        updatedAt: '2026-09-06T01:00:00.000Z',
        lastOpenedAt: '2026-09-06T01:00:00.000Z',
        memberIds: ['codex'],
      }],
      lastOpenedId: 'r_aaaaaaaaaa',
    }));
    writeFileSync(join(root, 'rooms', 'r_aaaaaaaaaa', 'events.json'), JSON.stringify([{
      seq: 1,
      roomId: { tenantId: 'local', conversationId: 'r_aaaaaaaaaa' },
      messageId: 'legacy:1',
      author: { kind: 'human', id: 'director' },
      kind: 'human',
      body: '旧文件里的一句',
      origin: 'endpoint',
      addressedTo: [],
      at: '2026-09-06T01:01:00.000Z',
    }]));
    // A legacy directory's workspace.json is not imported: every field it held
    // moved elsewhere or went with the count-off (RFC 0015 Storage).
    writeFileSync(join(root, 'rooms', 'r_aaaaaaaaaa', 'workspace.json'), JSON.stringify({
      countOff: { runId: 'COUNT-001', status: 'completed' },
    }));
    const store = SqliteRoomStore.open(root);
    const host = new RoomLabHost(store, probeReadyBinding);
    const snapshot = await host.snapshot('r_aaaaaaaaaa');
    expect(snapshot.title).toBe('Q3 定价方案');
    expect(snapshot.events[0]).toMatchObject({ body: '旧文件里的一句', messageId: 'legacy:1' });
    // An event from before depth existed stands at 0, the human round opener.
    const slice = await store.stream('r_aaaaaaaaaa').readSlice(roomIdOf('r_aaaaaaaaaa'), 0, { maxEvents: 10 });
    expect(slice.events[0]?.wakeDepth).toBe(0);
    expect('countOff' in snapshot).toBe(false);
  });
});
