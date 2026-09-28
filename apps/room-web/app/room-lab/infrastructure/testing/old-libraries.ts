import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, runMigrations } from '../migrations';

/**
 * A library at version 1: the first migration applied and recorded, nothing
 * else. Built by running that migration, which is the version-1 DDL itself.
 */
export function createVersionOneLibrary(
  root: string,
  fill: (db: DatabaseSync) => void = () => {},
): string {
  const file = join(root, 'rooms.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  MIGRATIONS[0]!.up(db);
  db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)')
    .run('2026-09-14T19:27:31.456Z');
  fill(db);
  db.close();
  return file;
}

/**
 * A library at version 2: members are rows but their instructions still live
 * in a separate table. The same runner, stopped after version 2.
 */
export function createVersionTwoLibrary(
  root: string,
  fill: (db: DatabaseSync) => void = () => {},
): string {
  const file = join(root, 'rooms.sqlite');
  const db = new DatabaseSync(file);
  runMigrations(db, { migrations: MIGRATIONS.filter(migration => migration.version <= 2) });
  fill(db);
  db.close();
  return file;
}

/**
 * A library at version 3: prompts are columns, and nothing RFC 0015 added yet.
 * This is the shape every library this project shipped before the control
 * plane — the state the migration tests stand in for the real
 * `rooms.sqlite` on a machine that has one.
 */
export function createVersionThreeLibrary(
  root: string,
  fill: (db: DatabaseSync) => void = () => {},
): string {
  const file = join(root, 'rooms.sqlite');
  const db = new DatabaseSync(file);
  runMigrations(db, { migrations: MIGRATIONS.filter(migration => migration.version <= 3) });
  fill(db);
  db.close();
  return file;
}
