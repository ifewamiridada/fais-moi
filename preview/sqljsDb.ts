import initSqlJs from 'sql.js';
import wasmBinary from 'sql.js/dist/sql-wasm.wasm';
import type { Bind, Db } from '../src/db/types';

/** expo-sqlite's async API over sql.js (SQLite compiled to WebAssembly), in memory. */
export async function openBrowserDb(): Promise<Db> {
  const SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  const db = new SQL.Database();
  const all = <T>(sql: string, params: Bind[]): T[] => {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      return rows;
    } finally {
      stmt.free();
    }
  };
  return {
    async execAsync(sql) {
      db.exec(sql);
    },
    async runAsync(sql, params) {
      db.run(sql, params);
      const changes = db.getRowsModified();
      const id = db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0];
      return { lastInsertRowId: Number(id ?? 0), changes };
    },
    async getFirstAsync<T>(sql: string, params: Bind[]) {
      return all<T>(sql, params)[0] ?? null;
    },
    async getAllAsync<T>(sql: string, params: Bind[]) {
      return all<T>(sql, params);
    },
    async withTransactionAsync(task) {
      db.exec('BEGIN');
      try {
        await task();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
