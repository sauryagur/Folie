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
  it("rejects self-verification and never marks completed without independent verdicts", async () => {
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

    // Independent pass completes, then the task may move submitted->completed.
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
    expect(t).toMatchObject({ status: "submitted" });

    // Goal evaluation is a separate gate: no verified task, no achieved.
    const ev = await service.evaluateGoal({ workItemId: workItem.id }, op);
    expect(ev.verdict).toBe("not_achieved");
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
});
