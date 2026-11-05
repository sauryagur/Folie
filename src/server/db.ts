// Narrow database port. pg.Pool satisfies it in production, PGlite in tests.
import pg from "pg";

export type Row = Record<string, unknown>;

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function pgDatabase(connectionString: string): Database {
  const pool = new pg.Pool({ connectionString });
  return {
    query: (text, params) => pool.query(text, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({
          query: (text, params) => client.query(text, params),
        });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
