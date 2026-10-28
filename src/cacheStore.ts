/** A disposable read cache. Drafts and unconfirmed writes stay in their existing durable stores. */
export interface CacheDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: (string | number)[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...params: (string | number)[]): Promise<T | null>;
}

export async function initializeCache(db: CacheDatabase) {
  await db.execAsync(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS snapshots (
      scope TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, revision INTEGER NOT NULL, epoch TEXT NOT NULL,
      PRIMARY KEY (scope, name)
    );`);
}

export async function readSnapshot<T>(db: CacheDatabase, scope: string, name: string): Promise<T | null> {
  const row = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM snapshots WHERE scope = ? AND name = ?", scope, name,
  );
  if (!row) return null;
  try { return JSON.parse(row.value) as T; } catch { return null; }
}

export async function writeSnapshot(db: CacheDatabase, scope: string, name: string, value: unknown, revision: number, epoch: string) {
  // A slow response from an earlier request must not replace a newer snapshot.
  const json = JSON.stringify(value);
  await db.runAsync(`INSERT INTO snapshots (scope, name, value, revision, epoch) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(scope, name) DO UPDATE SET value = excluded.value, revision = excluded.revision, epoch = excluded.epoch
    WHERE excluded.epoch != snapshots.epoch OR excluded.revision >= snapshots.revision`, scope, name, json, revision, epoch);
}
