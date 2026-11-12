// Persisted sessions: the server owns session creation and leases messages before transcripts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/server/db";
import { ValidationError } from "../../src/server/errors";
import { SwarmService } from "../../src/server/service";
import type { Store } from "../../src/server/store";
import { testStore } from "../support/db";
import { memoryTelemetry } from "../support/otel";

let db: Database;
let store: Store;
let reset: () => Promise<void>;
const mem = memoryTelemetry();
let service: SwarmService;
const asAgent = (name: string) =>
  ({ kind: "agent", name, generation: 1, executionId: "test-exec" }) as const;

beforeAll(async () => {
  ({ db, store, reset } = await testStore());
  service = new SwarmService(store, mem.telemetry);
});
beforeEach(() => reset());
afterAll(() => db.close());

describe("persisted sessions", () => {
  it("writes a running session before transcript events and leases its messages", async () => {
    await service.registerAgent("a");
    const m = await store.messages.send({ from: "human", to: "a", body: "hi" });

    // Events before a server-owned session exists are rejected.
    await expect(
      service.ingestEvents(
        {
          agent: "a",
          sessionId: "99",
          scope: "mail:1",
          events: [{ seq: 0, type: "message", data: {} }],
        },
        asAgent("a"),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    const s = await service.startSession(
      { agent: "a", messageIds: [m.id] },
      asAgent("a"),
    );
    expect(s.sessionId).toMatch(/^\d+$/);
    expect(s.state).toBe("running");
    expect(s.agent).toBe("a");

    // The leased message is no longer unacked for a second session to take.
    expect(await service.inbox("a", {}, asAgent("a"))).toEqual([]);
    // Events now ingest against the server-owned session.
    await expect(
      service.ingestEvents(
        {
          agent: "a",
          sessionId: s.sessionId,
          scope: "mail:1",
          events: [{ seq: 0, type: "message", data: {} }],
        },
        asAgent("a"),
      ),
    ).resolves.toEqual({ stored: 1 });

    // Reporting settles the same row instead of minting a new one.
    const submission = {
      agent: "a",
      sessionId: s.sessionId,
      startedAt: new Date().toISOString(),
      outcome: "done" as const,
      summary: "ok",
      messageIds: [m.id],
    };
    const r = await service.submitReport(submission, asAgent("a"));
    expect(r.id).toBeGreaterThan(0);
    const retry = await service.submitReport(submission, asAgent("a"));
    expect(retry.id).toBe(r.id);
    await expect(
      service.submitReport(
        { ...submission, summary: "different result" },
        asAgent("a"),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    const rows = (
      await db.query("SELECT state, outcome, ended_at FROM sessions")
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "settled", outcome: "done" });
    expect(rows[0]!.ended_at).not.toBeNull();
    const reportRows = (await db.query("SELECT id FROM reports")).rows;
    expect(reportRows).toHaveLength(1);
  });

  it("is idempotent on clientRequestId and rejects another agent's messages", async () => {
    await service.registerAgent("a");
    await service.registerAgent("b");
    const m = await store.messages.send({ from: "human", to: "a", body: "hi" });

    await expect(
      service.startSession({ agent: "b", messageIds: [m.id] }, asAgent("b")),
    ).rejects.toBeInstanceOf(ValidationError);

    const s1 = await service.startSession(
      { agent: "a", messageIds: [m.id], clientRequestId: "req-1" },
      asAgent("a"),
    );
    const s2 = await service.startSession(
      { agent: "a", messageIds: [m.id], clientRequestId: "req-1" },
      asAgent("a"),
    );
    expect(s2.sessionId).toBe(s1.sessionId);
  });
});
