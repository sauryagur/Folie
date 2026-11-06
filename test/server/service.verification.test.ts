// Verification contracts: verifiers must be independent of the producer; achieved only via evaluation (R-11).
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

describe("verification contracts", () => {
  it("moves submitted->verified on independent pass and evaluates achieved", async () => {
    const { workItem, task } = await setupTask();
    const v = await service.requestVerification(
      { taskId: task.id, check: "result-present", verifier: "b" },
      op,
    );
    expect(v).toMatchObject({ status: "pending", required: true });

    // The producer cannot be the verifier.
    await expect(
      service.recordVerdict(
        {
          verificationId: v.id,
          verifier: "a",
          verdict: "pass",
          confidence: 0.9,
          evidence: [],
        },
        op,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    // Independent pass moves submitted->verified.
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
    const t = (
      await db.query("SELECT status FROM tasks WHERE id = $1", [task.id])
    ).rows[0];
    expect(t).toMatchObject({ status: "verified" });

    // All tasks verified: goal is achieved.
    const ev = await service.evaluateGoal({ workItemId: workItem.id }, op);
    expect(ev.verdict).toBe("achieved");
  });

  it("rejects verdicts from unknown verifiers and can't force pass without evidence", async () => {
    const { task } = await setupTask();
    const v = await service.requestVerification(
      { taskId: task.id, check: "x", verifier: "b" },
      op,
    );
    await expect(
      service.recordVerdict(
        {
          verificationId: v.id,
          verifier: "b",
          verdict: "pass",
          confidence: 1.1,
          evidence: [],
        },
        op,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("stays submitted on fail verdict", async () => {
    const { workItem, task } = await setupTask();
    const v = await service.requestVerification(
      { taskId: task.id, check: "x", verifier: "b" },
      op,
    );
    await service.recordVerdict(
      {
        verificationId: v.id,
        verifier: "b",
        verdict: "fail",
        confidence: 0.9,
        evidence: ["bad"],
      },
      op,
    );
    const t = (
      await db.query("SELECT status FROM tasks WHERE id = $1", [task.id])
    ).rows[0];
    expect(t).toMatchObject({ status: "submitted" });
    const ev = await service.evaluateGoal({ workItemId: workItem.id }, op);
    expect(ev.verdict).toBe("not_achieved");
  });

  it("stays submitted without a required contract", async () => {
    const { workItem, task } = await setupTask();
    const v = await service.requestVerification(
      { taskId: task.id, check: "x", verifier: "b", required: false },
      op,
    );
    await service.recordVerdict(
      {
        verificationId: v.id,
        verifier: "b",
        verdict: "pass",
        confidence: 0.9,
        evidence: [],
      },
      op,
    );
    const t = (
      await db.query("SELECT status FROM tasks WHERE id = $1", [task.id])
    ).rows[0];
    expect(t).toMatchObject({ status: "submitted" });
    const ev = await service.evaluateGoal({ workItemId: workItem.id }, op);
    expect(ev.verdict).toBe("not_achieved");
  });

  it("requires every required check to pass before verified", async () => {
    const { task } = await setupTask();
    const v1 = await service.requestVerification(
      { taskId: task.id, check: "c1", verifier: "b" },
      op,
    );
    const v2 = await service.requestVerification(
      { taskId: task.id, check: "c2", verifier: "b" },
      op,
    );
    await service.recordVerdict(
      {
        verificationId: v1.id,
        verifier: "b",
        verdict: "pass",
        confidence: 0.9,
        evidence: [],
      },
      op,
    );
    const t1 = (
      await db.query("SELECT status FROM tasks WHERE id = $1", [task.id])
    ).rows[0];
    expect(t1).toMatchObject({ status: "submitted" });
    await service.recordVerdict(
      {
        verificationId: v2.id,
        verifier: "b",
        verdict: "pass",
        confidence: 0.9,
        evidence: [],
      },
      op,
    );
    const t2 = (
      await db.query("SELECT status FROM tasks WHERE id = $1", [task.id])
    ).rows[0];
    expect(t2).toMatchObject({ status: "verified" });
  });

  it("evaluates partially with one of two verified", async () => {
    const { workItem, task } = await setupTask();
    const t2 = await service.proposeTask(
      { agent: "a", workItemId: workItem.id, title: "sub2", spec: {} },
      asAgent("a"),
    );
    const c2 = await service.claimTask({ agent: "a", taskId: t2.id }, asAgent("a"));
    await service.startTask(
      { agent: "a", taskId: t2.id, fence: c2.fence },
      asAgent("a"),
    );
    await service.submitTask(
      { agent: "a", taskId: t2.id, fence: c2.fence, result: { ok: true } },
      asAgent("a"),
    );
    const v = await service.requestVerification(
      { taskId: task.id, check: "x", verifier: "b" },
      op,
    );
    await service.recordVerdict(
      {
        verificationId: v.id,
        verifier: "b",
        verdict: "pass",
        confidence: 0.9,
        evidence: [],
      },
      op,
    );
    const ev = await service.evaluateGoal({ workItemId: workItem.id }, op);
    expect(ev.verdict).toBe("partially");
    expect(ev.caveats.join(" ")).toMatch(/1\/2 tasks verified/);
  });

  it("evaluates not_achieved with no tasks yet", async () => {
    await service.registerAgent("a");
    const { workItem } = await service.submitGoal({ goal: "g2", to: "a" }, op);
    const ev = await service.evaluateGoal({ workItemId: workItem.id }, op);
    expect(ev.verdict).toBe("not_achieved");
    expect(ev.caveats.join(" ")).toMatch(/no tasks yet/);
  });
});
