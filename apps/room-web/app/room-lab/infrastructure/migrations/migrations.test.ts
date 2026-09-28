import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrationName, runMigrations } from './index';
import {
  createVersionOneLibrary,
  createVersionThreeLibrary,
  createVersionTwoLibrary,
} from '../testing/old-libraries';
import { DEFAULT_AGENT_SYSTEM_PROMPT } from './0003_agent_system_prompt.seed';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'rivus-room-migrations-'));
}

function tables(db: DatabaseSync): string[] {
  return (db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `).all() as unknown as Array<{ name: string }>).map(row => row.name);
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>)
    .map(row => row.name);
}

function versions(db: DatabaseSync): number[] {
  return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as unknown as Array<{ version: number }>)
    .map(row => Number(row.version));
}

describe('runMigrations', () => {
  it('applies every version to a fresh library, in order', () => {
    const db = new DatabaseSync(':memory:');

    expect(runMigrations(db)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6]);
    // agent_system_prompts is created by version 1 and retired by version 3,
    // so a library that runs the whole chain never ends up holding it.
    expect(tables(db)).toEqual([
      'agent_sessions',
      'agents',
      'app_meta',
      'member_leases',
      'room_events',
      'room_members',
      'room_workspace',
      'rooms',
      'schema_migrations',
      'turns',
    ]);
    expect(MIGRATIONS.map(migrationName)).toEqual([
      '0001_rooms',
      '0002_agents',
      '0003_agent_system_prompt',
      '0004_wake_depth',
      '0005_room_settings',
      '0006_control_plane',
    ]);
  });

  it('upgrades a version-1 library by running only what it is missing', () => {
    // A library from before members were rows: every version-1 table exists,
    // one room seats an agent this project does not ship.
    const file = createVersionOneLibrary(root(), db => {
      db.exec(`
        INSERT INTO rooms (id, title, goal, created_at, updated_at, last_opened_at)
        VALUES ('r_aaaaaaaaaa', '旧房间', NULL, '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z');
        INSERT INTO room_members (room_id, agent_id, seat_order)
        VALUES ('r_aaaaaaaaaa', 'inherited-one', 0);
      `);
    });
    const db = new DatabaseSync(file);
    expect(versions(db)).toEqual([1]);

    // Version 1 is not re-run — its CREATE TABLE would fail against the tables
    // that are already there, which is the whole point of recording versions.
    expect(runMigrations(db)).toEqual([2, 3, 4, 5, 6]);

    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(tables(db)).toContain('agents');
    const seeded = db.prepare('SELECT id, role FROM agents ORDER BY position').all() as unknown as Array<{ id: string; role: string }>;
    expect(seeded.map(row => row.id)).toEqual(['claude', 'codex', 'opencode', 'dsh', 'inherited-one']);
    expect(seeded.at(-1)?.role).toBe('成员');
    // The room it was seated in is untouched.
    expect(db.prepare('SELECT agent_id FROM room_members').all()).toEqual([{ agent_id: 'inherited-one' }]);
  });

  it('upgrades a version-2 library, moving what the old prompt table held', () => {
    // Members are already rows here, but their instructions still live in
    // agent_system_prompts: one member has one, one has whitespace, one has
    // none at all.
    const file = createVersionTwoLibrary(root(), db => {
      db.exec(`
        INSERT INTO agent_system_prompts (agent_id, prompt, updated_at) VALUES
          ('codex', '先给结论，再给依据。', '2026-09-18T00:00:00.000Z'),
          ('dsh', '   ', '2026-09-18T00:00:00.000Z');
      `);
    });
    const db = new DatabaseSync(file);
    expect(versions(db)).toEqual([1, 2]);

    expect(runMigrations(db)).toEqual([3, 4, 5, 6]);

    const rows = db.prepare('SELECT id, system_prompt FROM agents ORDER BY position')
      .all() as unknown as Array<{ id: string; system_prompt: string }>;
    const promptOf = new Map(rows.map(row => [row.id, row.system_prompt]));
    // What was saved is kept, verbatim.
    expect(promptOf.get('codex')).toBe('先给结论，再给依据。');
    // Whitespace was never an instruction, so that row starts from the default.
    expect(promptOf.get('dsh')).toBe(DEFAULT_AGENT_SYSTEM_PROMPT);
    expect(promptOf.get('claude')).toBe(DEFAULT_AGENT_SYSTEM_PROMPT);
    expect([...promptOf.values()].every(prompt => prompt.length > 0)).toBe(true);
    expect(tables(db)).not.toContain('agent_system_prompts');
  });

  it('upgrades a version-2 library whose prompt table is empty', () => {
    const file = createVersionTwoLibrary(root());
    const db = new DatabaseSync(file);

    expect(runMigrations(db)).toEqual([3, 4, 5, 6]);

    const rows = db.prepare('SELECT system_prompt FROM agents').all() as unknown as Array<{ system_prompt: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.system_prompt === DEFAULT_AGENT_SYSTEM_PROMPT)).toBe(true);
    expect(tables(db)).not.toContain('agent_system_prompts');
  });

  it('is a no-op on a library that is already up to date', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    const appliedAt = db.prepare('SELECT applied_at FROM schema_migrations WHERE version = 6').get();
    db.prepare('UPDATE agents SET command = ?, system_prompt = ? WHERE id = ?')
      .run('claude --edited', '只说风险。', 'claude');

    expect(runMigrations(db)).toEqual([]);

    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(db.prepare('SELECT applied_at FROM schema_migrations WHERE version = 6').get()).toEqual(appliedAt);
    // An edited row is not re-seeded, and an edited prompt is not overwritten.
    expect(db.prepare('SELECT command, system_prompt FROM agents WHERE id = ?').get('claude'))
      .toEqual({ command: 'claude --edited', system_prompt: '只说风险。' });
  });

  it('rolls a failing migration back and leaves the library on the last good version', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    // The real runner, one extra version: the transaction is what is under test.
    const migrations = [...MIGRATIONS, {
      version: 7,
      name: 'broken',
      up: (database: DatabaseSync) => {
        database.exec('CREATE TABLE half_applied (id TEXT PRIMARY KEY)');
        database.exec('THIS IS NOT SQL');
      },
    }];

    expect(() => runMigrations(db, { migrations })).toThrow('0007_broken failed and was rolled back');

    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(tables(db)).not.toContain('half_applied');
  });

  it('upgrades a version-3 library — the last shape before RFC 0015 — to the control plane', () => {
    // The fixture standing in for the real library on a machine that has one:
    // a room with an event and a seated member, built by the chain itself and
    // stopped after version 3.
    const file = createVersionThreeLibrary(root(), db => {
      db.exec(`
        INSERT INTO rooms (id, title, goal, created_at, updated_at, last_opened_at)
        VALUES ('r_bbbbbbbbbb', '升级前的房间', NULL, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
        INSERT INTO room_members (room_id, agent_id, seat_order)
        VALUES ('r_bbbbbbbbbb', 'codex', 0);
        INSERT INTO room_events (
          room_id, seq, message_id, author_kind, author_id, kind, body, addressed_to, origin, at
        ) VALUES
          ('r_bbbbbbbbbb', 1, 'legacy:1', 'human', 'director', 'human', '旧库里的一句话', '[]', 'endpoint', '2026-09-20T00:01:00.000Z');
      `);
    });
    const db = new DatabaseSync(file);
    expect(versions(db)).toEqual([1, 2, 3]);

    expect(runMigrations(db)).toEqual([4, 5, 6]);

    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6]);
    // 0004: every event carries a depth, and the ones already stored stand at 0.
    expect(columns(db, 'room_events')).toContain('wake_depth');
    expect(db.prepare('SELECT wake_depth FROM room_events WHERE room_id = ?').get('r_bbbbbbbbbb'))
      .toEqual({ wake_depth: 0 });
    // 0005: the room settings are there with their defaults, and the three
    // private-room columns wait for S6.
    expect(columns(db, 'rooms')).toEqual(expect.arrayContaining([
      'wake', 'serial', 'depth_ceiling', 'round_budget', 'cwd',
      'parent_room_id', 'opened_by', 'opened_at_seq',
    ]));
    expect(db.prepare('SELECT wake, serial, depth_ceiling, round_budget, cwd, parent_room_id, opened_by, opened_at_seq FROM rooms WHERE id = ?')
      .get('r_bbbbbbbbbb'))
      .toEqual({
        wake: 'broadcast',
        serial: 0,
        depth_ceiling: null,
        round_budget: null,
        cwd: null,
        parent_room_id: null,
        opened_by: null,
        opened_at_seq: null,
      });
    // 0005: a member's row can carry a turn timeout, defaulting to none.
    expect(columns(db, 'agents')).toContain('timeout_ms');
    expect(db.prepare('SELECT timeout_ms FROM agents WHERE id = ?').get('codex'))
      .toEqual({ timeout_ms: null });
    // 0006: the control plane's table and the endpoint's turn log, with the index.
    expect(tables(db)).toContain('member_leases');
    expect(tables(db)).toContain('turns');
    expect(columns(db, 'turns')).toEqual(expect.arrayContaining([
      'id', 'room_id', 'agent_id', 'round_seq', 'trigger_seq', 'read_up_to_seq',
      'started_at', 'ended_at', 'outcome', 'posted_seq', 'stop_reason', 'held_count', 'error',
    ]));
    expect(db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'turns_room_started'
    `).all()).toHaveLength(1);
    // Nothing that was already stored moved.
    expect(db.prepare('SELECT title FROM rooms WHERE id = ?').get('r_bbbbbbbbbb'))
      .toEqual({ title: '升级前的房间' });
    expect(db.prepare('SELECT body FROM room_events WHERE room_id = ?').get('r_bbbbbbbbbb'))
      .toEqual({ body: '旧库里的一句话' });
    expect(db.prepare('SELECT agent_id FROM room_members WHERE room_id = ?').get('r_bbbbbbbbbb'))
      .toEqual({ agent_id: 'codex' });
  });

  it('rolls a control-plane migration back mid-way and leaves the library on the last good version', () => {
    // A `turns` table already in the library: 0006 creates `member_leases`,
    // then fails on `CREATE TABLE turns` — the half-way state the transaction
    // has to swallow.
    const file = createVersionThreeLibrary(root(), db => {
      db.exec('CREATE TABLE turns (id TEXT PRIMARY KEY)');
    });
    const db = new DatabaseSync(file);

    expect(() => runMigrations(db)).toThrow('0006_control_plane failed and was rolled back');

    // The versions stop at the last one that fully applied, and the table the
    // failing version did manage to create is gone with it.
    expect(versions(db)).toEqual([1, 2, 3, 4, 5]);
    expect(tables(db)).not.toContain('member_leases');
    // The version before it stays applied, and the stray table is untouched.
    expect(columns(db, 'rooms')).toContain('wake');
    expect(columns(db, 'agents')).toContain('timeout_ms');
    expect(columns(db, 'turns')).toEqual(['id']);

    // Once the conflict is out of the way the same chain finishes the job.
    db.exec('DROP TABLE turns');
    expect(runMigrations(db)).toEqual([6]);
    expect(versions(db)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(tables(db)).toContain('member_leases');
    expect(tables(db)).toContain('turns');
  });
});
