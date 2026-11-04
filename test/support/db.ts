// Real Postgres semantics in-process (PGlite) behind Folie's Database port.
import { PGlite } from "@electric-sql/pglite";
import type { Database, Row } from "../../src/server/db";
import { pgStore } from "../../src/server/pg-store";
import { migrate } from "../../src/server/schema";
import type { Store } from "../../src/server/store";

type Q = Pick<PGlite, "query" | "exec">;

const queryOn = (q: Q) => async (text: string, params?: unknown[]): Promise<{ rows: Row[] }> => {
  // PGlite's query() takes one statement; the schema script has many and no params, so route it to exec().
  if (!params) return { rows: ((await q.exec(text)).at(-1)?.rows ?? []) as Row[] };
  return { rows: (await q.query(text, params)).rows as Row[] };
};

export async function testDatabase(): Promise<Database> {
  const pg = new PGlite();
  const db: Database = {
    query: queryOn(pg),
    transaction: (fn) => pg.transaction((tx) => fn({ query: queryOn(tx as unknown as Q) })),
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}

export async function testStore(): Promise<{ db: Database; store: Store; reset: () => Promise<void> }> {
  const db = await testDatabase();
  const reset = async () => void (await db.query("TRUNCATE agents, work_items, messages, sessions, reports RESTART IDENTITY CASCADE"));
  return { db, store: pgStore(db), reset };
}
