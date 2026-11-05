// Task proposals, claims and fencing (R-7/R-8 slice): one owner, single conditional claim, stale writes rejected.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../src/server/errors";
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
const asAgent = (name: string) => ({ kind: "agent", name, generation: 1, executionId: "test-exec" }) as const;

beforeAll(async () => {
  ({ db, store, reset } = await testStore());
  service = new SwarmService(store, mem.telemetry);
});
beforeEach(() => reset());
afterAll(() => db.close());

const goalTo = async (to: string, goal = "g") => {
  await service.registerAgent(to);
  const { workItem, message } = await service.submitGoal({ goal, to }, op);
  return { workItem, message: message! };
};

describe("task proposals and claims", () => {
  it("propose -> available -> claim -> start -> submit settles with a fenced owner", async () => {
    const { workItem } = await goalTo("a");
    const t = await service.proposeTask({ agent: "a", workItemId: workItem.id, title: "sub", spec: { text: "do it" } }, asAgent("a"));
    expect(t.id).toBeGreaterThan(0);
    expect(t.status).toBe("available");

    const c = await service.claimTask({ agent: "a", taskId: t.id }, asAgent("a"));
    expect(c.fence).toBe(1);
    expect(c.role).toBe("owner");

    // Second claimant loses the race deterministically (single conditional update).
    await service.registerAgent("b");
    await expect(service.claimTask({ agent: "b", taskId: t.id }, asAgent("b"))).rejects.toBeInstanceOf(ValidationError);

    await service.startTask({ agent: "a", taskId: t.id, fence: c.fence }, asAgent("a"));
    const s = await service.submitTask({ agent: "a", taskId: t.id, fence: c.fence, result: { ok: true } }, asAgent("a"));
    expect(s.status).toBe("submitted");

    // Stale fence can no longer write.
    await expect(service.submitTask({ agent: "a", taskId: t.id, fence: c.fence, result: {} }, asAgent("a"))).rejects.toBeInstanceOf(ValidationError);
    // Claim record is terminal-completed, not active.
    expect((await db.query("SELECT state FROM task_claims")).rows[0]).toMatchObject({ state: "completed" });
  });

  it("rejects claims from another agent's principal and unknown tasks", async () => {
    const { workItem } = await goalTo("a");
    const t = await service.proposeTask({ agent: "a", workItemId: workItem.id, title: "sub", spec: {} }, asAgent("a"));
    await service.registerAgent("b");
    await expect(service.claimTask({ agent: "a", taskId: t.id }, asAgent("b"))).rejects.toThrow();
    await expect(service.claimTask({ agent: "a", taskId: 9999 }, asAgent("a"))).rejects.toBeInstanceOf(ValidationError);
  });
});
