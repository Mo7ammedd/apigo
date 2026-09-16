import type Database from 'better-sqlite3';
import { ApigoError } from '../core/errors.js';

const migrations = [
  `CREATE TABLE apis (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, definition TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE collections (
    api_id TEXT NOT NULL REFERENCES apis(id) ON DELETE CASCADE,
    name TEXT NOT NULL, label TEXT NOT NULL, operations TEXT NOT NULL,
    PRIMARY KEY (api_id, name)
  );
  CREATE TABLE environments (name TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE credentials (scope TEXT NOT NULL, scheme TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (scope, scheme));
  CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `ALTER TABLE apis ADD COLUMN previous TEXT;
  ALTER TABLE apis ADD COLUMN last_diff TEXT;
  CREATE TABLE saved_requests (name TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE history (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, method TEXT NOT NULL, operation TEXT,
    api_id TEXT, status INTEGER, duration REAL, payload TEXT NOT NULL
  );
  CREATE INDEX history_time ON history(created_at DESC);`,
];

export function migrate(database: Database.Database): void {
  database.transaction(() => {
    const current = database.pragma('user_version', { simple: true }) as number;
    if (current > migrations.length) throw new ApigoError('NEWER_DATABASE', 'This database was created by a newer version of apigo.', 2, 'Upgrade apigo before using it.');
    for (let index = current; index < migrations.length; index++) {
      database.exec(migrations[index]!);
      database.pragma(`user_version = ${index + 1}`);
    }
  })();
}
