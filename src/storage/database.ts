import { chmodSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { StoragePaths } from '../config/paths.js';
import { ApigoError, errorCode } from '../core/errors.js';
import type { ApiRecord, HistoryEntry, SavedRequest } from '../core/types.js';
import { slug } from '../utils/objects.js';
import { privateFile, Vault } from './vault.js';
import { migrate } from './migrations.js';

interface ApiRow { id: string; name: string; definition: string; previous: string | null; last_diff: string | null; created_at: string; updated_at: string }
interface PayloadRow { payload: string }
export interface Collection { apiId: string; name: string; label: string; operations: string[] }
export interface HistorySummary { id: string; createdAt: string; method: string; operation?: string; status?: number; duration?: number }

export class Store {
  readonly vault: Vault;
  private readonly db: Database.Database;

  constructor(readonly paths: StoragePaths) {
    try {
      this.vault = new Vault(paths);
      privateFile(paths.database);
      this.db = new Database(paths.database);
      chmodSync(paths.database, 0o600);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('secure_delete = ON');
      migrate(this.db);
    } catch (error) {
      if (error instanceof ApigoError) throw error;
      if (error instanceof Error && (error.message.startsWith('Could not locate the bindings file.') || errorCode(error) === 'ERR_DLOPEN_FAILED')) {
        throw new ApigoError('SQLITE_UNAVAILABLE', 'SQLite could not load its native module.', 2,
          'For a global install, run npm rebuild -g better-sqlite3 --allow-scripts=better-sqlite3. For a local project, allow better-sqlite3 in package.json allowScripts and run npm rebuild better-sqlite3.');
      }
      throw new ApigoError('DATABASE_ERROR', 'Could not open local storage.', 2, 'Check directory permissions and available disk space.');
    }
  }

  close(): void { this.db.close(); }

  private guard<T>(work: () => T): T {
    try { return work(); }
    catch (error) { if (error instanceof ApigoError) throw error; throw new ApigoError('DATABASE_ERROR', 'Local storage operation failed.', 2, 'Check disk space and storage permissions.'); }
  }

  private api(row: ApiRow): ApiRecord {
    return { id: row.id, name: row.name, definition: this.vault.open(row.definition, `api:${row.id}`),
      ...(row.previous ? { previous: this.vault.open<ApiRecord['definition']>(row.previous, `previous:${row.id}`) } : {}),
      ...(row.last_diff ? { lastDiff: this.vault.open<ApiRecord['lastDiff']>(row.last_diff, `diff:${row.id}`) } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  listApis(): ApiRecord[] { return this.guard(() => (this.db.prepare('SELECT * FROM apis ORDER BY name').all() as ApiRow[]).map(row => this.api(row))); }
  getApi(nameOrId: string): ApiRecord | undefined {
    return this.guard(() => { const row = this.db.prepare('SELECT * FROM apis WHERE name = ? OR id = ?').get(nameOrId, nameOrId) as ApiRow | undefined; return row ? this.api(row) : undefined; });
  }

  putApi(api: ApiRecord): void {
    this.guard(() => this.db.transaction(() => {
      this.db.prepare(`INSERT INTO apis (id, name, definition, previous, last_diff, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, definition=excluded.definition, previous=excluded.previous, last_diff=excluded.last_diff, updated_at=excluded.updated_at`)
        .run(api.id, api.name, this.vault.seal(api.definition, `api:${api.id}`), api.previous ? this.vault.seal(api.previous, `previous:${api.id}`) : null,
          api.lastDiff ? this.vault.seal(api.lastDiff, `diff:${api.id}`) : null, api.createdAt, api.updatedAt);
      this.db.prepare('DELETE FROM collections WHERE api_id = ?').run(api.id);
      const groups = new Map<string, { label: string; operations: string[] }>();
      for (const operation of api.definition.operations) {
        for (const tag of operation.tags) {
          const name = slug(tag);
          const group = groups.get(name) ?? { label: tag, operations: [] };
          if (!group.operations.includes(operation.key)) group.operations.push(operation.key);
          groups.set(name, group);
        }
      }
      const insert = this.db.prepare('INSERT INTO collections (api_id, name, label, operations) VALUES (?, ?, ?, ?)');
      for (const [name, group] of groups) insert.run(api.id, name, group.label, JSON.stringify(group.operations));
    })());
  }

  removeApi(id: string): void {
    this.guard(() => this.db.transaction(() => { this.db.prepare('DELETE FROM apis WHERE id = ?').run(id); this.db.prepare('DELETE FROM credentials WHERE scope = ?').run(id); })());
  }

  collections(apiId: string): Collection[] {
    return this.guard(() => (this.db.prepare('SELECT * FROM collections WHERE api_id = ? ORDER BY name').all(apiId) as { api_id: string; name: string; label: string; operations: string }[])
      .map(row => ({ apiId: row.api_id, name: row.name, label: row.label, operations: JSON.parse(row.operations) as string[] })));
  }

  config(): Record<string, unknown> {
    return this.guard(() => Object.fromEntries((this.db.prepare('SELECT * FROM config').all() as { key: string; value: string }[]).map(row => [row.key, JSON.parse(row.value)])));
  }
  setConfig(key: string, value: unknown): void { this.guard(() => this.db.prepare('INSERT INTO config VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value))); }
  resetConfig(): void { this.guard(() => this.db.prepare('DELETE FROM config').run()); }

  environmentNames(): string[] { return this.guard(() => (this.db.prepare('SELECT name FROM environments ORDER BY name').all() as { name: string }[]).map(row => row.name)); }
  environment(name: string): Record<string, string> | undefined {
    return this.guard(() => { const row = this.db.prepare('SELECT payload FROM environments WHERE name = ?').get(name) as PayloadRow | undefined; return row ? this.vault.open(row.payload, `env:${name}`) : undefined; });
  }
  putEnvironment(name: string, values: Record<string, string>): void {
    this.guard(() => this.db.prepare('INSERT INTO environments VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at').run(name, this.vault.seal(values, `env:${name}`), new Date().toISOString()));
  }
  removeEnvironment(name: string): void { this.guard(() => this.db.prepare('DELETE FROM environments WHERE name = ?').run(name)); }

  credential<T>(scope: string, scheme: string): T | undefined {
    return this.guard(() => { const row = this.db.prepare('SELECT payload FROM credentials WHERE scope = ? AND scheme = ?').get(scope, scheme) as PayloadRow | undefined; return row ? this.vault.open(row.payload, `auth:${scope}:${scheme}`) : undefined; });
  }
  credentialSchemes(scope: string): string[] { return this.guard(() => (this.db.prepare('SELECT scheme FROM credentials WHERE scope = ? ORDER BY scheme').all(scope) as { scheme: string }[]).map(row => row.scheme)); }
  putCredential(scope: string, scheme: string, value: unknown): void {
    this.guard(() => this.db.prepare('INSERT INTO credentials VALUES (?, ?, ?) ON CONFLICT(scope, scheme) DO UPDATE SET payload=excluded.payload').run(scope, scheme, this.vault.seal(value, `auth:${scope}:${scheme}`)));
  }
  removeCredential(scope: string, scheme?: string): void { this.guard(() => scheme ? this.db.prepare('DELETE FROM credentials WHERE scope = ? AND scheme = ?').run(scope, scheme) : this.db.prepare('DELETE FROM credentials WHERE scope = ?').run(scope)); }

  save(request: SavedRequest): void { this.guard(() => this.db.prepare('INSERT INTO saved_requests VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at').run(request.name, this.vault.seal(request, `saved:${request.name}`), request.createdAt)); }
  saved(name: string): SavedRequest | undefined {
    return this.guard(() => { const row = this.db.prepare('SELECT payload FROM saved_requests WHERE name = ?').get(name) as PayloadRow | undefined; return row ? this.vault.open(row.payload, `saved:${name}`) : undefined; });
  }
  savedNames(): string[] { return this.guard(() => (this.db.prepare('SELECT name FROM saved_requests ORDER BY name').all() as { name: string }[]).map(row => row.name)); }
  removeSaved(name: string): void { this.guard(() => this.db.prepare('DELETE FROM saved_requests WHERE name = ?').run(name)); }

  addHistory(entry: HistoryEntry, limit: number): void {
    if (limit === 0) return;
    this.guard(() => this.db.transaction(() => {
      this.db.prepare('INSERT INTO history VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(entry.id, entry.createdAt, entry.request.method, entry.recipe.operation ?? null,
        entry.recipe.apiId ?? null, entry.response?.status ?? null, entry.response?.timings.totalMs ?? null, this.vault.seal(entry, `history:${entry.id}`));
      this.db.prepare('DELETE FROM history WHERE rowid NOT IN (SELECT rowid FROM history ORDER BY rowid DESC LIMIT ?)').run(limit);
    })());
  }
  history(limit: number): HistorySummary[] {
    return this.guard(() => this.db.prepare('SELECT id, created_at AS createdAt, method, operation, status, duration FROM history ORDER BY rowid DESC LIMIT ?').all(limit) as HistorySummary[]);
  }
  historyEntry(id: string): HistoryEntry | undefined {
    return this.guard(() => {
      const rows = this.db.prepare('SELECT id, payload FROM history WHERE substr(id, 1, ?) = ? ORDER BY rowid DESC LIMIT 2').all(id.length, id) as (PayloadRow & { id: string })[];
      if (rows.length > 1) throw new ApigoError('AMBIGUOUS_HISTORY', 'History ID is ambiguous; use more characters.');
      const row = rows[0];
      return row ? this.vault.open(row.payload, `history:${row.id}`) : undefined;
    });
  }
  clearHistory(): number { return this.guard(() => this.db.prepare('DELETE FROM history').run().changes); }
}
