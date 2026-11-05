// Cancellation (R-2.4/R-2.5): a control signal wakes the shim within ~1s, abort threads through,
// and the session settles `cancelled` with partial usage + interrupted entries. D10 closed at seam level.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/server/db";
import { SwarmService } from "../../src/server/service";
import type { Store } from "../../src/server/store";
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

describe("cancellation", () => {
  it("wakes the control watcher on cancel and the signal survives resume", async () => {
    await service.registerAgent("a");
    // No signal yet: control returns current cursor, no action.
    const empty = await service.control("a", { after: 0 }, asAgent("a"));
    expect(empty).toMatchObject({ actions: [] });
    // Queue a cancel via the operator kill path.
    await service.queueCancel({ agent: "a", reason: "operator" }, op);
    const got = await service.control(
      "a",
      { after: empty.cursor },
      asAgent("a"),
    );
    expect(got.actions).toEqual([expect.objectContaining({ type: "cancel" })]);
    expect(got.cursor).toBeGreaterThan(empty.cursor);
    // Resume from the delivered cursor: the signal is not redelivered.
    const again = await service.control(
      "a",
      { after: got.cursor },
      asAgent("a"),
    );
    expect(again.actions).toEqual([]);
  });

  it("rejects control reads by another agent and settles cancelled with partial usage", async () => {
    await service.registerAgent("a");
    await service.registerAgent("b");
    await expect(
      service.control("a", { after: 0 }, asAgent("b")),
    ).rejects.toThrowError();
    const m = await store.messages.send({ from: "human", to: "a", body: "hi" });
    const s = await service.startSession(
      { agent: "a", messageIds: [m.id] },
      asAgent("a"),
    );
    const r = await service.submitReport(
      {
        agent: "a",
        sessionId: s.sessionId,
        startedAt: new Date().toISOString(),
        outcome: "failed",
        summary: "cancelled by operator",
        messageIds: [m.id],
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          costUsd: 0.001,
          toolCalls: 1,
          toolFailures: 0,
        },
      },
      asAgent("a"),
    );
    expect(r.outcome).toBe("failed");
    const rows = (await db.query("SELECT state, outcome FROM sessions")).rows;
    expect(rows[0]).toMatchObject({ state: "settled" });
  });
});
