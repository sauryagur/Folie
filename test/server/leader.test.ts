import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/server/db";
import { LeaderElection } from "../../src/server/leader";
import { testDatabase } from "../support/db";

let db: Database;
beforeAll(async () => (db = await testDatabase()));
afterAll(() => db.close());

beforeEach(async () => {
  await db.query(
    "UPDATE leader_state SET holder = '', expires_at = now() - interval '1 second'",
  );
});

describe("LeaderElection", () => {
  it("lets a single instance acquire and renew its lease", async () => {
    const a = new LeaderElection(db, "leader-a", 60_000);
    await expect(a.tryAcquire()).resolves.toBe(true);
    await expect(a.tryAcquire()).resolves.toBe(true);
  });

  it("lets exactly one of two instances dispatch", async () => {
    const a = new LeaderElection(db, "leader-a", 30_000);
    const b = new LeaderElection(db, "leader-b", 30_000);
    let dispatches = 0;
    const tick = async (e: LeaderElection) => {
      if (await e.tryAcquire()) dispatches++;
    };
    await tick(a);
    await tick(b);
    expect(dispatches).toBe(1);
  });

  it("lets exactly one of two concurrent contenders dispatch", async () => {
    const a = new LeaderElection(db, "leader-a", 30_000);
    const b = new LeaderElection(db, "leader-b", 30_000);
    let dispatches = 0;
    const tick = async (e: LeaderElection) => {
      if (await e.tryAcquire()) dispatches++;
    };
    await Promise.all([tick(a), tick(b)]);
    expect(dispatches).toBe(1);
  });

  it("hands the lease over after expiry (failover)", async () => {
    const a = new LeaderElection(db, "leader-a", 60_000);
    const b = new LeaderElection(db, "leader-b", 60_000);
    await expect(a.tryAcquire()).resolves.toBe(true);
    await expect(b.tryAcquire()).resolves.toBe(false);
    // Simulate A's TTL lapsing (DB clock owns expiry): a crashed leader frees itself.
    await db.query(
      "UPDATE leader_state SET expires_at = now() - interval '1 second'",
    );
    await expect(b.tryAcquire()).resolves.toBe(true);
  });
});
