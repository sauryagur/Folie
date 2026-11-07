// Lease sweeper (R-8.4), claim revoke (R-8.3), goal pause (R-7.3).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "../../src/server/errors";
import { SwarmService } from "../../src/server/service";
import type { Store } from "../../src/server/store";
import type { Database } from "../../src/server/db";
import { testStore } from "../support/db";
import { memoryTelemetry } from "../support/otel";

let db: Database;
let store: Store;
let reset: () => Promise<void>;
const mem = memoryTelemetry();
let service: SwarmService;
const op = { kind: "operator", name: "operator" } as const;
const asAgent = (name: string) =>
  ({ kind: "agent", name, generation: 1, executionId: "test-exec" }) as const;

beforeAll(async () => {
  ({ db, store, reset } = await testStore());
  service = new SwarmService(store, mem.telemetry);
});
beforeEach(() => reset());
afterAll(() => db.close());

const setupTask = async () => {
  await service.registerAgent("a");
  const { workItem } = await service.submitGoal({ goal: "g", to: "a" }, op);
  const t = await service.proposeTask(
    { agent: "a", workItemId: workItem.id, title: "sub", spec: {} },
    asAgent("a"),
  );
  const c = await service.claimTask({ agent: "a", taskId: t.id }, asAgent("a"));
  return { workItem, task: t, claim: c };
};

describe("lease sweeper, revoke and goal pause", () => {
  it("sweep reclaims an expired lease with a fence bump; stale submit is rejected", async () => {
    const { workItem, task, claim } = await setupTask();
    expect(claim.fence).toBe(1);

    // Force the lease into the past (claimTask mints a 30s lease).
    await db.query(
      "UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE id=$1",
      [task.id],
    );

    const out = await service.sweepLeases(100, op);
    expect(out.reclaimed).toBe(1);

    const reclaimed = await store.tasks.get(task.id);
    expect(reclaimed?.status).toBe("available");
    expect(reclaimed?.owner).toBeNull();
    expect(reclaimed?.fence).toBe(2);

    // Stale owner write with the pre-sweep fence is rejected.
    await expect(
      service.submitTask(
        { agent: "a", taskId: task.id, fence: claim.fence, result: {} },
        asAgent("a"),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    // The active claim row was ended as expired.
    const claimRows = await db.query(
      "SELECT state FROM task_claims WHERE task_id=$1",
      [task.id],
    );
    expect(claimRows.rows[0]).toMatchObject({ state: "expired" });

    // Ledger recorded the reclaim in the same tx.
    const events = await db.query(
      "SELECT type FROM events WHERE type='task.reclaimed'",
    );
    expect(events.rows.length).toBe(1);
    expect(workItem.id).toBeGreaterThan(0);
  });

  it("revoke bumps the fence and rejects the stale owner", async () => {
    const { task, claim } = await setupTask();
    await service.startTask(
      { agent: "a", taskId: task.id, fence: claim.fence },
      asAgent("a"),
    );

    const revoked = await service.revokeClaim(task.id, op);
    expect(revoked.status).toBe("available");
    expect(revoked.owner).toBeNull();
    expect(revoked.fence).toBe(2);

    // Stale fence can no longer submit.
    await expect(
      service.submitTask(
        { agent: "a", taskId: task.id, fence: claim.fence, result: {} },
        asAgent("a"),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    const claimRows = await db.query(
      "SELECT state FROM task_claims WHERE task_id=$1",
      [task.id],
    );
    expect(claimRows.rows[0]).toMatchObject({ state: "revoked" });

    // A fresh claim takes it with a higher fence.
    const again = await service.claimTask(
      { agent: "a", taskId: task.id },
      asAgent("a"),
    );
    expect(again.fence).toBe(3);
  });

  it("pause blocks new claims; resume re-allows them", async () => {
    await service.registerAgent("a");
    const { workItem } = await service.submitGoal({ goal: "g", to: "a" }, op);
    const t = await service.proposeTask(
      { agent: "a", workItemId: workItem.id, title: "sub", spec: {} },
      asAgent("a"),
    );

    const paused = await service.setGoalPaused(workItem.id, true, op);
    expect(paused.paused).toBe(true);

    await expect(
      service.claimTask({ agent: "a", taskId: t.id }, asAgent("a")),
    ).rejects.toThrow(/paused/);

    const resumed = await service.setGoalPaused(workItem.id, false, op);
    expect(resumed.paused).toBe(false);

    const c = await service.claimTask(
      { agent: "a", taskId: t.id },
      asAgent("a"),
    );
    expect(c.fence).toBe(1);
  });

  it("sweep, revoke and pause are operator-only", async () => {
    const { task, workItem } = await setupTask();
    await expect(service.sweepLeases(100, asAgent("a"))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      service.revokeClaim(task.id, asAgent("a")),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.setGoalPaused(workItem.id, true, asAgent("a")),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
