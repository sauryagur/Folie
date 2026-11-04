import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/server/db";
import { migrate } from "../../src/server/schema";
import { testDatabase } from "../support/db";

let db: Database;
beforeAll(async () => (db = await testDatabase()));
afterAll(() => db.close());

describe("migrate", () => {
  it("is idempotent and keeps existing data (a restarted server must not wipe the swarm)", async () => {
    await db.query("INSERT INTO agents (name) VALUES ('keep-me')");
    await migrate(db);
    await migrate(db);
    expect((await db.query("SELECT name FROM agents")).rows).toEqual([{ name: "keep-me" }]);
  });

  it("tolerates overlapping callers, as old and new pods do during a rollout", async () => {
    await expect(Promise.all([migrate(db), migrate(db), migrate(db)])).resolves.toBeDefined();
  });
});
