import { DatabaseSync } from 'node:sqlite';
import type { Bind, Db } from '../types';

/** expo-sqlite's async API over Node's built-in SQLite, so repositories run in tests unchanged. */
export function openNodeDb(path = ':memory:'): Db & { close(): void } {
  const sqlite = new DatabaseSync(path);
  let inTransaction = false;
  return {
    async execAsync(sql) {
      sqlite.exec(sql);
    },
    async runAsync(sql, params: Bind[] = []) {
      const r = sqlite.prepare(sql).run(...params);
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    async getFirstAsync<T>(sql: string, params: Bind[] = []) {
      return (sqlite.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async getAllAsync<T>(sql: string, params: Bind[] = []) {
      return sqlite.prepare(sql).all(...params) as T[];
    },
    async withTransactionAsync(task) {
      // expo-sqlite doesn't nest transactions either; fail loudly if a repository tries.
      if (inTransaction) throw new Error('nested transaction');
      inTransaction = true;
      sqlite.exec('BEGIN');
      try {
        await task();
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      } finally {
        inTransaction = false;
      }
    },
    close: () => sqlite.close(),
  };
}
