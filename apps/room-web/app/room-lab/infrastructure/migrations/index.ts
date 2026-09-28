import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { seedAgents } from './0002_agents.seed';
import { adoptSystemPrompts } from './0003_agent_system_prompt.seed';

/**
 * The schema as an ordered list of versions, each applied at most once and
 * recorded in `schema_migrations`. A recorded version is never re-run, which is
 * why the SQL says `CREATE TABLE` rather than `CREATE TABLE IF NOT EXISTS`:
 * each file is a step between two known states, not a description of the end
 * state.
 *
 * Connection settings (`foreign_keys`, `busy_timeout`, `journal_mode`) are not
 * migrations — they are lost with the connection, so they stay with the store.
 */
export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

/**
 * Read at module load, so the SQL is part of the server bundle's own directory
 * rather than something the process has to find at runtime.
 */
const ROOMS_SQL = readFileSync(new URL('./0001_rooms.sql', import.meta.url), 'utf8');
const AGENTS_SQL = readFileSync(new URL('./0002_agents.sql', import.meta.url), 'utf8');
const SYSTEM_PROMPT_SQL = readFileSync(new URL('./0003_agent_system_prompt.sql', import.meta.url), 'utf8');
const WAKE_DEPTH_SQL = readFileSync(new URL('./0004_wake_depth.sql', import.meta.url), 'utf8');
const ROOM_SETTINGS_SQL = readFileSync(new URL('./0005_room_settings.sql', import.meta.url), 'utf8');
const CONTROL_PLANE_SQL = readFileSync(new URL('./0006_control_plane.sql', import.meta.url), 'utf8');

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'rooms',
    up: db => db.exec(ROOMS_SQL),
  },
  {
    version: 2,
    name: 'agents',
    up: db => {
      db.exec(AGENTS_SQL);
      seedAgents(db);
    },
  },
  {
    version: 3,
    name: 'agent_system_prompt',
    up: db => {
      db.exec(SYSTEM_PROMPT_SQL);
      adoptSystemPrompts(db);
    },
  },
  {
    version: 4,
    name: 'wake_depth',
    up: db => db.exec(WAKE_DEPTH_SQL),
  },
  {
    version: 5,
    name: 'room_settings',
    up: db => db.exec(ROOM_SETTINGS_SQL),
  },
  {
    version: 6,
    name: 'control_plane',
    up: db => db.exec(CONTROL_PLANE_SQL),
  },
];

const SCHEMA_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

/**
 * Applies every pending migration in version order, each inside its own
 * transaction: a version is recorded only if its whole `up` committed, so a
 * failure leaves the library on the last version that fully applied rather
 * than half-way into the next one. Returns the versions this call applied,
 * which is empty on an up-to-date library.
 */
export function runMigrations(
  db: DatabaseSync,
  options: {
    /** Defaults to this library's own list; a test may pass its own. */
    migrations?: readonly Migration[];
    now?: () => string;
  } = {},
): number[] {
  const migrations = options.migrations ?? MIGRATIONS;
  const now = options.now ?? (() => new Date().toISOString());
  db.exec(SCHEMA_MIGRATIONS);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as unknown as Array<{ version: number }>)
      .map(row => Number(row.version)),
  );
  const pending = [...migrations]
    .sort((left, right) => left.version - right.version)
    .filter(migration => !applied.has(migration.version));

  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      record.run(migration.version, now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(
        `Room migration ${migrationName(migration)} failed and was rolled back`,
        { cause: error },
      );
    }
  }
  return pending.map(migration => migration.version);
}

export function migrationName(migration: Migration): string {
  return `${String(migration.version).padStart(4, '0')}_${migration.name}`;
}
