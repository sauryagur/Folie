import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pgliteDatabase } from "../../src/server/pglite-db";
import { migrate } from "../../src/server/schema";

describe("file-backed PGlite", () => {
  let dir: string;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("keeps migrated rows across close, reopen, and remigrate", async () => {
    dir = await mkdtemp(join(tmpdir(), "folie-pglite-gate-"));
    const tag = `gate-${Date.now()}`;
    const db1 = await pgliteDatabase(dir);
    await migrate(db1);
    const writes = Array.from({ length: 5 }, (_, i) =>
      db1.query(
        "INSERT INTO work_items (goal, state) VALUES ($1, 'queued') RETURNING id",
        [`${tag}-${i}`],
      ),
    );
    await Promise.all(writes);
    const { rows: seeded } = await db1.query(
      "SELECT id, goal FROM work_items WHERE goal LIKE $1 ORDER BY id",
      [`${tag}-%`],
    );
    expect(seeded).toHaveLength(5);
    await db1.close();

    const db2 = await pgliteDatabase(dir);
    await migrate(db2);
    const { rows: reopened } = await db2.query(
      "SELECT id, goal FROM work_items WHERE goal LIKE $1 ORDER BY id",
      [`${tag}-%`],
    );
    expect(reopened).toEqual(seeded);
    await db2.close();
  });
});
