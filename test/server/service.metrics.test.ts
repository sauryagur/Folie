// Semantic metrics catalog: store-backed transitions emit, ids never become labels (R-15.4).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  await service.registerAgent("b");
  const { workItem } = await service.submitGoal({ goal: "g", to: "a" }, op);
  const t = await service.proposeTask(
    { agent: "a", workItemId: workItem.id, title: "sub", spec: {} },
    asAgent("a"),
  );
  const c = await service.claimTask({ agent: "a", taskId: t.id }, asAgent("a"));
  await service.startTask(
    { agent: "a", taskId: t.id, fence: c.fence },
    asAgent("a"),
  );
  const s = await service.submitTask(
    { agent: "a", taskId: t.id, fence: c.fence, result: { ok: true } },
    asAgent("a"),
  );
  return { workItem, task: s };
};

describe("semantic metrics catalog", () => {
  it("counts propose/claim/start/submit transitions once", async () => {
    await setupTask();
    const m = await mem.metrics();
    expect(m["folie.task.transition{from=none,to=available}"]).toBe(1);
    expect(m["folie.task.transition{from=available,to=claimed}"]).toBe(1);
    expect(m["folie.task.transition{from=claimed,to=running}"]).toBe(1);
    expect(m["folie.task.transition{from=running,to=submitted}"]).toBe(1);
    expect(m["folie.proposal{outcome=accepted}"]).toBe(1);
    expect(m["folie.task.claim.latency{}"]).toBe(1);
    for (const k of Object.keys(m)) {
      expect(k).not.toContain("task_id");
      expect(k).not.toContain("goal_id");
      expect(k).not.toContain("session_id");
    }
  });

  it("counts a zero-subscriber publish as undelivered", async () => {
    await service.registerAgent("a");
    const res = await service.publish(
      "empty-topic",
      { from: "a", body: "hi" },
      asAgent("a"),
    );
    expect(res.delivered).toBe(0);
    const m = await mem.metrics();
    expect(m["folie.publication.undelivered{}"]).toBe(1);
  });

  it("emits verification.result with bounded kind and goal/budget metrics", async () => {
    const { workItem, task } = await setupTask();
    const v = await service.requestVerification(
      { taskId: task.id, check: "result-present", verifier: "b" },
      op,
    );
    await service.recordVerdict(
      {
        verificationId: v.id,
        verifier: "b",
        verdict: "pass",
        confidence: 0.9,
        evidence: ["r1"],
      },
      op,
    );
    const ev = await service.evaluateGoal({ workItemId: workItem.id }, op);

    const budget = await service.createBudget(
      { name: "g", limitAmount: 10, dim: "usd" },
      op,
    );
    await service.recordUsage(
      { budgetId: budget.id, amount: 20, basis: "estimated" },
      op,
    );
    // Second usage after exhaustion must not flip again.
    await service.recordUsage(
      { budgetId: budget.id, amount: 5, basis: "estimated" },
      op,
    );

    const m = await mem.metrics();
    expect(m["folie.verification.result{result=pass,verification.kind=contract}"]).toBe(1);
    expect(ev.verdict).toBe("achieved");
    expect(m["folie.goal.outcome{outcome=achieved}"]).toBe(1);
    expect(m["folie.task.verified{}"]).toBe(1);
    expect(m["folie.task.time_to_verified{}"]).toBe(1);
    expect(m["folie.budget.exhausted{dim=usd}"]).toBe(1);
    expect(m["folie.budget.overrun{dim=usd}"]).toBe(1);
    expect(m["folie.llm.cost{cost_basis=estimated}"]).toBe(25);
    expect(m["folie.task.transition{from=submitted,to=completed}"]).toBeUndefined();
    for (const k of Object.keys(m)) {
      expect(k).not.toContain("task_id");
      expect(k).not.toContain("goal_id");
      expect(k).not.toContain("session_id");
    }
  });
});
