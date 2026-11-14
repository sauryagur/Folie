import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Database, Queryable, Row } from "./db";

type QuerySource = Pick<PGlite, "query" | "exec"> | Pick<Transaction, "query" | "exec">;

const queryOn =
  (source: QuerySource): Queryable["query"] =>
  async (text, params) => {
    // PGlite's query() accepts one statement. Folie's schema migration uses
    // unparameterized multi-statement scripts, so send those through exec().
    if (params === undefined) {
      const results = await source.exec(text);
      return { rows: (results.at(-1)?.rows ?? []) as Row[] };
    }
    return { rows: (await source.query(text, params)).rows as Row[] };
  };

/**
 * Open an embedded PostgreSQL database in a persistent local directory.
 *
 * PGlite is an in-process database, not a PostgreSQL server: keep one owner
 * process per data directory. It is suitable for a single-process local mode,
 * but not for multiple Folie servers sharing a directory, remote database
 * clients, or multi-host/high-availability deployments. Use pgDatabase for
 * those deployments.
 */
export async function pgliteDatabase(dataDir: string): Promise<Database> {
  if (!dataDir.trim()) throw new Error("PGlite data directory must not be empty");

  const path = resolve(dataDir);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const pg = await PGlite.create(path);

  return {
    query: queryOn(pg),
    transaction: (fn) => pg.transaction((tx) => fn({ query: queryOn(tx) })),
    close: () => pg.close(),
  };
}
